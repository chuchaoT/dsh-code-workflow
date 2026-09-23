/** Business Concept registry: semantic identity before implementation detail. */

import { randomUUID } from 'node:crypto'
import type {
  BusinessConcept,
  ConceptObservation,
  ConceptStatus,
  ProvenanceRef,
  ScopeRef,
} from './contracts.ts'
import { AutoDevStore } from './store.ts'
import { confidence, normalizeScope, unique } from './semantics.ts'
import { normalize, tokens } from './memory.ts'

export interface ObserveConceptInput {
  readonly scope: ScopeRef
  readonly key: string
  readonly name: string
  readonly definition: string
  readonly target: string
  readonly effect: string
  readonly evidenceCriteria?: readonly string[]
  readonly evidenceSummary: string
  readonly evidenceIds?: readonly string[]
  readonly provenance?: readonly ProvenanceRef[]
  readonly confidence?: number
}

export interface ConceptMatchInput {
  readonly target: string
  readonly effect: string
  readonly evidence?: readonly string[]
}

export class BusinessConceptService {
  constructor(readonly store: AutoDevStore) {}

  observe(input: ObserveConceptInput): { readonly concept: BusinessConcept; readonly observation: ConceptObservation } {
    const scope = normalizeScope(input.scope)
    const existing = this.store.listConcepts(scope.projectKey).find(item => item.key === requireText(input.key, 'concept key') && item.status !== 'DEPRECATED')
    const now = new Date().toISOString()
    const observation: ConceptObservation = {
      id: randomUUID(),
      scope,
      ...(existing === undefined ? {} : { conceptId: existing.id }),
      key: requireText(input.key, 'concept key'),
      target: requireText(input.target, 'concept target'),
      effect: requireText(input.effect, 'concept effect'),
      evidenceSummary: requireText(input.evidenceSummary, 'concept evidence summary'),
      evidenceIds: unique(input.evidenceIds ?? []),
      provenance: [...(input.provenance ?? [])],
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
        provenance: [...(input.provenance ?? [])], evidenceIds: [...observation.evidenceIds], relatedConceptIds: [],
        createdAt: now, updatedAt: now,
      }
      : {
        ...existing,
        confidence: Math.max(existing.confidence, observation.confidence),
        provenance: [...existing.provenance, ...(input.provenance ?? [])],
        evidenceIds: unique([...existing.evidenceIds, ...observation.evidenceIds]),
        updatedAt: now,
      }
    this.store.saveConcept(concept)
    const linkedObservation = existing === undefined ? { ...observation, conceptId: concept.id } : observation
    this.store.saveConceptObservation(linkedObservation)
    return { concept, observation: linkedObservation }
  }

  correct(input: ObserveConceptInput & { readonly resolution?: string }): BusinessConcept {
    const scope = normalizeScope(input.scope)
    const key = requireText(input.key, 'concept key')
    const existing = this.store.listConcepts(scope.projectKey).find(item => item.key === key && item.status !== 'DEPRECATED')
    const now = new Date().toISOString()
    const human: ProvenanceRef = { sourceType: 'human', sourceId: `human:${randomUUID()}`, ...(input.resolution === undefined ? {} : { note: input.resolution }) }
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
      provenance: [...(existing?.provenance ?? []), ...(input.provenance ?? []), human],
      evidenceIds: unique([...(existing?.evidenceIds ?? []), ...(input.evidenceIds ?? [])]),
      relatedConceptIds: existing?.relatedConceptIds ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    this.store.saveConcept(concept)
    return concept
  }

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

  search(projectKey: string, query: string): readonly BusinessConcept[] {
    const queryTokens = tokens(query)
    return this.store.listConcepts(projectKey)
      .filter(item => item.status !== 'DEPRECATED')
      .map(item => ({ item, score: tokens(`${item.key} ${item.name} ${item.definition} ${item.target} ${item.effect}`).filter(token => queryTokens.includes(token)).length }))
      .filter(item => item.score > 0 || normalize(query) === normalize(item.item.key))
      .sort((a, b) => b.score - a.score || b.item.confidence - a.item.confidence)
      .map(item => item.item)
  }

  match(scope: ScopeRef, input: ConceptMatchInput): readonly BusinessConcept[] {
    const target = normalize(input.target)
    const effect = normalize(input.effect)
    const evidence = (input.evidence ?? []).map(normalize)
    return this.store.listConcepts(normalizeScope(scope).projectKey)
      .filter(item => item.status !== 'DEPRECATED')
      .map((item) => {
        const targetMatch = target.includes(normalize(item.target)) || normalize(item.target).includes(target)
        const effectMatch = effect.includes(normalize(item.effect)) || normalize(item.effect).includes(effect)
        const evidenceMatch = item.evidenceCriteria.length === 0 || item.evidenceCriteria.every(
          criteria => evidence.some(value => value.includes(normalize(criteria))),
        )
        return { item, score: Number(targetMatch) + Number(effectMatch) + Number(evidenceMatch) }
      })
      .filter(item => item.score >= 2)
      .sort((a, b) => b.score - a.score || b.item.confidence - a.item.confidence)
      .map(item => item.item)
  }
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`)
  return value.trim()
}
