/** Durable AutoDev state and content-addressed local artifacts. */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ArtifactRef,
  ActionIntent,
  Assumption,
  AutoDevAuditActor,
  AutoDevAuditEvent,
  RetentionCleanupJobRecord,
  RetentionCleanupItemStatus,
  RetentionCleanupFailureCode,
  AutoDevSnapshot,
  BusinessConcept,
  CandidateRevision,
  CandidateRevisionSummary,
  ConceptObservation,
  Evidence,
  HumanGate,
  JevDecision,
  KnowledgeCandidate,
  KnowledgeMergeProposal,
  KnowledgeCompactionReport,
  KnowledgeRegressionCase,
  KnowledgeRegressionResult,
  KnowledgeRegressionSuite,
  Playbook,
  PlaybookFit,
  ProjectMemory,
  SemanticUncertainty,
  SideEffectRecord,
  NodeExecution,
  AgentProgressSnapshot,
  PlanVersion,
  RouteDecision,
  Run,
  VerificationCheck,
  VerificationReport,
  VerificationResult,
} from './contracts.ts'
import type { AgentSignalEnvelope } from './protocol.ts'
import { migrateAutoDevDatabase } from './migrations.ts'
import { normalizeScope, sameScope, scopeApplies, type ScopeQuery } from './scope.ts'

type RecordKind =
  | 'run' | 'plan' | 'node' | 'candidate' | 'evidence' | 'route' | 'jev' | 'gate' | 'artifact' | 'signal'
  | 'verification-check' | 'verification-result' | 'verification'
  | 'memory' | 'assumption' | 'uncertainty' | 'concept' | 'concept-observation'
  | 'playbook' | 'playbook-fit' | 'knowledge' | 'knowledge-merge' | 'compaction' | 'regression-case' | 'regression-result' | 'regression-suite'
  | 'action-intent' | 'side-effect' | 'cleanup-job' | 'setting'

/** Resolve the stable default AutoDev data directory below DSH_HOME or the user home.
 * @returns Absolute AutoDev data directory.
 */
export function defaultDataRoot(): string {
  const dshHome = process.env.DSH_HOME
  return resolve(dshHome ?? join(homedir(), '.dsh'), 'autodev')
}

function enableWalJournalMode(database: DatabaseSync): void {
  const deadline = Date.now() + 15_000
  const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  while (true) {
    try {
      database.exec('PRAGMA journal_mode = WAL;')
      const mode = database.prepare('PRAGMA journal_mode').get() as Record<string, unknown> | undefined
      if (String(Object.values(mode ?? {})[0]).toLowerCase() !== 'wal') {
        throw new Error('AutoDev SQLite could not enable WAL journal mode')
      }
      return
    } catch (error: unknown) {
      const isLock = error instanceof Error && /database is (?:locked|busy)/iu.test(error.message)
      if (!isLock || Date.now() >= deadline) throw error
      Atomics.wait(waitCell, 0, 0, 15 + Math.floor(Math.random() * 36))
    }
  }
}

/** A small synchronous SQLite repository; the Host calls it from serialized state transitions. */
export class AutoDevStore {
  /** Resolved root directory containing the SQLite database and artifacts. */
  readonly root: string
  /** Absolute path to the AutoDev SQLite database. */
  readonly dbPath: string
  /** Root directory for run-scoped artifacts. */
  readonly artifactsRoot: string
  private readonly db: DatabaseSync
  private transactionDepth = 0

  constructor(root: string = defaultDataRoot()) {
    this.root = resolve(root)
    this.dbPath = join(this.root, 'autodev.sqlite')
    this.artifactsRoot = join(this.root, 'runs')
    mkdirSync(this.root, { recursive: true })
    mkdirSync(this.artifactsRoot, { recursive: true })
    this.db = new DatabaseSync(this.dbPath, { timeout: 15_000 })
    try {
      this.db.exec('PRAGMA foreign_keys = ON;')
      enableWalJournalMode(this.db)
      migrateAutoDevDatabase(this.db)
    } catch (error: unknown) {
      try {
        this.db.close()
      } catch {
        // Keep the original startup or migration error.
      }
      throw error
    }
  }

  /** Close the SQLite connection and release its file handle. */
  close(): void {
    this.db.close()
  }

  /** Read one profile-scoped AutoDev setting from the existing durable record store.
   * @param key Stable setting identifier.
   * @returns The decoded setting, when present.
   */
  getSetting<T>(key: string): T | undefined {
    return this.get<T>('setting', requireSettingKey(key))
  }

  /** Persist a profile-scoped AutoDev setting without requiring a schema migration.
   * @param key Stable setting identifier.
   * @param value JSON-safe setting value; credentials must never be stored here.
   */
  setSetting<T>(key: string, value: T): void {
    this.put('setting', requireSettingKey(key), '', value)
  }

  /** Create a transactionally consistent SQLite snapshot at a new file path.
   * @param destinationPath A destination file that does not yet exist.
   */
  createDatabaseSnapshot(destinationPath: string): void {
    const target = resolve(destinationPath)
    if (existsSync(target)) throw new Error(`AutoDev database snapshot target already exists: ${target}`)
    const sqlLiteral = `'${target.replaceAll("'", "''")}'`
    this.db.exec(`VACUUM INTO ${sqlLiteral}`)
  }

  /** Persist a newly created Run and append its creation event.
   * @param run Run record to create.
   */
  createRun(run: Run): void {
    this.transaction(() => {
      const existing = this.getRun(run.id)
      if (existing !== undefined) throw new Error(`AutoDev run ${run.id} already exists`)
      this.put('run', run.id, run.repoPath, run)
      this.event(run.id, 'run/created', run)
    })
  }

  /** Read one Run by identifier.
   * @param id Run identifier.
   * @returns The stored Run, or undefined when absent.
   */
  getRun(id: string): Run | undefined {
    return this.get<Run>('run', id)
  }

