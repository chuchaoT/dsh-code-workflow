/** Business Concept registry: semantic identity before implementation detail. */

import { randomUUID } from 'node:crypto'
import type {
  BusinessConcept,
  ConceptObservation,
  ConceptStatus,
  SourceReference,
  ScopeRef,
} from './contracts.ts'
import { AutoDevStore } from './store.ts'
import { confidence, normalizeScope, unique } from './semantics.ts'
import { normalize, tokens } from './memory.ts'
import { sameScope, scopeSpecificity, type ScopeQuery } from './scope.ts'

/** Agent observation or human correction used to version a project Concept. */
export interface ObserveConceptInput {
  readonly scope: ScopeRef
  readonly runId?: string
  readonly planId?: string
  readonly key: string
  readonly name: string
  readonly definition: string
  readonly target: string
  readonly effect: string
  readonly evidenceCriteria?: readonly string[]
  readonly evidenceSummary: string
  readonly evidenceIds?: readonly string[]
  readonly sourceRefs?: readonly SourceReference[]
  readonly confidence?: number
}

/** Semantic target, effect, and optional Evidence context for Concept matching. */
export interface ConceptMatchInput {
  readonly target: string
  readonly effect: string
  readonly evidence?: readonly string[]
}

/** Stores scoped Business Concepts and keeps observations and corrections auditable. */
export class BusinessConceptService {
  constructor(readonly store: AutoDevStore) {}

