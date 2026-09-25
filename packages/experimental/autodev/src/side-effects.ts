/** Explicit side-effect intent boundary and conservative state machine. */

import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  ActionIntent,
  ActionIntentKind,
  ActionIntentStatus,
  ActionRisk,
  AutoDevAuditActor,
} from './contracts.ts'
import { AutoDevStore } from './store.ts'
import { unique } from './semantics.ts'

const allowedTransitions: Readonly<Record<ActionIntentStatus, readonly ActionIntentStatus[]>> = {
  PLANNED: ['AUTHORIZED', 'REJECTED', 'UNKNOWN'], AUTHORIZED: ['EXECUTING', 'COMMITTED', 'FAILED', 'UNKNOWN', 'REJECTED'],
  EXECUTING: ['COMMITTED', 'FAILED', 'UNKNOWN'], FAILED: ['AUTHORIZED', 'UNKNOWN'], UNKNOWN: [], COMMITTED: [], COMPENSATED: [], REJECTED: ['AUTHORIZED'],
}

/** Idempotent intent submitted before an operation with an external side effect. */
export interface PlanActionInput {
  readonly runId: string
  readonly nodeId?: string
  readonly kind: ActionIntentKind
  readonly target: string
  readonly risk: ActionRisk
  readonly preconditions?: readonly string[]
  readonly idempotencyKey?: string
}

/** Persists authorization and outcome records without retrying unknown effects. */
export class SideEffectService {
  constructor(readonly store: AutoDevStore) {}

