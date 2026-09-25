/** Project-scoped long-term memory with bounded, progressive retrieval. */

import { randomUUID } from 'node:crypto'
import type {
  KnowledgeStatus,
  MemoryKind,
  MemorySearchHit,
  ProjectMemory,
  SourceReference,
  ScopeRef,
} from './contracts.ts'
import { AutoDevStore } from './store.ts'
import { confidence, normalizeScope, unique } from './semantics.ts'
import { sameScope, scopeSpecificity, type ScopeQuery } from './scope.ts'

/** Scoped Memory content plus optional lifecycle, source references, and expiry metadata. */
export interface RememberInput {
  readonly scope: ScopeRef
  readonly kind: MemoryKind
  readonly title: string
  readonly content: string
  readonly tags?: readonly string[]
  readonly status?: KnowledgeStatus
  readonly confidence?: number
  readonly sourceRefs?: readonly SourceReference[]
  readonly evidenceIds?: readonly string[]
  readonly supersedesId?: string
  readonly expiresAt?: string
}

/** Result-count and content limits for Memory retrieval. */
export interface MemorySearchOptions {
  readonly limit?: number
  readonly maxChars?: number
  readonly includeDeprecated?: boolean
}

/** Persists project-scoped Memory and exposes bounded progressive retrieval. */
export class ProjectMemoryService {
  constructor(readonly store: AutoDevStore) {}

