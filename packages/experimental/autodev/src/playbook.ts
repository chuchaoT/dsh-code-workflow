/** Versioned, advisory Playbook registry and fit evaluation. */

import { randomUUID } from 'node:crypto'
import type {
  EvidenceType,
  Playbook,
  PlaybookFit,
  ProvenanceRef,
  ScopeRef,
} from './contracts.ts'
import { AutoDevStore } from './store.ts'
import { normalizeScope, confidence, unique } from './semantics.ts'
import { normalize, tokens } from './memory.ts'

export interface PlaybookInput {
  readonly scope?: ScopeRef
  readonly key: string
  readonly name: string
  readonly purpose: string
  readonly targets: readonly string[]
  readonly effects: readonly string[]
  readonly conceptKeys?: readonly string[]
  readonly exclusions?: readonly string[]
  readonly steps: readonly string[]
  readonly requiredEvidence?: readonly EvidenceType[]
  readonly confidence?: number
  readonly provenance?: readonly ProvenanceRef[]
  readonly supportingEvidenceIds?: readonly string[]
  readonly createdFromRunIds?: readonly string[]
}

export interface PlaybookFitInput {
  readonly target: string
  readonly effect: string
  readonly conceptKeys?: readonly string[]
  readonly evidenceTypes?: readonly EvidenceType[]
}

export class PlaybookService {
  constructor(readonly store: AutoDevStore) {}

  create(input: PlaybookInput): Playbook {
    const now = new Date().toISOString()
    const playbook: Playbook = {
      id: randomUUID(),
      ...(input.scope === undefined ? {} : { scope: normalizeScope(input.scope) }),
      key: requireText(input.key, 'playbook key'), name: requireText(input.name, 'playbook name'),
      purpose: requireText(input.purpose, 'playbook purpose'),
      targets: requiredTextList(input.targets, 'playbook targets'),
      effects: requiredTextList(input.effects, 'playbook effects'),
      conceptKeys: unique(input.conceptKeys ?? []),
      ...(input.exclusions === undefined ? {} : { exclusions: unique(input.exclusions) }),
      steps: requiredTextList(input.steps, 'playbook steps'),
      requiredEvidence: [...(input.requiredEvidence ?? [])], status: 'DRAFT',
      confidence: confidence(input.confidence), version: 1,
      provenance: [...(input.provenance ?? [])],
      ...(input.supportingEvidenceIds === undefined ? {} : { supportingEvidenceIds: unique(input.supportingEvidenceIds) }),
      ...(input.createdFromRunIds === undefined ? {} : { createdFromRunIds: unique(input.createdFromRunIds) }),
      createdAt: now, updatedAt: now,
    }
    this.store.savePlaybook(playbook)
    return playbook
  }

  activate(id: string): Playbook {
    const playbook = this.require(id)
    const next: Playbook = { ...playbook, status: 'ACTIVE', updatedAt: new Date().toISOString() }
    this.store.savePlaybook(next)
    return next
  }

  deprecate(id: string): Playbook {
    const playbook = this.require(id)
    const next: Playbook = { ...playbook, status: 'DEPRECATED', updatedAt: new Date().toISOString() }
    this.store.savePlaybook(next)
    return next
  }

  /** Create a new immutable content version and retain the prior version. */
  revise(id: string, input: PlaybookInput): Playbook {
    const previous = this.require(id)
    const created = this.create({
      ...input,
      ...(input.scope === undefined && previous.scope === undefined ? {} : input.scope === undefined ? { scope: previous.scope } : {}),
      supportingEvidenceIds: unique([...(previous.supportingEvidenceIds ?? []), ...(input.supportingEvidenceIds ?? [])]),
      createdFromRunIds: unique([...(previous.createdFromRunIds ?? []), ...(input.createdFromRunIds ?? [])]),
    })
    const next: Playbook = {
      ...created,
      version: previous.version + 1,
      status: previous.status === 'ACTIVE' ? 'ACTIVE' : 'DRAFT',
      parentId: previous.id,
      updatedAt: new Date().toISOString(),
    }
    this.store.savePlaybook(next)
    this.store.savePlaybook({ ...previous, status: 'DEPRECATED', supersededBy: next.id, updatedAt: new Date().toISOString() })
    return next
  }

  list(projectKey?: string): readonly Playbook[] {
    return this.store.listPlaybooks(projectKey).filter(item => item.status !== 'DEPRECATED')
  }

  search(projectKey: string | undefined, query: string): readonly Playbook[] {
    const queryTokens = tokens(query)
    return this.list(projectKey)
      .map(item => ({ item, score: tokens(`${item.key} ${item.name} ${item.purpose} ${item.targets.join(' ')} ${item.effects.join(' ')}`).filter(token => queryTokens.includes(token)).length }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.item.confidence - a.item.confidence)
      .map(item => item.item)
  }

  fit(playbookId: string, input: PlaybookFitInput, runId?: string): PlaybookFit {
    const playbook = this.require(playbookId)
    const matched: string[] = []
    const missing: string[] = []
    const target = normalize(input.target)
    const effect = normalize(input.effect)
    const targetMatch = playbook.targets.some(value => target.includes(normalize(value)) || normalize(value).includes(target))
    const effectMatch = playbook.effects.some(value => effect.includes(normalize(value)) || normalize(value).includes(effect))
    if (targetMatch) matched.push('target')
    else missing.push('target')
    if (effectMatch) matched.push('effect')
    else missing.push('effect')
    const requestedConcepts = new Set(input.conceptKeys ?? [])
    if (playbook.conceptKeys.length > 0 && playbook.conceptKeys.some(key => requestedConcepts.has(key))) matched.push('concept')
    else if (playbook.conceptKeys.length > 0) missing.push('concept')
    const availableEvidence = new Set(input.evidenceTypes ?? [])
    const missingEvidence = playbook.requiredEvidence.filter(type => !availableEvidence.has(type))
    if (missingEvidence.length > 0) missing.push(...missingEvidence.map(type => `evidence:${type}`))
    else if (playbook.requiredEvidence.length > 0) matched.push('evidence')
    const required = 2 + (playbook.conceptKeys.length > 0 ? 1 : 0) + (playbook.requiredEvidence.length > 0 ? 1 : 0)
    const outcome = matched.length === required ? 'MATCH' : matched.length === 0 ? 'MISMATCH' : 'PARTIAL'
    const fit: PlaybookFit = {
      id: randomUUID(), ...(runId === undefined ? {} : { runId }), playbookId, playbookVersion: playbook.version,
      outcome, matched, missing, reasons: outcome === 'MATCH' ? ['playbook target/effect and required context fit'] : [`missing: ${missing.join(', ') || 'none'}`],
      createdAt: new Date().toISOString(),
    }
    this.store.savePlaybookFit(fit)
    return fit
  }

  require(id: string): Playbook {
    const playbook = this.store.getPlaybook(id)
    if (playbook === undefined) throw new Error(`playbook ${id} does not exist`)
    return playbook
  }
}

function requiredTextList(values: readonly string[], name: string): string[] {
  const result = values.map(item => item.trim()).filter(Boolean)
  if (result.length === 0) throw new TypeError(`${name} must contain at least one item`)
  return unique(result)
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`)
  return value.trim()
}
