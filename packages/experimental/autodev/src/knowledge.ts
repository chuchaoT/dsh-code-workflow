/** Evidence-backed knowledge evolution, compaction and regression checks. */

import { randomUUID } from 'node:crypto'
import type {
  KnowledgeCandidate,
  KnowledgeCompactionReport,
  KnowledgeKind,
  KnowledgeMergeProposal,
  KnowledgeSearchHit,
  KnowledgeTemperature,
  KnowledgeRegressionCase,
  KnowledgeRegressionResult,
  KnowledgeRegressionSuite,
  Evidence,
  SourceReference,
  ScopeRef,
} from './contracts.ts'
import { AutoDevStore } from './store.ts'
import { confidence, normalizeScope, unique } from './semantics.ts'
import { normalize, tokens } from './memory.ts'
import { sameScope, scopeSpecificity, scopeIdentity, type ScopeQuery } from './scope.ts'

/** Input used to create an untrusted, scope-bound knowledge candidate. */
export interface KnowledgeCandidateInput {
  readonly scope: ScopeRef
  readonly kind: KnowledgeKind
  readonly statement: string
  readonly content?: string
  readonly confidence?: number
  readonly sourceRefs?: readonly SourceReference[]
  readonly evidenceIds?: readonly string[]
  readonly relatedMemoryIds?: readonly string[]
  readonly expiresAt?: string
}

/** Bounds and clock override for deterministic knowledge retrieval. */
export interface KnowledgeSearchOptions {
  readonly limit?: number
  readonly maxChars?: number
  readonly now?: string
}

/** Bounds and threshold for generating semantic merge proposals. */
export interface KnowledgeMergeOptions {
  readonly limit?: number
  readonly minSimilarity?: number
}

/** Human-authored output fields required to accept a merge proposal. */
export interface KnowledgeMergeApprovalInput {
  readonly statement: string
  readonly content?: string
  readonly resolution: string
}

const MAX_MERGE_SCAN_RECORDS = 200

/** Manages evidence-backed knowledge, compaction, and retrieval regressions. */
export class KnowledgeService {
  constructor(readonly store: AutoDevStore) {}

  /** Persist a normalized knowledge candidate without treating it as established truth.
   * @param input Candidate content, scope, source references, and optional links.
   * @returns The newly persisted candidate.
   */
  candidate(input: KnowledgeCandidateInput): KnowledgeCandidate {
    const now = new Date().toISOString()
    const statement = requireText(input.statement, 'knowledge statement')
    const value: KnowledgeCandidate = {
      id: randomUUID(), scope: normalizeScope(input.scope), kind: input.kind, statement,
      content: input.content?.trim() || statement, status: 'CANDIDATE', confidence: confidence(input.confidence), version: 1,
      sourceRefs: [...(input.sourceRefs ?? [])],
      evidenceIds: unique(input.evidenceIds ?? []),
      relatedMemoryIds: unique(input.relatedMemoryIds ?? []),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      createdAt: now, updatedAt: now,
    }
    this.store.saveKnowledge(value)
    return value
  }

  /** Look up a candidate by its stable identifier.
   * @param id Knowledge identifier.
   * @returns The candidate, or undefined when it does not exist.
   */
  get(id: string): KnowledgeCandidate | undefined { return this.store.getKnowledge(id) }

  /** List unexpired knowledge applicable to a scope.
   * @param scope Scope filter.
   * @param includeDeprecated Whether deprecated records may be included.
   * @returns Matching knowledge ordered by the store's update order.
   */
  list(scope: ScopeQuery, includeDeprecated: boolean = false): readonly KnowledgeCandidate[] {
    const now = new Date().toISOString()
    return this.store.listKnowledge(scope).filter(item => (includeDeprecated || item.status !== 'DEPRECATED') && (item.expiresAt === undefined || item.expiresAt > now))
  }

