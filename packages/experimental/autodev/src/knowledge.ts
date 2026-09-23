/** Evidence-backed knowledge evolution, compaction and regression checks. */

import { randomUUID } from 'node:crypto'
import type {
  KnowledgeCandidate,
  KnowledgeCompactionReport,
  KnowledgeKind,
  KnowledgeRegressionCase,
  KnowledgeRegressionResult,
  ProvenanceRef,
  ScopeRef,
} from './contracts.ts'
import { AutoDevStore } from './store.ts'
import { confidence, normalizeScope, unique } from './semantics.ts'
import { normalize, tokens } from './memory.ts'

export interface KnowledgeCandidateInput {
  readonly scope: ScopeRef
  readonly kind: KnowledgeKind
  readonly statement: string
  readonly content?: string
  readonly confidence?: number
  readonly provenance?: readonly ProvenanceRef[]
  readonly evidenceIds?: readonly string[]
  readonly relatedMemoryIds?: readonly string[]
  readonly expiresAt?: string
}

export class KnowledgeService {
  constructor(readonly store: AutoDevStore) {}

  candidate(input: KnowledgeCandidateInput): KnowledgeCandidate {
    const now = new Date().toISOString()
    const statement = requireText(input.statement, 'knowledge statement')
    const value: KnowledgeCandidate = {
      id: randomUUID(), scope: normalizeScope(input.scope), kind: input.kind, statement,
      content: input.content?.trim() || statement, status: 'CANDIDATE', confidence: confidence(input.confidence), version: 1,
      provenance: [...(input.provenance ?? [])],
      evidenceIds: unique(input.evidenceIds ?? []),
      relatedMemoryIds: unique(input.relatedMemoryIds ?? []),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      createdAt: now, updatedAt: now,
    }
    this.store.saveKnowledge(value)
    return value
  }

  get(id: string): KnowledgeCandidate | undefined { return this.store.getKnowledge(id) }

  list(projectKey: string, includeDeprecated: boolean = false): readonly KnowledgeCandidate[] {
    const now = new Date().toISOString()
    return this.store.listKnowledge(projectKey).filter(item => (includeDeprecated || item.status !== 'DEPRECATED') && (item.expiresAt === undefined || item.expiresAt > now))
  }

  search(projectKey: string, query: string): readonly KnowledgeCandidate[] {
    const queryTokens = tokens(query)
    return this.list(projectKey)
      .map(item => ({ item, score: tokens(`${item.statement} ${item.content}`).filter(token => queryTokens.includes(token)).length }))
      .filter(item => item.score > 0 || normalize(query) === normalize(item.item.statement))
      .sort((a, b) => b.score - a.score || b.item.confidence - a.item.confidence)
      .map(item => item.item)
  }