  /** Create a candidate Memory record with normalized scope and source references.
   * @param input - Memory content, scope, and optional source metadata.
   * @returns The persisted candidate Memory record.
   */
  remember(input: RememberInput): ProjectMemory {
    const now = new Date().toISOString()
    const memory: ProjectMemory = {
      id: randomUUID(),
      scope: normalizeScope(input.scope),
      kind: input.kind,
      title: requireText(input.title, 'memory title'),
      content: requireText(input.content, 'memory content'),
      tags: unique(input.tags ?? []),
      status: input.status ?? 'CANDIDATE',
      confidence: confidence(input.confidence),
      sourceRefs: [...(input.sourceRefs ?? [])],
      evidenceIds: unique(input.evidenceIds ?? []),
      version: 1,
      ...(input.supersedesId === undefined ? {} : { supersedesId: input.supersedesId }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      createdAt: now,
      updatedAt: now,
    }
    this.store.saveMemory(memory)
    return memory
  }

  /** Read one Memory record by its durable identifier.
   * @param id - Memory record identity.
   * @returns The record, or `undefined` when no such record exists.
   */
  get(id: string): ProjectMemory | undefined {
    return this.store.getMemory(id)
  }

  /** List records applicable to a project scope.
   * @param scope - Project and optional version dimensions to match.
   * @param includeDeprecated - Whether to retain deprecated records in the result.
   * @returns Scoped Memory records.
   */
  list(scope: ScopeQuery, includeDeprecated: boolean = false): readonly ProjectMemory[] {
    return this.store.listMemories(scope).filter(item => includeDeprecated || item.status !== 'DEPRECATED')
  }

  /** Search scoped Memory and return ranked, bounded summaries with match reasons.
   * @param scope - Project and optional version dimensions to match.
   * @param query - Natural-language terms used for retrieval.
   * @param options - Optional result-count, character, and lifecycle filters.
   * @returns Ranked Memory hits with content limited to the requested budget.
   */
  search(scope: ScopeQuery, query: string, options: MemorySearchOptions = {}): readonly MemorySearchHit[] {
    const normalizedQuery = normalize(query)
    if (normalizedQuery === '') return []
    const queryTokens = tokens(query)
    const now = new Date().toISOString()
    const limit = clamp(options.limit ?? 8, 1, 50)
    const maxChars = clamp(options.maxChars ?? 1000, 32, 12_000)
    return this.list(scope, options.includeDeprecated === true)
      .filter(item => item.expiresAt === undefined || item.expiresAt > now)
      .map((memory) => {
        const haystack = normalize(`${memory.title} ${memory.content} ${memory.tags.join(' ')}`)
        const overlap = queryTokens.filter(token => haystack.includes(token)).length
        const exact = haystack.includes(normalizedQuery) ? 1 : 0
        const score = Math.min(1, exact * 0.6 + (queryTokens.length === 0 ? 0 : overlap / queryTokens.length) * 0.4)
        return {
          memory: { ...memory, content: truncate(memory.content, maxChars) },
          score,
          reason: exact > 0 ? 'exact project-memory match' : `${overlap}/${queryTokens.length} query token(s) matched`,
        }
      })
      .filter(item => item.score > 0)
      .sort((a, b) =>
        b.score - a.score ||
        scopeSpecificity(b.memory.scope) - scopeSpecificity(a.memory.scope) ||
        b.memory.confidence - a.memory.confidence ||
        a.memory.id.localeCompare(b.memory.id),
      )
      .slice(0, limit)
  }

  /** Update a Memory lifecycle status and retain the supplied Evidence references.
   * @param id - Memory identity to update.
   * @param status - Non-candidate lifecycle status to apply.
   * @param evidenceIds - Additional Evidence IDs associated with this version.
   * @returns The persisted Memory version.
   */
  setStatus(id: string, status: Exclude<KnowledgeStatus, 'CANDIDATE'>, evidenceIds: readonly string[] = []): ProjectMemory {
    const current = this.store.getMemory(id)
    if (current === undefined) throw new Error(`memory ${id} does not exist`)
    const next: ProjectMemory = {
      ...current,
      status,
      confidence: status === 'ESTABLISHED' ? Math.max(current.confidence, 0.8) : current.confidence,
      evidenceIds: unique([...current.evidenceIds, ...evidenceIds]),
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    }
    this.store.saveMemory(next)
    return next
  }

  /** Deterministically deprecate exact duplicates while retaining the canonical record.
   * @param scope - Exact project scope to compact.
   * @returns A report identity and the IDs deprecated by this operation.
   */
  compact(scope: ScopeRef): { readonly reportId: string; readonly deprecatedIds: readonly string[] } {
    const normalizedScope = normalizeScope(scope)
    const memories = [...this.store.listMemories(normalizedScope)].filter(item => sameScope(item.scope, normalizedScope) && item.status !== 'DEPRECATED')
    const canonical = new Map<string, ProjectMemory>()
    const deprecatedIds: string[] = []
    for (const memory of memories.sort((a, b) => b.confidence - a.confidence || a.createdAt.localeCompare(b.createdAt))) {
      const key = `${memory.kind}:${normalize(memory.title)}:${normalize(memory.content)}`
      const existing = canonical.get(key)
      if (existing === undefined) {
        canonical.set(key, memory)
        continue
      }
      this.store.saveMemory({ ...memory, status: 'DEPRECATED', supersedesId: existing.id, version: memory.version + 1, updatedAt: new Date().toISOString() })
      deprecatedIds.push(memory.id)
    }
    return { reportId: randomUUID(), deprecatedIds }
  }
}

/** Normalize case and whitespace for deterministic text comparisons.
 * @param value - Text to normalize.
 * @returns Trimmed, lower-case text with internal whitespace collapsed.
 */
export function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

/** Extract unique Unicode word tokens used by scoped search and Concept matching.
 * @param value - Text to tokenize.
 * @returns Unique normalized tokens longer than one character.
 */
export function tokens(value: string): readonly string[] {
  const normalized = normalize(value)
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []
  return [...new Set(words.filter(item => item.length > 1))]
}

/** Truncate text to a character budget and mark the omitted tail.
 * @param value - Text to bound.
 * @param maxChars - Maximum output length before the truncation marker.
 * @returns Original text when it fits, otherwise a bounded prefix and marker.
 */
export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 14))}… [truncated]`
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`)
  return value.trim()
}
