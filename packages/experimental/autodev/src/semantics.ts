/** Assumption and semantic-uncertainty lifecycle owned by the Host. */

import { randomUUID } from 'node:crypto'
import type {
  Assumption,
  AssumptionStatus,
  SourceReference,
  ScopeRef,
  SemanticUncertainty,
  SemanticUncertaintyStatus,
} from './contracts.ts'
import { AutoDevStore } from './store.ts'
import { normalizeScope, sameScope } from './scope.ts'

/** Re-export the shared scope normalizer for existing semantic-service consumers. */
export { normalizeScope } from './scope.ts'

/** Evidence-linked assumption proposed for one project and optional Plan. */
export interface RaiseAssumptionInput {
  readonly scope: ScopeRef
  readonly runId?: string
  readonly planId?: string
  readonly statement: string
  readonly rationale?: string
  readonly confidence?: number
  readonly sourceRefs?: readonly SourceReference[]
  readonly evidenceIds?: readonly string[]
}

/** Explicit semantic uncertainty that may require a human decision. */
export interface RaiseUncertaintyInput {
  readonly scope: ScopeRef
  readonly runId: string
  readonly planId?: string
  readonly subject: string
  readonly reason: string
  readonly alternatives?: readonly string[]
  readonly severity?: SemanticUncertainty['severity']
  readonly sourceRefs?: readonly SourceReference[]
}

/**
 * Semantic uncertainty is not a failure. It is an explicit state that may
 * block execution until a human or new evidence resolves the meaning.
 */
export class SemanticService {
  constructor(readonly store: AutoDevStore) {}

  /** Record a proposed assumption after checking its Evidence scope.
   * @param input - Assumption statement, source references, scope, and optional Evidence.
   * @returns The persisted proposed assumption.
   */
  raiseAssumption(input: RaiseAssumptionInput): Assumption {
    const now = new Date().toISOString()
    const scope = normalizeScope(input.scope)
    const evidenceIds = unique(input.evidenceIds ?? [])
    validateEvidenceReferences(this.store, scope, evidenceIds, input.runId)
    const assumption: Assumption = {
      id: randomUUID(),
      scope,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.planId === undefined ? {} : { planId: input.planId }),
      statement: requireText(input.statement, 'assumption statement'),
      ...(input.rationale === undefined ? {} : { rationale: input.rationale.trim() }),
      status: 'PROPOSED',
      confidence: confidence(input.confidence),
      sourceRefs: [...(input.sourceRefs ?? [])],
      evidenceIds,
      createdAt: now,
      updatedAt: now,
    }
    this.store.saveAssumption(assumption)
    return assumption
  }

  /** Resolve or invalidate an assumption with a human-readable rationale.
   * @param id - Assumption identity to resolve.
   * @param status - Confirmed, invalidated, or unknown outcome.
   * @param resolution - Explanation retained in the durable record.
   * @param evidenceIds - Optional supporting Evidence IDs, scope-checked before save.
   * @returns The updated assumption record.
   */
  resolveAssumption(id: string, status: Exclude<AssumptionStatus, 'PROPOSED'>, resolution: string, evidenceIds: readonly string[] = []): Assumption {
    const current = this.store.getAssumption(id)
    if (current === undefined) throw new Error(`assumption ${id} does not exist`)
    validateEvidenceReferences(this.store, current.scope, evidenceIds, current.runId, current.planId)
    const allEvidenceIds = unique([...current.evidenceIds, ...evidenceIds])
    if (status === 'CONFIRMED') {
      validateEvidenceReferences(this.store, current.scope, allEvidenceIds, current.runId, current.planId)
      for (const evidenceId of allEvidenceIds) {
        const evidence = this.store.getEvidence(evidenceId)
        if (evidence === undefined || evidence.status !== 'PASS' || evidence.source === 'agent'
          || (evidence.expiresAt !== undefined && evidence.expiresAt <= new Date().toISOString())) {
          throw new Error(`assumption ${id} cannot be confirmed with non-passing, untrusted, missing, or expired Evidence ${evidenceId}`)
        }
      }
    }
    const next: Assumption = {
      ...current,
      status,
      resolution: requireText(resolution, 'assumption resolution'),
      evidenceIds: allEvidenceIds,
      confidence: status === 'CONFIRMED' ? Math.max(current.confidence, 0.9) : status === 'INVALIDATED' ? 1 : current.confidence,
      updatedAt: new Date().toISOString(),
    }
    this.store.saveAssumption(next)
    return next
  }

  /** Reconcile confirmed assumptions against their current Evidence records.
   * A failing Evidence item invalidates the assumption; missing, expired,
   * untrusted, or otherwise non-passing Evidence downgrades it to UNKNOWN.
   * @param runId Run whose confirmed assumptions are checked.
   * @returns Assumptions changed by this reconciliation.
   */
  reconcileAssumptionEvidence(runId: string): readonly Assumption[] {
    const changed: Assumption[] = []
    for (const assumption of this.store.listAssumptions(runId)) {
      if (assumption.status !== 'CONFIRMED' || assumption.evidenceIds.length === 0) continue
      const issues: { readonly id: string; readonly reason: string; readonly failed: boolean }[] = []
      for (const evidenceId of assumption.evidenceIds) {
        const evidence = this.store.getEvidence(evidenceId)
        if (evidence === undefined) issues.push({ id: evidenceId, reason: 'missing', failed: false })
        else if (evidence.status === 'FAIL') issues.push({ id: evidenceId, reason: 'FAIL', failed: true })
        else if (evidence.status !== 'PASS') issues.push({ id: evidenceId, reason: evidence.status, failed: false })
        else if (evidence.source === 'agent') issues.push({ id: evidenceId, reason: 'untrusted Agent report', failed: false })
        else if (evidence.expiresAt !== undefined && evidence.expiresAt <= new Date().toISOString()) {
          issues.push({ id: evidenceId, reason: 'expired', failed: false })
        }
      }
      if (issues.length === 0) continue
      const status: AssumptionStatus = issues.some(issue => issue.failed) ? 'INVALIDATED' : 'UNKNOWN'
      const detail = issues.map(issue => `${issue.id}=${issue.reason}`).join(', ')
      const note = `Evidence reconciliation changed assumption to ${status}: ${detail}`
      const now = new Date().toISOString()
      const updated: Assumption = {
        ...assumption,
        status,
        resolution: [assumption.resolution, note].filter((value): value is string => value !== undefined && value.trim() !== '').join('; '),
        sourceRefs: [...assumption.sourceRefs, {
          sourceType: 'system', sourceId: `evidence-reconciliation:${runId}:${assumption.id}:${now}`,
          runId, evidenceIds: issues.map(issue => issue.id), note,
        }],
        updatedAt: now,
      }
      this.store.saveAssumption(updated)
      changed.push(updated)
    }
    return changed
  }

  /** Record an open uncertainty without treating it as an execution failure.
   * @param input - Scoped subject, reason, alternatives, and source references.
   * @returns The persisted open uncertainty.
   */
  raiseUncertainty(input: RaiseUncertaintyInput): SemanticUncertainty {
    const now = new Date().toISOString()
    const uncertainty: SemanticUncertainty = {
      id: randomUUID(),
      scope: normalizeScope(input.scope),
      runId: requireText(input.runId, 'uncertainty runId'),
      ...(input.planId === undefined ? {} : { planId: input.planId }),
      subject: requireText(input.subject, 'uncertainty subject'),
      reason: requireText(input.reason, 'uncertainty reason'),
      alternatives: [...(input.alternatives ?? [])].map(item => item.trim()).filter(Boolean),
      severity: input.severity ?? 'medium',
      status: 'OPEN',
      sourceRefs: [...(input.sourceRefs ?? [])],
      createdAt: now,
      updatedAt: now,
    }
    this.store.saveUncertainty(uncertainty)
    return uncertainty
  }

  /** Resolve or dismiss an uncertainty while retaining its history.
   * @param id - Uncertainty identity to update.
   * @param status - Non-open terminal status.
   * @param resolution - Explanation of the human or evidence-based decision.
   * @returns The updated uncertainty record.
   */
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

  /** List uncertainties that still block or qualify one Run's interpretation.
   * @param runId - Run identity whose uncertainty state is requested.
   * @returns Open uncertainties associated with that Run.
   */
  openForRun(runId: string): readonly SemanticUncertainty[] {
    return this.store.listUncertainties(runId).filter(item => item.status === 'OPEN')
  }
}