  /** List Runs from most recently updated to least recently updated.
   * @returns All persisted Runs.
   */
  listRuns(): Run[] {
    return this.list<Run>('run').sort((a: Run, b: Run) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** Atomically update an existing Run and append its before/after event.
   * @param id Run identifier.
   * @param update Pure callback that produces the next Run state.
   * @returns The persisted next Run state.
   */
  updateRun(id: string, update: (run: Run) => Run): Run {
    return this.transaction(() => {
      const current = this.getRun(id)
      if (current === undefined) throw new Error(`AutoDev run ${id} does not exist`)
      this.assertRunNotLockedByCleanup(id)
      const next = update(current)
      this.put('run', id, next.repoPath, next)
      this.event(id, 'run/updated', { before: current, after: next })
      return next
    })
  }

  /** Atomically bind an explicit review decision to the active immutable Plan.
   * @param runId Run whose current Plan was reviewed.
   * @param planId Exact reviewed Plan version.
   * @param evidenceId Identifier for the audit Evidence written in the same transaction.
   * @param actor Host-derived initiating source recorded with the decision.
   * @returns The Run made ready for execution.
   */
  approvePlan(runId: string, planId: string, evidenceId: string, actor: AutoDevAuditActor): Run {
    return this.transaction(() => {
      const run = this.getRun(runId)
      this.assertRunNotLockedByCleanup(runId)
      const plan = this.getPlan(planId)
      if (run === undefined || plan === undefined || run.activePlanId !== planId || plan.runId !== runId || plan.status !== 'ACTIVE') {
        throw new Error(`plan ${planId} is not the active Plan of run ${runId}`)
      }
      if (run.approvedPlanId === planId && run.approvedPlanFingerprint === plan.fingerprint) return run
      if (run.status !== 'DRAFT' && run.status !== 'READY') throw new Error(`run ${runId} is ${run.status}; Plan approval requires DRAFT or READY`)
      const now = new Date().toISOString()
      const next: Run = { ...run, status: 'READY', approvedPlanId: planId, approvedPlanFingerprint: plan.fingerprint, planApprovedAt: now, approvedBy: actor, updatedAt: now }
      this.put('run', runId, next.repoPath, next)
      this.event(runId, 'run/updated', { before: run, after: next })
      this.saveEvidence({
        id: evidenceId, runId, planId, type: 'PLAN_APPROVAL', status: 'PASS', source: 'human', actor,
        summary: `Explicit Plan approval recorded for version ${plan.version} (${plan.fingerprint}) by ${actor.kind}`,
        createdAt: now,
      })
      this.appendAuditEvent({
        id: evidenceId, runId, action: 'plan-approved', actor, resourceKind: 'run', resourceId: runId,
        result: 'APPROVED', createdAt: now,
      })
      return next
    })
  }

  /** Persist a plan version and append its creation event.
   * @param plan Plan version to create.
   */
  createPlan(plan: PlanVersion): void {
    this.transaction(() => {
      const existing = this.getPlan(plan.id)
      if (existing !== undefined) {
        if (!samePlanDefinition(existing, plan)) {
          throw new Error(`Plan ${plan.id} already exists with a different immutable definition`)
        }
        return
      }
      this.put('plan', plan.id, plan.runId, plan)
      this.event(plan.runId, 'plan/created', plan)
    })
  }

  /** Change only a Plan's lifecycle state while preserving its immutable definition.
   * @param id Plan identifier.
   * @param status Terminal lifecycle state for this Plan version.
   * @returns The updated Plan version.
   */
  updatePlanStatus(id: string, status: Extract<PlanVersion['status'], 'SUPERSEDED' | 'CANCELLED'>): PlanVersion {
    return this.transaction(() => {
      const current = this.getPlan(id)
      if (current === undefined) throw new Error(`Plan ${id} does not exist`)
      if (current.status === status) return current
      if (current.status !== 'ACTIVE') throw new Error(`Plan ${id} cannot transition from ${current.status} to ${status}`)
      const next: PlanVersion = { ...current, status }
      this.put('plan', id, next.runId, next)
      this.event(next.runId, 'plan/status-updated', { before: current, after: next })
      return next
    })
  }

  /** Read one plan version by identifier.
   * @param id Plan identifier.
   * @returns The stored plan, or undefined when absent.
   */
  getPlan(id: string): PlanVersion | undefined {
    return this.get<PlanVersion>('plan', id)
  }

  /** List a Run's plans in ascending version order.
   * @param runId Owning Run identifier.
   * @returns Persisted plan versions.
   */
  listPlans(runId: string): PlanVersion[] {
    return this.list<PlanVersion>('plan', runId).sort((a: PlanVersion, b: PlanVersion) => a.version - b.version)
  }

  /** Persist a new plan-node execution record.
   * @param node Node execution to create.
   */
  createNode(node: NodeExecution): void {
    this.put('node', node.id, node.runId, node)
  }

  /** Persist a node execution and append its update event.
   * @param node Current node execution state.
   */
  saveNode(node: NodeExecution): void {
    this.put('node', node.id, node.runId, node)
    this.event(node.runId, 'node/updated', node)
  }

  /** Update only the live progress projection; token updates are not audit events. */
  saveNodeProgress(
    id: string,
    expected: Pick<NodeExecution, 'runId' | 'planId' | 'nodeId' | 'attempt'>,
    agentProgress: AgentProgressSnapshot,
  ): boolean {
    const current = this.getNode(id)
    if (current === undefined
      || current.status !== 'RUNNING'
      || current.runId !== expected.runId
      || current.planId !== expected.planId
      || current.nodeId !== expected.nodeId
      || current.attempt !== expected.attempt) return false
    this.put('node', id, current.runId, { ...current, agentProgress })
    return true
  }

  /** Read a node execution by identifier.
   * @param id Node identifier.
   * @returns The stored node, or undefined when absent.
   */
  getNode(id: string): NodeExecution | undefined {
    return this.get<NodeExecution>('node', id)
  }

  /** List a Run's nodes in stable identifier order.
   * @param runId Owning Run identifier.
   * @returns Persisted node executions.
   */
  listNodes(runId: string): NodeExecution[] {
    return this.list<NodeExecution>('node', runId).sort((a: NodeExecution, b: NodeExecution) => a.id.localeCompare(b.id))
  }

  /** Persist a sealed candidate revision and append its event.
   * @param candidate Candidate revision to save.
   */
  saveCandidate(candidate: CandidateRevision): void {
    this.put('candidate', candidate.id, candidate.runId, candidate)
    this.event(candidate.runId, 'candidate/sealed', candidate)
  }

  /** Read a candidate revision by identifier.
   * @param id Candidate identifier.
   * @returns The stored candidate, or undefined when absent.
   */
  getCandidate(id: string): CandidateRevision | undefined {
    return this.get<CandidateRevision>('candidate', id)
  }

  /** Read artifact metadata by identifier.
   * @param id Artifact identifier.
   * @returns The stored artifact reference, or undefined when absent.
   */
  getArtifact(id: string): ArtifactRef | undefined {
    return this.get<ArtifactRef>('artifact', id)
  }

  /** List all candidate revisions for a Run.
   * @param runId Owning Run identifier.
   * @returns Persisted candidate revisions.
   */
  listCandidates(runId: string): CandidateRevision[] {
    return this.list<CandidateRevision>('candidate', runId)
  }

  /** Read one durable retention Cleanup Job by its idempotency key.
   * @param id Stable Job identity supplied when preparation is requested.
   * @returns The persisted Job, or undefined when it has not been prepared.
   */
  getRetentionCleanupJob(id: string): RetentionCleanupJobRecord | undefined {
    return this.get<RetentionCleanupJobRecord>('cleanup-job', id)
  }

  /** List durable retention Cleanup Jobs, newest first.
   * @returns Persisted path-free maintenance records.
   */
  listRetentionCleanupJobs(): RetentionCleanupJobRecord[] {
    return this.list<RetentionCleanupJobRecord>('cleanup-job').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Insert a prepared Cleanup Job or return the matching prior request.
   * @param job Immutable Job selection and initial audit event.
   * @returns Existing or newly persisted Job and whether it was created now.
   * @throws Error when the idempotency key is reused for a different selection.
   */
  createRetentionCleanupJob(job: RetentionCleanupJobRecord): { readonly job: RetentionCleanupJobRecord; readonly created: boolean } {
    return this.transaction(() => {
      const existing = this.getRetentionCleanupJob(job.id)
      if (existing !== undefined) {
        const sameSelection = existing.snapshotFingerprint === job.snapshotFingerprint
          && existing.minAgeDays === job.minAgeDays
          && sameCleanupSelection(existing.items, job.items)
        if (!sameSelection) throw new Error(`retention cleanup idempotency key ${job.id} was reused with a different selection`)
        return { job: existing, created: false }
      }
      this.put('cleanup-job', job.id, '', job)
      if (job.requestedBy !== undefined) {
        for (const runId of new Set(job.items.map(item => item.runId))) {
          this.appendAuditEvent({
            id: `${job.id}:prepared:${runId}`, runId, action: 'cleanup-prepared', actor: job.requestedBy,
            resourceKind: 'cleanup-job', resourceId: job.id, result: 'PREPARED', risk: 'destructive', createdAt: job.createdAt,
          })
        }
      }
      return { job, created: true }
    })
  }

  /** Persist the explicit confirmation for a prepared or interrupted Job.
   * @param id Job identity.
   * @param sourcePeerId DSH invocation.peer.id connection identifier, when called through a Remote; not a user identity.
   * @param actor Host-derived initiating source; it is never a user-supplied authorization claim.
   * @returns The Job admitted for execution.
   */
  confirmRetentionCleanupJob(id: string, sourcePeerId: string | undefined, actor?: AutoDevAuditActor): RetentionCleanupJobRecord {
    return this.transaction(() => {
      const current = this.getRetentionCleanupJob(id)
      if (current === undefined) throw new Error(`retention cleanup job ${id} does not exist`)
      if (current.status === 'COMPLETED') return current
      if (current.status === 'CANCELLED') throw new Error(`retention cleanup job ${id} was cancelled`)
      const now = new Date().toISOString()
      const event = { at: now, type: 'confirmed' as const, ...(sourcePeerId === undefined ? {} : { sourcePeerId }), ...(actor === undefined ? {} : { actor }) }
      const next: RetentionCleanupJobRecord = {
        ...current,
        status: 'EXECUTING',
        updatedAt: now,
        confirmedAt: now,
        ...(sourcePeerId === undefined ? {} : { confirmedFromPeerId: sourcePeerId }),
        ...(actor === undefined ? {} : { confirmedBy: actor }),
        events: [...current.events, event],
      }
      this.put('cleanup-job', id, '', next)
      if (actor !== undefined) {
        for (const runId of new Set(current.items.map(item => item.runId))) {
          this.appendAuditEvent({
            id: `${id}:confirmed:${runId}:${now}`, runId, action: 'cleanup-confirmed', actor,
            resourceKind: 'cleanup-job', resourceId: id, result: 'CONFIRMED', risk: 'destructive', createdAt: now,
          })
        }
      }
      return next
    })
  }

  /** Atomically claim one selected Worktree and fence concurrent Run transitions.
   * @param jobId Parent Cleanup Job.
   * @param retentionId Selected path-free Worktree identity.
   * @param ownerId Current Host runtime instance.
   * @param leaseExpiresAt Bounded lease expiry used by Run mutation guards.
   * @returns Claim result with the latest persisted Job.
   */
  claimRetentionCleanupItem(
    jobId: string,
    retentionId: string,
    ownerId: string,
    leaseExpiresAt: string,
  ): { readonly result: 'CLAIMED' | 'REMOVED' | 'BUSY' | 'BLOCKED'; readonly job: RetentionCleanupJobRecord } {
    return this.transaction(() => {
      const job = this.getRetentionCleanupJob(jobId)
      if (job === undefined) throw new Error(`retention cleanup job ${jobId} does not exist`)
      if (job.status !== 'EXECUTING') return { result: 'BUSY', job }
      const nowMs = Date.now()
      const itemIndex = job.items.findIndex(item => item.retentionId === retentionId)
      if (itemIndex < 0) throw new Error(`retention cleanup job ${jobId} does not contain ${retentionId}`)
      const item = job.items[itemIndex]
      if (item === undefined) throw new Error(`retention cleanup job ${jobId} does not contain ${retentionId}`)
      if (item.status === 'REMOVED') return { result: 'REMOVED', job }
      if (item.status === 'EXECUTING' && item.leaseExpiresAt !== undefined && Date.parse(item.leaseExpiresAt) > nowMs) {
        return { result: 'BUSY', job }
      }
      const otherLiveLease = this.listRetentionCleanupJobs().some(other => other.items.some(candidate =>
        candidate.runId === item.runId
        && candidate.status === 'EXECUTING'
        && candidate.leaseExpiresAt !== undefined
        && Date.parse(candidate.leaseExpiresAt) > nowMs
        && !(other.id === job.id && candidate.retentionId === retentionId)))
      if (otherLiveLease) return { result: 'BUSY', job }

      const run = this.getRun(item.runId)
      const blockedCode: RetentionCleanupFailureCode | undefined = run === undefined || !CLEANUP_TERMINAL_RUN_STATES.has(run.status)
        ? 'run-state-changed'
        : this.listGates(item.runId).some(gate => gate.status === 'OPEN')
          || this.listActionIntents(item.runId).some(intent => CLEANUP_UNSETTLED_ACTIONS.has(intent.status))
          ? 'run-state-changed'
          : undefined
      if (blockedCode !== undefined) {
        const now = new Date().toISOString()
        const items: RetentionCleanupJobRecord['items'] = job.items.map((candidate, index) => index === itemIndex
          ? {
            retentionId: candidate.retentionId,
            runId: candidate.runId,
            attempt: candidate.attempt,
            status: 'BLOCKED' as const,
            failureCode: blockedCode,
          }
          : candidate)
        const next = withCleanupJobEvent(job, items, 'item-failed', now, retentionId, blockedCode)
        this.put('cleanup-job', job.id, '', next)
        return { result: 'BLOCKED', job: next }
      }

      const now = new Date().toISOString()
      const items = job.items.map((candidate, index) => index === itemIndex
        ? { ...candidate, status: 'EXECUTING' as const, leaseOwner: ownerId, leaseExpiresAt }
        : candidate)
      const next = withCleanupJobEvent(job, items, 'item-started', now, retentionId)
      this.put('cleanup-job', job.id, '', next)
      return { result: 'CLAIMED', job: next }
    })
  }

  /** Commit one Worktree outcome and release its Run transition lease.
   * @param jobId Parent Cleanup Job.
   * @param retentionId Selected Worktree identity.
   * @param ownerId Host runtime that owns the current lease.
   * @param status Terminal outcome for this item.
   * @param failureCode Optional path-free failure category.
   * @returns The resulting durable Job.
   */
  settleRetentionCleanupItem(
    jobId: string,
    retentionId: string,
    ownerId: string,
    status: Extract<RetentionCleanupItemStatus, 'REMOVED' | 'FAILED' | 'BLOCKED' | 'UNKNOWN'>,
    failureCode?: RetentionCleanupFailureCode,
  ): RetentionCleanupJobRecord {
    return this.transaction(() => {
      const job = this.getRetentionCleanupJob(jobId)
      if (job === undefined) throw new Error(`retention cleanup job ${jobId} does not exist`)
      const itemIndex = job.items.findIndex(item => item.retentionId === retentionId)
      if (itemIndex < 0) throw new Error(`retention cleanup job ${jobId} does not contain ${retentionId}`)
      const current = job.items[itemIndex]
      if (current === undefined) throw new Error(`retention cleanup job ${jobId} does not contain ${retentionId}`)
      if (current.status === 'REMOVED' && status === 'REMOVED') return job
      if (current.status !== 'EXECUTING' || current.leaseOwner !== ownerId) {
        throw new Error(`retention cleanup item ${retentionId} is not leased by this Host`)
      }
      const now = new Date().toISOString()
      const items = job.items.map((candidate, index) => index === itemIndex
        ? {
          retentionId: candidate.retentionId,
          runId: candidate.runId,
          attempt: candidate.attempt,
          status,
          ...(failureCode === undefined ? {} : { failureCode }),
        }
        : candidate)
      const eventType = status === 'REMOVED' ? 'item-removed' as const : 'item-failed' as const
      const next = withCleanupJobEvent(job, items, eventType, now, retentionId, failureCode)
      this.put('cleanup-job', job.id, '', next)
      return next
    })
  }

  /** Renew live Worktree cleanup leases owned by one Host runtime.
   * @param ownerId Host runtime instance.
   * @param leaseExpiresAt New bounded lease expiry.
   */
  renewRetentionCleanupLeases(ownerId: string, leaseExpiresAt: string): void {
    this.transaction(() => {
      const now = new Date().toISOString()
      for (const job of this.listRetentionCleanupJobs()) {
        if (!job.items.some(item => item.status === 'EXECUTING' && item.leaseOwner === ownerId)) continue
        const items = job.items.map(item => item.status === 'EXECUTING' && item.leaseOwner === ownerId
          ? { ...item, leaseExpiresAt }
          : item)
        this.put('cleanup-job', job.id, '', { ...job, updatedAt: now, items })
      }
    })
  }

  /** Mark a running Job as requiring operator review after a cooperative stop.
   * @param id Job identity.
   */
  pauseRetentionCleanupJob(id: string): void {
    this.updateRetentionCleanupJob(id, job => job.status === 'EXECUTING'
      ? { ...job, status: 'NEEDS_ATTENTION', updatedAt: new Date().toISOString() }
      : job)
  }

  /** Cancel a Job only while it is still awaiting its first confirmation.
   * @param id Job identity.
   * @param sourcePeerId DSH invocation.peer.id connection identifier, when available; not a user identity.
   * @param actor Host-derived initiating source; it is never a user-supplied authorization claim.
   * @returns The cancelled Job.
   */
  cancelRetentionCleanupJob(id: string, sourcePeerId?: string, actor?: AutoDevAuditActor): RetentionCleanupJobRecord {
    return this.transaction(() => {
      const job = this.getRetentionCleanupJob(id)
      if (job === undefined) throw new Error(`retention cleanup job ${id} does not exist`)
      if (job.status === 'CANCELLED') return job
      if (job.status !== 'AWAITING_CONFIRMATION') throw new Error(`retention cleanup job ${id} can no longer be cancelled`)
      const now = new Date().toISOString()
      const next: RetentionCleanupJobRecord = {
        ...job,
        status: 'CANCELLED',
        updatedAt: now,
        events: [...job.events, { at: now, type: 'cancelled', ...(sourcePeerId === undefined ? {} : { sourcePeerId }), ...(actor === undefined ? {} : { actor }) }],
        ...(actor === undefined ? {} : { cancelledBy: actor }),
      }
      this.put('cleanup-job', id, '', next)
      if (actor !== undefined) {
        for (const runId of new Set(job.items.map(item => item.runId))) {
          this.appendAuditEvent({
            id: `${id}:cancelled:${runId}:${now}`, runId, action: 'cleanup-cancelled', actor,
            resourceKind: 'cleanup-job', resourceId: id, result: 'CANCELLED', risk: 'destructive', createdAt: now,
          })
        }
      }
      return next
    })
  }

  /** Atomically update one Cleanup Job using a synchronous state transition.
   * @param id Job identity.
   * @param update Pure transition from the current durable state.
   * @returns The persisted next state.
   */
  updateRetentionCleanupJob(
    id: string,
    update: (job: RetentionCleanupJobRecord) => RetentionCleanupJobRecord,
  ): RetentionCleanupJobRecord {
    return this.transaction(() => {
      const current = this.getRetentionCleanupJob(id)
      if (current === undefined) throw new Error(`retention cleanup job ${id} does not exist`)
      const next = update(current)
      if (next.id !== current.id) throw new Error('retention cleanup job identity is immutable')
      this.put('cleanup-job', id, '', next)
      return next
    })
  }

  /** Persist an Evidence record and append its creation event.
   * @param evidence Evidence record to save.
   */
  saveEvidence(evidence: Evidence): void {
    this.put('evidence', evidence.id, evidence.runId, evidence)
    this.event(evidence.runId, 'evidence/created', evidence)
  }

  /**
   * Read one Evidence record by id.
   * @param id Stable Evidence identifier.
   * @returns The stored Evidence, or undefined when no such id exists.
   */
  getEvidence(id: string): Evidence | undefined {
    return this.get<Evidence>('evidence', id)
  }

  /** List Evidence records belonging to a Run.
   * @param runId Owning Run identifier.
   * @returns Persisted Evidence records.
   */
  listEvidence(runId: string): Evidence[] {
    return this.list<Evidence>('evidence', runId)
  }

  /** Persist a provider route decision and append its event when run-scoped.
   * @param decision Route decision to save.
   */
  saveRouteDecision(decision: RouteDecision): void {
    this.put('route', decision.id, decision.runId ?? '', decision)
    if (decision.runId !== undefined) this.event(decision.runId, 'route/decided', decision)
  }

  /** Persist a Jev decision and append its event when run-scoped.
   * @param decision Jev decision to save.
   */
  saveJevDecision(decision: JevDecision): void {
    this.put('jev', decision.id, decision.runId ?? '', decision)
    if (decision.runId !== undefined) this.event(decision.runId, 'jev/decided', decision)
  }

  /** List route and Jev decisions for a Run in creation order.
   * @param runId Owning Run identifier.
   * @returns Persisted routing and Jev decisions.
   */
  listDecisions(runId: string): (RouteDecision | JevDecision)[] {
    return [
      ...this.list<RouteDecision>('route', runId),
      ...this.list<JevDecision>('jev', runId),
    ].sort((a: RouteDecision | JevDecision, b: RouteDecision | JevDecision) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Persist a human approval gate and append its update event.
   * @param gate Gate state to save.
   */
  saveGate(gate: HumanGate): void {
    this.transaction(() => {
      const previous = this.getGate(gate.id)
      this.put('gate', gate.id, gate.runId, gate)
      this.event(gate.runId, 'gate/updated', gate)
      if (previous?.status === 'OPEN' && gate.status === 'RESOLVED' && gate.resolvedBy !== undefined) {
        this.appendAuditEvent({
          id: `${gate.id}:resolved:${gate.resolvedAt ?? gate.createdAt}`, runId: gate.runId, action: 'gate-resolved',
          actor: gate.resolvedBy, resourceKind: 'gate', resourceId: gate.id, result: 'RESOLVED',
          ...(gate.selected === 'promote' ? { risk: 'destructive' as const } : {}),
          createdAt: gate.resolvedAt ?? new Date().toISOString(),
        })
      }
    })
  }

  /** Read a human approval gate by identifier.
   * @param id Gate identifier.
   * @returns The stored gate, or undefined when absent.
   */
  getGate(id: string): HumanGate | undefined {
    return this.get<HumanGate>('gate', id)
  }

  /** List a Run's gates in creation order.
   * @param runId Owning Run identifier.
   * @returns Persisted approval gates.
   */
  listGates(runId: string): HumanGate[] {
    return this.list<HumanGate>('gate', runId).sort((a: HumanGate, b: HumanGate) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Persist an Agent Protocol signal and append its event.
   * @param signal Validated signal envelope to save.
   */
  saveAgentSignal(signal: AgentSignalEnvelope): void {
    this.put('signal', signal.id, signal.runId, signal)
    this.event(signal.runId, 'agent/signal', signal)
  }

  /** List Agent signals in sequence and creation order.
   * @param runId Owning Run identifier.
   * @returns Persisted signal envelopes.
   */
  listAgentSignals(runId: string): AgentSignalEnvelope[] {
    return this.list<AgentSignalEnvelope>('signal', runId).sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt))
  }

  /** Persist the definition of a verification check.
   * @param check Verification check to save.
   */
  saveVerificationCheck(check: VerificationCheck): void {
    this.put('verification-check', check.id, check.runId, check)
  }

  /** List verification checks for a Run in creation order.
   * @param runId Owning Run identifier.
   * @returns Persisted verification checks.
   */
  listVerificationChecks(runId: string): VerificationCheck[] {
    return this.list<VerificationCheck>('verification-check', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Persist an individual verification result and append its event.
   * @param result Verification result to save.
   */
  saveVerificationResult(result: VerificationResult): void {
    this.put('verification-result', result.id, result.runId, result)
    this.event(result.runId, 'verification/result', result)
  }

  /** List individual verification results for a Run.
   * @param runId Owning Run identifier.
   * @returns Persisted verification results.
   */
  listVerificationResults(runId: string): VerificationResult[] {
    return this.list<VerificationResult>('verification-result', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Persist an aggregate verification report and append its event.
   * @param report Verification report to save.
   */
  saveVerificationReport(report: VerificationReport): void {
    this.put('verification', report.id, report.runId, report)
    this.event(report.runId, 'verification/report', report)
  }

  /** List aggregate verification reports for a Run.
   * @param runId Owning Run identifier.
   * @returns Persisted verification reports.
   */
  listVerificationReports(runId: string): VerificationReport[] {
    return this.list<VerificationReport>('verification', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Persist project memory and append a scope-level update event.
   * @param memory Project memory record to save.
   */
  saveMemory(memory: ProjectMemory): void {
    this.put('memory', memory.id, memory.scope.projectKey, memory)
    this.eventForScope(memory.scope.projectKey, 'memory/updated', memory)
  }

  /** Read project memory by identifier.
   * @param id Memory identifier.
   * @returns The stored memory record, or undefined when absent.
   */
  getMemory(id: string): ProjectMemory | undefined {
    return this.get<ProjectMemory>('memory', id)
  }

  /** List memories applicable to an optional project scope, newest first.
   * @param scope Optional scope filter.
   * @returns Applicable project memory records.
   */
  listMemories(scope?: ScopeQuery): ProjectMemory[] {
    return this.list<ProjectMemory>('memory', projectKeyOf(scope))
      .filter(item => scope === undefined || scopeApplies(scope, item.scope))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** Persist an assumption and append its scope-level update event.
   * @param assumption Assumption record to save.
   */
  saveAssumption(assumption: Assumption): void {
    this.put('assumption', assumption.id, assumption.runId ?? assumption.scope.projectKey, assumption)
    this.eventForScope(assumption.runId ?? assumption.scope.projectKey, 'assumption/updated', assumption)
  }

  /** Read an assumption by identifier.
   * @param id Assumption identifier.
   * @returns The stored assumption, or undefined when absent.
   */
  getAssumption(id: string): Assumption | undefined {
    return this.get<Assumption>('assumption', id)
  }

  /** List assumptions for a Run, or all assumptions when omitted.
   * @param runId Optional owning Run identifier.
   * @returns Matching assumptions in creation order.
   */
  listAssumptions(runId?: string): Assumption[] {
    return this.list<Assumption>('assumption', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Persist a semantic uncertainty and append its event.
   * @param uncertainty Uncertainty record to save.
   */
  saveUncertainty(uncertainty: SemanticUncertainty): void {
    this.put('uncertainty', uncertainty.id, uncertainty.runId, uncertainty)
    this.event(uncertainty.runId, 'uncertainty/updated', uncertainty)
  }

  /** Read a semantic uncertainty by identifier.
   * @param id Uncertainty identifier.
   * @returns The stored uncertainty, or undefined when absent.
   */
  getUncertainty(id: string): SemanticUncertainty | undefined {
    return this.get<SemanticUncertainty>('uncertainty', id)
  }

  /** List uncertainties for a Run, or all uncertainties when omitted.
   * @param runId Optional owning Run identifier.
   * @returns Matching uncertainties in creation order.
   */
  listUncertainties(runId?: string): SemanticUncertainty[] {
    return this.list<SemanticUncertainty>('uncertainty', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Persist a business concept and append a scope-level update event.
   * @param concept Business concept to save.
   */
  saveConcept(concept: BusinessConcept): void {
    this.put('concept', concept.id, concept.scope.projectKey, concept)
    this.eventForScope(concept.scope.projectKey, 'concept/updated', concept)
  }

  /** Read a business concept by identifier.
   * @param id Concept identifier.
   * @returns The stored concept, or undefined when absent.
   */
  getConcept(id: string): BusinessConcept | undefined {
    return this.get<BusinessConcept>('concept', id)
  }

  /** List concepts applicable to an optional scope in stable key/version order.
   * @param scope Optional scope filter.
   * @returns Applicable business concepts.
   */
  listConcepts(scope?: ScopeQuery): BusinessConcept[] {
    return this.list<BusinessConcept>('concept', projectKeyOf(scope))
      .filter(item => scope === undefined || scopeApplies(scope, item.scope))
      .sort((a, b) => a.key.localeCompare(b.key) || b.version - a.version)
  }

  /** Persist a concept observation and append its scope-level event.
   * @param observation Observation record to save.
   */
  saveConceptObservation(observation: ConceptObservation): void {
    this.put('concept-observation', observation.id, observation.scope.projectKey, observation)
    this.eventForScope(observation.scope.projectKey, 'concept/observed', observation)
  }

  /** List concept observations applicable to an optional scope.
   * @param scope Optional scope filter.
   * @returns Matching observations in creation order.
   */
  listConceptObservations(scope?: ScopeQuery): ConceptObservation[] {
    return this.list<ConceptObservation>('concept-observation', projectKeyOf(scope))
      .filter(item => scope === undefined || scopeApplies(scope, item.scope))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Persist a playbook and append its scope-level update event.
   * @param playbook Playbook to save.
   */
  savePlaybook(playbook: Playbook): void {
    this.put('playbook', playbook.id, playbook.scope?.projectKey ?? '', playbook)
    this.eventForScope(playbook.scope?.projectKey ?? '', 'playbook/updated', playbook)
  }

  /** Read a playbook by identifier.
   * @param id Playbook identifier.
   * @returns The stored playbook, or undefined when absent.
   */
  getPlaybook(id: string): Playbook | undefined {
    return this.get<Playbook>('playbook', id)
  }

  /** List playbooks applicable to an optional scope in stable key/version order.
   * @param scope Optional scope filter.
   * @returns Matching playbooks.
   */
  listPlaybooks(scope?: ScopeQuery): Playbook[] {
    const values = this.list<Playbook>('playbook')
    return values
      .filter(item => scope === undefined || scopeApplies(scope, item.scope))
      .sort((a, b) => a.key.localeCompare(b.key) || b.version - a.version)
  }

  /** Persist a playbook-fit assessment and append its Run event when scoped.
   * @param fit Fit assessment to save.
   */
  savePlaybookFit(fit: PlaybookFit): void {
    this.put('playbook-fit', fit.id, fit.runId ?? '', fit)
    if (fit.runId !== undefined) this.event(fit.runId, 'playbook/fit', fit)
  }

  /** List playbook-fit assessments for an optional Run.
   * @param runId Optional owning Run identifier.
   * @returns Matching fit assessments in creation order.
   */
  listPlaybookFits(runId?: string): PlaybookFit[] {
    return this.list<PlaybookFit>('playbook-fit', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Persist a knowledge record and append a scope-level update event.
   * @param candidate Knowledge record to save.
   */
  saveKnowledge(candidate: KnowledgeCandidate): void {
    this.put('knowledge', candidate.id, candidate.scope.projectKey, candidate)
    this.eventForScope(candidate.scope.projectKey, 'knowledge/updated', candidate)
  }

  /** Read a knowledge record by identifier.
   * @param id Knowledge identifier.
   * @returns The stored record, or undefined when absent.
   */
  getKnowledge(id: string): KnowledgeCandidate | undefined {
    return this.get<KnowledgeCandidate>('knowledge', id)
  }

  /** List knowledge applicable to an optional scope, newest first.
   * @param scope Optional scope filter.
   * @returns Applicable knowledge records.
   */
  listKnowledge(scope?: ScopeQuery): KnowledgeCandidate[] {
    return this.list<KnowledgeCandidate>('knowledge', projectKeyOf(scope))
      .filter(item => scope === undefined || scopeApplies(scope, item.scope))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** Persist a merge proposal and append its scope-level event.
   * @param proposal Human-reviewable Knowledge merge proposal.
   */
  saveKnowledgeMergeProposal(proposal: KnowledgeMergeProposal): void {
    this.put('knowledge-merge', proposal.id, proposal.scope.projectKey, proposal)
    this.eventForScope(proposal.scope.projectKey, 'knowledge/merge-proposed', proposal)
  }

  /** Read a Knowledge merge proposal by identifier.
   * @param id Merge proposal identifier.
   * @returns The proposal, or undefined when absent.
   */
  getKnowledgeMergeProposal(id: string): KnowledgeMergeProposal | undefined {
    return this.get<KnowledgeMergeProposal>('knowledge-merge', id)
  }

  /** List merge proposals applicable to an optional scope, newest first.
   * @param scope Optional project scope filter.
   * @returns Persisted merge proposals.
   */
  listKnowledgeMergeProposals(scope?: ScopeQuery): KnowledgeMergeProposal[] {
    return this.list<KnowledgeMergeProposal>('knowledge-merge', projectKeyOf(scope))
      .filter(item => scope === undefined || scopeApplies(scope, item.scope))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Atomically resolve a merge proposal and, on acceptance, save its new Candidate.
   * The acceptance path checks every snapshotted input version while holding a
   * write transaction; stale proposals are retained as STALE without side effects.
   * @param id Merge proposal identifier.
   * @param decision Human decision for this proposal.
   * @param resolution Review rationale retained in the proposal.
   * @param candidate New untrusted Candidate created by an accepted merge.
   * @returns The resolved proposal, including any linked output Candidate id.
   */
  resolveKnowledgeMergeProposal(
    id: string,
    decision: 'ACCEPTED' | 'REJECTED',
    resolution: string,
    candidate?: KnowledgeCandidate,
  ): KnowledgeMergeProposal {
    return this.transaction(() => {
      const current = this.getKnowledgeMergeProposal(id)
      if (current === undefined) throw new Error(`knowledge merge proposal ${id} does not exist`)
      if (current.status !== 'PROPOSED') throw new Error(`knowledge merge proposal ${id} is already ${current.status}`)
      if (decision === 'ACCEPTED') {
        const inputIds = [...current.inputIds].sort()
        const versionIds = current.inputVersions.map(item => item.id).sort()
        const malformed = inputIds.length < 2
          || new Set(inputIds).size !== inputIds.length
          || JSON.stringify(inputIds) !== JSON.stringify(versionIds)
        const changed = current.inputVersions.filter((expected) => {
          const input = this.getKnowledge(expected.id)
          return input === undefined || input.version !== expected.version
            || input.kind !== current.kind || !sameScope(input.scope, current.scope)
            || input.status === 'DEPRECATED'
            || (input.expiresAt !== undefined && input.expiresAt <= new Date().toISOString())
        })
        if (malformed || changed.length > 0) {
          const now = new Date().toISOString()
          const stale: KnowledgeMergeProposal = {
            ...current,
            status: 'STALE',
            resolution: `${resolution}; ${malformed ? 'merge proposal input snapshot is incomplete or invalid' : `merge inputs changed after this proposal: ${changed.map(item => item.id).join(', ')}`}`,
            resolvedAt: now,
          }
          this.saveKnowledgeMergeProposal(stale)
          return stale
        }
        if (candidate === undefined || candidate.status !== 'CANDIDATE' || candidate.kind !== current.kind
          || !sameScope(candidate.scope, current.scope)) {
          throw new Error(`accepted Knowledge merge ${id} requires a same-scope, same-kind Candidate`)
        }
        if (this.getKnowledge(candidate.id) !== undefined) throw new Error(`accepted Knowledge merge ${id} cannot overwrite existing Knowledge ${candidate.id}`)
        this.saveKnowledge(candidate)
      } else if (candidate !== undefined) {
        throw new Error(`rejected Knowledge merge ${id} cannot create a Candidate`)
      }
      const now = new Date().toISOString()
      const resolved: KnowledgeMergeProposal = {
        ...current,
        status: decision,
        ...(candidate === undefined ? {} : { outputKnowledgeId: candidate.id }),
        resolution,
        resolvedAt: now,
      }
      this.saveKnowledgeMergeProposal(resolved)
      return resolved
    })
  }

  /** Persist a knowledge compaction report and append its scope event.
   * @param report Compaction report to save.
   */
  saveCompaction(report: KnowledgeCompactionReport): void {
    this.put('compaction', report.id, report.scope.projectKey, report)
    this.eventForScope(report.scope.projectKey, 'knowledge/compacted', report)
  }

  /** Atomically restore a compaction after validating its report and current versions.
   * @param reportId Compaction report identifier.
   * @param validate Domain validation performed before restoration.
   * @param restoredAt Timestamp to assign to restored records.
   * @returns Identifiers of restored knowledge records.
   */
  restoreKnowledgeCompaction(
    reportId: string,
    validate: (report: KnowledgeCompactionReport) => void,
    restoredAt: string,
  ): readonly string[] {
    return this.transaction(() => {
      const report = this.getCompaction(reportId)
      if (report === undefined) throw new Error(`knowledge compaction report ${reportId} does not exist`)
      if (report.restoredAt !== undefined) throw new Error(`knowledge compaction report ${reportId} has already been restored`)
      validate(report)
      for (const expected of report.resultingVersions) {
        const current = this.getKnowledge(expected.id)
        if (current === undefined || current.version !== expected.version) {
          throw new Error(`knowledge compaction report ${reportId} is stale; ${expected.id} changed after compaction`)
        }
      }
      const restoredIds: string[] = []
      for (const snapshot of report.snapshots) {
        const current = this.getKnowledge(snapshot.id)
        if (current === undefined) throw new Error(`knowledge compaction input ${snapshot.id} no longer exists`)
        this.saveKnowledge({ ...snapshot, version: current.version + 1, updatedAt: restoredAt })
        restoredIds.push(snapshot.id)
      }
      this.saveCompaction({ ...report, restoredAt })
      return restoredIds
    })
  }

  /** Read a knowledge compaction report by identifier.
   * @param id Compaction report identifier.
   * @returns The report, or undefined when absent.
   */
  getCompaction(id: string): KnowledgeCompactionReport | undefined {
    return this.get<KnowledgeCompactionReport>('compaction', id)
  }

  /** List compaction reports applicable to a scope, newest first.
   * @param scope Optional scope filter.
   * @returns Matching compaction reports.
   */
  listCompactions(scope?: ScopeQuery): KnowledgeCompactionReport[] {
    return this.list<KnowledgeCompactionReport>('compaction', projectKeyOf(scope))
      .filter(item => scope === undefined || scopeApplies(scope, item.scope))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Persist a knowledge retrieval regression case and append its event.
   * @param testCase Regression case to save.
   */
  saveRegressionCase(testCase: KnowledgeRegressionCase): void {
    this.put('regression-case', testCase.id, testCase.scope.projectKey, testCase)
    this.eventForScope(testCase.scope.projectKey, 'knowledge/regression-case', testCase)
  }

  /** Read a knowledge regression case by identifier.
   * @param id Regression case identifier.
   * @returns The case, or undefined when absent.
   */
  getRegressionCase(id: string): KnowledgeRegressionCase | undefined {
    return this.get<KnowledgeRegressionCase>('regression-case', id)
  }

  /** List regression cases applicable to a scope in creation order.
   * @param scope Optional scope filter.
   * @returns Matching regression cases.
   */
  listRegressionCases(scope?: ScopeQuery): KnowledgeRegressionCase[] {
    return this.list<KnowledgeRegressionCase>('regression-case', projectKeyOf(scope))
      .filter(item => scope === undefined || scopeApplies(scope, item.scope))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Persist a knowledge regression result and append its scope event when known.
   * @param result Regression result to save.
   */
  saveRegressionResult(result: KnowledgeRegressionResult): void {
    this.put('regression-result', result.id, result.caseId, result)
    const testCase = this.getRegressionCase(result.caseId)
    if (testCase !== undefined) this.eventForScope(testCase.scope.projectKey, 'knowledge/regression-result', result)
  }

  /** List results for one case, or all results when no case is specified.
   * @param caseId Optional regression case identifier.
   * @returns Matching results in newest-first order.
   */
  listRegressionResults(caseId?: string): KnowledgeRegressionResult[] {
    return this.list<KnowledgeRegressionResult>('regression-result', caseId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Persist an aggregate knowledge regression suite and append its event.
   * @param suite Regression suite to save.
   */
  saveRegressionSuite(suite: KnowledgeRegressionSuite): void {
    this.put('regression-suite', suite.id, suite.scope.projectKey, suite)
    this.eventForScope(suite.scope.projectKey, 'knowledge/regression-suite', suite)
  }

  /** List regression suites applicable to a scope, newest first.
   * @param scope Optional scope filter.
   * @returns Matching regression suites.
   */
  listRegressionSuites(scope?: ScopeQuery): KnowledgeRegressionSuite[] {
    return this.list<KnowledgeRegressionSuite>('regression-suite', projectKeyOf(scope))
      .filter(item => scope === undefined || scopeApplies(scope, item.scope))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Persist an external action intent and append its Run event.
   * @param intent Action intent to save.
   */
  saveActionIntent(intent: ActionIntent): void {
    this.transaction(() => this.persistActionIntent(intent))
  }

  /** Atomically persist a planned intent and its ledger entry only when the key is new.
   * @param intent Planned action intent.
   * @param plannedEffect Matching PLANNED side-effect ledger entry.
   * @returns The existing or newly created intent for this Run and idempotency key.
   */
  createActionIntentIfAbsent(intent: ActionIntent, plannedEffect: SideEffectRecord): ActionIntent {
    if (intent.status !== 'PLANNED'
      || plannedEffect.status !== 'PLANNED'
      || plannedEffect.runId !== intent.runId
      || plannedEffect.intentId !== intent.id) {
      throw new TypeError('planned ActionIntent and SideEffect must describe the same Run and intent')
    }
    return this.transaction(() => {
      const existing = this.list<ActionIntent>('action-intent', intent.runId)
        .find(item => item.idempotencyKey === intent.idempotencyKey)
      if (existing !== undefined) return existing
      this.persistActionIntent(intent)
      this.saveSideEffect(plannedEffect)
      return intent
    })
  }

  /** Read an external action intent by identifier.
   * @param id Action intent identifier.
   * @returns The intent, or undefined when absent.
   */
  getActionIntent(id: string): ActionIntent | undefined {
    return this.get<ActionIntent>('action-intent', id)
  }

  /** Atomically validate and persist one ActionIntent transition and optional outcome ledger entry.
   * @param id ActionIntent identity to update.
   * @param update Synchronous state transition evaluated while holding the SQLite write transaction.
   * @param createSideEffect Optional synchronous outcome ledger factory. Its record is committed with the ActionIntent and Events.
   * @returns The persisted ActionIntent, or the existing state after a matching idempotent outcome replay.
   * @throws Error when the intent does not exist or the transition callback rejects the current state.
   */
  updateActionIntent(
    id: string,
    update: (current: ActionIntent) => ActionIntent,
    createSideEffect?: (next: ActionIntent) => SideEffectRecord | undefined,
  ): ActionIntent {
    return this.transaction(() => {
      const current = this.get<ActionIntent>('action-intent', id)
      if (current === undefined) throw new Error(`action intent ${id} does not exist`)
      const next = update(current)
      if (next.id !== current.id || next.runId !== current.runId) {
        throw new Error('ActionIntent identity and Run ownership are immutable')
      }
      const effect = createSideEffect?.(next)
      if (effect !== undefined) {
        if (effect.runId !== next.runId || effect.intentId !== next.id || effect.status !== next.status) {
          throw new Error('ActionIntent outcome and SideEffect ledger must describe the same state')
        }
        const existingEffect = this.get<SideEffectRecord>('side-effect', effect.id)
        if (next === current) {
          if (existingEffect === undefined || !sameSideEffectRecord(existingEffect, effect)) {
            throw new Error(`ActionIntent ${id} outcome replay does not match its durable SideEffect record`)
          }
          return current
        }
        if (existingEffect !== undefined) throw new Error(`SideEffect record ${effect.id} already exists`)
      } else if (next === current) {
        return current
      }
      this.persistActionIntent(next)
      if (effect !== undefined) this.saveSideEffect(effect)
      return next
    })
  }

  /** List action intents for a Run, or all intents when omitted.
   * @param runId Optional owning Run identifier.
   * @returns Matching intents in creation order.
   */
  listActionIntents(runId?: string): ActionIntent[] {
    return this.list<ActionIntent>('action-intent', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Persist a side-effect ledger entry and append its Run event.
   * @param effect Side-effect record to save.
   */
  saveSideEffect(effect: SideEffectRecord): void {
    this.put('side-effect', effect.id, effect.runId, effect)
    this.event(effect.runId, 'side-effect/updated', effect)
  }

  /** Read a side-effect ledger entry by identifier.
   * @param id Side-effect identifier.
   * @returns The record, or undefined when absent.
   */
  getSideEffect(id: string): SideEffectRecord | undefined {
    return this.get<SideEffectRecord>('side-effect', id)
  }

  /** List side-effect records for a Run, or all records when omitted.
   * @param runId Optional owning Run identifier.
   * @returns Matching side-effect records in creation order.
   */
  listSideEffects(runId?: string): SideEffectRecord[] {
    return this.list<SideEffectRecord>('side-effect', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Write a content-addressed artifact below the Run's private directory.
   * @param runId Owning Run identifier.
   * @param kind Artifact category used for metadata and a safe filename.
   * @param content UTF-8 text or raw bytes to persist.
   * @param extension Optional filename extension.
   * @returns Stored artifact metadata including SHA-256 and byte count.
   */
  writeArtifact(runId: string, kind: string, content: string | Uint8Array, extension: string = '.txt'): ArtifactRef {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const safeKind = kind.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'artifact'
    const safeExtension = extension.startsWith('.') ? extension.replace(/[^a-zA-Z0-9.]/g, '') : `.${extension}`
    const runDir = join(this.artifactsRoot, runId, 'artifacts')
    mkdirSync(runDir, { recursive: true })
    const path = join(runDir, `${sha256.slice(0, 16)}-${safeKind}${safeExtension}`)
    writeFileSync(path, bytes, { flag: 'w' })
    const artifact: ArtifactRef = {
      id: `${runId}:${sha256}`,
      runId,
      kind,
      path,
      sha256,
      bytes: bytes.byteLength,
      createdAt: new Date().toISOString(),
    }
    this.put('artifact', artifact.id, runId, artifact)
    this.event(runId, 'artifact/written', artifact)
    return artifact
  }

  /** Read and integrity-check an artifact while enforcing its Run directory boundary.
   * @param artifact Stored artifact metadata.
   * @returns Verified artifact bytes.
   */
  readArtifact(artifact: ArtifactRef): Buffer {
    const root = resolve(this.artifactsRoot, artifact.runId)
    const target = resolve(artifact.path)
    const prefix = root.endsWith(sep) ? root : root + sep
    if (target !== root && !target.startsWith(prefix)) throw new Error('artifact path escapes its run directory')
    const bytes = readFileSync(target)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (bytes.byteLength !== artifact.bytes || sha256 !== artifact.sha256) {
      throw new Error(`artifact ${artifact.id} failed its stored size or SHA-256 integrity check`)
    }
    return bytes
  }

  /** Assemble the complete persisted state view for one AutoDev Run.
   * @param runId Run identifier.
   * @returns Run state plus its plans, evidence, decisions, memory, knowledge, and actions.
   */
  snapshot(runId: string): AutoDevSnapshot {
    const run = this.getRun(runId)
    if (run === undefined) throw new Error(`AutoDev run ${runId} does not exist`)
    const plans = this.listPlans(runId)
    const plan = run.activePlanId === undefined
      ? plans.at(-1)
      : this.getPlan(run.activePlanId)
    const candidate = run.candidateId === undefined ? undefined : this.getCandidate(run.candidateId)
    const candidateHistory: CandidateRevisionSummary[] = this.listCandidates(runId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(({ id, runId: candidateRunId, planId, baseCommit, gitTreeHash, attempt, diffArtifactId, createdAt }) => ({
        id,
        runId: candidateRunId,
        planId,
        baseCommit,
        gitTreeHash,
        ...(attempt === undefined ? {} : { attempt }),
        diffAvailable: diffArtifactId !== undefined,
        createdAt,
      }))
    return {
      run,
      ...(plan === undefined ? {} : { plan }),
      nodes: this.listNodes(runId),
      ...(candidate === undefined ? {} : { candidate }),
      candidateHistory,
      evidence: this.listEvidence(runId),
      decisions: this.listDecisions(runId),
      gates: this.listGates(runId),
      signals: this.listAgentSignals(runId),
      verificationChecks: this.listVerificationChecks(runId),
      verificationResults: this.listVerificationResults(runId),
      verifications: this.listVerificationReports(runId),
      memories: this.listMemories(run.scope ?? run.projectKey ?? run.repoRoot),
      assumptions: this.listAssumptions(runId).filter(item =>
        scopeApplies(run.scope ?? { projectKey: run.projectKey ?? run.repoRoot }, item.scope),
      ),
      uncertainties: this.listUncertainties(runId).filter(item =>
        scopeApplies(run.scope ?? { projectKey: run.projectKey ?? run.repoRoot }, item.scope),
      ),
      concepts: this.listConcepts(run.scope ?? run.projectKey ?? run.repoRoot),
      conceptObservations: this.listConceptObservations(run.scope ?? run.projectKey ?? run.repoRoot),
      playbooks: this.listPlaybooks(run.scope ?? run.projectKey ?? run.repoRoot),
      playbookFits: this.listPlaybookFits(runId),
      knowledge: this.listKnowledge(run.scope ?? run.projectKey ?? run.repoRoot),
      knowledgeMergeProposals: this.listKnowledgeMergeProposals(run.scope ?? run.projectKey ?? run.repoRoot),
      compactions: this.listCompactions(run.scope ?? run.projectKey ?? run.repoRoot),
      regressionCases: this.listRegressionCases(run.scope ?? run.projectKey ?? run.repoRoot),
      regressionResults: this.listRegressionCases(run.scope ?? run.projectKey ?? run.repoRoot).flatMap(item =>
        this.listRegressionResults(item.id),
      ),
      regressionSuites: this.listRegressionSuites(run.scope ?? run.projectKey ?? run.repoRoot),
      actionIntents: this.listActionIntents(runId),
      sideEffects: this.listSideEffects(runId),
      auditEvents: this.listAuditEvents(runId),
    }
  }

  /** Read a bounded newest-first projection of structured append-only audit entries.
   * @param runId Owning Run identifier.
   * @returns Up to 100 most recent path-free audit events, in chronological order.
   */
  listAuditEvents(runId: string): AutoDevAuditEvent[] {
    return this.events(runId)
      .filter(event => event.type === 'audit/action')
      .map(event => event.payload as AutoDevAuditEvent)
      .slice(-100)
  }

  /** Append one typed audit event to the existing Run event stream.
   * @param auditEvent Host-created event with no request text or filesystem path.
   */
  appendAuditEvent(auditEvent: AutoDevAuditEvent): void {
    this.event(auditEvent.runId, 'audit/action', auditEvent)
  }

  /** Read a Run's append-only event stream in sequence order.
   * @param runId Run identifier used as the event stream key.
   * @returns Event sequence, type, decoded payload, and timestamp.
   */
  events(runId: string): readonly { seq: number; type: string; payload: unknown; createdAt: string }[] {
    const rows = this.db.prepare(
      'SELECT seq, type, payload, created_at AS createdAt FROM autodev_events WHERE run_id = ? ORDER BY seq',
    ).all(runId) as { seq: number; type: string; payload: string; createdAt: string }[]
    return rows.map(row => ({ seq: row.seq, type: row.type, payload: parse(row.payload), createdAt: row.createdAt }))
  }

  private event(runId: string, type: string, payload: unknown): void {
    this.db.prepare(
      'INSERT INTO autodev_events (run_id, type, payload, created_at) VALUES (?, ?, ?, ?)',
    ).run(runId, type, JSON.stringify(payload), new Date().toISOString())
  }

  private eventForScope(scope: string, type: string, payload: unknown): void {
    if (scope !== '') this.event(scope, type, payload)
  }

  private persistActionIntent(intent: ActionIntent): void {
    const previous = this.get<ActionIntent>('action-intent', intent.id)
    this.put('action-intent', intent.id, intent.runId, intent)
    this.event(intent.runId, 'action/updated', intent)
    if (intent.authorizedBy !== undefined && intent.status === 'AUTHORIZED' && previous?.status !== 'AUTHORIZED') {
      this.appendAuditEvent({
        id: `${intent.id}:authorized:${intent.updatedAt}`, runId: intent.runId, action: 'action-authorized',
        actor: intent.authorizedBy, resourceKind: 'action-intent', resourceId: intent.id, result: 'AUTHORIZED',
        risk: intent.risk, createdAt: intent.updatedAt,
      })
    } else if (intent.authorizedBy !== undefined
      && ['COMMITTED', 'FAILED', 'UNKNOWN', 'REJECTED'].includes(intent.status)
      && previous?.status !== intent.status) {
      this.appendAuditEvent({
        id: `${intent.id}:result:${intent.status}:${intent.updatedAt}`, runId: intent.runId, action: 'action-result',
        actor: intent.authorizedBy, resourceKind: 'action-intent', resourceId: intent.id,
        result: intent.status as AutoDevAuditEvent['result'], risk: intent.risk, createdAt: intent.updatedAt,
      })
    }
  }

  private put(kind: RecordKind, id: string, runId: string, value: unknown): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO autodev_records (kind, id, run_id, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, id) DO UPDATE SET value = excluded.value, run_id = excluded.run_id, updated_at = excluded.updated_at
    `).run(kind, id, runId || null, JSON.stringify(value), now, now)
  }

  private get<T>(kind: RecordKind, id: string): T | undefined {
    const row = this.db.prepare(
      'SELECT value FROM autodev_records WHERE kind = ? AND id = ?',
    ).get(kind, id) as { value?: string } | undefined
    return row?.value === undefined ? undefined : parse<T>(row.value)
  }

  private list<T>(kind: RecordKind, runId?: string): T[] {
    const rows = runId === undefined
      ? this.db.prepare('SELECT value FROM autodev_records WHERE kind = ?').all(kind)
      : this.db.prepare('SELECT value FROM autodev_records WHERE kind = ? AND run_id = ?').all(kind, runId)
    return (rows as { value: string }[]).map(row => parse<T>(row.value))
  }

  private assertRunNotLockedByCleanup(runId: string): void {
    const now = Date.now()
    for (const job of this.listRetentionCleanupJobs()) {
      if (job.items.some(item => item.runId === runId
        && item.status === 'EXECUTING'
        && item.leaseExpiresAt !== undefined
        && Date.parse(item.leaseExpiresAt) > now)) {
        throw new Error(`AutoDev run ${runId} is temporarily locked by retention cleanup`)
      }
    }
  }

  /** Run synchronous SQLite reads and writes atomically; do not pass an async callback.
   * @param body - Database work to execute within one SQLite transaction.
   * @returns The value returned by the transaction callback.
   * @internal
   */
  withTransaction<T>(body: () => T): T {
    return this.transaction(body)
  }

  private transaction<T>(body: () => T): T {
    const nested = this.transactionDepth > 0
    const savepoint = `autodev_nested_${this.transactionDepth}`
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
    this.transactionDepth += 1
    try {
      const result = body()
      this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT')
      return result
    } catch (error: unknown) {
      try {
        if (nested) {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`)
        } else {
          this.db.exec('ROLLBACK')
        }
      } catch { /* preserve the original failure */ }
      throw error
    } finally {
      this.transactionDepth -= 1
    }
  }
}

const legacySourceRefsKey = ['pro', 'venance'].join('')

function sameCleanupSelection(
  left: RetentionCleanupJobRecord['items'],
  right: RetentionCleanupJobRecord['items'],
): boolean {
  const signature = (items: RetentionCleanupJobRecord['items']) => items
    .map(item => `${item.retentionId}\0${item.runId}\0${item.attempt}`)
    .sort()
    .join('\n')
  return signature(left) === signature(right)
}

function sameSideEffectRecord(left: SideEffectRecord, right: SideEffectRecord): boolean {
  return left.id === right.id
    && left.runId === right.runId
    && left.intentId === right.intentId
    && left.status === right.status
    && left.summary === right.summary
    && left.beforeFingerprint === right.beforeFingerprint
    && left.afterFingerprint === right.afterFingerprint
    && left.createdAt === right.createdAt
    && left.evidenceIds.length === right.evidenceIds.length
    && left.evidenceIds.every((id, index) => id === right.evidenceIds[index])
}

function samePlanDefinition(left: PlanVersion, right: PlanVersion): boolean {
  const withoutLifecycle = (plan: PlanVersion): Omit<PlanVersion, 'status'> => {
    const { status: _status, ...definition } = plan
    return definition
  }
  return stableJson(withoutLifecycle(left)) === stableJson(withoutLifecycle(right))
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

const CLEANUP_TERMINAL_RUN_STATES = new Set<Run['status']>(['PROMOTED', 'FAILED', 'CANCELLED', 'ABANDONED'])
const CLEANUP_UNSETTLED_ACTIONS = new Set(['PLANNED', 'AUTHORIZED', 'EXECUTING', 'UNKNOWN'])

function withCleanupJobEvent(
  job: RetentionCleanupJobRecord,
  items: RetentionCleanupJobRecord['items'],
  type: RetentionCleanupJobRecord['events'][number]['type'],
  at: string,
  retentionId?: string,
  failureCode?: RetentionCleanupFailureCode,
): RetentionCleanupJobRecord {
  const allRemoved = items.every(item => item.status === 'REMOVED')
  const hasPending = items.some(item => item.status === 'PENDING' || item.status === 'EXECUTING')
  const status = allRemoved ? 'COMPLETED' : hasPending ? 'EXECUTING' : 'NEEDS_ATTENTION'
  return {
    ...job,
    status,
    updatedAt: at,
    items,
    events: [...job.events, {
      at,
      type,
      ...(retentionId === undefined ? {} : { retentionId }),
      ...(failureCode === undefined ? {} : { failureCode }),
    }],
  }
}

function parse<T>(value: string): T {
  return normalizeLegacySourceRefs(JSON.parse(value)) as T
}

function normalizeLegacySourceRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeLegacySourceRefs)
  if (value === null || typeof value !== 'object') return value

  const record = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, normalizeLegacySourceRefs(child)]),
  ) as Record<string, unknown>
  if (!Object.hasOwn(record, legacySourceRefsKey)) return record

  const legacyRefs = record[legacySourceRefsKey]
  const currentRefs = record.sourceRefs
  if (currentRefs === undefined) record.sourceRefs = legacyRefs
  else if (Array.isArray(currentRefs) && Array.isArray(legacyRefs)) {
    record.sourceRefs = [...currentRefs, ...legacyRefs]
  } else {
    throw new Error('conflicting persisted source reference fields')
  }
  delete record.provenance
  return record
}

function projectKeyOf(scope: ScopeQuery | undefined): string | undefined {
  return scope === undefined ? undefined : typeof scope === 'string' ? scope.trim() : normalizeScope(scope).projectKey
}

function requireSettingKey(value: string): string {
  const key = value.trim()
  if (key.length === 0 || key.length > 128) throw new TypeError('AutoDev setting key must be non-empty and bounded')
  return key
}
