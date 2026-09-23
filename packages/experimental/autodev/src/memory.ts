/** Project-scoped long-term memory with bounded, progressive retrieval. */

import { randomUUID } from 'node:crypto'
import type {
  KnowledgeStatus,
  MemoryKind,
  MemorySearchHit,
  ProjectMemory,
  ProvenanceRef,
  ScopeRef,
} from './contracts.ts'
import { AutoDevStore } from './store.ts'
import { confidence, normalizeScope, unique } from './semantics.ts'

export interface RememberInput {
  readonly scope: ScopeRef
  readonly kind: MemoryKind
  readonly title: string
  readonly content: string
  readonly tags?: readonly string[]
  readonly status?: KnowledgeStatus
  readonly confidence?: number
  readonly provenance?: readonly ProvenanceRef[]
  readonly evidenceIds?: readonly string[]
  readonly supersedesId?: string
  readonly expiresAt?: string
}

export interface MemorySearchOptions {
  readonly limit?: number
  readonly maxChars?: number
  readonly includeDeprecated?: boolean
}

export class ProjectMemoryService {
  constructor(readonly store: AutoDevStore) {}

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
      provenance: [...(input.provenance ?? [])],
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

  get(id: string): ProjectMemory | undefined {
    return this.store.getMemory(id)
  }

  list(projectKey: string, includeDeprecated: boolean = false): readonly ProjectMemory[] {
    return this.store.listMemories(projectKey).filter(item => includeDeprecated || item.status !== 'DEPRECATED')
  }

  search(projectKey: string, query: string, options: MemorySearchOptions = {}): readonly MemorySearchHit[] {
    const normalizedQuery = normalize(query)
    if (normalizedQuery === '') return []
    const queryTokens = tokens(query)
    const now = new Date().toISOString()
    const limit = clamp(options.limit ?? 8, 1, 50)
    const maxChars = clamp(options.maxChars ?? 1000, 32, 12_000)
    return this.list(projectKey, options.includeDeprecated === true)
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
      .sort((a, b) => b.score - a.score || b.memory.confidence - a.memory.confidence || a.memory.id.localeCompare(b.memory.id))
      .slice(0, limit)
  }

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

  /** Deterministically deprecate exact duplicates while retaining provenance. */
  compact(scope: ScopeRef): { readonly reportId: string; readonly deprecatedIds: readonly string[] } {
    const memories = [...this.list(normalizeScope(scope).projectKey, true)].filter(item => item.status !== 'DEPRECATED')
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

export function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

export function tokens(value: string): readonly string[] {
  const normalized = normalize(value)
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []
  return [...new Set(words.filter(item => item.length > 1))]
}

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
