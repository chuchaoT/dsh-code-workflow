/** Assumption and semantic-uncertainty lifecycle owned by the Host. */

import { randomUUID } from 'node:crypto'
import type {
  Assumption,
  AssumptionStatus,
  ProvenanceRef,
  ScopeRef,
  SemanticUncertainty,
  SemanticUncertaintyStatus,
} from './contracts.ts'
import { AutoDevStore } from './store.ts'

export interface RaiseAssumptionInput {
  readonly scope: ScopeRef
  readonly runId?: string
  readonly planId?: string
  readonly statement: string
  readonly rationale?: string
  readonly confidence?: number
  readonly provenance?: readonly ProvenanceRef[]
  readonly evidenceIds?: readonly string[]
}

export interface RaiseUncertaintyInput {
  readonly scope: ScopeRef
  readonly runId: string
  readonly subject: string
  readonly reason: string
  readonly alternatives?: readonly string[]
  readonly severity?: SemanticUncertainty['severity']
  readonly provenance?: readonly ProvenanceRef[]
}

/**
 * Semantic uncertainty is not a failure. It is an explicit state that may
 * block execution until a human or new evidence resolves the meaning.
 */
export class SemanticService {
  constructor(readonly store: AutoDevStore) {}

  raiseAssumption(input: RaiseAssumptionInput): Assumption {
    const now = new Date().toISOString()
    const assumption: Assumption = {
      id: randomUUID(),
      scope: normalizeScope(input.scope),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.planId === undefined ? {} : { planId: input.planId }),
      statement: requireText(input.statement, 'assumption statement'),
      ...(input.rationale === undefined ? {} : { rationale: input.rationale.trim() }),
      status: 'PROPOSED',
      confidence: confidence(input.confidence),
      provenance: [...(input.provenance ?? [])],
      evidenceIds: [...(input.evidenceIds ?? [])],
      createdAt: now,
      updatedAt: now,
    }
    this.store.saveAssumption(assumption)
    return assumption
  }

  resolveAssumption(id: string, status: Exclude<AssumptionStatus, 'PROPOSED'>, resolution: string, evidenceIds: readonly string[] = []): Assumption {
    const current = this.store.getAssumption(id)
    if (current === undefined) throw new Error(`assumption ${id} does not exist`)
    const next: Assumption = {
      ...current,
      status,
      resolution: requireText(resolution, 'assumption resolution'),
      evidenceIds: unique([...current.evidenceIds, ...evidenceIds]),
      confidence: status === 'CONFIRMED' ? Math.max(current.confidence, 0.9) : status === 'INVALIDATED' ? 1 : current.confidence,
      updatedAt: new Date().toISOString(),
    }
    this.store.saveAssumption(next)
    return next
  }

  raiseUncertainty(input: RaiseUncertaintyInput): SemanticUncertainty {
    const now = new Date().toISOString()
    const uncertainty: SemanticUncertainty = {
      id: randomUUID(),
      scope: normalizeScope(input.scope),
      runId: requireText(input.runId, 'uncertainty runId'),
      subject: requireText(input.subject, 'uncertainty subject'),
      reason: requireText(input.reason, 'uncertainty reason'),
      alternatives: [...(input.alternatives ?? [])].map(item => item.trim()).filter(Boolean),
      severity: input.severity ?? 'medium',
      status: 'OPEN',
      provenance: [...(input.provenance ?? [])],
      createdAt: now,
      updatedAt: now,
    }
    this.store.saveUncertainty(uncertainty)
    return uncertainty
  }

  resolveUncertainty(id: string, status: Exclude<SemanticUncertaintyStatus, 'OPEN'>, resolution: string): SemanticUncertainty {
    const current = this.store.getUncertainty(id)
    if (current === undefined) throw new Error(`semantic uncertainty ${id} does not exist`)
    const next: SemanticUncertainty = {
      ...current,
      status,
      resolution: requireText(resolution, 'uncertainty resolution'),
      updatedAt: new Date().toISOString(),
    }
    this.store.saveUncertainty(next)
    return next
  }

  openForRun(runId: string): readonly SemanticUncertainty[] {
    return this.store.listUncertainties(runId).filter(item => item.status === 'OPEN')
  }
}

export function normalizeScope(scope: ScopeRef): ScopeRef {
  return {
    projectKey: requireText(scope.projectKey, 'projectKey'),
    ...(scope.module === undefined ? {} : { module: scope.module.trim() }),
    ...(scope.branch === undefined ? {} : { branch: scope.branch.trim() }),
    ...(scope.language === undefined ? {} : { language: scope.language.trim() }),
    ...(scope.projectVersion === undefined ? {} : { projectVersion: scope.projectVersion.trim() }),
    ...(scope.schemaVersion === undefined ? {} : { schemaVersion: scope.schemaVersion.trim() }),
    ...(scope.techStackVersion === undefined ? {} : { techStackVersion: scope.techStackVersion.trim() }),
  }
}

export function confidence(value: number | undefined): number {
  if (value === undefined) return 0.5
  if (!Number.isFinite(value)) throw new TypeError('confidence must be finite')
  return Math.max(0, Math.min(1, value))
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(item => item.trim() !== ''))]
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`)
  return value.trim()
}