  promote(id: string, evidenceIds: readonly string[], regressionCaseId?: string): KnowledgeCandidate {
    const current = this.store.getKnowledge(id)
    if (current === undefined) throw new Error(`knowledge candidate ${id} does not exist`)
    const evidence = unique([...current.evidenceIds, ...evidenceIds])
    if (evidence.length === 0) throw new Error('knowledge promotion requires at least one Evidence id')
    if (regressionCaseId !== undefined) {
      const result = this.store.listRegressionResults(regressionCaseId)[0]
      if (result?.status !== 'PASS') throw new Error(`knowledge promotion requires a PASS regression result for ${regressionCaseId}`)
    }
    const promoted: KnowledgeCandidate = { ...current, status: 'ESTABLISHED', confidence: Math.max(current.confidence, 0.85), evidenceIds: evidence, version: current.version + 1, lastValidatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    this.store.saveKnowledge(promoted)
    return promoted
  }

  recordUse(id: string, outcome: 'success' | 'failure'): KnowledgeCandidate {
    const current = this.store.getKnowledge(id)
    if (current === undefined) throw new Error(`knowledge candidate ${id} does not exist`)
    const next: KnowledgeCandidate = {
      ...current,
      usageCount: (current.usageCount ?? 0) + 1,
      successCount: (current.successCount ?? 0) + (outcome === 'success' ? 1 : 0),
      failureCount: (current.failureCount ?? 0) + (outcome === 'failure' ? 1 : 0),
      lastUsedAt: new Date().toISOString(),
      confidence: outcome === 'success' ? Math.min(1, current.confidence + 0.02) : Math.max(0, current.confidence - 0.05),
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    }
    this.store.saveKnowledge(next)
    return next
  }

  validate(id: string, evidenceIds: readonly string[]): KnowledgeCandidate {
    const current = this.store.getKnowledge(id)
    if (current === undefined) throw new Error(`knowledge candidate ${id} does not exist`)
    const next: KnowledgeCandidate = {
      ...current,
      evidenceIds: unique([...current.evidenceIds, ...evidenceIds]),
      lastValidatedAt: new Date().toISOString(),
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    }
    this.store.saveKnowledge(next)
    return next
  }

  expire(scopeInput: ScopeRef, now: string = new Date().toISOString()): readonly string[] {
    const expired = this.store.listKnowledge(normalizeScope(scopeInput).projectKey).filter(item => item.expiresAt !== undefined && item.expiresAt <= now && item.status !== 'DEPRECATED')
    for (const item of expired) this.deprecate(item.id, `knowledge expired at ${item.expiresAt}`)
    return expired.map(item => item.id)
  }

  deprecate(id: string, reason?: string): KnowledgeCandidate {
    const current = this.store.getKnowledge(id)
    if (current === undefined) throw new Error(`knowledge candidate ${id} does not exist`)
    const provenance: ProvenanceRef[] = reason === undefined ? [...current.provenance] : [...current.provenance, { sourceType: 'system', sourceId: `deprecate:${randomUUID()}`, note: reason }]
    const deprecated: KnowledgeCandidate = { ...current, status: 'DEPRECATED', provenance, version: current.version + 1, updatedAt: new Date().toISOString() }
    this.store.saveKnowledge(deprecated)
    return deprecated
  }

  compact(scopeInput: ScopeRef): KnowledgeCompactionReport {
    const scope = normalizeScope(scopeInput)
    const values = [...this.list(scope.projectKey, true)].filter(item => item.status !== 'DEPRECATED')
    const groups = new Map<string, KnowledgeCandidate[]>()
    for (const item of values) {
      const key = `${item.kind}:${normalize(item.statement)}`
      const group = groups.get(key) ?? []
      group.push(item)
      groups.set(key, group)
    }
    const actions: KnowledgeCompactionReport['actions'][number][] = []
    const inputIds = values.map(item => item.id)
    const outputIds: string[] = []
    for (const group of groups.values()) {
      group.sort((a, b) => Number(b.status === 'ESTABLISHED') - Number(a.status === 'ESTABLISHED') || b.confidence - a.confidence || a.createdAt.localeCompare(b.createdAt))
      const primary = group[0]
      if (primary === undefined) continue
      outputIds.push(primary.id)
      if (group.length === 1) continue
      const mergedEvidence = unique(group.flatMap(item => item.evidenceIds))
      const mergedProvenance = group.flatMap(item => item.provenance)
      const merged: KnowledgeCandidate = {
        ...primary,
        evidenceIds: mergedEvidence,
        provenance: mergedProvenance,
        version: primary.version + 1,
        updatedAt: new Date().toISOString(),
      }
      this.store.saveKnowledge(merged)
      const duplicates = group.slice(1)
      for (const duplicate of duplicates) {
        this.store.saveKnowledge({ ...duplicate, status: 'DEPRECATED', version: duplicate.version + 1, updatedAt: new Date().toISOString() })
      }
      actions.push({ kind: 'merged', inputIds: group.map(item => item.id), outputId: primary.id })
      actions.push(...duplicates.map(item => ({ kind: 'deprecated' as const, inputIds: [item.id], outputId: primary.id })))
    }
    const report: KnowledgeCompactionReport = { id: randomUUID(), scope, inputIds, outputIds, actions, createdAt: new Date().toISOString() }
    this.store.saveCompaction(report)
    return report
  }

  createRegressionCase(input: {
    readonly scope: ScopeRef
    readonly name: string
    readonly query: string
    readonly expectedStatements: readonly string[]
  }): KnowledgeRegressionCase {
    const testCase: KnowledgeRegressionCase = {
      id: randomUUID(),
      scope: normalizeScope(input.scope),
      name: requireText(input.name, 'regression case name'),
      input: requireText(input.query, 'regression input'),
      expectedStatements: unique(input.expectedStatements),
      createdAt: new Date().toISOString(),
    }
    this.store.saveRegressionCase(testCase)
    return testCase
  }

  runRegression(caseId: string): KnowledgeRegressionResult {
    const testCase = this.store.getRegressionCase(caseId)
    if (testCase === undefined) throw new Error(`knowledge regression case ${caseId} does not exist`)
    const active = this.list(testCase.scope.projectKey)
    const matched = testCase.expectedStatements.filter(expected => active.some(
      item => normalize(item.statement) === normalize(expected) || normalize(item.content).includes(normalize(expected)),
    ))
    const missing = testCase.expectedStatements.filter(expected => !matched.includes(expected))
    const status = active.length === 0 ? 'UNKNOWN' : missing.length === 0 ? 'PASS' : 'FAIL'
    const result: KnowledgeRegressionResult = {
      id: randomUUID(), caseId, status, matched, missing, unexpected: [], createdAt: new Date().toISOString(),
    }
    this.store.saveRegressionResult(result)
    return result
  }
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`)
  return value.trim()
}