/** Normalize optional confidence to the inclusive range from zero to one.
 * @param value - Untrusted confidence value, or `undefined` for the default.
 * @returns The validated, clamped confidence score.
 * @throws TypeError when a supplied value is not finite.
 */
export function confidence(value: number | undefined): number {
  if (value === undefined) return 0.5
  if (!Number.isFinite(value)) throw new TypeError('confidence must be finite')
  return Math.max(0, Math.min(1, value))
}

/** Remove duplicate and blank strings while preserving first-seen order.
 * @param values - Candidate string values.
 * @returns A new array of unique nonblank values.
 */
export function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(item => item.trim() !== ''))]
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`)
  return value.trim()
}

function validateEvidenceReferences(
  store: AutoDevStore,
  scope: ScopeRef,
  evidenceIds: readonly string[],
  runId?: string,
  planId?: string,
): void {
  for (const id of unique(evidenceIds)) {
    const evidence = store.getEvidence(id)
    if (evidence === undefined) throw new Error(`Evidence ${id} does not exist`)
    if (runId !== undefined && evidence.runId !== runId) throw new Error(`Evidence ${id} is outside the assumption Run`)
    if (planId !== undefined && evidence.planId !== undefined && evidence.planId !== planId) throw new Error(`Evidence ${id} is outside the assumption Plan`)
    const run = store.getRun(evidence.runId)
    if (run === undefined) throw new Error(`Evidence ${id} references missing Run ${evidence.runId}`)
    const evidenceScope = run.scope ?? { projectKey: run.projectKey ?? run.repoRoot }
    if (!sameScope(scope, evidenceScope)) throw new Error(`Evidence ${id} is outside the assumption scope`)
  }
}