  /** Search scoped knowledge and return only the matched records.
   * @param scope Scope filter.
   * @param query Natural-language retrieval query.
   * @param options Search limits and optional clock override.
   * @returns Matching knowledge ordered by relevance and temperature.
   */
  search(scope: ScopeQuery, query: string, options: KnowledgeSearchOptions = {}): readonly KnowledgeCandidate[] {
    return this.searchHits(scope, query, options).map(hit => hit.knowledge)
  }

  /** Search knowledge with relevance, temperature, and explanation metadata.
   * @param scope Scope filter.
   * @param query Natural-language retrieval query.
   * @param options Search limits and optional clock override.
   * @returns Ranked knowledge hits with retrieval reasons.
   */
  searchHits(scope: ScopeQuery, query: string, options: KnowledgeSearchOptions = {}): readonly KnowledgeSearchHit[] {
    const queryTokens = tokens(query)
    if (queryTokens.length === 0 && normalize(query) === '') return []
    const limit = clamp(options.limit ?? 20, 1, 50)
    const maxChars = clamp(options.maxChars ?? 6_000, 32, 12_000)
    const now = options.now ?? new Date().toISOString()
    return this.list(scope)
      .map((item) => {
        const score = tokens(`${item.statement} ${item.content}`).filter(token => queryTokens.includes(token)).length
        const temperature = knowledgeTemperature(item, now)
        return {
          knowledge: {
            ...item,
            statement: truncateKnowledge(item.statement, maxChars),
            content: truncateKnowledge(item.content, maxChars),
          },
          temperature,
          score,
          reason: score > 0 ? `${score} query token(s) matched; ${temperature} knowledge tier` : `${temperature} tier exact statement match`,
        }
      })
      .filter(hit => hit.score > 0 || normalize(query) === normalize(hit.knowledge.statement))
      .sort((a, b) =>
        b.score - a.score ||
        temperatureRank(a.temperature) - temperatureRank(b.temperature) ||
        scopeSpecificity(b.knowledge.scope) - scopeSpecificity(a.knowledge.scope) ||
        b.knowledge.confidence - a.knowledge.confidence ||
        a.knowledge.id.localeCompare(b.knowledge.id),
      )
      .slice(0, limit)
  }

  /** Generate bounded, explainable merge proposals without changing Knowledge.
   * Only active records of the same kind and exact scope are compared; each
   * proposal records the token-overlap reason and exact input versions.
   * @param scopeInput Exact project scope to scan.
   * @param options Maximum new proposal count and minimum Jaccard similarity.
   * @returns Persisted proposals for this exact scope, newest first.
   */
  proposeMerges(scopeInput: ScopeRef, options: KnowledgeMergeOptions = {}): readonly KnowledgeMergeProposal[] {
    const scope = normalizeScope(scopeInput)
    const limit = clamp(options.limit ?? 25, 1, 100)
    const minSimilarity = clampDecimal(options.minSimilarity ?? 0.65, 0.5, 0.95)
    const now = new Date().toISOString()
    const records = this.store.listKnowledge(scope)
      .filter(item => sameScope(item.scope, scope) && item.status !== 'DEPRECATED' && (item.expiresAt === undefined || item.expiresAt > now))
      .slice(0, MAX_MERGE_SCAN_RECORDS)
    const existing = this.store.listKnowledgeMergeProposals(scope).filter(proposal => sameScope(proposal.scope, scope))
    let created = 0
    for (let leftIndex = 0; leftIndex < records.length && created < limit; leftIndex++) {
      const left = records[leftIndex]
      if (left === undefined) continue
      const leftTokens = new Set(tokens(left.statement))
      if (leftTokens.size < 2) continue
      for (let rightIndex = leftIndex + 1; rightIndex < records.length && created < limit; rightIndex++) {
        const right = records[rightIndex]
        if (right === undefined || right.kind !== left.kind || sameScope(left.scope, right.scope) === false) continue
        if (normalize(left.statement) === normalize(right.statement)) continue
        const rightTokens = new Set(tokens(right.statement))
        if (rightTokens.size < 2) continue
        const sharedTerms = [...leftTokens].filter(token => rightTokens.has(token)).sort()
        const similarity = sharedTerms.length / new Set([...leftTokens, ...rightTokens]).size
        if (similarity < minSimilarity) continue
        const inputVersions = [
          { id: left.id, version: left.version },
          { id: right.id, version: right.version },
        ].sort((a, b) => a.id.localeCompare(b.id))
        const inputIds = inputVersions.map(item => item.id)
        const alreadyRecorded = existing.some(proposal => sameMergeInputs(proposal, inputIds, inputVersions))
        if (alreadyRecorded) continue
        const proposal: KnowledgeMergeProposal = {
          id: randomUUID(), scope, kind: left.kind, inputIds, inputVersions,
          similarity, sharedTerms,
          reason: `${Math.round(similarity * 100)}% Jaccard token overlap; shared terms: ${sharedTerms.join(', ')}. Similarity is a review hint, not a truth claim.`,
          status: 'PROPOSED', createdAt: now,
        }
        this.store.saveKnowledgeMergeProposal(proposal)
        existing.push(proposal)
        created++
      }
    }
    return this.store.listKnowledgeMergeProposals(scope)
      .filter(proposal => sameScope(proposal.scope, scope))
  }

