/** Explicit side-effect intent boundary and conservative state machine. */

import { createHash, randomUUID } from 'node:crypto'
import type {
  ActionIntent,
  ActionIntentKind,
  ActionIntentStatus,
  ActionRisk,
  SideEffectRecord,
} from './contracts.ts'
import { AutoDevStore } from './store.ts'
import { unique } from './semantics.ts'

export interface PlanActionInput {
  readonly runId: string
  readonly nodeId?: string
  readonly kind: ActionIntentKind
  readonly target: string
  readonly risk: ActionRisk
  readonly preconditions?: readonly string[]
  readonly idempotencyKey?: string
}

export class SideEffectService {
  constructor(readonly store: AutoDevStore) {}

  plan(input: PlanActionInput): ActionIntent {
    const key = input.idempotencyKey ?? idempotencyKey(input.runId, input.kind, input.target)
    const existing = this.store.listActionIntents(input.runId).find(item => item.idempotencyKey === key)
    if (existing !== undefined) return existing
    const now = new Date().toISOString()
    const intent: ActionIntent = {
      id: randomUUID(), runId: requireText(input.runId, 'action runId'),
      ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }), kind: input.kind,
      target: requireText(input.target, 'action target'), risk: input.risk,
      idempotencyKey: key, preconditions: unique(input.preconditions ?? []), status: 'PLANNED', createdAt: now, updatedAt: now,
    }
    this.store.saveActionIntent(intent)
    this.store.saveSideEffect({ id: `${intent.id}:planned`, runId: intent.runId, intentId: intent.id, status: 'PLANNED', summary: `planned ${intent.kind} action on ${intent.target}`, evidenceIds: [], createdAt: now })
    return intent
  }

  authorize(id: string, authorization: string): ActionIntent {
    return this.transition(id, 'AUTHORIZED', { authorization: requireText(authorization, 'action authorization') })
  }

  start(id: string): ActionIntent {
    const current = this.require(id)
    if (current.status !== 'AUTHORIZED') throw new Error(`action ${id} must be AUTHORIZED before execution`)
    return this.transition(id, 'EXECUTING')
  }

  commit(
    id: string,
    summary: string,
    beforeFingerprint?: string,
    afterFingerprint?: string,
    evidenceIds: readonly string[] = [],
  ): ActionIntent {
    const current = this.require(id)
    if (current.status !== 'EXECUTING' && current.status !== 'AUTHORIZED') throw new Error(`action ${id} cannot be committed from ${current.status}`)
    const next = this.transition(id, 'COMMITTED')
    this.record(next, 'COMMITTED', summary, beforeFingerprint, afterFingerprint, evidenceIds)
    return next
  }

  fail(id: string, summary: string, evidenceIds: readonly string[] = []): ActionIntent {
    const next = this.transition(id, 'FAILED')
    this.record(next, 'FAILED', summary, undefined, undefined, evidenceIds)
    return next
  }

  unknown(id: string, summary: string, evidenceIds: readonly string[] = []): ActionIntent {
    const current = this.require(id)
    if (current.status === 'COMMITTED') return current
    const next = this.transition(id, 'UNKNOWN')
    this.record(next, 'UNKNOWN', summary, undefined, undefined, evidenceIds)
    return next
  }

  canRetry(intent: ActionIntent): boolean {
    return intent.status === 'PLANNED' || intent.status === 'FAILED' || intent.status === 'REJECTED'
  }

  require(id: string): ActionIntent {
    const intent = this.store.getActionIntent(id)
    if (intent === undefined) throw new Error(`action intent ${id} does not exist`)
    return intent
  }

  private transition(id: string, status: ActionIntentStatus, patch: Partial<ActionIntent> = {}): ActionIntent {
    const current = this.require(id)
    const allowed: Readonly<Record<ActionIntentStatus, readonly ActionIntentStatus[]>> = {
      PLANNED: ['AUTHORIZED', 'REJECTED', 'UNKNOWN'], AUTHORIZED: ['EXECUTING', 'COMMITTED', 'FAILED', 'UNKNOWN', 'REJECTED'],
      EXECUTING: ['COMMITTED', 'FAILED', 'UNKNOWN'], FAILED: ['AUTHORIZED', 'UNKNOWN'], UNKNOWN: [], COMMITTED: [], COMPENSATED: [], REJECTED: ['AUTHORIZED'],
    }
    if (current.status !== status && !allowed[current.status].includes(status)) throw new Error(`invalid action transition ${current.status} -> ${status}`)
    const next: ActionIntent = { ...current, ...patch, status, updatedAt: new Date().toISOString() }
    this.store.saveActionIntent(next)
    return next
  }

  private record(
    intent: ActionIntent,
    status: ActionIntentStatus,
    summary: string,
    beforeFingerprint: string | undefined,
    afterFingerprint: string | undefined,
    evidenceIds: readonly string[],
  ): void {
    const record: SideEffectRecord = {
      id: `${intent.id}:${status.toLocaleLowerCase()}:${Date.now()}`,
      runId: intent.runId, intentId: intent.id, status, summary: requireText(summary, 'side-effect summary'),
      ...(beforeFingerprint === undefined ? {} : { beforeFingerprint }), ...(afterFingerprint === undefined ? {} : { afterFingerprint }),
      evidenceIds: unique(evidenceIds), createdAt: new Date().toISOString(),
    }
    this.store.saveSideEffect(record)
  }
}

export function idempotencyKey(runId: string, kind: ActionIntentKind, target: string): string {
  return createHash('sha256').update(`${runId}\0${kind}\0${target}`).digest('hex')
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`)
  return value.trim()
}