  /** Record an observation, preserving semantic conflicts as ambiguity.
   * @param input - Scoped Concept content and its supporting source references.
   * @returns The current Concept and the immutable observation event.
   */
  observe(input: ObserveConceptInput): { readonly concept: BusinessConcept; readonly observation: ConceptObservation } {
    const scope = normalizeScope(input.scope)
    const evidenceIds = unique(input.evidenceIds ?? [])
    validateConceptEvidence(this.store, scope, evidenceIds)
    const existing = this.store.listConcepts(scope).find(item => sameScope(item.scope, scope) && item.key === requireText(input.key, 'concept key') && item.status !== 'DEPRECATED')
    const key = requireText(input.key, 'concept key')
    const observations = this.store.listConceptObservations(scope).filter(item => item.key === key && sameScope(item.scope, scope))
    const observationVersion = Math.max(0, ...observations.map(item => item.version ?? 0)) + 1
    const now = new Date().toISOString()
    const supportsExisting = existing !== undefined
      && normalize(existing.target) === normalize(input.target)
      && normalize(existing.effect) === normalize(input.effect)
    const relationship = existing === undefined || supportsExisting ? 'SUPPORTING' : 'AMBIGUOUS'
    const observation: ConceptObservation = {
      id: randomUUID(),
      scope,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.planId === undefined ? {} : { planId: input.planId }),
      ...(existing === undefined ? {} : { conceptId: existing.id }),
      version: observationVersion,
      name: requireText(input.name, 'concept name'),
      definition: requireText(input.definition, 'concept definition'),
      key: requireText(input.key, 'concept key'),
      target: requireText(input.target, 'concept target'),
      effect: requireText(input.effect, 'concept effect'),
      relationship,
      evidenceSummary: requireText(input.evidenceSummary, 'concept evidence summary'),
      evidenceIds,
      sourceRefs: [...(input.sourceRefs ?? [])],
      confidence: confidence(input.confidence),
      createdAt: now,
    }
    const concept: BusinessConcept = existing === undefined
      ? {
        id: randomUUID(), scope, key: observation.key,
        name: requireText(input.name, 'concept name'), definition: requireText(input.definition, 'concept definition'),
        target: observation.target, effect: observation.effect,
        evidenceCriteria: unique(input.evidenceCriteria ?? []), status: 'CANDIDATE',
        confidence: observation.confidence, version: 1,
        sourceRefs: [...(input.sourceRefs ?? [])], evidenceIds: [...observation.evidenceIds], relatedConceptIds: [],
        createdAt: now, updatedAt: now,
      }
      : !supportsExisting ? existing : {
        ...existing,
        confidence: Math.max(existing.confidence, observation.confidence),
        sourceRefs: [...existing.sourceRefs, ...(input.sourceRefs ?? [])],
        evidenceIds: unique([...existing.evidenceIds, ...observation.evidenceIds]),
        updatedAt: now,
      }
    this.store.saveConcept(concept)
    const linkedObservation = existing === undefined ? { ...observation, conceptId: concept.id } : observation
    this.store.saveConceptObservation(linkedObservation)
    return { concept, observation: linkedObservation }
  }

  /** Apply an explicit human correction while retaining the prior observation history.
   * @param input - Corrected Concept content, Evidence, and resolution rationale.
   * @returns The established, newly versioned Concept.
   */
  correct(input: ObserveConceptInput & { readonly resolution?: string }): BusinessConcept {
    const scope = normalizeScope(input.scope)
    const evidenceIds = unique(input.evidenceIds ?? [])
    validateConceptEvidence(this.store, scope, evidenceIds)
    const key = requireText(input.key, 'concept key')
    const observations = this.store.listConceptObservations(scope).filter(item => item.key === key && sameScope(item.scope, scope))
    const observationVersion = Math.max(0, ...observations.map(item => item.version ?? 0)) + 1
    const existing = this.store.listConcepts(scope).find(item => sameScope(item.scope, scope) && item.key === key && item.status !== 'DEPRECATED')
    const now = new Date().toISOString()
    const human: SourceReference = { sourceType: 'human', sourceId: `human:${randomUUID()}`, ...(input.resolution === undefined ? {} : { note: input.resolution }) }
    const concept: BusinessConcept = {
      id: existing?.id ?? randomUUID(),
      scope,
      key,
      name: requireText(input.name, 'concept name'),
      definition: requireText(input.definition, 'concept definition'),
      target: requireText(input.target, 'concept target'),
      effect: requireText(input.effect, 'concept effect'),
      evidenceCriteria: unique(input.evidenceCriteria ?? existing?.evidenceCriteria ?? []),
      status: 'ESTABLISHED',
      confidence: 1,
      version: (existing?.version ?? 0) + 1,
      sourceRefs: [...(existing?.sourceRefs ?? []), ...(input.sourceRefs ?? []), human],
      evidenceIds: unique([...(existing?.evidenceIds ?? []), ...evidenceIds]),
      relatedConceptIds: existing?.relatedConceptIds ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.store.saveConcept(concept)
    this.store.saveConceptObservation({
      id: randomUUID(), scope, conceptId: concept.id,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.planId === undefined ? {} : { planId: input.planId }),
      name: concept.name, definition: concept.definition, key, target: concept.target, effect: concept.effect,
      relationship: 'HUMAN_CORRECTION', version: observationVersion, evidenceSummary: requireText(input.evidenceSummary, 'concept evidence summary'),
      evidenceIds, sourceRefs: [...(input.sourceRefs ?? []), human], confidence: 1,
      createdAt: now,
    })
    return concept
  }

  /** Change a Concept lifecycle status and append any supporting Evidence references.
   * @param id - Concept identity to update.
   * @param status - New lifecycle status.
   * @param evidenceIds - Additional Evidence IDs retained on the Concept.
   * @returns The persisted Concept version.
   */
  setStatus(id: string, status: ConceptStatus, evidenceIds: readonly string[] = []): BusinessConcept {
    const current = this.store.getConcept(id)
    if (current === undefined) throw new Error(`business concept ${id} does not exist`)
    const next: BusinessConcept = {
      ...current,
      status,
      confidence: status === 'ESTABLISHED' ? Math.max(current.confidence, 0.8) : current.confidence,
      evidenceIds: unique([...current.evidenceIds, ...evidenceIds]),
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    }
    this.store.saveConcept(next)
    return next
  }

  /** Search Concepts applicable to a project scope using semantic text overlap.
   * @param scope - Project and optional version dimensions to match.
   * @param query - Natural-language target or effect terms.
   * @returns Non-deprecated Concepts ordered by match, scope specificity, and confidence.
   */
  search(scope: ScopeQuery, query: string): readonly BusinessConcept[] {
    const queryTokens = tokens(query)
    return this.store.listConcepts(scope)
      .filter(item => item.status !== 'DEPRECATED')
      .map(item => ({ item, score: tokens(`${item.key} ${item.name} ${item.definition} ${item.target} ${item.effect}`).filter(token => queryTokens.includes(token)).length }))
      .filter(item => item.score > 0 || normalize(query) === normalize(item.item.key))
      .sort((a, b) =>
        b.score - a.score ||
        scopeSpecificity(b.item.scope) - scopeSpecificity(a.item.scope) ||
        b.item.confidence - a.item.confidence,
      )
      .map(item => item.item)
  }

  /** Find unresolved conflicting observations relevant to a query.
   * @param scope - Project scope used to restrict observations.
   * @param query - Concept-key terms to match.
   * @returns Ambiguous observations not followed by a human correction.
   */
  unresolvedAmbiguities(scope: ScopeQuery, query: string): readonly ConceptObservation[] {
    const queryTokens = tokens(query)
    if (queryTokens.length === 0) return []
    const observations = this.store.listConceptObservations(scope)
    return observations.filter((item) => {
      if (item.relationship !== 'AMBIGUOUS' || !tokens(item.key).some(token => queryTokens.includes(token))) return false
      const version = item.version ?? 0
      return !observations.some(later => later.key === item.key && sameScope(later.scope, item.scope)
        && (later.version ?? 0) > version && later.relationship === 'HUMAN_CORRECTION')
    })
  }

  /** Match established Concept meaning by target, effect, and required Evidence criteria.
   * @param scope - Exact project scope for candidate Concepts.
   * @param input - Target/effect text and optional Evidence summaries.
   * @returns Concepts whose target, effect, and Evidence requirements all fit.
   */
  match(scope: ScopeRef, input: ConceptMatchInput): readonly BusinessConcept[] {
    const target = normalize(input.target)
    const effect = normalize(input.effect)
    const evidence = (input.evidence ?? []).map(normalize)
    return this.store.listConcepts(scope)
      .filter(item => item.status !== 'DEPRECATED')
      .map((item) => {
        const targetMatch = target.includes(normalize(item.target)) || normalize(item.target).includes(target)
        const effectMatch = effect.includes(normalize(item.effect)) || normalize(item.effect).includes(effect)
        const evidenceMatch = item.evidenceCriteria.length === 0 || item.evidenceCriteria.every(
          criteria => evidence.some(value => value.includes(normalize(criteria))),
        )
        const evidenceScore = item.evidenceCriteria.length === 0 ? 0 : Number(evidenceMatch)
        return { item, targetMatch, effectMatch, evidenceMatch, score: Number(targetMatch) + Number(effectMatch) + evidenceScore }
      })
      .filter(item => item.targetMatch && item.effectMatch && item.evidenceMatch)
      .sort((a, b) =>
        b.score - a.score ||
        scopeSpecificity(b.item.scope) - scopeSpecificity(a.item.scope) ||
        b.item.confidence - a.item.confidence,
      )
      .map(item => item.item)
  }
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`)
  return value.trim()
}

function validateConceptEvidence(store: AutoDevStore, scope: ScopeRef, evidenceIds: readonly string[]): void {
  for (const id of evidenceIds) {
    const evidence = store.getEvidence(id)
    if (evidence === undefined) throw new Error(`Evidence ${id} does not exist`)
    const run = store.getRun(evidence.runId)
    if (run === undefined) throw new Error(`Evidence ${id} references missing Run ${evidence.runId}`)
    const evidenceScope = run.scope ?? { projectKey: run.projectKey ?? run.repoRoot }
    if (!sameScope(scope, evidenceScope)) throw new Error(`Evidence ${id} is outside the concept scope`)
  }
}