  /** Accept a merge proposal as a new untrusted Candidate, preserving its inputs.
   * Input versions are checked again inside one SQLite write transaction; a
   * changed proposal is marked STALE and no merged Candidate is written.
   * @param proposalId Proposal identifier.
   * @param input Human-approved statement, content, and resolution rationale.
   * @returns The newly persisted Candidate; existing Knowledge remains unchanged.
   */
  acceptMergeProposal(proposalId: string, input: KnowledgeMergeApprovalInput): KnowledgeCandidate {
    const proposal = this.store.getKnowledgeMergeProposal(proposalId)
    if (proposal === undefined) throw new Error(`knowledge merge proposal ${proposalId} does not exist`)
    if (proposal.status !== 'PROPOSED') throw new Error(`knowledge merge proposal ${proposalId} is already ${proposal.status}`)
    const statement = requireText(input.statement, 'merged knowledge statement')
    const content = requireText(input.content ?? statement, 'merged knowledge content')
    const resolution = requireText(input.resolution, 'knowledge merge resolution')
    const sources = proposal.inputIds.map(id => this.store.getKnowledge(id))
    if (sources.some(item => item === undefined)) {
      this.store.resolveKnowledgeMergeProposal(proposalId, 'ACCEPTED', resolution)
      throw new Error(`knowledge merge proposal ${proposalId} is stale because an input no longer exists`)
    }
    const records = sources as KnowledgeCandidate[]
    if (records.some(item => !sameScope(item.scope, proposal.scope) || item.kind !== proposal.kind)) {
      throw new Error(`knowledge merge proposal ${proposalId} contains an out-of-scope or different-kind input`)
    }
    const evidenceIds = unique(records.flatMap(item => item.evidenceIds))
    validateMergeEvidence(this.store, proposal.scope, evidenceIds)
    const now = new Date().toISOString()
    const candidate: KnowledgeCandidate = {
      id: randomUUID(), scope: proposal.scope, kind: proposal.kind, statement, content,
      status: 'CANDIDATE', confidence: Math.min(0.7, records.reduce((sum, item) => sum + item.confidence, 0) / records.length),
      version: 1,
      sourceRefs: uniqueSourceReferences([
        ...records.flatMap(item => item.sourceRefs),
        { sourceType: 'system', sourceId: `knowledge-merge:${proposal.id}`, note: proposal.reason },
        { sourceType: 'human', sourceId: `knowledge-merge-review:${proposal.id}`, note: resolution },
      ]),
      evidenceIds,
      relatedMemoryIds: unique(records.flatMap(item => item.relatedMemoryIds)),
      ...(() => {
        const expiresAt = earliestTimestamp(records.map(item => item.expiresAt))
        return expiresAt === undefined ? {} : { expiresAt }
      })(),
      createdAt: now, updatedAt: now,
    }
    const resolved = this.store.resolveKnowledgeMergeProposal(proposalId, 'ACCEPTED', resolution, candidate)
    if (resolved.status === 'STALE') throw new Error(`knowledge merge proposal ${proposalId} became stale before acceptance`)
    return candidate
  }