  /** Plan an action, returning the prior intent when its idempotency key already exists.
   * @param input - Run, target, risk, preconditions, and optional idempotency key.
   * @returns The durable planned intent.
   */
  plan(input: PlanActionInput): ActionIntent {
    const key = input.idempotencyKey ?? idempotencyKey(input.runId, input.kind, input.target)
    const now = new Date().toISOString()
    const intent: ActionIntent = {
      id: randomUUID(), runId: requireText(input.runId, 'action runId'),
      ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }), kind: input.kind,
      target: requireText(input.target, 'action target'), risk: input.risk,
      idempotencyKey: key, preconditions: unique(input.preconditions ?? []), status: 'PLANNED', createdAt: now, updatedAt: now,
    }
    return this.store.createActionIntentIfAbsent(intent, {
      id: `${intent.id}:planned`, runId: intent.runId, intentId: intent.id, status: 'PLANNED',
      summary: `planned ${intent.kind} action on ${intent.target}`, evidenceIds: [], createdAt: now,
    })
  }

  /** Record explicit authorization before a planned action may execute.
   * @param id - Action intent identity.
   * @param authorization - Non-empty approval or authorization rationale.
   * @param actor - Host-derived initiating source; defaults to AutoDev runtime policy.
   * @returns The authorized intent.
   */
  authorize(
    id: string,
    authorization: string,
    actor: AutoDevAuditActor = { kind: 'autodev-runtime', source: 'runtime-policy' },
  ): ActionIntent {
    return this.transition(id, 'AUTHORIZED', {
      authorization: requireText(authorization, 'action authorization'),
      authorizedBy: actor,
    })
  }

  /** Mark an authorized intent as executing.
   * @param id - Action intent identity.
   * @returns The executing intent.
   * @throws Error unless the intent is currently authorized.
   */
  start(id: string): ActionIntent {
    return this.store.updateActionIntent(id, (current) => {
      if (current.status !== 'AUTHORIZED') throw new Error(`action ${id} must be AUTHORIZED before execution`)
      return { ...current, status: 'EXECUTING', updatedAt: new Date().toISOString() }
    })
  }

  /** Commit a known successful outcome and append its side-effect record.
   * @param id - Action intent identity.
   * @param summary - Auditable description of the observed result.
   * @param beforeFingerprint - Optional digest of relevant state before execution.
   * @param afterFingerprint - Optional digest of relevant state after execution.
   * @param evidenceIds - Evidence records supporting the outcome.
   * @returns The committed intent.
   */
  commit(
    id: string,
    summary: string,
    beforeFingerprint?: string,
    afterFingerprint?: string,
    evidenceIds: readonly string[] = [],
  ): ActionIntent {
    return this.transitionWithOutcome(id, 'COMMITTED', summary, beforeFingerprint, afterFingerprint, evidenceIds)
  }

  /** Record a known failed outcome and its supporting Evidence.
   * @param id - Action intent identity.
   * @param summary - Failure explanation retained in the audit record.
   * @param evidenceIds - Optional Evidence IDs describing the failure.
   * @returns The failed intent.
   */
  fail(id: string, summary: string, evidenceIds: readonly string[] = []): ActionIntent {
    return this.transitionWithOutcome(id, 'FAILED', summary, undefined, undefined, evidenceIds)
  }

  /** Record an uncertain outcome that must not be automatically retried.
   * @param id - Action intent identity.
   * @param summary - Why the Host cannot establish whether the effect completed.
   * @param evidenceIds - Optional Evidence IDs describing the uncertainty.
   * @returns The unknown intent, or the already-committed intent unchanged.
   */
  unknown(id: string, summary: string, evidenceIds: readonly string[] = []): ActionIntent {
    return this.transitionWithOutcome(id, 'UNKNOWN', summary, undefined, undefined, evidenceIds)
  }

  /** Decide whether a known pre-execution or failed intent may be retried.
   * @param intent - Action intent whose status determines retry safety.
   * @returns True only for planned, failed, or rejected intents.
   */
  canRetry(intent: ActionIntent): boolean {
    return intent.status === 'PLANNED' || intent.status === 'FAILED' || intent.status === 'REJECTED'
  }

  /** Read an action intent or fail when its identity is missing.
   * @param id - Action intent identity.
   * @returns The durable action intent.
   * @throws Error when no intent with this identity exists.
   */
  require(id: string): ActionIntent {
    const intent = this.store.getActionIntent(id)
    if (intent === undefined) throw new Error(`action intent ${id} does not exist`)
    return intent
  }

  private transition(id: string, status: ActionIntentStatus, patch: Partial<ActionIntent> = {}): ActionIntent {
    return this.store.updateActionIntent(id, (current) => {
      if (current.status === status) {
        const samePatch = Object.entries(patch).every(([key, value]) => isDeepStrictEqual(current[key as keyof ActionIntent], value))
        if (samePatch) return current
        throw new Error(`action ${id} already has status ${status} with different authorization data`)
      }
      if (!allowedTransitions[current.status].includes(status)) throw new Error(`invalid action transition ${current.status} -> ${status}`)
      return { ...current, ...patch, status, updatedAt: timestampAfter(current.updatedAt) }
    })
  }

  private transitionWithOutcome(
    id: string,
    status: ActionIntentStatus,
    summary: string,
    beforeFingerprint: string | undefined,
    afterFingerprint: string | undefined,
    evidenceIds: readonly string[],
  ): ActionIntent {
    const normalizedSummary = requireText(summary, 'side-effect summary')
    const normalizedEvidenceIds = unique(evidenceIds).sort()
    return this.store.updateActionIntent(id, (current) => {
      if (status === 'UNKNOWN' && current.status === 'COMMITTED') return current
      if (current.status === status) return current
      if (!allowedTransitions[current.status].includes(status)) throw new Error(`invalid action transition ${current.status} -> ${status}`)
      return { ...current, status, updatedAt: timestampAfter(current.updatedAt) }
    }, (intent) => {
      if (intent.status !== status) return undefined
      return {
        id: `${intent.id}:${status.toLowerCase()}:${intent.updatedAt}`,
        runId: intent.runId,
        intentId: intent.id,
        status,
        summary: normalizedSummary,
        ...(beforeFingerprint === undefined ? {} : { beforeFingerprint }),
        ...(afterFingerprint === undefined ? {} : { afterFingerprint }),
        evidenceIds: normalizedEvidenceIds,
        createdAt: intent.updatedAt,
      }
    })
  }
}

function timestampAfter(previous: string): string {
  const previousMs = Date.parse(previous)
  return new Date(Math.max(Date.now(), Number.isFinite(previousMs) ? previousMs + 1 : 0)).toISOString()
}

/** Derive a stable key for equivalent action plans within one Run.
 * @param runId - Run identity partitioning the action namespace.
 * @param kind - Kind of external or repository side effect.
 * @param target - Canonical action target.
 * @returns A SHA-256 hex key stable for this exact input tuple.
 */
export function idempotencyKey(runId: string, kind: ActionIntentKind, target: string): string {
  return createHash('sha256').update(`${runId}\0${kind}\0${target}`).digest('hex')
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`)
  return value.trim()
}
