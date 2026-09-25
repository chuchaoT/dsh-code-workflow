/** Versioned, advisory Playbook registry and fit evaluation. */

import { randomUUID } from 'node:crypto'
import type {
  EvidenceType,
  Playbook,
  PlaybookFit,
  SourceReference,
  ScopeRef,
} from './contracts.ts'
import { AutoDevStore } from './store.ts'
import { normalizeScope, confidence, unique } from './semantics.ts'
import { normalize, tokens } from './memory.ts'
import { scopeApplies, scopeSpecificity, type ScopeQuery } from './scope.ts'

/** Content and evidence references used to create a versioned Playbook. */
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
  readonly sourceRefs?: readonly SourceReference[]
  readonly supportingEvidenceIds?: readonly string[]
  readonly createdFromRunIds?: readonly string[]
}

/** Run context evaluated against one Playbook's scope and applicability rules. */
export interface PlaybookFitInput {
  readonly scope?: ScopeRef
  readonly target: string
  readonly effect: string
  readonly conceptKeys?: readonly string[]
  readonly evidenceTypes?: readonly EvidenceType[]
}

/** Creates immutable Playbook versions and evaluates advisory fit for Plans. */
export class PlaybookService {
  constructor(readonly store: AutoDevStore) {}

  /** Create a draft Playbook with a normalized scope and retained source references.
   * @param input - Playbook content, requirements, and source records.
   * @returns The persisted draft Playbook.
   */
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
      sourceRefs: [...(input.sourceRefs ?? [])],
      ...(input.supportingEvidenceIds === undefined ? {} : { supportingEvidenceIds: unique(input.supportingEvidenceIds) }),
      ...(input.createdFromRunIds === undefined ? {} : { createdFromRunIds: unique(input.createdFromRunIds) }),
      createdAt: now, updatedAt: now,
    }
    this.store.savePlaybook(playbook)
    return playbook
  }

  /** Mark a Playbook version active for future matching.
   * @param id - Playbook version identity.
   * @returns The persisted active version.
   */
  activate(id: string): Playbook {
    const playbook = this.require(id)
    const next: Playbook = { ...playbook, status: 'ACTIVE', updatedAt: new Date().toISOString() }
    this.store.savePlaybook(next)
    return next
  }

  /** Deprecate a Playbook without removing its historical record.
   * @param id - Playbook version identity.
   * @returns The persisted deprecated version.
   */
  deprecate(id: string): Playbook {
    const playbook = this.require(id)
    const next: Playbook = { ...playbook, status: 'DEPRECATED', updatedAt: new Date().toISOString() }
    this.store.savePlaybook(next)
    return next
  }

  /** Create a new immutable content version and retain the prior version.
   * @param id - Prior version whose lineage is continued.
   * @param input - New Playbook content and any additional source references.
   * @returns The new version linked to its predecessor.
   */
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

  /** List non-deprecated Playbooks applicable to an optional scope.
   * @param scope - Optional project/version filter.
   * @returns Matching Playbook records.
   */
  list(scope?: ScopeQuery): readonly Playbook[] {
    return this.store.listPlaybooks(scope).filter(item => item.status !== 'DEPRECATED')
  }

  /** Rank applicable Playbooks by textual overlap with their purpose and targets.
   * @param scope - Optional project/version filter.
   * @param query - Natural-language task description to match.
   * @returns Matching Playbooks ordered by score and scope specificity.
   */
  search(scope: ScopeQuery | undefined, query: string): readonly Playbook[] {
    const queryTokens = tokens(query)
    return this.list(scope)
      .map(item => ({ item, score: tokens(`${item.key} ${item.name} ${item.purpose} ${item.targets.join(' ')} ${item.effects.join(' ')}`).filter(token => queryTokens.includes(token)).length }))
      .filter(item => item.score > 0)
      .sort((a, b) =>
        b.score - a.score ||
        scopeSpecificity(b.item.scope) - scopeSpecificity(a.item.scope) ||
        b.item.confidence - a.item.confidence,
      )
      .map(item => item.item)
  }

  /** Persist a Match/Partial/Mismatch decision for one Run's task context.
   * @param playbookId - Playbook version evaluated.
   * @param input - Scope, target, effect, concepts, and available Evidence types.
   * @param runId - Optional Run identity to attach to the fit record.
   * @returns A persisted fit result with matched and missing criteria.
   */
  fit(playbookId: string, input: PlaybookFitInput, runId?: string): PlaybookFit {
    const playbook = this.require(playbookId)
    const targetInput = requireText(input.target, 'playbook fit target')
    const effectInput = requireText(input.effect, 'playbook fit effect')
    const matched: string[] = []
    const missing: string[] = []
    const scopeMatches = input.scope === undefined ? playbook.scope === undefined : scopeApplies(input.scope, playbook.scope)
    if (!scopeMatches) missing.push('scope')
    const context = normalize(`${targetInput} ${effectInput} ${(input.conceptKeys ?? []).join(' ')}`)
    const excluded = (playbook.exclusions ?? []).filter(value => context.includes(normalize(value)))
    if (excluded.length > 0) missing.push(...excluded.map(value => `excluded:${value}`))
    const target = normalize(targetInput)
    const effect = normalize(effectInput)
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
    const conceptMatches = playbook.conceptKeys.length === 0 || playbook.conceptKeys.some(key => requestedConcepts.has(key))
    const semanticMismatch = !scopeMatches || excluded.length > 0 || !targetMatch || !effectMatch || !conceptMatches
    const outcome = semanticMismatch ? 'MISMATCH' : missingEvidence.length > 0 ? 'PARTIAL' : 'MATCH'
    const fit: PlaybookFit = {
      id: randomUUID(), ...(runId === undefined ? {} : { runId }), playbookId, playbookVersion: playbook.version,
      outcome, matched, missing,
      reasons: outcome === 'MATCH' ? ['playbook target/effect and required context fit'] : excluded.length > 0 ? [`excluded context: ${excluded.join(', ')}`] : [`missing: ${missing.join(', ') || 'none'}`],
      createdAt: new Date().toISOString(),
    }
    this.store.savePlaybookFit(fit)
    return fit
  }

  /** Read a Playbook version or fail when the requested identity is absent.
   * @param id - Playbook version identity.
   * @returns The requested Playbook.
   * @throws Error when the identifier is not present in the Store.
   */
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