  /** Reject a merge proposal while retaining the reviewer rationale.
   * @param proposalId Proposal identifier.
   * @param resolution Reason the candidate records must remain separate.
   * @returns The persisted REJECTED proposal.
   */
  rejectMergeProposal(proposalId: string, resolution: string): KnowledgeMergeProposal {
    const rationale = requireText(resolution, 'knowledge merge rejection')
    return this.store.resolveKnowledgeMergeProposal(proposalId, 'REJECTED', rationale)
  }

  /** Promote a candidate only after scoped Evidence and fresh regressions pass.
   * @param id Candidate identifier.
   * @param evidenceIds Additional Evidence identifiers to bind to the candidate.
   * @param regressionCaseId Passing regression case identifier.
   * @returns The established knowledge record.
   */
  promote(id: string, evidenceIds: readonly string[], regressionCaseId: string): KnowledgeCandidate {
    const current = this.store.getKnowledge(id)
    if (current === undefined) throw new Error(`knowledge candidate ${id} does not exist`)
    if (current.status !== 'CANDIDATE' && current.status !== 'OBSERVED') throw new Error(`knowledge candidate ${id} is not promotable from ${current.status}`)
    if (current.expiresAt !== undefined && current.expiresAt <= new Date().toISOString()) throw new Error(`knowledge candidate ${id} has expired`)
    const evidence = unique([...current.evidenceIds, ...evidenceIds])
    validateEvidence(this.store, current.scope, evidence)
    if (regressionCaseId === undefined || regressionCaseId.trim() === '') throw new Error('knowledge promotion requires a regression case id')
    const regressionCase = this.store.getRegressionCase(regressionCaseId)
    if (regressionCase === undefined) throw new Error(`knowledge regression case ${regressionCaseId} does not exist`)
    if (!sameScope(regressionCase.scope, current.scope)) throw new Error(`knowledge regression case ${regressionCaseId} is outside the candidate scope`)
    const result = this.store.listRegressionResults(regressionCaseId)[0]
    if (result?.status !== 'PASS') throw new Error(`knowledge promotion requires a PASS regression result for ${regressionCaseId}`)
    if (!sameKnowledgeVersions(result.testedKnowledgeVersions, this.list(current.scope))) {
      throw new Error(`knowledge regression result ${result.id} is stale for the current scope state`)
    }
    const suite = this.store.listRegressionSuites(current.scope)[0]
    if (suite?.status !== 'PASS') throw new Error('knowledge promotion requires a PASS regression suite for the candidate scope')
    const applicableCaseIds = this.store.listRegressionCases(current.scope).map(testCase => testCase.id)
    if (
      !sameScope(suite.scope, current.scope) ||
      !sameIds(suite.caseIds, applicableCaseIds) ||
      !sameKnowledgeVersions(suite.testedKnowledgeVersions, this.list(current.scope))
    ) {
      throw new Error(`knowledge regression suite ${suite.id} is stale for the current scope state`)
    }
    const promoted: KnowledgeCandidate = { ...current, status: 'ESTABLISHED', confidence: Math.max(current.confidence, 0.85), evidenceIds: evidence, version: current.version + 1, lastValidatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    this.store.saveKnowledge(promoted)
    return promoted
  }

  /** Record an observed use and adjust confidence based on its outcome.
   * @param id Knowledge identifier.
   * @param outcome Whether the use succeeded or failed.
   * @returns The updated knowledge record.
   */
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

  /** Attach passing, in-scope Evidence and record a new validation version.
   * @param id Knowledge identifier.
   * @param evidenceIds Evidence identifiers to validate and attach.
   * @returns The updated knowledge record.
   */
  validate(id: string, evidenceIds: readonly string[]): KnowledgeCandidate {
    const current = this.store.getKnowledge(id)
    if (current === undefined) throw new Error(`knowledge candidate ${id} does not exist`)
    const evidence = unique([...current.evidenceIds, ...evidenceIds])
    validateEvidence(this.store, current.scope, evidence)
    const next: KnowledgeCandidate = {
      ...current,
      evidenceIds: evidence,
      lastValidatedAt: new Date().toISOString(),
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    }
    this.store.saveKnowledge(next)
    return next
  }

  /** Deprecate all expired knowledge in an exact normalized scope.
   * @param scopeInput Scope to sweep.
   * @param now Clock value used to determine expiration.
   * @returns Identifiers of records deprecated by this sweep.
   */
  expire(scopeInput: ScopeRef, now: string = new Date().toISOString()): readonly string[] {
    const scope = normalizeScope(scopeInput)
    const expired = this.store.listKnowledge(scope).filter(item => sameScope(item.scope, scope) && item.expiresAt !== undefined && item.expiresAt <= now && item.status !== 'DEPRECATED')
    for (const item of expired) this.deprecate(item.id, `knowledge expired at ${item.expiresAt}`)
    return expired.map(item => item.id)
  }

  /** Mark a record deprecated while preserving the reason as a source reference.
   * @param id Knowledge identifier.
   * @param reason Optional reason for the lifecycle transition.
   * @returns The deprecated record.
   */
  deprecate(id: string, reason?: string): KnowledgeCandidate {
    const current = this.store.getKnowledge(id)
    if (current === undefined) throw new Error(`knowledge candidate ${id} does not exist`)
    const sourceRefs: SourceReference[] = reason === undefined ? [...current.sourceRefs] : [...current.sourceRefs, { sourceType: 'system', sourceId: `deprecate:${randomUUID()}`, note: reason }]
    const deprecated: KnowledgeCandidate = { ...current, status: 'DEPRECATED', sourceRefs, version: current.version + 1, updatedAt: new Date().toISOString() }
    this.store.saveKnowledge(deprecated)
    return deprecated
  }

  /** Merge exact same-scope duplicates and retain a guarded restoration snapshot.
   * @param scopeInput Exact scope to compact.
   * @returns Durable report describing compaction inputs, outputs, and actions.
   */
  compact(scopeInput: ScopeRef): KnowledgeCompactionReport {
    const scope = normalizeScope(scopeInput)
    return this.store.withTransaction(() => this.compactScope(scope))
  }

  private compactScope(scope: ScopeRef): KnowledgeCompactionReport {
    const values = [...this.store.listKnowledge(scope)].filter(item => sameScope(item.scope, scope) && item.status !== 'DEPRECATED')
    const groups = new Map<string, KnowledgeCandidate[]>()
    for (const item of values) {
      const key = `${scopeIdentity(item.scope)}:${item.kind}:${normalize(item.statement)}`
      const group = groups.get(key) ?? []
      group.push(item)
      groups.set(key, group)
    }
    const actions: KnowledgeCompactionReport['actions'][number][] = []
    const snapshots: KnowledgeCandidate[] = []
    const resultingVersions: { id: string; version: number }[] = []
    const inputIds = values.map(item => item.id)
    const outputIds: string[] = []
    for (const group of groups.values()) {
      group.sort((a, b) => Number(b.status === 'ESTABLISHED') - Number(a.status === 'ESTABLISHED') || b.confidence - a.confidence || a.createdAt.localeCompare(b.createdAt))
      const primary = group[0]
      if (primary === undefined) continue
      outputIds.push(primary.id)
      if (group.length === 1) {
        actions.push({ kind: 'retained', inputIds: [primary.id], outputId: primary.id, reason: 'No exact same-scope duplicate was found; record was left unchanged.' })
        continue
      }
      snapshots.push(...group)
      const mergedEvidence = unique(group.flatMap(item => item.evidenceIds))
      const mergedSourceRefs = group.flatMap(item => item.sourceRefs)
      const now = new Date().toISOString()
      const expiry = earliestTimestamp(group.map(item => item.expiresAt))
      const lastUsedAt = latestTimestamp(group.map(item => item.lastUsedAt))
      const lastValidatedAt = latestTimestamp(group.map(item => item.lastValidatedAt))
      const usageCount = sumDefined(group.map(item => item.usageCount))
      const successCount = sumDefined(group.map(item => item.successCount))
      const failureCount = sumDefined(group.map(item => item.failureCount))
      const merged: KnowledgeCandidate = {
        ...primary,
        evidenceIds: mergedEvidence,
        sourceRefs: mergedSourceRefs,
        relatedMemoryIds: unique(group.flatMap(item => item.relatedMemoryIds)),
        ...(usageCount === undefined ? {} : { usageCount }),
        ...(successCount === undefined ? {} : { successCount }),
        ...(failureCount === undefined ? {} : { failureCount }),
        ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
        ...(lastValidatedAt === undefined ? {} : { lastValidatedAt }),
        ...(expiry === undefined ? {} : { expiresAt: expiry }),
        version: primary.version + 1,
        updatedAt: now,
      }
      this.store.saveKnowledge(merged)
      resultingVersions.push({ id: merged.id, version: merged.version })
      const duplicates = group.slice(1)
      for (const duplicate of duplicates) {
        const deprecated = { ...duplicate, status: 'DEPRECATED' as const, version: duplicate.version + 1, updatedAt: now }
        this.store.saveKnowledge(deprecated)
        resultingVersions.push({ id: deprecated.id, version: deprecated.version })
      }
      actions.push({ kind: 'merged', inputIds: group.map(item => item.id), outputId: primary.id, reason: 'Exact normalized statement and kind matched within the same scope; evidence, source references, related memories and usage counters were combined.' })
      actions.push(...duplicates.map(item => ({ kind: 'deprecated' as const, inputIds: [item.id], outputId: primary.id, reason: 'Duplicate remains stored as deprecated; its pre-compaction version is included for guarded restoration.' })))
    }
    const report: KnowledgeCompactionReport = {
      id: randomUUID(),
      scope,
      inputIds,
      outputIds,
      actions,
      snapshots,
      resultingVersions,
      createdAt: new Date().toISOString(),
    }
    this.store.saveCompaction(report)
    return report
  }

  /** Restore a compaction only if its recorded post-compaction versions are unchanged.
   * @param reportId Compaction report identifier.
   * @returns Identifiers of restored records.
   */
  restoreCompaction(reportId: string): readonly string[] {
    const report = this.store.getCompaction(reportId)
    if (report === undefined) throw new Error(`knowledge compaction report ${reportId} does not exist`)
    return this.store.restoreKnowledgeCompaction(reportId, current => validateCompactionReport(current), new Date().toISOString())
  }

  /** Create a retrieval regression case for one scope.
   * @param input Case name, scope, query, and expected or forbidden statements.
   * @returns The persisted regression case.
   */
  createRegressionCase(input: {
    readonly scope: ScopeRef
    readonly name: string
    readonly query: string
    readonly expectedStatements: readonly string[]
    readonly forbiddenStatements?: readonly string[]
  }): KnowledgeRegressionCase {
    const testCase: KnowledgeRegressionCase = {
      id: randomUUID(),
      scope: normalizeScope(input.scope),
      name: requireText(input.name, 'regression case name'),
      input: requireText(input.query, 'regression input'),
      expectedStatements: unique(input.expectedStatements),
      ...(input.forbiddenStatements === undefined ? {} : { forbiddenStatements: unique(input.forbiddenStatements) }),
      createdAt: new Date().toISOString(),
    }
    this.store.saveRegressionCase(testCase)
    return testCase
  }

  /** Run one retrieval regression against the current scoped knowledge version set.
   * @param caseId Regression case identifier.
   * @returns A persisted PASS, FAIL, or UNKNOWN result.
   */
  runRegression(caseId: string): KnowledgeRegressionResult {
    const testCase = this.store.getRegressionCase(caseId)
    if (testCase === undefined) throw new Error(`knowledge regression case ${caseId} does not exist`)
    const active = this.list(testCase.scope)
    const retrieved = this.search(testCase.scope, testCase.input)
    const matched = testCase.expectedStatements.filter(expected => retrieved.some(
      item => normalize(item.statement) === normalize(expected) || normalize(item.content).includes(normalize(expected)),
    ))
    const missing = testCase.expectedStatements.filter(expected => !matched.includes(expected))
    const unexpected = (testCase.forbiddenStatements ?? []).filter(forbidden => retrieved.some(
      item => normalize(item.statement) === normalize(forbidden) || normalize(item.content).includes(normalize(forbidden)),
    ))
    const status = active.length === 0 ? 'UNKNOWN' : missing.length === 0 && unexpected.length === 0 ? 'PASS' : 'FAIL'
    const result: KnowledgeRegressionResult = {
      id: randomUUID(), caseId, status, matched, missing, unexpected,
      testedKnowledgeVersions: active.map(item => ({ id: item.id, version: item.version })),
      createdAt: new Date().toISOString(),
    }
    this.store.saveRegressionResult(result)
    return result
  }

  /** Run and persist all regression cases currently registered for a scope.
   * @param scopeInput Scope whose cases and knowledge are tested.
   * @returns The aggregate suite result and tested knowledge versions.
   */
  runRegressionSuite(scopeInput: ScopeRef): KnowledgeRegressionSuite {
    const scope = normalizeScope(scopeInput)
    const cases = this.store.listRegressionCases(scope)
    const results = cases.map(testCase => this.runRegression(testCase.id))
    const status = cases.length === 0 ? 'UNKNOWN' : results.some(result => result.status === 'FAIL') ? 'FAIL' : results.some(result => result.status === 'UNKNOWN') ? 'UNKNOWN' : 'PASS'
    const suite: KnowledgeRegressionSuite = {
      id: randomUUID(), scope, status, caseIds: cases.map(testCase => testCase.id), resultIds: results.map(result => result.id),
      testedKnowledgeVersions: this.list(scope).map(item => ({ id: item.id, version: item.version })),
      createdAt: new Date().toISOString(),
    }
    this.store.saveRegressionSuite(suite)
    return suite
  }
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`)
  return value.trim()
}

function validateEvidence(store: AutoDevStore, scope: ScopeRef, evidenceIds: readonly string[]): readonly Evidence[] {
  if (evidenceIds.length === 0) throw new Error('knowledge validation requires at least one Evidence id')
  return evidenceIds.map((id) => {
    const evidence = store.getEvidence(id)
    if (evidence === undefined) throw new Error(`Evidence ${id} does not exist`)
    if (evidence.status !== 'PASS') throw new Error(`Evidence ${id} is ${evidence.status}, not PASS`)
    if (evidence.source === 'agent') throw new Error(`Evidence ${id} is an untrusted Agent report`)
    if (evidence.expiresAt !== undefined && evidence.expiresAt <= new Date().toISOString()) throw new Error(`Evidence ${id} has expired`)
    const run = store.getRun(evidence.runId)
    if (run === undefined) throw new Error(`Evidence ${id} references missing Run ${evidence.runId}`)
    const evidenceScope = run.scope ?? { projectKey: run.projectKey ?? run.repoRoot }
    if (!sameScope(scope, evidenceScope)) throw new Error(`Evidence ${id} is outside the candidate scope`)
    return evidence
  })
}

function sameKnowledgeVersions(
  tested: KnowledgeRegressionResult['testedKnowledgeVersions'],
  current: readonly KnowledgeCandidate[],
): boolean {
  if (tested === undefined) return false
  const keys = (items: readonly { readonly id: string; readonly version: number }[]) => items
    .map(item => `${item.id}:${item.version}`)
    .sort()
  return JSON.stringify(keys(tested)) === JSON.stringify(keys(current))
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function validateCompactionReport(report: KnowledgeCompactionReport): void {
  const inputIds = new Set(report.inputIds)
  const snapshotIds = report.snapshots.map(item => item.id)
  const versionIds = report.resultingVersions.map(item => item.id)
  if (inputIds.size !== report.inputIds.length
    || new Set(snapshotIds).size !== snapshotIds.length
    || new Set(versionIds).size !== versionIds.length
    || snapshotIds.some(id => !inputIds.has(id))) {
    throw new Error(`knowledge compaction report ${report.id} is inconsistent; snapshot identities do not match its inputs`)
  }
  if (snapshotIds.length !== versionIds.length || snapshotIds.some(id => !versionIds.includes(id))) {
    throw new Error(`knowledge compaction report ${report.id} is inconsistent; resulting versions do not cover its snapshots`)
  }
  const versions = new Map(report.resultingVersions.map(item => [item.id, item.version]))
  for (const snapshot of report.snapshots) {
    if (!sameScope(report.scope, snapshot.scope) || versions.get(snapshot.id) !== snapshot.version + 1) {
      throw new Error(`knowledge compaction report ${report.id} is inconsistent for snapshot ${snapshot.id}`)
    }
  }
}

function sameMergeInputs(
  proposal: KnowledgeMergeProposal,
  inputIds: readonly string[],
  inputVersions: readonly { readonly id: string; readonly version: number }[],
): boolean {
  return JSON.stringify(proposal.inputIds) === JSON.stringify(inputIds)
    && JSON.stringify(proposal.inputVersions) === JSON.stringify(inputVersions)
}

function uniqueSourceReferences(references: readonly SourceReference[]): SourceReference[] {
  const seen = new Set<string>()
  return references.filter((reference) => {
    const key = JSON.stringify(reference)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function validateMergeEvidence(store: AutoDevStore, scope: ScopeRef, evidenceIds: readonly string[]): void {
  for (const id of evidenceIds) {
    const evidence = store.getEvidence(id)
    if (evidence === undefined) throw new Error(`knowledge merge references missing Evidence ${id}`)
    const run = store.getRun(evidence.runId)
    if (run === undefined) throw new Error(`knowledge merge Evidence ${id} references missing Run ${evidence.runId}`)
    const evidenceScope = run.scope ?? { projectKey: run.projectKey ?? run.repoRoot }
    if (!sameScope(scope, evidenceScope)) throw new Error(`knowledge merge Evidence ${id} is outside the proposal scope`)
  }
}

function sumDefined(values: readonly (number | undefined)[]): number | undefined {
  return values.some(value => value !== undefined) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : undefined
}

function latestTimestamp(values: readonly (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => value !== undefined).sort().at(-1)
}

function earliestTimestamp(values: readonly (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => value !== undefined).sort()[0]
}

function knowledgeTemperature(item: KnowledgeCandidate, now: string): KnowledgeTemperature {
  const nowMs = Date.parse(now)
  const recentlyUsed =
    item.lastUsedAt !== undefined &&
    Number.isFinite(Date.parse(item.lastUsedAt)) &&
    nowMs - Date.parse(item.lastUsedAt) <= 30 * 24 * 60 * 60 * 1000
  const recentlyValidated =
    item.lastValidatedAt !== undefined &&
    Number.isFinite(Date.parse(item.lastValidatedAt)) &&
    nowMs - Date.parse(item.lastValidatedAt) <= 180 * 24 * 60 * 60 * 1000
  if (item.status === 'ESTABLISHED' && recentlyUsed && (item.successCount ?? 0) > (item.failureCount ?? 0)) return 'hot'
  if (item.status === 'ESTABLISHED' && recentlyValidated) return 'warm'
  return 'cold'
}

function temperatureRank(value: KnowledgeTemperature): number {
  return value === 'hot' ? 0 : value === 'warm' ? 1 : 2
}

function truncateKnowledge(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const marker = '… [truncated]'
  return maxChars <= marker.length ? value.slice(0, maxChars) : `${value.slice(0, maxChars - marker.length)}${marker}`
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) throw new TypeError('knowledge search limits must be finite')
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function clampDecimal(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) throw new TypeError('knowledge merge similarity must be finite')
  return Math.max(min, Math.min(max, value))
}
