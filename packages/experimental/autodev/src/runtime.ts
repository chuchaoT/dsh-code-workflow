/** AutoDev's durable Run state machine and serial software-engineering scheduler. */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createAutoDevBackup, restoreAutoDevBackup } from './backup.ts'
import type {
  AutoDevBackupManifest,
  AutoDevCleanupJobView,
  AutoDevAuditActor,
  AutoDevConfig,
  AutoDevRetentionPreview,
  AutoDevSnapshot,
  ArtifactContent,
  BuildDriverId,
  BusinessConcept,
  CandidateRevision,
  CreateRunRequest,
  DecisionPurpose,
  EnvironmentFingerprint,
  ExecuteRetentionCleanupRequest,
  EvidenceType,
  FailureAction,
  HumanGate,
  JevDecision,
  KnowledgeCandidate,
  KnowledgeSearchHit,
  KnowledgeRegressionCase,
  MemorySearchHit,
  NodeExecution,
  PlanNode,
  PlanVersion,
  Playbook,
  ProjectMemory,
  PrepareRetentionCleanupRequest,
  ProviderCatalog,
  ProviderInfo,
  RouteCandidate,
  Run,
  RunStatus,
  RetentionCleanupFailureCode,
  RetentionCleanupJobRecord,
  ScopeRef,
  VerificationReport,
} from './contracts.ts'
import { HarnessCommandExecutor, type CommandExecutor, type CommandResult } from './command.ts'
import { commandForDriver, detectBuildDrivers, selectBuildDriver, type DriverSettings } from './drivers.ts'
import { GitManager, GitPromotionError, GitWorktreeCleanupError } from './git.ts'
import { answerOf, DecisionCoordinator, JevUnavailableError, type DecisionProvider } from './jev.ts'
import { ProviderRouter, type CustomProvider } from './router.ts'
import { AgentProtocol, isValidAgentSignalEnvelope, MAX_AGENT_CONTEXT_CHARS, normalizeSignal, type AutoDevAgentContext, type AgentSignalEnvelope, type AgentTask } from './protocol.ts'
import { AutoDevStore, defaultDataRoot } from './store.ts'
import { defaultVerificationChecks, evaluateVerification } from './verification.ts'
import { BusinessConceptService } from './concepts.ts'
import { KnowledgeService } from './knowledge.ts'
import { ProjectMemoryService } from './memory.ts'
import { PlaybookService } from './playbook.ts'
import { SemanticService } from './semantics.ts'
import { idempotencyKey, SideEffectService } from './side-effects.ts'
import { normalizeScope, sameScope, scopeApplies } from './scope.ts'
import { previewAutoDevRetention, resolveRetentionCleanupTarget } from './retention.ts'
import { createModePlanNodes, isReadOnlyMode, modeTaskInstruction, resolveAutoDevMode } from './mode.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host AutoDev service and Remote namespace owner. */
    autodev: AutoDevRuntime
  }
}

/** Injectable runtime dependencies for tests and Host composition. */
export interface AutoDevRuntimeOptions {
  readonly store?: AutoDevStore
  readonly commands?: CommandExecutor
  readonly decisions?: DecisionCoordinator
  readonly sessionBridge?: AutoDevSessionBridge
}

/** Narrow DSH Session Controller seam used for browser-started Runs. */
export interface AutoDevSessionBridge {
  inspect(sessionId: string, signal?: AbortSignal): Promise<{ readonly meta: { readonly cwd?: string } }>
  resolveAgent(sessionId: string): Promise<{ readonly agent: unknown } | { readonly error: Error }>
}

interface ActiveRunOperation {
  readonly controller: AbortController
  readonly signal: AbortSignal
  readonly completion: Promise<void>
  readonly disposeSignal: () => void
  readonly settle: () => void
}

const ALLOWED_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['EXECUTING', 'PAUSED', 'CANCELLED', 'REWORK_REQUESTED', 'NEEDS_INTERVENTION'],
  EXECUTING: ['BUILDING', 'TESTING', 'VERIFY', 'FAILED', 'NEEDS_INTERVENTION', 'PAUSED', 'CANCELLED'],
  BUILDING: ['TESTING', 'FAILED', 'NEEDS_INTERVENTION', 'PAUSED', 'CANCELLED'],
  TESTING: ['VERIFY', 'FAILED', 'NEEDS_INTERVENTION', 'PAUSED', 'CANCELLED'],
  VERIFY: ['PROMOTING', 'REWORK_REQUESTED', 'NEEDS_INTERVENTION', 'CANCELLED', 'ABANDONED'],
  PROMOTING: ['PROMOTED', 'NEEDS_INTERVENTION'],
  PROMOTED: [],
  PAUSED: ['READY', 'EXECUTING', 'NEEDS_INTERVENTION', 'CANCELLED'],
  NEEDS_INTERVENTION: ['DRAFT', 'READY', 'REWORK_REQUESTED', 'ABANDONED', 'CANCELLED', 'PROMOTING'],
  FAILED: ['NEEDS_INTERVENTION', 'REWORK_REQUESTED', 'ABANDONED', 'CANCELLED'],
  CANCELLED: [],
  ABANDONED: [],
  REWORK_REQUESTED: ['READY', 'EXECUTING', 'NEEDS_INTERVENTION', 'CANCELLED'],
}

const MAX_REMOTE_ARTIFACT_BYTES = 512 * 1024
const MAX_CLEANUP_SELECTION = 10
const CLEANUP_HEARTBEAT_MS = 10_000
const CLEANUP_LEASE_MS = 60_000

/** Main Host-owned AutoDev service. */
export class AutoDevRuntime extends TypertRemoteService {
  /** Durable repository for Runs, Evidence, decisions, and project knowledge. */
  readonly store: AutoDevStore
  /** Bounded command executor used by Git and build/test drivers. */
  readonly commands: CommandExecutor
  /** Worktree creation, drift checks, and verified promotion service. */
  readonly git: GitManager
  /** Jev-backed decision coordinator used by routing and human decisions. */
  readonly decisions: DecisionCoordinator
  /** Dynamic provider registry and route selector. */
  readonly router: ProviderRouter
  /** Agent task, context, cancellation, and signal contract service. */
  readonly protocol: AgentProtocol
  /** Assumption and semantic uncertainty lifecycle service. */
  readonly semantics: SemanticService
  /** Scope-aware project memory retrieval and budgeting service. */
  readonly memory: ProjectMemoryService
  /** Business concept and observation service. */
  readonly concepts: BusinessConceptService
  /** Reusable, scope-aware playbook service. */
  readonly playbooks: PlaybookService
  /** Evidence-backed knowledge, compaction, and regression service. */
  readonly knowledge: KnowledgeService
  /** Approval and idempotency ledger for external side effects. */
  readonly sideEffects: SideEffectService
  private readonly hostContext: Context
  private readonly sessionBridge: AutoDevSessionBridge | undefined
  /** Fully resolved and validated runtime settings. */
  readonly config: ResolvedAutoDevConfig
  private readonly activeRuns = new Map<string, ActiveRunOperation>()
  private readonly runtimeInstanceId = randomUUID()
  private disposing = false

  constructor(
    ctx: Context,
    config: AutoDevConfig = {},
    options: AutoDevRuntimeOptions = {},
  ) {
    super(ctx, 'autodev')
    this.hostContext = ctx
    this.sessionBridge = options.sessionBridge
    this.config = resolveConfig(config)
    this.store = options.store ?? new AutoDevStore(this.config.dataRoot)
    this.commands = options.commands ?? new HarnessCommandExecutor(getService<SubprocessRuntime>(ctx, 'subprocess'))
    this.git = new GitManager(this.commands, this.config.worktreeRoot)
    this.decisions = options.decisions ?? new DecisionCoordinator({ config: this.config.jev })
    this.router = new ProviderRouter({
      ...(this.config.routes === undefined ? {} : { routes: this.config.routes }),
      decisions: this.decisions,
      store: this.store,
      subagents: getService<SubagentRuntime>(ctx, 'subagents'),
    })
    this.protocol = new AgentProtocol()
    this.semantics = new SemanticService(this.store)
    this.memory = new ProjectMemoryService(this.store)
    this.concepts = new BusinessConceptService(this.store)
    this.playbooks = new PlaybookService(this.store)
    this.knowledge = new KnowledgeService(this.store)
    this.sideEffects = new SideEffectService(this.store)
    this.recoverInterruptedRuns()
  }

  /** List the durable Runs available to the profile's Web dashboard.
   * @returns Runs ordered by most recent update.
   */
  @Remote('list')
  listRuns(): readonly Run[] {
    return this.store.listRuns()
  }

  /** Create a verified backup in a new operator-selected directory.
   * @param request New destination path outside the live AutoDev data root.
   * @param signal DSH Remote cancellation signal; cancellation is checked before the backup is published.
   * @returns The backup manifest, whose file paths are relative to the backup.
   */
  @Remote('createBackup')
  async remoteCreateBackup(
    request: { readonly destinationPath: string },
    signal: AbortSignal,
  ): Promise<AutoDevBackupManifest> {
    signal.throwIfAborted()
    return createAutoDevBackup(this.store, request.destinationPath, signal)
  }

  /** Restore a verified backup to a new operator-selected data root.
   * @param request Backup directory, new target, and the exact target path typed by the operator for confirmation.
   * @param signal DSH Remote cancellation signal; cancellation is checked before the restored directory is published.
   * @returns The verified backup manifest; the running Store is not switched to the restored root.
   */
  @Remote('restoreBackup')
  async remoteRestoreBackup(
    request: {
      readonly backupPath: string
      readonly targetDataRoot: string
      readonly confirmedTargetDataRoot: string
    },
    signal: AbortSignal,
  ): Promise<AutoDevBackupManifest> {
    signal.throwIfAborted()
    if (request.confirmedTargetDataRoot !== request.targetDataRoot) {
      throw new Error('AutoDev restore confirmation must exactly match the new data root')
    }
    return restoreAutoDevBackup(request.backupPath, request.targetDataRoot, signal)
  }

  /** Return a path-free, read-only preview of Worktrees eligible for retention.
   * @param request Optional minimum terminal age in days; defaults to 30.
   * @param signal DSH Remote cancellation signal.
   * @returns Eligible and protected Worktrees plus an observed-state fingerprint.
   */
  @Remote('retentionPreview')
  remoteRetentionPreview(request: { readonly minAgeDays?: number }, signal: AbortSignal): AutoDevRetentionPreview {
    signal.throwIfAborted()
    const preview = previewAutoDevRetention(
      this.store,
      this.config.worktreeRoot,
      new Set(this.activeRuns.keys()),
      request.minAgeDays,
    )
    signal.throwIfAborted()
    return preview
  }

  /** List path-free retention Cleanup Jobs for recovery and audit review.
   * @returns Recent durable Jobs without filesystem paths or user identity claims.
   */
  @Remote('retentionCleanupJobs')
  remoteRetentionCleanupJobs(): readonly AutoDevCleanupJobView[] {
    return this.store.listRetentionCleanupJobs().slice(0, 50).map(cleanupJobView)
  }

  /** Persist an explicit bounded selection without deleting or modifying any Worktree.
   * @param request Idempotency key, exact current preview fingerprint, and selected IDs.
   * @returns A path-free Job and the exact text required for its second confirmation.
   */
  @Remote('prepareRetentionCleanup')
  remotePrepareRetentionCleanup(request: PrepareRetentionCleanupRequest): AutoDevCleanupJobView {
    validatePrepareRetentionCleanupRequest(request)
    const preview = previewAutoDevRetention(
      this.store,
      this.config.worktreeRoot,
      new Set(this.activeRuns.keys()),
      request.minAgeDays,
    )
    if (preview.snapshotFingerprint !== request.snapshotFingerprint) {
      throw new Error('retention Preview changed; review a fresh Preview before preparing cleanup')
    }
    const eligible = new Map(preview.eligibleWorktrees.map(item => [item.retentionId, item]))
    const selected = request.retentionIds.map((id) => {
      const item = eligible.get(id)
      if (item === undefined) throw new Error(`selected Worktree ${id} is no longer eligible for retention cleanup`)
      return { retentionId: id, runId: item.runId, attempt: item.attempt, status: 'PENDING' as const }
    })
    const now = new Date().toISOString()
    const actor = this.remoteActor()
    const peerId = actor.kind === 'dsh-operator' ? actor.connectionPeerId : undefined
    const job: RetentionCleanupJobRecord = {
      id: request.requestId,
      status: 'AWAITING_CONFIRMATION',
      minAgeDays: request.minAgeDays,
      snapshotFingerprint: request.snapshotFingerprint,
      createdAt: now,
      updatedAt: now,
      items: selected,
      events: [{ at: now, type: 'prepared', ...(peerId === undefined ? {} : { sourcePeerId: peerId }), actor }],
      ...(peerId === undefined ? {} : { requestedFromPeerId: peerId }),
      requestedBy: actor,
    }
    return cleanupJobView(this.store.createRetentionCleanupJob(job).job)
  }

  /** Execute or resume a confirmed Cleanup Job after rechecking the current Preview and each target.
   * @param request Job id, freshly observed fingerprint, and the UI's typed confirmation phrase.
   * @param signal DSH Remote cancellation signal; an individual Git removal is allowed to settle once claimed.
   * @returns Latest path-free durable Job state.
   */
  @Remote('executeRetentionCleanup')
  async remoteExecuteRetentionCleanup(
    request: ExecuteRetentionCleanupRequest,
    signal: AbortSignal,
  ): Promise<AutoDevCleanupJobView> {
    validateExecuteRetentionCleanupRequest(request)
    signal.throwIfAborted()
    let job = this.store.getRetentionCleanupJob(request.jobId)
    if (job === undefined) throw new Error(`retention cleanup job ${request.jobId} does not exist`)
    if (request.confirmationPhrase !== retentionCleanupConfirmationPhrase(job.id)) {
      throw new Error('retention cleanup confirmation text does not match the selected Job')
    }
    if (job.status === 'COMPLETED' || job.status === 'CANCELLED') return cleanupJobView(job)

    const freshPreview = previewAutoDevRetention(
      this.store,
      this.config.worktreeRoot,
      new Set(this.activeRuns.keys()),
      job.minAgeDays,
    )
    if (freshPreview.snapshotFingerprint !== request.snapshotFingerprint) {
      throw new Error('retention Preview changed; review a fresh Preview before confirming cleanup')
    }
    if (job.status === 'AWAITING_CONFIRMATION'
      && (job.snapshotFingerprint !== freshPreview.snapshotFingerprint
        || job.items.some(item => !freshPreview.eligibleWorktrees.some(eligible => eligible.retentionId === item.retentionId)))) {
      throw new Error('prepared retention selection is stale; create a new Cleanup Job from the current Preview')
    }

    const actor = this.remoteActor()
    const peerId = actor.kind === 'dsh-operator' ? actor.connectionPeerId : undefined
    job = this.store.confirmRetentionCleanupJob(job.id, peerId, actor)
    const leaseTimer = setInterval(() => {
      const leaseExpiresAt = new Date(Date.now() + CLEANUP_LEASE_MS).toISOString()
      this.store.renewRetentionCleanupLeases(this.runtimeInstanceId, leaseExpiresAt)
    }, CLEANUP_HEARTBEAT_MS)
    leaseTimer.unref?.()
    try {
      for (const selected of job.items) {
        if (selected.status === 'REMOVED') continue
        if (signal.aborted) {
          this.store.pauseRetentionCleanupJob(job.id)
          break
        }
        const leaseExpiresAt = new Date(Date.now() + CLEANUP_LEASE_MS).toISOString()
        const claim = this.store.claimRetentionCleanupItem(job.id, selected.retentionId, this.runtimeInstanceId, leaseExpiresAt)
        if (claim.result !== 'CLAIMED') continue
        try {
          const target = resolveRetentionCleanupTarget(this.store, this.config.worktreeRoot, selected.retentionId)
          if (target === undefined || target.run.id !== selected.runId || target.attempt !== selected.attempt) {
            this.store.settleRetentionCleanupItem(job.id, selected.retentionId, this.runtimeInstanceId, 'BLOCKED', 'target-not-eligible')
            continue
          }
          if (!existsSync(target.path)) {
            if (await this.git.isRegisteredWorktree(target.path, target.run.repoRoot)) {
              this.store.settleRetentionCleanupItem(job.id, selected.retentionId, this.runtimeInstanceId, 'UNKNOWN', 'git-registration-mismatch')
            } else {
              this.store.settleRetentionCleanupItem(job.id, selected.retentionId, this.runtimeInstanceId, 'REMOVED')
            }
            continue
          }
          const itemPreview = previewAutoDevRetention(
            this.store,
            this.config.worktreeRoot,
            new Set(this.activeRuns.keys()),
            job.minAgeDays,
          )
          if (itemPreview.eligibleWorktrees.some(item => item.retentionId === selected.retentionId) === false) {
            this.store.settleRetentionCleanupItem(job.id, selected.retentionId, this.runtimeInstanceId, 'BLOCKED', 'run-state-changed')
            continue
          }
          await this.git.removeWorktreeSafely(target.path, target.run.repoRoot)
          this.store.settleRetentionCleanupItem(job.id, selected.retentionId, this.runtimeInstanceId, 'REMOVED')
        } catch (error: unknown) {
          const failureCode = cleanupFailureCode(error)
          const itemStatus = failureCode === 'git-remove-failed' || failureCode === 'interrupted' ? 'FAILED' : 'BLOCKED'
          this.store.settleRetentionCleanupItem(job.id, selected.retentionId, this.runtimeInstanceId, itemStatus, failureCode)
        }
      }
    } finally {
      clearInterval(leaseTimer)
    }
    job = this.store.getRetentionCleanupJob(job.id) ?? job
    if (job.status === 'EXECUTING' && !job.items.some(item => item.status === 'EXECUTING' && item.leaseExpiresAt !== undefined && Date.parse(item.leaseExpiresAt) > Date.now())) {
      this.store.pauseRetentionCleanupJob(job.id)
      job = this.store.getRetentionCleanupJob(job.id) ?? job
    }
    return cleanupJobView(job)
  }

  /** Cancel a prepared Job before any filesystem operation has been authorized.
   * @param jobId Job to cancel.
   * @returns The latest path-free Job.
   */
  @Remote('cancelRetentionCleanup')
  remoteCancelRetentionCleanup(jobId: string): AutoDevCleanupJobView {
    const actor = this.remoteActor()
    const sourcePeerId = actor.kind === 'dsh-operator' ? actor.connectionPeerId : undefined
    return cleanupJobView(this.store.cancelRetentionCleanupJob(jobId, sourcePeerId, actor))
  }

  /** Read one authoritative Run snapshot.
   * @param runId - The Run to inspect.
   * @returns The current persisted Run state and related records.
   */
  @Remote('snapshot')
  remoteSnapshot(runId: string): AutoDevSnapshot {
    return this.snapshot(runId)
  }

  /** Read the registered Providers and configured routes.
   * @returns A detached Provider and route catalog.
   */
  @Remote('providers')
  remoteProviders(): ProviderCatalog {
    return { providers: this.listProviders(), routes: this.router.listRoutes() }
  }

  /** Create a Run and immutable Plan for Web review without starting a Provider.
   * @param request - Local repository, task, acceptance checks, and optional Driver.
   * @param signal - Cancellation of repository inspection.
   * @returns The persisted Run snapshot for review.
   */
  @Remote('create')
  async remoteCreate(request: CreateRunRequest, signal: AbortSignal): Promise<AutoDevSnapshot> {
    return this.create(request, signal)
  }

  /** Record explicit approval for exactly the Plan shown to the caller.
   * @param request Run and reviewed Plan version identifiers.
   * @returns The ready Run with an auditable approval Evidence item.
   */
  @Remote('approvePlan')
  remoteApprovePlan(request: { readonly runId: string; readonly planId: string }): AutoDevSnapshot {
    this.store.approvePlan(request.runId, request.planId, randomUUID(), this.remoteActor())
    return this.snapshot(request.runId)
  }

  /** Start an approved Plan from an ordinary DSH Session bound to this repository.
   * The Run outlives this short Remote call and can be observed via snapshot.
   * @param request Run and framework-bound Session identities.
   * @param signal Cancellation only for admission, not the background Run.
   * @returns The latest durable snapshot after execution has been admitted.
   */
  @Remote('start')
  async remoteStart(request: { readonly runId: string; readonly sessionId: string }, signal: AbortSignal): Promise<AutoDevSnapshot> {
    signal.throwIfAborted()
    const run = this.requireRun(request.runId)
    const plan = this.activePlan(run)
    if (run.approvedPlanId !== plan.id || run.approvedPlanFingerprint !== plan.fingerprint) {
      throw new Error(`active Plan ${plan.id} has not been explicitly approved`)
    }
    if (!['READY', 'REWORK_REQUESTED', 'PAUSED'].includes(run.status) || this.activeRuns.has(run.id)) {
      throw new Error(`run ${run.id} is not ready for another start`)
    }
    const parent = await this.resolveParentAgent(run.id, request.sessionId, signal)
    const operation = this.run(run.id, parent)
    void operation.catch((error: unknown) => {
      this.hostContext.logger.error(`autodev: Web-started Run ${run.id} failed before normal settlement: ${errorMessage(error)}`)
    })
    return this.snapshot(run.id)
  }

  /** Search bounded Memory records within the Run's derived project scope.
   * @param request - The Run, query, and optional result limits.
   * @returns Matching summaries that apply to the Run's scope.
   */
  @Remote('memorySearch')
  remoteMemorySearch(request: {
    readonly runId: string
    readonly query: string
    readonly limit?: number
    readonly maxChars?: number
  }): readonly MemorySearchHit[] {
    const run = this.requireRun(request.runId)
    return this.memory.search(runScope(run), request.query, {
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
    })
  }

  /** Read one Memory record after checking its scope against the Run.
   * @param request - The Run and Memory identifiers.
   * @returns The scoped record, or `undefined` when it does not exist.
   */
  @Remote('memoryDetail')
  remoteMemoryDetail(request: { readonly runId: string; readonly memoryId: string }): ProjectMemory | undefined {
    const run = this.requireRun(request.runId)
    const memory = this.memory.get(request.memoryId)
    if (memory !== undefined && !scopeApplies(runScope(run), memory.scope)) throw new Error('memory is outside the run scope')
    return memory
  }

  /** Read the open semantic decisions associated with one Run.
   * @param runId - The Run whose assumptions and uncertainties are requested.
   * @returns The Run's assumptions and currently open uncertainties.
   */
  @Remote('semanticState')
  remoteSemanticState(runId: string): { readonly assumptions: AutoDevSnapshot['assumptions']; readonly uncertainties: AutoDevSnapshot['uncertainties'] } {
    this.requireRun(runId)
    return {
      assumptions: this.store.listAssumptions(runId),
      uncertainties: this.semantics.openForRun(runId),
    }
  }

  /** Search Concepts using the Run's request and project scope.
   * @param runId - The Run that supplies the query and scope.
   * @returns Up to eight matching Concepts.
   */
  @Remote('concepts')
  remoteConcepts(runId: string): readonly BusinessConcept[] {
    const run = this.requireRun(runId)
    return this.concepts.search(runScope(run), run.request).slice(0, 8)
  }

  /** Read a Concept only when it belongs to the Run's scope.
   * @param request - The Run and Concept identifiers.
   * @returns The scoped Concept, or `undefined` when it does not exist.
   */
  @Remote('conceptDetail')
  remoteConceptDetail(request: { readonly runId: string; readonly conceptId: string }): BusinessConcept | undefined {
    const run = this.requireRun(request.runId)
    const concept = this.store.getConcept(request.conceptId)
    if (concept !== undefined && !scopeApplies(runScope(run), concept.scope)) throw new Error('concept is outside the run scope')
    return concept
  }

  /** Read observations for a Concept after validating its scope.
   * @param request - The Run and Concept identifiers.
   * @returns Observations for the selected Concept in the Run's scope.
   */
  @Remote('conceptHistory')
  remoteConceptHistory(request: { readonly runId: string; readonly conceptId: string }): AutoDevSnapshot['conceptObservations'] {
    const run = this.requireRun(request.runId)
    const concept = this.store.getConcept(request.conceptId)
    if (concept === undefined || !scopeApplies(runScope(run), concept.scope)) throw new Error('concept is outside the run scope')
    return this.store.listConceptObservations(runScope(run)).filter(item => item.conceptId === concept.id)
  }

  /** Add an Agent or operator observation to a project Concept.
   * @param request - The Run, Concept observation, and optional Evidence references.
   * @returns The updated authoritative Run snapshot.
   */
  @Remote('observeConcept')
  remoteObserveConcept(request: {
    readonly runId: string
    readonly key: string
    readonly name: string
    readonly definition: string
    readonly target: string
    readonly effect: string
    readonly evidenceSummary: string
    readonly evidenceIds?: readonly string[]
    readonly confidence?: number
  }): AutoDevSnapshot {
    const run = this.requireRun(request.runId)
    const observed = this.concepts.observe({
      scope: runScope(run),
      runId: run.id,
      ...(run.activePlanId === undefined ? {} : { planId: run.activePlanId }),
      key: request.key,
      name: request.name,
      definition: request.definition,
      target: request.target, effect: request.effect, evidenceSummary: request.evidenceSummary,
      ...(request.evidenceIds === undefined ? {} : { evidenceIds: request.evidenceIds }),
      ...(request.confidence === undefined ? {} : { confidence: request.confidence }),
      sourceRefs: [{ sourceType: 'run', sourceId: run.id, runId: run.id }],
    })
    this.store.updateRun(run.id, current => ({
      ...current,
      conceptIds: [...new Set([...(current.conceptIds ?? []), observed.concept.id])],
    }))
    return this.snapshot(run.id)
  }

  /** Record an explicit human correction for a project Concept.
   * @param request - The Run, corrected definition, and resolution rationale.
   * @returns The updated authoritative Run snapshot.
   */
  @Remote('correctConcept')
  remoteCorrectConcept(request: {
    readonly runId: string
    readonly key: string
    readonly name: string
    readonly definition: string
    readonly target: string
    readonly effect: string
    readonly evidenceSummary: string
    readonly resolution: string
    readonly evidenceIds?: readonly string[]
  }): AutoDevSnapshot {
    const run = this.requireRun(request.runId)
    this.assertProjectSemanticMutationAllowed(run)
    const corrected = this.concepts.correct({
      scope: runScope(run),
      runId: run.id,
      ...(run.activePlanId === undefined ? {} : { planId: run.activePlanId }),
      key: request.key,
      name: request.name,
      definition: request.definition,
      target: request.target, effect: request.effect, evidenceSummary: request.evidenceSummary, resolution: request.resolution,
      ...(request.evidenceIds === undefined ? {} : { evidenceIds: request.evidenceIds }),
    })
    this.store.updateRun(run.id, current => ({ ...current, conceptIds: [...new Set([...(current.conceptIds ?? []), corrected.id])] }))
    this.requirePlanReviewAfterSemanticMutation(run.id, `Business Concept ${corrected.key} changed to v${corrected.version}; the active Plan must be re-evaluated`)
    return this.snapshot(run.id)
  }

  /** List relevant Playbooks for the Run's project scope.
   * @param runId - The Run that supplies the scope and request.
   * @returns Up to eight applicable Playbooks.
   */
  @Remote('playbooks')
  remotePlaybooks(runId: string): readonly Playbook[] {
    const run = this.requireRun(runId)
    return this.playbooks.list(runScope(run)).slice(0, 8)
  }

  /** Read one Playbook after validating its project scope.
   * @param request - The Run and Playbook identifiers.
   * @returns The requested Playbook.
   */
  @Remote('playbookDetail')
  remotePlaybookDetail(request: { readonly runId: string; readonly playbookId: string }): Playbook {
    const run = this.requireRun(request.runId)
    const playbook = this.playbooks.require(request.playbookId)
    if (!scopeApplies(runScope(run), playbook.scope)) throw new Error('playbook is outside the run scope')
    return playbook
  }

  /** Create a Run-scoped Draft Playbook for later human activation.
   * @param request - Scoped Playbook content authored from this Run.
   * @returns The updated project snapshot.
   */
  @Remote('createPlaybook')
  remoteCreatePlaybook(request: {
    readonly runId: string
    readonly key: string
    readonly name: string
    readonly purpose: string
    readonly targets: readonly string[]
    readonly effects: readonly string[]
    readonly conceptKeys?: readonly string[]
    readonly exclusions?: readonly string[]
    readonly steps: readonly string[]
    readonly requiredEvidence?: readonly EvidenceType[]
  }): AutoDevSnapshot {
    const run = this.requireRun(request.runId)
    this.playbooks.create({
      scope: runScope(run), key: request.key, name: request.name, purpose: request.purpose,
      targets: request.targets, effects: request.effects,
      ...(request.conceptKeys === undefined ? {} : { conceptKeys: request.conceptKeys }),
      ...(request.exclusions === undefined ? {} : { exclusions: request.exclusions }),
      steps: request.steps,
      ...(request.requiredEvidence === undefined ? {} : { requiredEvidence: request.requiredEvidence }),
      sourceRefs: [{ sourceType: 'human', sourceId: `playbook-draft:${run.id}:${randomUUID()}`, runId: run.id }],
      createdFromRunIds: [run.id],
    })
    return this.snapshot(run.id)
  }

  /** Revise an applicable Playbook as a new immutable version.
   * The operation forces Plan re-review before a non-Draft Run can continue.
   * @param request - Prior version, revised content, and human rationale.
   * @returns The updated project snapshot.
   */
  @Remote('revisePlaybook')
  remoteRevisePlaybook(request: {
    readonly runId: string
    readonly playbookId: string
    readonly name: string
    readonly purpose: string
    readonly targets: readonly string[]
    readonly effects: readonly string[]
    readonly conceptKeys?: readonly string[]
    readonly exclusions?: readonly string[]
    readonly steps: readonly string[]
    readonly requiredEvidence?: readonly EvidenceType[]
    readonly resolution: string
  }): AutoDevSnapshot {
    const run = this.requireRun(request.runId)
    this.assertProjectSemanticMutationAllowed(run)
    const previous = this.playbooks.require(request.playbookId)
    if (!scopeApplies(runScope(run), previous.scope)) throw new Error('playbook is outside the run scope')
    if (previous.status === 'DEPRECATED') throw new Error('a deprecated Playbook cannot be revised; revise its active successor instead')
    const revised = this.playbooks.revise(previous.id, {
      ...(previous.scope === undefined ? {} : { scope: previous.scope }),
      key: previous.key, name: request.name, purpose: request.purpose,
      targets: request.targets, effects: request.effects,
      ...(request.conceptKeys === undefined ? {} : { conceptKeys: request.conceptKeys }),
      ...(request.exclusions === undefined ? {} : { exclusions: request.exclusions }),
      steps: request.steps,
      ...(request.requiredEvidence === undefined ? {} : { requiredEvidence: request.requiredEvidence }),
      confidence: previous.confidence,
      sourceRefs: [...previous.sourceRefs, {
        sourceType: 'human', sourceId: `playbook-correction:${run.id}:${randomUUID()}`, runId: run.id, note: request.resolution,
      }],
      createdFromRunIds: [run.id],
    })
    this.requirePlanReviewAfterSemanticMutation(run.id, `Playbook ${previous.key} revised to v${revised.version}: ${request.resolution}`)
    return this.snapshot(run.id)
  }

  /** Activate an applicable Draft Playbook and require Plan re-review.
   * @param request - The Run and Draft Playbook identities.
   * @returns The updated project snapshot.
   */
  @Remote('activatePlaybook')
  remoteActivatePlaybook(request: { readonly runId: string; readonly playbookId: string }): AutoDevSnapshot {
    const run = this.requireRun(request.runId)
    this.assertProjectSemanticMutationAllowed(run)
    const playbook = this.playbooks.require(request.playbookId)
    if (!scopeApplies(runScope(run), playbook.scope)) throw new Error('playbook is outside the run scope')
    if (playbook.status === 'DEPRECATED') throw new Error('a deprecated Playbook cannot be reactivated; create a new version')
    if (playbook.status !== 'ACTIVE') {
      this.playbooks.activate(playbook.id)
      this.requirePlanReviewAfterSemanticMutation(run.id, `Playbook ${playbook.key} v${playbook.version} was activated; the active Plan must be re-evaluated`)
    }
    return this.snapshot(run.id)
  }

  /** Deprecate an applicable Playbook while retaining its history.
   * @param request - The Run and Playbook identities.
   * @returns The updated project snapshot.
   */
  @Remote('deprecatePlaybook')
  remoteDeprecatePlaybook(request: { readonly runId: string; readonly playbookId: string }): AutoDevSnapshot {
    const run = this.requireRun(request.runId)
    this.assertProjectSemanticMutationAllowed(run)
    const playbook = this.playbooks.require(request.playbookId)
    if (!scopeApplies(runScope(run), playbook.scope)) throw new Error('playbook is outside the run scope')
    if (playbook.status !== 'DEPRECATED') {
      this.playbooks.deprecate(playbook.id)
      this.requirePlanReviewAfterSemanticMutation(run.id, `Playbook ${playbook.key} v${playbook.version} was deprecated; the active Plan must be re-evaluated`)
    }
    return this.snapshot(run.id)
  }

  /** List established or candidate Knowledge records in the Run's scope.
   * @param runId - The Run that supplies the scope.
   * @returns Up to twenty Knowledge records.
   */
  @Remote('knowledge')
  remoteKnowledge(runId: string): readonly KnowledgeCandidate[] {
    const run = this.requireRun(runId)
    return this.knowledge.list(runScope(run)).slice(0, 20)
  }

  /** Search Knowledge with caller-selected, bounded result limits.
   * @param request - The Run, query, and optional result limits.
   * @returns Matching Knowledge summaries and retrieval metadata.
   */
  @Remote('knowledgeSearch')
  remoteKnowledgeSearch(request: {
    readonly runId: string
    readonly query: string
    readonly limit?: number
    readonly maxChars?: number
  }): readonly KnowledgeSearchHit[] {
    const run = this.requireRun(request.runId)
    return this.knowledge.searchHits(runScope(run), request.query, {
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
    })
  }

  /** List the Knowledge regression cases that apply to the Run's scope.
   * @param runId - The Run that supplies the project scope.
   * @returns The current scoped regression cases.
   */
  @Remote('knowledgeRegressionCases')
  remoteKnowledgeRegressionCases(runId: string): readonly KnowledgeRegressionCase[] {
    const run = this.requireRun(runId)
    return this.store.listRegressionCases(runScope(run))
  }

  /** Create a scoped Knowledge retrieval regression case.
   * @param request - The Run, query, and expected or forbidden statements.
   * @returns The updated authoritative Run snapshot.
   */
  @Remote('createKnowledgeRegression')
  remoteCreateKnowledgeRegression(request: {
    readonly runId: string
    readonly operationId?: string
    readonly name: string
    readonly query: string
    readonly expectedStatements: readonly string[]
    readonly forbiddenStatements?: readonly string[]
  }): AutoDevSnapshot {
    const run = this.requireRun(request.runId)
    const intentId = this.beginKnowledgeAction(run.id, 'knowledge-regression-case', request.operationId, 'explicit knowledge regression case creation', this.remoteActor())
    if (intentId === undefined) return this.snapshot(run.id)
    try {
      const testCase = this.knowledge.createRegressionCase({
        scope: runScope(run), name: request.name, query: request.query, expectedStatements: request.expectedStatements,
        ...(request.forbiddenStatements === undefined ? {} : { forbiddenStatements: request.forbiddenStatements }),
      })
      this.sideEffects.commit(intentId, `knowledge regression case ${testCase.id} created`, undefined, testCase.id)
    } catch (error: unknown) {
      this.failKnowledgeAction(intentId, `knowledge regression case creation failed: ${errorMessage(error)}`)
      throw error
    }
    return this.snapshot(run.id)
  }

  /** Run the current regression suite for the Run's Knowledge scope.
   * @param runId - The Run that supplies the project scope.
   * @param operationId - Optional caller identity used to deduplicate Remote retries.
   * @returns The updated snapshot with the persisted suite result.
   */
  @Remote('runKnowledgeRegressionSuite')
  remoteRunKnowledgeRegressionSuite(runId: string, operationId?: string): AutoDevSnapshot {
    const run = this.requireRun(runId)
    const intentId = this.beginKnowledgeAction(run.id, 'knowledge-regression-suite', operationId, 'explicit knowledge regression suite execution', this.remoteActor())
    if (intentId === undefined) return this.snapshot(run.id)
    try {
      const suite = this.knowledge.runRegressionSuite(runScope(run))
      this.sideEffects.commit(intentId, `knowledge regression suite ${suite.id}: ${suite.status}`, undefined, suite.id)
    } catch (error: unknown) {
      this.failKnowledgeAction(intentId, `knowledge regression suite failed: ${errorMessage(error)}`)
      throw error
    }
    return this.snapshot(run.id)
  }

  /** Read a Knowledge record only when it applies to the Run's scope.
   * @param request - The Run and Knowledge identifiers.
   * @returns The scoped Knowledge record, or `undefined` when absent.
   */
  @Remote('knowledgeDetail')
  remoteKnowledgeDetail(request: { readonly runId: string; readonly knowledgeId: string }): KnowledgeCandidate | undefined {
    const run = this.requireRun(request.runId)
    const knowledge = this.knowledge.get(request.knowledgeId)
    if (knowledge !== undefined && !scopeApplies(runScope(run), knowledge.scope)) throw new Error('knowledge is outside the run scope')
    return knowledge
  }

  /** Generate bounded semantic merge proposals for exact-scope Knowledge.
   * @param request Run identifier and optional proposal-generation limits.
   * @returns The authoritative snapshot including persisted review proposals.
   */
  @Remote('proposeKnowledgeMerges')
  remoteProposeKnowledgeMerges(request: {
    readonly runId: string
    readonly limit?: number
    readonly minSimilarity?: number
  }): AutoDevSnapshot {
    const run = this.requireRun(request.runId)
    this.knowledge.proposeMerges(runScope(run), {
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.minSimilarity === undefined ? {} : { minSimilarity: request.minSimilarity }),
    })
    return this.snapshot(request.runId)
  }

  /** Accept a Knowledge merge as a new Candidate without changing its inputs.
   * @param request Run, proposal, human-authored merged text, and review rationale.
   * @returns The authoritative snapshot including the Candidate and resolved proposal.
   */
  @Remote('acceptKnowledgeMerge')
  remoteAcceptKnowledgeMerge(request: {
    readonly runId: string
    readonly proposalId: string
    readonly statement: string
    readonly content?: string
    readonly resolution: string
  }): AutoDevSnapshot {
    const run = this.requireRun(request.runId)
    const proposal = this.store.getKnowledgeMergeProposal(request.proposalId)
    if (proposal === undefined || !scopeApplies(runScope(run), proposal.scope)) throw new Error('knowledge merge proposal is outside the Run scope')
    const intent = this.sideEffects.plan({ runId: run.id, kind: 'memory-write', target: `knowledge-merge:${proposal.id}`, risk: 'medium' })
    this.sideEffects.authorize(intent.id, `human reviewed Knowledge merge: ${request.resolution}`, this.remoteActor())
    this.sideEffects.start(intent.id)
    try {
      const candidate = this.knowledge.acceptMergeProposal(proposal.id, request)
      this.sideEffects.commit(intent.id, `Knowledge merge ${proposal.id} created Candidate ${candidate.id}`, undefined, String(candidate.version))
    } catch (error: unknown) {
      this.sideEffects.fail(intent.id, `Knowledge merge ${proposal.id} was not accepted: ${errorMessage(error)}`)
      throw error
    }
    return this.snapshot(request.runId)
  }

  /** Reject a Knowledge merge while retaining the human rationale.
   * @param request Run, proposal, and reason to keep the inputs separate.
   * @returns The authoritative snapshot with the rejected proposal.
   */
  @Remote('rejectKnowledgeMerge')
  remoteRejectKnowledgeMerge(request: {
    readonly runId: string
    readonly proposalId: string
    readonly resolution: string
  }): AutoDevSnapshot {
    const run = this.requireRun(request.runId)
    const proposal = this.store.getKnowledgeMergeProposal(request.proposalId)
    if (proposal === undefined || !scopeApplies(runScope(run), proposal.scope)) throw new Error('knowledge merge proposal is outside the Run scope')
    const intent = this.sideEffects.plan({ runId: run.id, kind: 'memory-write', target: `knowledge-merge-rejection:${proposal.id}`, risk: 'low' })
    this.sideEffects.authorize(intent.id, `human rejected Knowledge merge: ${request.resolution}`, this.remoteActor())
    this.sideEffects.start(intent.id)
    try {
      this.knowledge.rejectMergeProposal(proposal.id, request.resolution)
      this.sideEffects.commit(intent.id, `Knowledge merge ${proposal.id} was rejected`)
    } catch (error: unknown) {
      this.sideEffects.fail(intent.id, `Knowledge merge ${proposal.id} could not be rejected: ${errorMessage(error)}`)
      throw error
    }
    return this.snapshot(request.runId)
  }

  /** Resolve or dismiss an uncertainty owned by the Run.
   * @param request - The Run, uncertainty, status, and human resolution.
   * @returns The updated authoritative Run snapshot.
   */
  @Remote('resolveUncertainty')
  remoteResolveUncertainty(request: { readonly runId: string; readonly uncertaintyId: string; readonly status: 'RESOLVED' | 'DISMISSED'; readonly resolution: string }): AutoDevSnapshot {
    const run = this.requireRun(request.runId)
    const uncertainty = this.store.getUncertainty(request.uncertaintyId)
    if (uncertainty === undefined || uncertainty.runId !== request.runId || !scopeApplies(runScope(run), uncertainty.scope)) {
      throw new Error('uncertainty is not part of this run scope')
    }
    this.semantics.resolveUncertainty(request.uncertaintyId, request.status, request.resolution)
    return this.snapshot(run.id)
  }

  /** Resolve an assumption and open a Gate when invalidation needs replanning.
   * @param request - The Run, assumption, resolution, and optional Evidence ids.
   * @returns The updated authoritative Run snapshot.
   */
  @Remote('resolveAssumption')
  remoteResolveAssumption(request: { readonly runId: string; readonly assumptionId: string; readonly status: 'CONFIRMED' | 'INVALIDATED' | 'UNKNOWN'; readonly resolution: string; readonly evidenceIds?: readonly string[] }): AutoDevSnapshot {
    const run = this.requireRun(request.runId)
    const assumption = this.store.getAssumption(request.assumptionId)
    if (assumption === undefined || assumption.runId !== request.runId || !scopeApplies(runScope(run), assumption.scope)) {
      throw new Error('assumption is not part of this run scope')
    }
    const resolved = this.semantics.resolveAssumption(request.assumptionId, request.status, request.resolution, request.evidenceIds)
    if (request.status === 'INVALIDATED') {
      const reason = `assumption invalidated; active Plan requires human re-evaluation: ${resolved.statement}`
      const gate = run.currentGateId === undefined ? undefined : this.store.getGate(run.currentGateId)
      if (gate?.status === 'OPEN') {
        const options = [...new Set<HumanGate['options'][number]>([...gate.options, 'replan'])]
        this.store.saveGate({ ...gate, reason: `${gate.reason}; ${reason}`, options })
        this.store.updateRun(run.id, current => ({ ...current, lastError: reason }))
      } else if (!['PROMOTED', 'ABANDONED', 'CANCELLED'].includes(run.status)) {
        this.openGate(run.id, reason, ['replan', 'rework', 'abandon', 'cancel'])
      }
    }
    return this.snapshot(run.id)
  }

  /** Compact Knowledge in the Run's exact scope and record the side effect.
   * @param runId - The Run that supplies the Knowledge scope.
   * @param operationId - Optional caller identity used to deduplicate Remote retries.
   * @returns The updated authoritative Run snapshot.
   */
  @Remote('compactKnowledge')
  remoteCompactKnowledge(runId: string, operationId?: string): AutoDevSnapshot {
    const run = this.requireRun(runId)
    const intentId = this.beginKnowledgeAction(runId, `knowledge-compaction:${run.projectKey ?? run.repoRoot}`, operationId, 'explicit knowledge compaction', this.remoteActor())
    if (intentId === undefined) return this.snapshot(runId)
    try {
      const report = this.knowledge.compact(runScope(run))
      this.sideEffects.commit(intentId, `knowledge compaction ${report.id} completed`)
    } catch (error: unknown) {
      this.failKnowledgeAction(intentId, `knowledge compaction failed: ${errorMessage(error)}`)
      throw error
    }
    return this.snapshot(runId)
  }

  /** Restore a compaction only when its snapshots and versions still match.
   * @param request - The Run and compaction report identifiers.
   * @returns The updated authoritative Run snapshot.
   */
  @Remote('restoreKnowledgeCompaction')
  remoteRestoreKnowledgeCompaction(request: { readonly runId: string; readonly reportId: string }): AutoDevSnapshot {
    const run = this.requireRun(request.runId)
    const report = this.store.getCompaction(request.reportId)
    if (report === undefined || !sameScope(report.scope, runScope(run))) throw new Error('knowledge compaction report is outside the run scope')
    const intent = this.sideEffects.plan({ runId: request.runId, kind: 'memory-write', target: `knowledge-compaction-restore:${report.id}`, risk: 'medium' })
    this.sideEffects.authorize(intent.id, 'explicit knowledge compaction restoration', this.remoteActor())
    this.sideEffects.start(intent.id)
    try {
      const restoredIds = this.knowledge.restoreCompaction(report.id)
      this.sideEffects.commit(intent.id, `knowledge compaction ${report.id} restored`, undefined, restoredIds.join(','))
    } catch (error: unknown) {
      this.sideEffects.fail(intent.id, `knowledge compaction restoration failed: ${errorMessage(error)}`)
      throw error
    }
    return this.snapshot(request.runId)
  }

  /** Promote a Knowledge candidate after Evidence and regression validation.
   * @param request - The Run, candidate, Evidence ids, and passing case id.
   * @returns The updated authoritative Run snapshot.
   */
  @Remote('promoteKnowledge')
  remotePromoteKnowledge(request: {
    readonly runId: string
    readonly knowledgeId: string
    readonly evidenceIds: readonly string[]
    readonly regressionCaseId: string
  }): AutoDevSnapshot {
    const run = this.requireRun(request.runId)
    const knowledge = this.knowledge.get(request.knowledgeId)
    if (knowledge === undefined || !scopeApplies(runScope(run), knowledge.scope)) throw new Error('knowledge candidate is outside the run scope')
    const intent = this.sideEffects.plan({ runId: request.runId, kind: 'knowledge-promotion', target: request.knowledgeId, risk: 'medium' })
    this.sideEffects.authorize(intent.id, 'explicit knowledge promotion', this.remoteActor())
    this.sideEffects.start(intent.id)
    try {
      const promoted = this.knowledge.promote(request.knowledgeId, request.evidenceIds, request.regressionCaseId)
      this.sideEffects.commit(intent.id, `knowledge ${promoted.id} established`, undefined, promoted.version.toString(), request.evidenceIds)
    } catch (error: unknown) {
      this.sideEffects.fail(intent.id, `knowledge promotion failed: ${errorMessage(error)}`, request.evidenceIds)
      throw error
    }
    return this.snapshot(request.runId)
  }

  /** Resolve a browser-visible Gate action without accepting arbitrary Agent input.
   * Retry and rework require the DSH Session bound to this repository and use
   * its live parent Agent. Their Run outlives the short Remote admission call.
   * @param request - The Run, selected Gate action, and optional DSH Session identity.
   * @param signal - The Host request cancellation signal for admission.
   * @returns The updated authoritative Run snapshot.
   */
  @Remote('resolveGate')
  async remoteResolveGate(request: { readonly runId: string; readonly action: 'retry' | 'rework' | 'replan' | 'abandon' | 'promote' | 'cancel'; readonly sessionId?: string }, signal: AbortSignal): Promise<AutoDevSnapshot> {
    this.requireOpenGateAction(request.runId, request.action)
    const actor = this.remoteActor()
    if (request.action !== 'retry' && request.action !== 'rework') {
      return this.resolveGate(request.runId, request.action, undefined, signal, actor)
    }
    if (request.sessionId === undefined || request.sessionId.trim() === '') {
      throw new Error(`Gate action ${request.action} requires a live DSH Session bound to the AutoDev repository`)
    }
    const parent = await this.resolveParentAgent(request.runId, request.sessionId, signal)
    signal.throwIfAborted()
    this.requireOpenGateAction(request.runId, request.action)
    const operation = this.resolveGate(request.runId, request.action, parent, undefined, actor)
    void operation.catch((error: unknown) => {
      this.hostContext.logger.error(`autodev: Web Gate action ${request.action} for Run ${request.runId} failed before normal settlement: ${errorMessage(error)}`)
    })
    return this.snapshot(request.runId)
  }

  /** Promote after the browser has presented the Candidate and Evidence.
   * @param runId - The Run whose verified Candidate is being promoted.
   * @param signal - The Host request cancellation signal.
   * @returns The updated authoritative Run snapshot.
   */
  @Remote('promote')
  async remotePromote(runId: string, signal: AbortSignal): Promise<AutoDevSnapshot> {
    return this.promote(runId, signal, this.remoteActor())
  }

  /** Cancel a Run while retaining its Worktree and artifacts.
   * @param runId - The Run to cancel.
   * @returns The updated authoritative Run snapshot.
   */
  @Remote('cancel')
  async remoteCancel(runId: string): Promise<AutoDevSnapshot> {
    return this.cancel(runId)
  }

  /** Return a bounded, path-free Candidate Diff view to the Web Client.
   * @param runId - The Run whose Candidate diff is requested.
   * @param signal - The Host request cancellation signal.
   * @returns The bounded diff artifact, or `undefined` when no Candidate exists.
   */
  @Remote('candidateDiff')
  async remoteCandidateDiff(runId: string, signal: AbortSignal): Promise<ArtifactContent | undefined> {
    signal.throwIfAborted()
    const run = this.requireRun(runId)
    const candidate = run.candidateId === undefined ? undefined : this.store.getCandidate(run.candidateId)
    return this.readCandidateDiff(runId, candidate, signal)
  }

  /** Return a bounded Diff for a specific Candidate that belongs to the Run.
   * @param runId - The owning Run identifier.
   * @param candidateId - Candidate revision identifier from this Run's history.
   * @param signal - The Host request cancellation signal.
   * @returns The bounded Diff artifact, or `undefined` when the Candidate has no Diff.
   */
  @Remote('candidateRevisionDiff')
  async remoteCandidateRevisionDiff(runId: string, candidateId: string, signal: AbortSignal): Promise<ArtifactContent | undefined> {
    signal.throwIfAborted()
    this.requireRun(runId)
    const candidate = this.store.getCandidate(candidateId)
    if (candidate === undefined || candidate.runId !== runId) {
      throw new Error(`candidate ${candidateId} does not belong to run ${runId}`)
    }
    return this.readCandidateDiff(runId, candidate, signal)
  }

  private readCandidateDiff(runId: string, candidate: CandidateRevision | undefined, signal: AbortSignal): ArtifactContent | undefined {
    const artifactId = candidate?.diffArtifactId
    if (artifactId === undefined) return undefined
    const artifact = this.store.getArtifact(artifactId)
    if (artifact === undefined || artifact.runId !== runId || artifact.kind !== 'candidate-diff') {
      throw new Error(`candidate diff ${artifactId} is not available for run ${runId}`)
    }
    const bytes = this.store.readArtifact(artifact)
    const truncated = bytes.byteLength > MAX_REMOTE_ARTIFACT_BYTES
    const content = bytes.subarray(0, MAX_REMOTE_ARTIFACT_BYTES).toString('utf8')
    signal.throwIfAborted()
    return { id: artifact.id, runId, kind: artifact.kind, sha256: artifact.sha256, bytes: artifact.bytes, content, truncated }
  }

  /** Inspect a clean repository and persist a Run, Plan, and baseline Evidence.
   * @param request - The repository, requested change, acceptance criteria, and optional scope.
   * @param signal - Optional cancellation signal for repository inspection.
   * @returns The new Run's authoritative snapshot.
   */
  async create(request: CreateRunRequest, signal?: AbortSignal): Promise<AutoDevSnapshot> {
    const requestText = requireText(request.request, 'request')
    const baseline = await this.git.inspect(request.repoPath, signal)
    if (!baseline.clean) {
      throw new Error(`target repository has uncommitted changes; AutoDev requires a clean baseline:\n${baseline.status.join('\n')}`)
    }
    const selectedMode = resolveAutoDevMode(request.mode, requestText)
    const configuredDriver = request.buildDriver ?? this.config.buildDriver
    const detectedDrivers = detectBuildDrivers(baseline.repoRoot)
    const mayOmitDriver = isReadOnlyMode(selectedMode.mode) || (baseline.kind === 'unborn' && detectedDrivers.length === 0 && configuredDriver === 'auto')
    const buildDriverId = mayOmitDriver && configuredDriver === 'auto'
      ? undefined
      : selectBuildDriver(baseline.repoRoot, configuredDriver)
    const environmentSpec = request.executionEnvironment ?? { kind: 'LOCAL_WORKTREE' as const }
    if (typeof environmentSpec !== 'object' || environmentSpec === null || environmentSpec.kind !== 'LOCAL_WORKTREE') {
      throw new Error(`unsupported execution environment: ${String(environmentSpec?.kind)}`)
    }
    const id = randomUUID()
    const now = new Date().toISOString()
    const run: Run = {
      schemaVersion: 1,
      id,
      repoPath: baseline.repoRoot,
      request: requestText,
      acceptanceCriteria: (request.acceptanceCriteria ?? []).map(item => requireText(item, 'acceptance criterion')),
      status: 'DRAFT',
      baseCommit: baseline.baseCommit,
      mode: selectedMode.mode,
      modeSource: selectedMode.source,
      baselineKind: baseline.kind ?? 'commit',
      executionEnvironment: environmentSpec,
      repoRoot: baseline.repoRoot,
      projectKey: baseline.repoRoot,
      scope: normalizeScope({ projectKey: baseline.repoRoot, ...request.scope }),
      ...(request.goalId === undefined ? {} : { goalId: request.goalId }),
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    }
    const environment = await this.environment(baseline.repoRoot, buildDriverId, signal)
    const plan = this.makePlan(run, buildDriverId)
    this.store.withTransaction(() => {
      this.store.createRun(run)
      this.store.createPlan(plan)
      for (const [index, node] of plan.nodes.entries()) {
        this.store.createNode({
          id: `${plan.id}:${node.id}:0`,
          runId: id,
          planId: plan.id,
          nodeId: node.id,
          attempt: 0,
          status: index === 0 ? 'READY' : 'PENDING',
        })
      }
      this.store.saveEvidence({
        id: randomUUID(),
        runId: id,
        type: 'REPOSITORY_BASELINE',
        status: 'PASS',
        summary: `${baseline.kind === 'unborn' ? 'Empty unborn baseline' : 'Clean baseline'} ${baseline.baseCommit} at ${baseline.repoRoot}`,
        createdAt: now,
      })
      this.store.saveEvidence({
        id: randomUUID(),
        runId: id,
        type: 'ENVIRONMENT',
        status: buildDriverId === undefined && !isReadOnlyMode(selectedMode.mode) ? 'WARN' : 'PASS',
        summary: `Host ${process.platform}/${process.arch}, Node ${process.version}${buildDriverId === undefined && !isReadOnlyMode(selectedMode.mode) ? '; no deterministic Build/Test driver detected' : ''}`,
        environment,
        createdAt: new Date().toISOString(),
      })
      this.store.updateRun(id, current => ({ ...current, activePlanId: plan.id, updatedAt: new Date().toISOString() }))
    })
    return this.snapshot(id)
  }

  /** Read the current authoritative snapshot for a Run.
   * @param runId - The Run to inspect.
   * @returns The persisted Run state and related records.
   */
  snapshot(runId: string): AutoDevSnapshot {
    return this.store.snapshot(runId)
  }

  /** List Providers visible to the current Host runtime.
   * @returns Registered custom Providers and Harness subagents.
   */
  listProviders(): readonly ProviderInfo[] {
    return this.router.list()
  }

  /** Register a Provider for dynamic route selection.
   * @param provider - The adapter identity, capabilities, and run function.
   * @returns A disposer that unregisters this Provider.
   */
  registerProvider(provider: Parameters<ProviderRouter['register']>[0]): () => void {
    return this.router.register(provider)
  }

  /** Register a reversible local-model or Jev-compatible decision backend.
   * @param id Stable provider identifier for audit records.
   * @param provider Typed decision adapter.
   * @param priority Higher values are tried before the configured default Jev endpoint.
   * @returns Disposer that removes only this exact registration.
   */
  registerDecisionProvider(id: string, provider: DecisionProvider, priority: number = 0): () => void {
    return this.decisions.registerProvider(id, provider, priority)
  }

  /** Add a candidate backed by a Provider already loaded by Harness, such as an ACP subagent.
   * @param routeName Existing AutoDev route to extend.
   * @param candidate Provider kind, registered name, and route-specific capabilities.
   * @returns A disposer that removes only this candidate.
   */
  registerRouteCandidate(routeName: string, candidate: RouteCandidate): () => void {
    return this.router.registerCandidate(routeName, candidate)
  }

  /** Register a custom Provider and append it to an existing route as one reversible operation.
   * If candidate registration fails, the Provider registration is rolled back. The returned
   * disposer removes the candidate and Provider together, which lets an extension Bundle
   * unload without leaving a dangling route entry or an unreachable Provider.
   * @param routeName Existing AutoDev route to extend.
   * @param provider Custom Provider adapter to register.
   * @param candidate Route-specific model, enabled state, or capability declaration.
   * @returns A disposer that unregisters both parts of the extension.
   */
  registerRoutedProvider(
    routeName: string,
    provider: CustomProvider,
    candidate: Pick<RouteCandidate, 'enabled' | 'model' | 'traits'> = {},
  ): () => void {
    const unregisterProvider = this.router.register(provider)
    let removeCandidate: (() => void)
    try {
      removeCandidate = this.router.registerCandidate(routeName, {
        kind: provider.kind,
        provider: provider.name,
        ...(candidate.enabled === undefined ? {} : { enabled: candidate.enabled }),
        ...(candidate.model === undefined ? {} : { model: candidate.model }),
        traits: [...(candidate.traits ?? provider.traits)],
      })
    } catch (error: unknown) {
      unregisterProvider()
      throw error
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      removeCandidate()
      unregisterProvider()
    }
  }

  /** Execute the current Plan in a dedicated Worktree and retain all Evidence.
   * @param runId - The Run to execute or resume.
   * @param parentAgent - Optional Harness Agent context passed to subagent adapters.
   * @param signal - Optional caller cancellation signal.
   * @returns The updated authoritative Run snapshot.
   */
  async run(runId: string, parentAgent?: unknown, signal?: AbortSignal): Promise<AutoDevSnapshot> {
    if (this.disposing) throw new Error('AutoDev Runtime is disposing and cannot start another Run')
    const run = this.requireRun(runId)
    if (this.activeRuns.has(runId)) throw new Error(`run ${runId} already has an active operation`)
    const plan = this.activePlan(run)
    if (run.approvedPlanId !== plan.id || run.approvedPlanFingerprint !== plan.fingerprint) {
      throw new Error(`active Plan ${plan.id} has not been explicitly approved; review and approve this exact Plan version before execution`)
    }
    if (!['READY', 'REWORK_REQUESTED', 'PAUSED'].includes(run.status)) {
      throw new Error(`run ${runId} is ${run.status}; only READY, REWORK_REQUESTED, or PAUSED runs can start`)
    }
    if (this.reconcileRunAssumptions(runId)) return this.snapshot(runId)
    if (run.attempt >= this.config.maxAttempts) {
      this.openGate(runId, `maximum AutoDev attempts (${this.config.maxAttempts}) reached; review the retained Worktree before continuing`, ['rework', 'replan', 'cancel'])
      return this.snapshot(runId)
    }
    const operation = this.beginRunOperation(runId, signal)
    const operationSignal = operation.signal
    try {
      const nextAttempt = run.attempt + 1
      // Every explicit retry/rework gets a fresh Worktree. Retaining the old
      // path is important for review, but reusing it would let a failed Agent
      // silently carry unknown edits into another Provider invocation.
      const worktreePath = run.worktreePath !== undefined && run.attempt === 0
        ? run.worktreePath
        : await this.git.createWorktree(run.id, {
          repoPath: run.repoPath,
          repoRoot: run.repoRoot,
          baseCommit: run.baseCommit,
          kind: run.baselineKind ?? 'commit',
          clean: true,
          status: [],
          capturedAt: run.createdAt,
        }, operationSignal, nextAttempt)
      if (run.worktreePath !== worktreePath) {
        this.store.updateRun(run.id, current => ({ ...current, worktreePath, status: current.status }))
      }
      operationSignal.throwIfAborted()
      this.transition(run.id, 'EXECUTING', { attempt: run.attempt + 1, lastError: undefined, currentGateId: undefined })
      await this.executeImplementation(run.id, worktreePath, parentAgent, operationSignal)
      operationSignal.throwIfAborted()
      if (plan.nodes.some(node => node.kind === 'build')) {
        await this.executeBuild(run.id, worktreePath, operationSignal)
        operationSignal.throwIfAborted()
      }
      if (plan.nodes.some(node => node.kind === 'test')) {
        await this.executeTest(run.id, worktreePath, operationSignal)
        operationSignal.throwIfAborted()
      }
      if (!isReadOnlyMode(run.mode ?? 'DEV') && !await this.executeQuality(run.id, operationSignal)) return this.snapshot(run.id)
      operationSignal.throwIfAborted()
      await this.executeCompletion(run.id, operationSignal)
      return this.snapshot(run.id)
    } catch (error: unknown) {
      if (error instanceof InterventionRequiredError) {
        this.openGate(run.id, error.message, error.options)
      } else if (error instanceof JevUnavailableError) {
        this.openGate(run.id, `Jev is required but unavailable: ${error.message}`, ['retry', 'rework', 'cancel'])
      } else if (isAbort(error, operationSignal)) {
        this.settleInterruptedRun(runId, 'Run execution was interrupted; inspect the retained Worktree before resuming')
      } else {
        const message = errorMessage(error)
        this.transitionIfAllowed(run.id, 'FAILED', { lastError: message })
        const gate = await this.failureGate(run.id, message, error, operationSignal)
        if (operationSignal.aborted) {
          this.settleInterruptedRun(runId, 'Run execution was interrupted while resolving a failure; inspect the retained Worktree before resuming')
        } else {
          this.openGate(run.id, gate.reason, gate.options)
        }
      }
      return this.snapshot(run.id)
    } finally {
      this.finishRunOperation(runId, operation)
    }
  }

  /** Apply an action that the current Human Gate explicitly permits.
   * @param runId - The Run with the open Gate.
   * @param action - The selected Gate action.
   * @param parentAgent - Optional Harness Agent context used for resumed execution.
   * @param signal - Optional caller cancellation signal.
   * @param actor - Host-derived initiating source; it is never read from request data.
   * @returns The updated authoritative Run snapshot.
   */
  async resolveGate(
    runId: string,
    action: 'retry' | 'rework' | 'replan' | 'abandon' | 'promote' | 'cancel',
    parentAgent?: unknown,
    signal?: AbortSignal,
    actor: AutoDevAuditActor = { kind: 'autodev-runtime', source: 'runtime-policy' },
  ): Promise<AutoDevSnapshot> {
    const run = this.requireRun(runId)
    const gate = run.currentGateId === undefined ? undefined : this.store.getGate(run.currentGateId)
    if (gate === undefined || gate.status !== 'OPEN') throw new Error(`run ${runId} has no open Human Gate`)
    if (!gate.options.includes(action)) throw new Error(`action ${action} is not allowed by gate ${gate.id}`)
    if ((action === 'retry' || action === 'rework') && this.activeRuns.has(runId)) {
      throw new Error(`run ${runId} still has an active operation; the Human Gate remains open`)
    }
    const resolveCurrentGate = (): HumanGate => {
      const currentRun = this.requireRun(runId)
      const currentGate = currentRun.currentGateId === undefined ? undefined : this.store.getGate(currentRun.currentGateId)
      if (currentGate === undefined || currentGate.id !== gate.id || currentGate.status !== 'OPEN') {
        throw new Error(`run ${runId} no longer has open Human Gate ${gate.id}`)
      }
      if (!currentGate.options.includes(action)) throw new Error(`action ${action} is not allowed by gate ${currentGate.id}`)
      const resolved: HumanGate = { ...currentGate, status: 'RESOLVED', selected: action, resolvedAt: new Date().toISOString(), resolvedBy: actor }
      this.store.saveGate(resolved)
      return resolved
    }
    if (action === 'promote') {
      const resolved = this.store.withTransaction(() => {
        const selected = resolveCurrentGate()
        this.assertPromotionGateClaimable(this.requireRun(runId))
        this.transition(runId, 'PROMOTING', { currentGateId: undefined })
        return selected
      })
      return this.promoteFromGate(runId, resolved.id, signal, actor)
    }
    if (action === 'replan') {
      this.store.withTransaction(() => {
        resolveCurrentGate()
        this.createReplan(runId)
        this.transition(runId, 'DRAFT', { currentGateId: undefined })
      })
      return this.snapshot(runId)
    }
    this.store.withTransaction(() => {
      resolveCurrentGate()
      this.transition(runId, action === 'abandon' ? 'ABANDONED' : action === 'cancel' ? 'CANCELLED' : action === 'rework' ? 'REWORK_REQUESTED' : 'READY', { currentGateId: undefined })
    })
    if (action === 'abandon' || action === 'cancel') return this.snapshot(runId)
    return this.run(runId, parentAgent, signal)
  }

  /** Revalidate and explicitly apply the verified Candidate to its original checkout.
   * @param runId - The Run whose Candidate is being promoted.
   * @param signal - Optional cancellation signal for promotion checks.
   * @param actor - Host-derived initiating source; it is never read from request data.
   * @returns The updated authoritative Run snapshot.
   */
  async promote(
    runId: string,
    signal?: AbortSignal,
    actor: AutoDevAuditActor = { kind: 'autodev-runtime', source: 'runtime-policy' },
  ): Promise<AutoDevSnapshot> {
    return this.promoteRun(runId, undefined, signal, actor)
  }

  private async promoteFromGate(
    runId: string,
    gateId: string,
    signal: AbortSignal | undefined,
    actor: AutoDevAuditActor,
  ): Promise<AutoDevSnapshot> {
    return this.promoteRun(runId, gateId, signal, actor)
  }

  private async promoteRun(
    runId: string,
    approvedGateId: string | undefined,
    signal: AbortSignal | undefined,
    actor: AutoDevAuditActor = { kind: 'autodev-runtime', source: 'runtime-policy' },
  ): Promise<AutoDevSnapshot> {
    const run = this.requireRun(runId)
    if (run.status === 'PROMOTED') return this.snapshot(runId)
    if (run.status !== 'VERIFY' && run.status !== 'NEEDS_INTERVENTION' && run.status !== 'PROMOTING') {
      throw new Error(`run ${runId} is not ready for promotion`)
    }
    const approvedGate = approvedGateId === undefined ? undefined : this.store.getGate(approvedGateId)
    if (run.status === 'PROMOTING') {
      if (approvedGateId === undefined) {
        throw new Error(`run ${runId} changed while promotion was being claimed`)
      }
      if (approvedGate?.runId !== runId
        || approvedGate.status !== 'RESOLVED' || approvedGate.selected !== 'promote'
        || run.currentGateId !== undefined) {
        throw new Error(`run ${runId} is PROMOTING without its atomically claimed Human Gate`)
      }
    }
    if (run.status === 'NEEDS_INTERVENTION') {
      const gate = run.currentGateId === undefined ? undefined : this.store.getGate(run.currentGateId)
      if (approvedGateId === undefined || gate?.id !== approvedGateId || gate.status !== 'RESOLVED' || gate.selected !== 'promote') {
        throw new Error(`run ${runId} requires an explicitly resolved Human Gate with action promote`)
      }
    } else if (approvedGateId !== undefined && run.status !== 'PROMOTING') {
      throw new Error(`run ${runId} is not awaiting a Human Gate promotion`)
    }
    if (this.reconcileRunAssumptions(runId)) return this.snapshot(runId)
    const candidate = run.candidateId === undefined ? undefined : this.store.getCandidate(run.candidateId)
    if (candidate === undefined || candidate.runId !== runId) throw new Error('run has no sealed candidate')
    if (run.worktreePath === undefined || candidate.worktreePath !== run.worktreePath
      || candidate.planId !== run.activePlanId || candidate.baseCommit !== run.baseCommit
      || candidate.attempt !== run.attempt) {
      return this.blockPromotion(run, 'candidate does not match the active Run, Plan, Attempt, Worktree, and baseline', 'UNKNOWN')
    }
    const activePlan = run.activePlanId === undefined ? undefined : this.store.getPlan(run.activePlanId)
    if (activePlan === undefined || activePlan.runId !== runId || activePlan.status !== 'ACTIVE') {
      return this.blockPromotion(run, 'candidate has no matching active Plan', 'UNKNOWN')
    }
    // Claim the cross-instance promotion lease before writing fresh verification
    // evidence. Otherwise every racing Host repeats the same SQLite writes before
    // one of them wins the lease, creating avoidable lock contention.
    if (run.status === 'PROMOTING') {
      const current = this.requireRun(runId)
      if (current.status !== 'PROMOTING' || current.candidateId !== candidate.id || current.activePlanId !== candidate.planId) {
        throw new Error(`run ${runId} changed after its Human Gate promotion claim`)
      }
    } else {
      this.store.updateRun(runId, (current) => {
        if (current.status !== run.status || current.candidateId !== candidate.id || current.activePlanId !== candidate.planId) {
          throw new Error(`run ${runId} changed while promotion was being claimed`)
        }
        return { ...current, status: 'PROMOTING', currentGateId: undefined, updatedAt: new Date().toISOString() }
      })
    }

    let intentId: string | undefined
    let sideEffectStarted = false
    try {
      if (run.status === 'VERIFY') {
        const verification = this.recordVerification(runId)
        if (verification.candidateId !== candidate.id || verification.status !== 'PASS') {
          const blockedStatus = verification.status === 'PASS' ? 'UNKNOWN' : verification.status
          return this.blockPromotion(run, `promotion verification is ${verification.status}: ${verification.summary}`, blockedStatus)
        }
      }

      const currentTree = await this.git.treeHash(candidate.worktreePath, signal)
      if (currentTree !== candidate.gitTreeHash) {
        throw new GitPromotionError(`sealed Worktree tree changed from ${candidate.gitTreeHash} to ${currentTree}`, 'conflict')
      }
      const patchArtifact = candidate.diffArtifactId === undefined ? undefined : this.store.getArtifact(candidate.diffArtifactId)
      if (patchArtifact === undefined || patchArtifact.runId !== runId || patchArtifact.kind !== 'candidate-diff') {
        throw new GitPromotionError('sealed candidate patch artifact is missing or invalid', 'conflict')
      }
      this.store.readArtifact(patchArtifact)

      const target = `${run.repoRoot}@${run.baseCommit}#${candidate.id}`
      const previousIntents = this.store.listActionIntents(runId).filter(item => item.kind === 'git-promotion' && item.target === target)
      const previous = previousIntents.at(-1)
      const reusableKey = previous !== undefined && ['FAILED', 'PLANNED', 'REJECTED'].includes(previous.status)
        ? previous.idempotencyKey
        : undefined
      const idempotencyKey = reusableKey ?? `${runId}:git-promotion:${candidate.id}:${previousIntents.length}`
      const intent = this.sideEffects.plan({
        runId,
        kind: 'git-promotion',
        target,
        risk: 'destructive',
        preconditions: ['candidate is the active Plan and Attempt', 'sealed Worktree tree is unchanged', 'original baseline is unchanged'],
        idempotencyKey,
      })
      intentId = intent.id
      this.sideEffects.authorize(intent.id, approvedGateId === undefined ? 'explicit promote operation' : `Human Gate ${approvedGateId} explicitly approved promote`, actor)
      this.sideEffects.start(intent.id)
      sideEffectStarted = true
      const outcome = await this.git.promote(run.repoRoot, run.baseCommit, patchArtifact.path, candidate.gitTreeHash, signal, run.baselineKind ?? 'commit')
      const evidence = {
        id: randomUUID(), runId, candidateId: candidate.id, planId: candidate.planId, attempt: candidate.attempt,
        gitTreeHash: candidate.gitTreeHash, type: 'PROMOTION', status: 'PASS',
        summary: outcome === 'already-applied'
          ? `Sealed candidate ${candidate.id} was already applied exactly to ${run.repoRoot}; promotion reconciled`
          : `Applied sealed candidate ${candidate.id} to ${run.repoRoot}`,
        artifactId: patchArtifact.id, createdAt: new Date().toISOString(),
      } as const
      this.store.saveEvidence(evidence)
      this.sideEffects.commit(intent.id, evidence.summary, run.baseCommit, candidate.gitTreeHash, [evidence.id])
      this.transition(runId, 'PROMOTED')
    } catch (error: unknown) {
      const certainty = error instanceof GitPromotionError ? error.certainty : 'unknown'
      if (intentId !== undefined && sideEffectStarted) {
        if (certainty === 'unknown') this.sideEffects.unknown(intentId, `promotion outcome is unknown: ${errorMessage(error)}`)
        else this.sideEffects.fail(intentId, `promotion did not complete: ${errorMessage(error)}`)
      }
      const reason = `promotion ${certainty}: ${errorMessage(error)}`
      this.store.saveEvidence({
        id: randomUUID(), runId, candidateId: candidate.id, planId: candidate.planId, attempt: candidate.attempt,
        gitTreeHash: candidate.gitTreeHash, type: certainty === 'conflict' ? 'DRIFT' : 'PROMOTION',
        status: certainty === 'conflict' ? 'FAIL' : 'UNKNOWN', summary: reason, createdAt: new Date().toISOString(),
      })
      this.transitionIfAllowed(runId, 'NEEDS_INTERVENTION', { lastError: errorMessage(error) })
      const options: HumanGate['options'] = certainty === 'not-applied'
        ? ['promote', 'rework', 'replan', 'abandon', 'cancel']
        : ['rework', 'replan', 'abandon', 'cancel']
      this.openGate(runId, reason, options)
    }
    return this.snapshot(runId)
  }

  private blockPromotion(run: Run, reason: string, status: 'FAIL' | 'WARN' | 'UNKNOWN'): AutoDevSnapshot {
    this.store.saveEvidence({
      id: randomUUID(), runId: run.id, ...(run.candidateId === undefined ? {} : { candidateId: run.candidateId }),
      ...(run.activePlanId === undefined ? {} : { planId: run.activePlanId }), attempt: run.attempt,
      type: 'VERIFICATION', status, summary: reason, createdAt: new Date().toISOString(),
    })
    this.transitionIfAllowed(run.id, 'NEEDS_INTERVENTION', { lastError: reason })
    this.openGate(run.id, reason, ['rework', 'replan', 'abandon', 'cancel'])
    return this.snapshot(run.id)
  }

  /** Check synchronous durable preconditions before consuming a Gate promotion decision.
   * @param run Run currently guarded by an OPEN Human Gate.
   * @throws Error if the Run does not own a sealed Candidate for its active Plan and Attempt.
   */
  private assertPromotionGateClaimable(run: Run): void {
    const candidate = run.candidateId === undefined ? undefined : this.store.getCandidate(run.candidateId)
    if (candidate === undefined || candidate.runId !== run.id) throw new Error('run has no sealed candidate')
    if (run.worktreePath === undefined || candidate.worktreePath !== run.worktreePath
      || candidate.planId !== run.activePlanId || candidate.baseCommit !== run.baseCommit
      || candidate.attempt !== run.attempt) {
      throw new Error('candidate does not match the active Run, Plan, Attempt, Worktree, and baseline')
    }
    const activePlan = run.activePlanId === undefined ? undefined : this.store.getPlan(run.activePlanId)
    if (activePlan === undefined || activePlan.runId !== run.id || activePlan.status !== 'ACTIVE') {
      throw new Error('candidate has no matching active Plan')
    }
  }

  /**
   * Abort active Run work while retaining Worktree and evidence; uncertain effects remain non-promotable.
   * @param runId - Exact Run to cancel.
   * @returns The persisted state after the cancellation request.
   */
  async cancel(runId: string): Promise<AutoDevSnapshot> {
    const run = this.requireRun(runId)
    if (run.status === 'PROMOTING') {
      throw new Error(`run ${runId} is promoting; cancellation cannot safely interrupt repository promotion`)
    }
    if (run.status === 'NEEDS_INTERVENTION') {
      const gate = run.currentGateId === undefined ? undefined : this.store.getGate(run.currentGateId)
      if (gate === undefined || gate.status !== 'OPEN' || !gate.options.includes('cancel')) {
        throw new Error(`run ${runId} has no open Human Gate that allows cancellation`)
      }
      return this.resolveGate(runId, 'cancel')
    }
    if (run.status !== 'CANCELLED' && !ALLOWED_TRANSITIONS[run.status].includes('CANCELLED')) {
      throw new Error(`run ${runId} cannot be cancelled from ${run.status}`)
    }
    this.transition(runId, 'CANCELLED', { lastError: 'cancelled by user; Worktree and evidence retained' })
    this.activeRuns.get(runId)?.controller.abort(new Error('AutoDev Run cancelled by user'))
    return this.snapshot(run.id)
  }

  /**
   * Abort active Runs and await settlement before the owning plugin closes SQLite.
   * @returns A promise that resolves after all active Run operations settle.
   */
  async dispose(): Promise<void> {
    this.disposing = true
    const active = [...this.activeRuns.values()]
    for (const operation of active) operation.controller.abort(new Error('AutoDev Host is disposing'))
    await Promise.all(active.map(operation => operation.completion))
  }

  private async executeImplementation(runId: string, worktreePath: string, parentAgent: unknown, signal: AbortSignal): Promise<void> {
    const run = this.requireRun(runId)
    const plan = this.activePlan(run)
    const mode = run.mode ?? 'DEV'
    const readOnly = isReadOnlyMode(mode)
    this.assertSemanticPlanReady(run, plan)
    const node = plan.nodes.find(item => item.kind !== 'build' && item.kind !== 'test')
    if (node === undefined) throw new Error('active plan has no Agent task node')
    const execution = this.beginNode(run, plan, node)
    const selection = await this.router.select(runId, node.id, 'agent-route', node.routeName ?? (readOnly ? 'review' : 'implement'), {
      request: run.request,
      mode,
      acceptanceCriteria: run.acceptanceCriteria,
      availableProviders: this.router.list(),
    }, readOnly ? ['read-only'] : ['code-edit', 'local-workspace'], signal)
    if (selection.candidate === undefined) {
      const detail = readOnly ? 'no eligible read-only Agent Provider is loaded' : 'no eligible Coding Agent Provider is loaded'
      this.failNode(execution, detail)
      throw new Error(detail)
    }
    const action = this.sideEffects.plan({
      runId,
      nodeId: node.id,
      kind: 'agent-workspace',
      target: worktreePath,
      risk: 'medium',
      preconditions: ['isolated Worktree exists', 'clean candidate baseline'],
      idempotencyKey: `${execution.id}:agent-workspace`,
    })
    this.sideEffects.authorize(action.id, `AutoDev selected provider ${selection.candidate.provider}`)
    this.sideEffects.start(action.id)
    const task: AgentTask = {
      protocolVersion: 'dsh.agent.v1',
      id: `${execution.id}:agent`,
      runId,
      planVersionId: plan.id,
      nodeId: node.id,
      attempt: run.attempt,
      kind: readOnly ? mode === 'REVIEW' ? 'review' : 'analyze' : 'implement',
      instruction: modeTaskInstruction(mode, run.request),
      acceptanceCriteria: run.acceptanceCriteria,
      workspacePath: worktreePath,
      createdAt: new Date().toISOString(),
    }
    const memoryHits = this.memory.search(runScope(run), run.request, { limit: 4, maxChars: 500 })
    const conceptHits = (plan.conceptIds ?? []).flatMap((id) => {
      const concept = this.store.getConcept(id)
      return concept !== undefined && concept.status !== 'DEPRECATED' && scopeApplies(runScope(run), concept.scope) ? [concept] : []
    })
    const assumptions = this.store.listAssumptions(runId).filter(item => scopeApplies(runScope(run), item.scope)).slice(-8)
    const uncertainties = this.store.listUncertainties(runId).filter(item => scopeApplies(runScope(run), item.scope)).slice(-8)
    const playbookHits = this.playbooks.search(runScope(run), run.request).slice(0, 4)
    const knowledgeHits = this.knowledge.searchHits(runScope(run), run.request, { limit: 4, maxChars: 500 })
    const memoryCards = memoryHits.map(hit => [
      `id=${hit.memory.id}; ${hit.memory.kind}/${hit.memory.status}; confidence=${hit.memory.confidence.toFixed(2)}; reason=${hit.reason}`,
      `${hit.memory.title}: ${hit.memory.content}`,
      `sourceRefs=${hit.memory.sourceRefs.map(item => `${item.sourceType}:${item.sourceId}`).join(', ') || 'none'}; evidence=${hit.memory.evidenceIds.join(', ') || 'none'}`,
    ].join('\n'))
    const conceptCards = conceptHits.map(item => [
      `id=${item.id}; key=${item.key}; version=${item.version}; status=${item.status}; confidence=${item.confidence.toFixed(2)}`,
      `${item.name}: ${item.definition}`,
      `target=${item.target}; effect=${item.effect}; evidenceCriteria=${item.evidenceCriteria.join('; ') || 'none'}`,
      `sourceRefs=${item.sourceRefs.map(ref => `${ref.sourceType}:${ref.sourceId}`).join(', ') || 'none'}; evidence=${item.evidenceIds.join(', ') || 'none'}`,
    ].join('\n'))
    const assumptionCards = assumptions.map(item => [
      `id=${item.id}; status=${item.status}; confidence=${item.confidence.toFixed(2)}; planId=${item.planId ?? 'unbound'}`,
      `${item.statement}${item.rationale === undefined ? '' : `; rationale=${item.rationale}`}`,
      `resolution=${item.resolution ?? 'none'}; evidence=${item.evidenceIds.join(', ') || 'none'}; sourceRefs=${item.sourceRefs.map(ref => `${ref.sourceType}:${ref.sourceId}`).join(', ') || 'none'}`,
    ].join('\n'))
    const uncertaintyCards = uncertainties.map(item => [
      `id=${item.id}; status=${item.status}; severity=${item.severity}; planId=${item.planId ?? 'unbound'}`,
      `${item.subject}: ${item.reason}`,
      `alternatives=${item.alternatives.join('; ') || 'none'}; resolution=${item.resolution ?? 'none'}; sourceRefs=${item.sourceRefs.map(ref => `${ref.sourceType}:${ref.sourceId}`).join(', ') || 'none'}`,
    ].join('\n'))
    const playbookCards = playbookHits.map(item => [
      `id=${item.id}; ${item.key} v${item.version}; ${item.status}; confidence=${item.confidence.toFixed(2)}`,
      `${item.name}: ${item.purpose}`,
      `targets=${item.targets.join('; ')}; effects=${item.effects.join('; ')}; exclusions=${item.exclusions?.join('; ') || 'none'}`,
      `steps=${item.steps.join(' -> ')}; requiredEvidence=${item.requiredEvidence.join(', ') || 'none'}; sourceRefs=${item.sourceRefs.map(ref => `${ref.sourceType}:${ref.sourceId}`).join(', ') || 'none'}`,
    ].join('\n'))
    const knowledgeCards = knowledgeHits.map(hit => [
      `id=${hit.knowledge.id}; ${hit.knowledge.kind}/${hit.knowledge.status}; ${hit.temperature}; confidence=${hit.knowledge.confidence.toFixed(2)}; reason=${hit.reason}`,
      `${hit.knowledge.statement}: ${hit.knowledge.content}`,
      `sourceRefs=${hit.knowledge.sourceRefs.map(item => `${item.sourceType}:${item.sourceId}`).join(', ') || 'none'}; evidence=${hit.knowledge.evidenceIds.join(', ') || 'none'}`,
    ].join('\n'))
    const boundedCards = boundAgentContextCards(memoryCards, conceptCards, playbookCards, assumptionCards, uncertaintyCards, knowledgeCards)
    const context: AutoDevAgentContext = {
      mode,
      runId,
      projectKey: run.repoRoot,
      repoRoot: run.repoRoot,
      baseCommit: run.baseCommit,
      workspacePath: worktreePath,
      planVersionId: plan.id,
      nodeId: node.id,
      attempt: run.attempt,
      evidenceIds: this.store.listEvidence(runId).map(item => item.id).slice(-16),
      memoryRefs: memoryHits.map(item => item.memory.id),
      conceptRefs: conceptHits.map(item => item.id),
      assumptionRefs: assumptions.map(item => item.id),
      uncertaintyRefs: uncertainties.map(item => item.id),
      playbookRefs: playbookHits.map(item => item.id),
      knowledgeRefs: knowledgeHits.map(item => item.knowledge.id),
      memoryCards: boundedCards.memoryCards,
      conceptCards: boundedCards.conceptCards,
      assumptionCards: boundedCards.assumptionCards,
      uncertaintyCards: boundedCards.uncertaintyCards,
      playbookCards: boundedCards.playbookCards,
      knowledgeCards: boundedCards.knowledgeCards,
      contextBudget: { maxChars: MAX_AGENT_CONTEXT_CHARS, usedChars: boundedCards.usedChars },
    }
    const contextArtifact = this.store.writeArtifact(runId, 'agent-context', JSON.stringify(context, null, 2), '.json')
    this.store.saveEvidence({
      id: randomUUID(), runId, planId: plan.id, nodeId: node.id, attempt: run.attempt, type: 'AGENT_CONTEXT', status: 'PASS',
      source: 'runtime', artifactId: contextArtifact.id,
      summary: `Provider context captured: ${boundedCards.usedChars}/${MAX_AGENT_CONTEXT_CHARS} summary characters; Memory=${memoryHits.length}, Concept=${conceptHits.length}, Assumption=${assumptions.length}, Uncertainty=${uncertainties.length}, Playbook=${playbookHits.length}, Knowledge=${knowledgeHits.length}.`,
      createdAt: new Date().toISOString(),
    })
    let result: Awaited<ReturnType<AgentProtocol['execute']>>
    try {
      result = await this.protocol.execute(this.router.agentAdapter(selection.candidate), {
        task,
        context,
        signal,
        parentAgent,
      })
    } catch (error: unknown) {
      this.sideEffects.unknown(action.id, `${selection.candidate.provider} invocation outcome is unknown`)
      this.store.saveEvidence({ id: randomUUID(), runId, planId: plan.id, nodeId: node.id, attempt: run.attempt, type: 'SIDE_EFFECT', status: 'UNKNOWN', source: 'system', summary: `${selection.candidate.provider} workspace side effect outcome is unknown`, createdAt: new Date().toISOString() })
      this.unknownNode(execution, errorMessage(error))
      this.store.saveEvidence({
        id: randomUUID(),
        runId,
        planId: plan.id,
        nodeId: node.id,
        attempt: run.attempt,
        type: 'AGENT_OUTPUT',
        status: 'UNKNOWN',
        summary: `${selection.candidate.provider} threw after start; file and external side effects are unknown`,
        createdAt: new Date().toISOString(),
      })
      throw new ExternalOutcomeUnknownError(`${selection.candidate.provider} invocation outcome is unknown`, { cause: error })
    }
    const outputArtifact = this.store.writeArtifact(runId, 'agent-output', result.output)
    if (result.status !== 'completed' || signal.aborted) {
      const diagnostic = result.diagnostic ?? (signal.aborted
        ? 'cancellation was requested before the Provider confirmed completion'
        : `Provider ${result.provider} ended with ${result.status}`)
      const evidenceId = randomUUID()
      this.sideEffects.unknown(action.id, diagnostic, [evidenceId])
      this.store.saveEvidence({
        id: evidenceId, runId, planId: plan.id, nodeId: node.id, attempt: run.attempt,
        type: 'SIDE_EFFECT', status: 'UNKNOWN', source: 'system', summary: `Agent workspace outcome is unknown: ${diagnostic}`, createdAt: new Date().toISOString(),
      })
      this.store.saveEvidence({
        id: randomUUID(), runId, planId: plan.id, nodeId: node.id, attempt: run.attempt,
        type: 'AGENT_OUTPUT', status: 'UNKNOWN', source: 'agent', artifactId: outputArtifact.id,
        summary: `Provider ${result.provider} did not confirm a completed implementation: ${diagnostic}`, createdAt: new Date().toISOString(),
      })
      this.unknownNode(execution, diagnostic)
      throw new ExternalOutcomeUnknownError(`${result.provider} invocation outcome is unknown: ${diagnostic}`)
    }
    const outputTree = await this.git.treeHash(worktreePath, signal)
    const agentEvidence = {
      id: randomUUID(), runId, planId: plan.id, nodeId: node.id, attempt: run.attempt, type: 'AGENT_OUTPUT', status: 'PASS',
      summary: `Provider ${result.provider} completed ${mode.toLowerCase()} task`,
      ...(readOnly ? {} : { gitTreeHash: outputTree }), artifactId: outputArtifact.id, createdAt: new Date().toISOString(),
    } as const
    this.store.saveEvidence(agentEvidence)
    if (readOnly) {
      const baseTreeResult = await this.commands.run(['git', 'rev-parse', `${run.baseCommit}^{tree}`], worktreePath, { signal })
      if (baseTreeResult.exitCode !== 0) throw new Error(`cannot inspect read-only baseline tree: ${baseTreeResult.stderr.trim()}`)
      const worktreeState = await this.commands.run(['git', 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'], worktreePath, { signal })
      const unchanged = baseTreeResult.stdout.trim() === outputTree && worktreeState.exitCode === 0 && worktreeState.stdout.trim() === ''
      const review = mode === 'REVIEW'
      const reviewOutcome = review ? parseReviewOutcome(result.output) : undefined
      const decisionEvidence = {
        id: randomUUID(), runId, planId: plan.id, nodeId: node.id, attempt: run.attempt,
        type: review ? 'REVIEW' as const : 'ANALYSIS' as const,
        status: unchanged && (!review || reviewOutcome === 'PASS') ? 'PASS' as const : 'WARN' as const,
        source: 'agent' as const,
        artifactId: outputArtifact.id,
        summary: !unchanged
          ? 'Read-only Agent modified the isolated Worktree; output is not accepted'
          : review
            ? reviewOutcome === 'PASS' ? 'Read-only Agent returned a structured review with no findings' : 'Review output was missing a valid PASS verdict; human review is required'
            : `${mode} report captured from ${result.provider}`,
        createdAt: new Date().toISOString(),
      }
      this.store.saveEvidence(decisionEvidence)
      if (!unchanged) {
        this.sideEffects.fail(action.id, 'read-only Agent modified the isolated Worktree', [decisionEvidence.id])
        this.store.saveEvidence({
          id: randomUUID(), runId, planId: plan.id, nodeId: node.id, attempt: run.attempt,
          type: 'DRIFT', status: 'FAIL', source: 'system', gitTreeHash: outputTree,
          summary: 'Read-only mode changed the Candidate Worktree; original repository was not touched', createdAt: new Date().toISOString(),
        })
        this.failNode(execution, 'read-only Agent modified the isolated Worktree')
        throw new InterventionRequiredError('read-only mode modified files in its isolated Worktree; inspect the retained result and re-run with an explicit write mode if appropriate', ['abandon', 'cancel'])
      }
      this.sideEffects.commit(action.id, `read-only ${mode.toLowerCase()} report captured`, undefined, outputTree, [agentEvidence.id, decisionEvidence.id])
      this.store.saveEvidence({
        id: randomUUID(), runId, planId: plan.id, nodeId: node.id, attempt: run.attempt,
        type: 'SIDE_EFFECT', status: 'PASS', source: 'system',
        summary: `${mode} Agent completed without changing the Worktree`, createdAt: new Date().toISOString(),
      })
      this.completeNode(execution, selection.candidate.provider, outputTree)
      const intervention = this.ingestAgentSignals(run, plan.id, task, selection.candidate.provider, result.signals)
      if (intervention.reason !== undefined) throw new InterventionRequiredError(intervention.reason, intervention.options)
      return
    }
    const diff = await this.git.diff(worktreePath, run.baseCommit, signal)
    const diffArtifact = this.store.writeArtifact(runId, 'candidate-diff', diff, '.patch')
    const candidate: CandidateRevision = {
      id: randomUUID(), runId, planId: plan.id, worktreePath, baseCommit: run.baseCommit,
      gitTreeHash: outputTree, attempt: run.attempt, diffArtifactId: diffArtifact.id, createdAt: new Date().toISOString(),
    }
    this.store.saveCandidate(candidate)
    this.store.updateRun(runId, current => ({ ...current, candidateId: candidate.id }))
    this.completeNode(execution, selection.candidate.provider, outputTree)
    const intervention = this.ingestAgentSignals(run, plan.id, task, selection.candidate.provider, result.signals)
    if (intervention.unknownSideEffect) {
      this.sideEffects.unknown(action.id, intervention.reason ?? 'unexpected Agent side effect was reported', [agentEvidence.id])
      this.store.saveEvidence({ id: randomUUID(), runId, planId: plan.id, nodeId: node.id, attempt: run.attempt, type: 'SIDE_EFFECT', status: 'UNKNOWN', source: 'agent', summary: intervention.reason ?? 'unexpected Agent side effect was reported', createdAt: new Date().toISOString() })
    } else {
      this.sideEffects.commit(action.id, `sealed candidate ${candidate.id}`, undefined, outputTree, [agentEvidence.id])
      this.store.saveEvidence({ id: randomUUID(), runId, candidateId: candidate.id, planId: plan.id, nodeId: node.id, attempt: run.attempt, gitTreeHash: outputTree, type: 'SIDE_EFFECT', status: 'PASS', source: 'system', summary: `Agent workspace side effect committed at ${outputTree}`, createdAt: new Date().toISOString() })
    }
    if (intervention.reason !== undefined) throw new InterventionRequiredError(intervention.reason, intervention.options)
  }

  private async executeBuild(runId: string, worktreePath: string, signal: AbortSignal): Promise<void> {
    this.transition(runId, 'BUILDING')
    const run = this.requireRun(runId)
    const plan = this.activePlan(run)
    const node = plan.nodes.find(item => item.kind === 'build')
    if (node === undefined) throw new Error('active plan has no build node')
    const execution = this.beginNode(run, plan, node)
    const before = await this.git.treeHash(worktreePath, signal)
    const driverId = this.planDriver(plan, run)
    const command = commandForDriver(driverId, 'build', worktreePath, this.driverSettings())
    const result = await this.runDriverCommand(runId, node.id, worktreePath, command.argv, this.config.buildTimeoutMs, signal)
    const after = await this.git.treeHash(worktreePath, signal)
    this.saveCommandEvidence(runId, node.id, 'BUILD', result, before, after)
    if (before !== after) {
      this.store.saveEvidence({ id: randomUUID(), runId, planId: plan.id, nodeId: node.id, attempt: run.attempt, type: 'DRIFT', status: 'FAIL', gitTreeHash: after, summary: 'Build changed tracked files after the candidate was sealed', createdAt: new Date().toISOString() })
      this.failNode(execution, 'tracked file drift detected during build')
      throw new Error('tracked file drift detected during build')
    }
    if (result.exitCode !== 0 || result.timedOut) {
      this.failNode(execution, result.timedOut ? 'build timed out' : `build exited ${String(result.exitCode)}`)
      throw new Error(result.timedOut ? 'build timed out' : `build failed with exit code ${String(result.exitCode)}`)
    }
    this.completeNode(execution, undefined, after)
  }

  private async executeTest(runId: string, worktreePath: string, signal: AbortSignal): Promise<void> {
    this.transition(runId, 'TESTING')
    const run = this.requireRun(runId)
    const plan = this.activePlan(run)
    const node = plan.nodes.find(item => item.kind === 'test')
    if (node === undefined) throw new Error('active plan has no test node')
    const execution = this.beginNode(run, plan, node)
    const before = await this.git.treeHash(worktreePath, signal)
    const driverId = this.planDriver(plan, run)
    const command = commandForDriver(driverId, 'test', worktreePath, this.driverSettings())
    const result = await this.runDriverCommand(runId, node.id, worktreePath, command.argv, this.config.testTimeoutMs, signal)
    const after = await this.git.treeHash(worktreePath, signal)
    this.saveCommandEvidence(runId, node.id, 'TEST', result, before, after)
    if (before !== after) {
      this.store.saveEvidence({ id: randomUUID(), runId, planId: plan.id, nodeId: node.id, attempt: run.attempt, type: 'DRIFT', status: 'FAIL', gitTreeHash: after, summary: 'Tests changed tracked files after the candidate was sealed', createdAt: new Date().toISOString() })
      this.failNode(execution, 'tracked file drift detected during test')
      throw new Error('tracked file drift detected during test')
    }
    if (result.exitCode !== 0 || result.timedOut) {
      this.failNode(execution, result.timedOut ? 'tests timed out' : `tests exited ${String(result.exitCode)}`)
      throw new Error(result.timedOut ? 'tests timed out' : `tests failed with exit code ${String(result.exitCode)}`)
    }
    this.completeNode(execution, undefined, after)
  }

  private async executeCompletion(runId: string, signal: AbortSignal): Promise<void> {
    this.transition(runId, 'VERIFY')
    const run = this.requireRun(runId)
    const verification = this.recordVerification(runId)
    if (verification.status !== 'PASS') {
      const options: HumanGate['options'] = run.candidateId === undefined
        ? ['rework', 'replan', 'abandon', 'cancel']
        : ['rework', 'replan', 'promote', 'abandon', 'cancel']
      this.openGate(runId, `deterministic verification is ${verification.status}: ${verification.summary}`, options)
      return
    }
    this.recordRunLearnings(run, verification)
    const candidate = run.candidateId === undefined ? undefined : this.store.getCandidate(run.candidateId)
    const result = await this.decisions.evaluate('completion', {
      request: run.request,
      acceptanceCriteria: run.acceptanceCriteria,
      evidence: this.store.listEvidence(runId).map(item => ({ type: item.type, status: item.status, summary: item.summary })),
      candidateTree: candidate?.gitTreeHash,
    }, signal)
    this.recordJev(runId, 'completion', result, result.degraded === undefined ? 'accepted' : 'degraded', result.degraded ?? 'completion decision recorded')
    const answer = answerOf(result, 'completion')
    if (answer?.value === 'work_remaining' || answer?.value === 'human_review') {
      this.openGate(runId, `Jev completion decision: ${String(answer.value)}`, ['rework', 'replan', 'promote', 'abandon', 'cancel'])
    }
  }

  /**
   * Signals are observations, not authority. The Runtime persists them first,
   * translates only the bounded known vocabulary, and gates any signal that
   * changes semantic meaning or reports a blocked/unsafe execution.
   */
  private ingestAgentSignals(
    run: Run,
    planId: string,
    task: AgentTask,
    provider: string,
    envelopes: readonly AgentSignalEnvelope[],
  ): { readonly reason?: string; readonly options: HumanGate['options']; readonly unknownSideEffect: boolean } {
    const reasons: string[] = []
    let options: HumanGate['options'] = ['rework', 'replan', 'abandon', 'cancel']
    let unknownSideEffect = false
    const assumptionIds = [...(run.assumptionIds ?? [])]
    let expectedSequence = 1
    for (const value of envelopes as readonly unknown[]) {
      if (!isValidAgentSignalEnvelope(value, {
        taskId: task.id, runId: run.id, planVersionId: planId, nodeId: task.nodeId,
        attempt: run.attempt, provider, sequence: expectedSequence,
      })) {
        const id = isRecord(value) && typeof value.id === 'string' ? value.id.slice(0, 64) : 'untrusted'
        reasons.push(`Agent Signal envelope ${id} has invalid Run/Plan/node/task/provider/attempt identity or sequence`)
        continue
      }
      expectedSequence += 1
      const envelope: AgentSignalEnvelope = { ...value, signal: normalizeSignal(value.signal) }
      this.store.saveAgentSignal(envelope)
      const signal = envelope.signal
      const sourceRefs = [{ sourceType: 'signal' as const, sourceId: envelope.id, runId: run.id }]
      switch (signal.type) {
        case 'AssumptionRaised': {
          if (signal.statement === undefined || signal.statement.trim() === '') break
          const assumption = this.semantics.raiseAssumption({
            scope: runScope(run), runId: run.id, planId,
            statement: signal.statement, ...(signal.confidence === undefined ? {} : { confidence: signal.confidence }), sourceRefs,
          })
          assumptionIds.push(assumption.id)
          for (const conflictingId of signal.conflictsWith ?? []) {
            const conflicting = this.store.getAssumption(conflictingId)
            if (conflicting?.runId === run.id && conflicting.status !== 'INVALIDATED') {
              const reason = `Agent signal ${envelope.id} claims a conflict with assumption ${conflicting.id}; human evidence review is required`
              this.store.saveEvidence({
                id: randomUUID(), runId: run.id, planId, nodeId: envelope.nodeId, attempt: envelope.attempt,
                type: 'VERIFICATION', status: 'UNKNOWN', source: 'agent', summary: reason, createdAt: envelope.createdAt,
              })
              reasons.push(reason)
            }
          }
          break
        }
        case 'SemanticUncertainty': {
          const uncertainty = this.semantics.raiseUncertainty({
            scope: runScope(run), runId: run.id, planId,
            subject: signal.subject ?? 'Agent semantic interpretation',
            reason: signal.reason ?? 'Agent reported unresolved semantic uncertainty',
            ...(signal.alternatives === undefined ? {} : { alternatives: signal.alternatives }), sourceRefs,
          })
          reasons.push(`semantic uncertainty ${uncertainty.id}: ${uncertainty.reason}`)
          break
        }
        case 'KnowledgeCandidate': {
          const statement = signal.subject ?? signal.summary
          if (statement === undefined || statement.trim() === '') break
          this.knowledge.candidate({
            scope: runScope(run), kind: 'experience', statement,
            content: signal.summary ?? statement, ...(signal.confidence === undefined ? {} : { confidence: signal.confidence }), sourceRefs,
          })
          break
        }
        case 'PlaybookMatched':
        case 'PlaybookMismatch': {
          if (signal.playbookId === undefined || this.store.getPlaybook(signal.playbookId) === undefined) break
          const fit = this.playbooks.fit(signal.playbookId, { scope: runScope(run), target: run.request, effect: run.request }, run.id)
          if (signal.type === 'PlaybookMismatch' || fit.outcome !== 'MATCH') {
            const reason = signal.type === 'PlaybookMismatch' ? signal.reason ?? fit.reasons.join('; ') : fit.reasons.join('; ')
            reasons.push(`playbook ${signal.playbookId} ${fit.outcome.toLowerCase()}: ${reason}`)
          }
          break
        }
        case 'EvidenceProduced': {
          const id = signal.evidenceId ?? randomUUID()
          if (this.store.listEvidence(run.id).some(item => item.id === id)) break
          this.store.saveEvidence({
            id, runId: run.id, planId, nodeId: envelope.nodeId, attempt: envelope.attempt, type: 'AGENT_OUTPUT', status: 'UNKNOWN',
            source: 'agent', summary: `Agent-reported Evidence is untrusted until Runtime verification: ${signal.summary ?? 'no summary'}`,
            createdAt: envelope.createdAt,
          })
          break
        }
        case 'VerificationFailed': {
          this.store.saveEvidence({
            id: randomUUID(), runId: run.id, planId, nodeId: envelope.nodeId, attempt: envelope.attempt, type: 'VERIFICATION', status: 'FAIL', source: 'agent',
            summary: `Agent reported verification failure${signal.checkId === undefined ? '' : ` for ${signal.checkId}`}: ${signal.reason ?? 'unspecified'}`,
            createdAt: envelope.createdAt,
          })
          reasons.push(signal.reason ?? 'Agent reported verification failure')
          break
        }
        case 'ExecutionBlocked':
          reasons.push(`Agent execution blocked: ${signal.reason ?? 'unspecified'}`)
          break
        case 'HumanDecisionRequired':
          reasons.push(`Agent requested human decision: ${signal.question ?? 'unspecified question'}`)
          break
        case 'ReplanRequested':
          reasons.push(`Agent requested replan: ${signal.reason ?? 'unspecified'}`)
          options = ['replan', 'rework', 'abandon', 'cancel']
          break
        case 'UnexpectedSideEffect': {
          unknownSideEffect = true
          const summary = `Unexpected Agent side effect${signal.path === undefined ? '' : ` at ${signal.path}`}: ${signal.description ?? 'unspecified'}`
          this.store.saveEvidence({ id: randomUUID(), runId: run.id, planId, nodeId: envelope.nodeId, attempt: envelope.attempt, type: 'SIDE_EFFECT', status: 'UNKNOWN', source: 'agent', summary, createdAt: envelope.createdAt })
          reasons.push(summary)
          break
        }
        case 'PlanProposed':
        case 'UnknownSignal':
          break
      }
    }
    if (assumptionIds.length > 0) this.store.updateRun(run.id, current => ({ ...current, assumptionIds: [...new Set(assumptionIds)] }))
    return {
      ...(reasons.length === 0 ? {} : { reason: reasons.join('; ') }),
      options,
      unknownSideEffect,
    }
  }

  /** Candidate learnings are deliberately untrusted until later promotion. */
  private recordRunLearnings(run: Run, verification: VerificationReport): void {
    const candidate = run.candidateId === undefined ? undefined : this.store.getCandidate(run.candidateId)
    if (candidate === undefined) return
    const sourceId = `run:${run.id}:${candidate.id}`
    const evidenceIds = this.store.listEvidence(run.id).filter(item => item.status === 'PASS').map(item => item.id)
    if (!this.memory.list(runScope(run), true).some(item => item.sourceRefs.some(ref => ref.sourceId === sourceId))) {
      this.memory.remember({
        scope: runScope(run), kind: 'experience', title: `AutoDev run ${run.id} candidate`,
        content: `Request: ${run.request}. Candidate tree ${candidate.gitTreeHash} passed deterministic verification (${verification.id}).`,
        tags: ['autodev', 'candidate', 'verification'], status: 'CANDIDATE', confidence: 0.7,
        sourceRefs: [{ sourceType: 'run', sourceId, runId: run.id }], evidenceIds,
      })
    }
    if (!this.knowledge.list(runScope(run), true).some(item => item.sourceRefs.some(ref => ref.sourceId === sourceId))) {
      this.knowledge.candidate({
        scope: runScope(run), kind: 'experience', statement: `A candidate for "${run.request}" passed deterministic verification`,
        content: `Candidate ${candidate.id} at tree ${candidate.gitTreeHash} passed verification ${verification.id}.`, confidence: 0.7,
        sourceRefs: [{ sourceType: 'run', sourceId, runId: run.id }], evidenceIds,
      })
    }
  }

  /**
   * Ask Jev for a bounded evidence-quality assessment after deterministic
   * Build/Test checks. The score can only add review work; it can never turn a
   * failed deterministic check into a pass.
   */
  private async executeQuality(runId: string, signal: AbortSignal): Promise<boolean> {
    const run = this.requireRun(runId)
    const candidate = run.candidateId === undefined ? undefined : this.store.getCandidate(run.candidateId)
    const evidence = this.store.listEvidence(runId)
    const diffArtifact = candidate?.diffArtifactId === undefined ? undefined : this.store.getArtifact(candidate.diffArtifactId)
    const diffText = diffArtifact === undefined ? '' : this.store.readArtifact(diffArtifact).subarray(0, 24_000).toString('utf8')
    const result = await this.decisions.evaluate('quality', {
      request: run.request,
      acceptanceCriteria: run.acceptanceCriteria,
      candidateTree: candidate?.gitTreeHash,
      candidateDiff: diffText,
      candidateDiffTruncated: diffArtifact !== undefined && diffArtifact.bytes > 24_000,
      evidence: evidence.map(item => ({ type: item.type, status: item.status, summary: item.summary })),
    }, signal)
    this.recordJev(runId, 'quality', result, result.degraded === undefined ? 'accepted' : 'degraded', result.degraded ?? 'quality decision recorded')
    const score = answerOf(result, 'score')?.value
    // Missing or malformed review intent is not an approval. Only an explicit false may pass.
    const needsReview = answerOf(result, 'needs_review')?.value !== false
    const trustedReview = result.source === 'jev'
    const scorePass = trustedReview && typeof score === 'number' && score >= this.config.qualityMinScore
    const reviewStatus = scorePass && !needsReview ? 'PASS' : 'WARN'
    this.store.saveEvidence({
      id: randomUUID(),
      runId,
      attempt: run.attempt,
      type: 'REVIEW',
      planId: this.activePlan(run).id,
      status: reviewStatus,
      source: trustedReview ? 'jev' : 'system',
      ...(candidate === undefined ? {} : { candidateId: candidate.id, gitTreeHash: candidate.gitTreeHash }),
      summary: typeof score === 'number'
        ? `${trustedReview ? 'Jev' : 'Untrusted fallback'} quality score ${score}/${100}; minimum ${this.config.qualityMinScore}${needsReview ? '; additional human review requested' : ''}${trustedReview ? '' : '; fallback output cannot approve code review'}`
        : 'Jev quality score was not available; human review is required',
      createdAt: new Date().toISOString(),
    })
    this.recordVerification(runId)
    if (!scorePass || needsReview) {
      const reason = !trustedReview
        ? 'quality review is unavailable from the configured decision service; static/advisory fallback cannot create Review PASS Evidence'
        : `quality review required${typeof score === 'number' ? `: score ${score}/${100}` : ''}`
      this.openGate(runId, reason, ['rework', 'replan', 'abandon', 'cancel'])
      return false
    }
    return true
  }

  /** Evaluate completion inputs from Host-owned Evidence; Agents cannot mark a check passed. */
  private recordVerification(runId: string): VerificationReport {
    const run = this.requireRun(runId)
    const plan = this.activePlan(run)
    const checks = defaultVerificationChecks(run, plan, new Date().toISOString())
    for (const check of checks) this.store.saveVerificationCheck(check)
    const candidate = run.candidateId === undefined ? undefined : this.store.getCandidate(run.candidateId)
    const evaluation = evaluateVerification(checks, this.store.listEvidence(runId), candidate)
    const resultIds = evaluation.results.map((result) => {
      const id = `${result.checkId}:${result.evidenceIds.at(-1) ?? 'none'}`
      this.store.saveVerificationResult({ ...result, id, createdAt: new Date().toISOString() })
      return id
    })
    const candidateId = run.candidateId
    const report: VerificationReport = {
      id: `${runId}:${plan.id}:verification:${candidateId ?? 'none'}`,
      runId,
      ...(candidateId === undefined ? {} : { candidateId }),
      status: evaluation.status,
      requiredCheckIds: checks.filter(check => check.required).map(check => check.id),
      resultIds,
      summary: evaluation.summary,
      createdAt: new Date().toISOString(),
    }
    this.store.saveVerificationReport(report)
    return report
  }

  private async failureGate(
    runId: string,
    message: string,
    error: unknown,
    signal: AbortSignal,
  ): Promise<{ readonly reason: string; readonly options: HumanGate['options'] }> {
    const safeOptions: HumanGate['options'] = error instanceof ExternalOutcomeUnknownError
      ? ['rework', 'replan', 'abandon', 'cancel']
      : ['retry', 'rework', 'replan', 'abandon', 'cancel']
    let suggested: FailureAction | undefined
    try {
      const result = await this.decisions.evaluate('failure-action', {
        runId,
        error: message,
        safeActions: safeOptions,
        evidence: this.store.listEvidence(runId).slice(-8).map(item => ({ type: item.type, status: item.status })),
      }, signal)
      this.recordJev(runId, 'failure-action', result, result.degraded === undefined ? 'accepted' : 'degraded', result.degraded ?? 'failure action recorded')
      const value = answerOf(result, 'action')?.value
      if (typeof value === 'string' && ['retry_same', 'rework', 'replan', 'human', 'stop'].includes(value)) suggested = value as FailureAction
    } catch (decisionError: unknown) {
      this.store.saveEvidence({
        id: randomUUID(),
        runId,
        type: 'JEV_DECISION',
        status: 'WARN',
        summary: `failure-action decision unavailable: ${errorMessage(decisionError)}`,
        createdAt: new Date().toISOString(),
      })
    }
    const mapped = suggested === 'retry_same'
      ? 'retry'
      : suggested === 'rework'
        ? 'rework'
        : suggested === 'replan'
          ? 'replan'
          : undefined
    const options = mapped !== undefined && safeOptions.includes(mapped) && mapped !== 'retry'
      ? [mapped, ...safeOptions.filter(item => item !== mapped)] as HumanGate['options']
      : mapped === 'retry' && safeOptions.includes('retry')
        ? ['retry', ...safeOptions.filter(item => item !== 'retry')] as HumanGate['options']
        : suggested === 'stop'
          ? safeOptions.filter(item => item === 'cancel' || item === 'abandon')
          : safeOptions
    return {
      reason: suggested === undefined ? message : `${message}; Jev failure-action suggestion: ${suggested}`,
      options: options.length === 0 ? ['cancel'] : options,
    }
  }

  private async runDriverCommand(
    runId: string,
    nodeId: string,
    worktreePath: string,
    argv: readonly string[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    const currentRun = this.requireRun(runId)
    const commandDigest = createHash('sha256').update(JSON.stringify(argv)).digest('hex')
    const intent = this.sideEffects.plan({
      runId, nodeId, kind: 'command', target: JSON.stringify(argv), risk: 'low', preconditions: ['candidate is sealed'],
      idempotencyKey: `${runId}:${currentRun.activePlanId ?? 'unplanned'}:${nodeId}:${currentRun.attempt}:command:${commandDigest}`,
    })
    this.sideEffects.authorize(intent.id, 'AutoDev deterministic command policy')
    this.sideEffects.start(intent.id)
    try {
      const result = await this.commands.run(argv, worktreePath, {
        signal,
        timeoutMs,
        maxOutputBytes: 8 * 1024 * 1024,
      })
      const summary = result.timedOut ? 'command timed out' : `command exited ${String(result.exitCode)}`
      const passed = result.exitCode === 0 && !result.timedOut
      const evidenceId = randomUUID()
      this.store.saveEvidence({ id: evidenceId, runId, ...(currentRun.candidateId === undefined ? {} : { candidateId: currentRun.candidateId }), ...(currentRun.activePlanId === undefined ? {} : { planId: currentRun.activePlanId }), nodeId, attempt: currentRun.attempt, type: 'SIDE_EFFECT', status: passed ? 'PASS' : 'FAIL', source: 'command', summary: `Command side effect: ${summary}`, createdAt: new Date().toISOString() })
      if (passed) this.sideEffects.commit(intent.id, summary, undefined, undefined, [evidenceId])
      else this.sideEffects.fail(intent.id, summary, [evidenceId])
      return result
    } catch (error: unknown) {
      this.sideEffects.unknown(intent.id, `command outcome is unknown: ${errorMessage(error)}`)
      const currentRun = this.requireRun(runId)
      this.store.saveEvidence({ id: randomUUID(), runId, ...(currentRun.candidateId === undefined ? {} : { candidateId: currentRun.candidateId }), ...(currentRun.activePlanId === undefined ? {} : { planId: currentRun.activePlanId }), nodeId, attempt: currentRun.attempt, type: 'SIDE_EFFECT', status: 'UNKNOWN', source: 'command', summary: `Command side effect outcome is unknown: ${errorMessage(error)}`, createdAt: new Date().toISOString() })
      throw error
    }
  }

  private beginRunOperation(runId: string, parentSignal?: AbortSignal): ActiveRunOperation {
    const controller = new AbortController()
    const linked = linkAbortSignals(parentSignal, controller.signal)
    let settle!: () => void
    const completion = new Promise<void>((resolve) => { settle = resolve })
    const operation: ActiveRunOperation = {
      controller,
      signal: linked.signal,
      completion,
      disposeSignal: linked.dispose,
      settle,
    }
    this.activeRuns.set(runId, operation)
    return operation
  }

  private finishRunOperation(runId: string, operation: ActiveRunOperation): void {
    if (this.activeRuns.get(runId) === operation) this.activeRuns.delete(runId)
    operation.disposeSignal()
    operation.settle()
  }

  private recordInterruptedOperation(runId: string, reason: string): void {
    const run = this.requireRun(runId)
    const now = new Date().toISOString()
    for (const node of this.store.listNodes(runId)) {
      if (node.status !== 'RUNNING') continue
      this.unknownNode(node, reason)
      this.store.saveEvidence({
        id: randomUUID(), runId, planId: node.planId, nodeId: node.nodeId, attempt: node.attempt,
        type: 'DRIFT', status: 'UNKNOWN', source: 'system', summary: reason, createdAt: now,
      })
    }
    for (const intent of this.store.listActionIntents(runId)) {
      if (intent.status !== 'AUTHORIZED' && intent.status !== 'EXECUTING') continue
      const evidenceId = randomUUID()
      this.sideEffects.unknown(intent.id, reason, [evidenceId])
      this.store.saveEvidence({
        id: evidenceId, runId, ...(run.activePlanId === undefined ? {} : { planId: run.activePlanId }),
        ...(intent.nodeId === undefined ? {} : { nodeId: intent.nodeId }), attempt: run.attempt,
        type: 'SIDE_EFFECT', status: 'UNKNOWN', source: 'system', summary: reason, createdAt: now,
      })
    }
  }

  private settleInterruptedRun(runId: string, reason: string): void {
    this.recordInterruptedOperation(runId, reason)
    if (this.requireRun(runId).status !== 'CANCELLED') {
      this.transitionIfAllowed(runId, 'PAUSED', { lastError: 'operation interrupted; uncertain effects were retained for review' })
    }
  }

  private saveCommandEvidence(runId: string, nodeId: string, type: 'BUILD' | 'TEST', result: CommandResult, before: string, after: string): void {
    const run = this.requireRun(runId)
    const plan = this.activePlan(run)
    const output = [`$ ${result.argv.join(' ')}`, result.stdout, result.stderr].filter(Boolean).join('\n')
    const artifact = this.store.writeArtifact(runId, type.toLowerCase(), output, '.log')
    this.store.saveEvidence({
      id: randomUUID(),
      runId,
      nodeId,
      attempt: run.attempt,
      ...(run.candidateId === undefined ? {} : { candidateId: run.candidateId }),
      planId: plan.id,
      type,
      gitTreeHash: after,
      status: result.exitCode === 0 && !result.timedOut && before === after ? 'PASS' : 'FAIL',
      summary: result.timedOut ? `${type} timed out` : `${type} exit=${String(result.exitCode)} duration=${result.durationMs}ms`,
      artifactId: artifact.id, createdAt: new Date().toISOString(),
    })
  }

  private recordJev(runId: string, purpose: DecisionPurpose, result: Awaited<ReturnType<DecisionCoordinator['evaluate']>>, outcome: JevDecision['policyOutcome'], reason: string): void {
    const first = result.answers[0]
    this.store.saveJevDecision({
      id: randomUUID(),
      runId,
      purpose,
      stateHash: result.stateHash,
      questionSetVersion: result.questionSetVersion,
      source: result.source,
      ...(result.providerId === undefined ? {} : { providerId: result.providerId }),
      modelVersion: result.modelVersion,
      answer: result.answers,
      ...(first?.probability === undefined ? {} : {
        probability: first.probability,
        confidence: first.probability,
      }),
      policyOutcome: outcome, reason, createdAt: new Date().toISOString(),
    })
    this.store.saveEvidence({
      id: randomUUID(), runId, type: 'JEV_DECISION', status: outcome === 'paused' ? 'WARN' : 'PASS',
      summary: `${purpose}: ${reason}`, createdAt: new Date().toISOString(),
    })
  }

  private openGate(runId: string, reason: string, options: HumanGate['options']): HumanGate {
    const gate: HumanGate = { id: randomUUID(), runId, reason, options, status: 'OPEN', createdAt: new Date().toISOString() }
    this.store.withTransaction(() => {
      this.store.saveGate(gate)
      this.transitionIfAllowed(runId, 'NEEDS_INTERVENTION', { currentGateId: gate.id, lastError: reason })
    })
    return gate
  }

  private reconcileRunAssumptions(runId: string): boolean {
    const changed = this.semantics.reconcileAssumptionEvidence(runId)
    if (changed.length === 0) return false
    const summary = changed.map(item => `${item.statement}: ${item.status}`).join('; ')
    this.openGate(
      runId,
      `confirmed assumptions no longer have current supporting Evidence and require human review: ${summary}`,
      ['replan', 'rework', 'abandon', 'cancel'],
    )
    return true
  }

  /**
   * Reconcile in-flight work synchronously when a Host process is recreated.
   * An external Agent or promotion may have had side effects at the moment of
   * interruption, so recovery never retries it automatically and never marks
   * the candidate as verified. The retained Worktree and evidence remain
   * available for an explicit human action.
   */
  private recoverInterruptedRuns(): void {
    const interrupted = new Set<RunStatus>(['EXECUTING', 'BUILDING', 'TESTING', 'PROMOTING'])
    for (const run of this.store.listRuns()) {
      if (!interrupted.has(run.status)) continue
      for (const intent of this.store.listActionIntents(run.id)) {
        if (intent.status !== 'AUTHORIZED' && intent.status !== 'EXECUTING') continue
        const summary = intent.kind === 'git-promotion'
          ? 'Host restarted during PROMOTING (Promotion); inspect the repository before any retry'
          : `Host restarted during ${run.status}; the ${intent.kind} outcome is unknown and must not be retried automatically`
        const evidenceId = randomUUID()
        this.sideEffects.unknown(intent.id, summary, [evidenceId])
        this.store.saveEvidence({
          id: evidenceId,
          runId: run.id,
          ...(run.activePlanId === undefined ? {} : { planId: run.activePlanId }),
          ...(intent.nodeId === undefined ? {} : { nodeId: intent.nodeId }),
          attempt: run.attempt,
          type: 'SIDE_EFFECT',
          status: 'UNKNOWN',
          source: 'system',
          summary,
          createdAt: new Date().toISOString(),
        })
      }
      for (const node of this.store.listNodes(run.id)) {
        if (node.status !== 'RUNNING') continue
        this.store.saveNode({
          ...node,
          status: 'UNKNOWN',
          error: 'Host restarted while this node was running; outcome requires human review',
          endedAt: new Date().toISOString(),
        })
      }
      const openGate = this.store.listGates(run.id).find(gate => gate.status === 'OPEN')
      if (openGate !== undefined) {
        this.transitionIfAllowed(run.id, 'NEEDS_INTERVENTION', {
          currentGateId: openGate.id,
          lastError: openGate.reason,
        })
        continue
      }
      this.store.saveEvidence({
        id: randomUUID(),
        runId: run.id,
        type: 'DRIFT',
        status: 'WARN',
        summary: `Host restarted during ${run.status}; external outcome is unknown and automatic retry is disabled`,
        createdAt: new Date().toISOString(),
      })
      this.openGate(
        run.id,
        `Host restarted during ${run.status}; inspect the retained Worktree before continuing`,
        run.status === 'PROMOTING' && run.candidateId !== undefined
          ? ['promote', 'rework', 'replan', 'abandon', 'cancel']
          : ['rework', 'replan', 'abandon', 'cancel'],
      )
    }
  }

  private createReplan(runId: string): PlanVersion {
    const run = this.requireRun(runId)
    const current = this.activePlan(run)
    const plan: PlanVersion = {
      ...current,
      id: randomUUID(),
      version: current.version + 1,
      parentId: current.id,
      status: 'ACTIVE',
      conceptIds: this.concepts.search(runScope(run), run.request).slice(0, 8).map(item => item.id),
      playbookIds: this.playbooks.search(runScope(run), run.request).filter(item => item.status === 'ACTIVE').slice(0, 8).map(item => item.id),
      assumptionIds: this.store.listAssumptions(runId).map(item => item.id),
      fingerprint: fingerprint({ mode: current.mode ?? run.mode ?? 'DEV', executionEnvironment: run.executionEnvironment?.kind ?? 'LOCAL_WORKTREE', buildDriverId: current.buildDriverId ?? null, nodes: current.nodes }),
      createdAt: new Date().toISOString(),
    }
    this.store.withTransaction(() => {
      this.store.createPlan(plan)
      this.store.updatePlanStatus(current.id, 'SUPERSEDED')
      this.store.updateRun(runId, value => ({ ...value, activePlanId: plan.id }))
      for (const [index, node] of plan.nodes.entries()) {
        this.store.createNode({ id: `${plan.id}:${node.id}:${run.attempt + 1}`, runId, planId: plan.id, nodeId: node.id, attempt: run.attempt + 1, status: index === 0 ? 'READY' : 'PENDING' })
      }
    })
    return plan
  }

  private makePlan(run: Run, buildDriverId?: BuildDriverId): PlanVersion {
    const mode = run.mode ?? 'DEV'
    const nodes = createModePlanNodes(mode, buildDriverId)
    const playbookIds = this.playbooks.search(runScope(run), run.request).filter(item => item.status === 'ACTIVE').slice(0, 8).map(item => item.id)
    const conceptIds = this.concepts.search(runScope(run), run.request).slice(0, 8).map(item => item.id)
    return {
      schemaVersion: 1, id: randomUUID(), runId: run.id, version: 1, status: 'ACTIVE',
      fingerprint: fingerprint({ mode, executionEnvironment: run.executionEnvironment?.kind ?? 'LOCAL_WORKTREE', buildDriverId: buildDriverId ?? null, nodes }),
      mode, nodes, ...(buildDriverId === undefined ? {} : { buildDriverId }), createdAt: new Date().toISOString(),
      ...(conceptIds.length === 0 ? {} : { conceptIds }),
      ...(playbookIds.length === 0 ? {} : { playbookIds }),
    }
  }

  private assertSemanticPlanReady(run: Run, plan: PlanVersion): void {
    const ambiguous = this.concepts.unresolvedAmbiguities(runScope(run), run.request)
    if (ambiguous.length > 0) {
      const descriptions = ambiguous.map(item => `${item.key} (${item.target} -> ${item.effect})`).join('; ')
      throw new InterventionRequiredError(`unresolved Business Concept observations require human clarification: ${descriptions}`, ['replan', 'rework', 'abandon', 'cancel'])
    }
    const establishedConcepts = this.concepts.search(runScope(run), run.request).filter(item => item.status === 'ESTABLISHED')
    for (const playbookId of plan.playbookIds ?? []) {
      const playbook = this.store.getPlaybook(playbookId)
      if (playbook === undefined || playbook.status !== 'ACTIVE') continue
      const matchingConcepts = establishedConcepts.filter(
        concept => playbook.conceptKeys.length === 0 || playbook.conceptKeys.includes(concept.key),
      )
      for (const concept of matchingConcepts) {
        const fit = this.playbooks.fit(playbook.id, {
          scope: runScope(run), target: concept.target, effect: concept.effect, conceptKeys: [concept.key],
          evidenceTypes: this.store.listEvidence(run.id).filter(item => item.status === 'PASS').map(item => item.type),
        }, run.id)
        if (fit.outcome === 'MISMATCH') {
          throw new InterventionRequiredError(`active Playbook ${playbook.key} v${playbook.version} does not fit established Concept ${concept.key}: ${fit.reasons.join('; ')}`, ['replan', 'rework', 'abandon', 'cancel'])
        }
      }
    }
  }

  private assertProjectSemanticMutationAllowed(run: Run): void {
    if (this.activeRuns.has(run.id) || ['EXECUTING', 'BUILDING', 'TESTING', 'PROMOTING'].includes(run.status)) {
      throw new Error(`project semantics for Run ${run.id} cannot change while execution or Promotion is active`)
    }
    if (['PROMOTED', 'CANCELLED', 'ABANDONED'].includes(run.status)) {
      throw new Error(`project semantics cannot be changed from terminal Run state ${run.status}`)
    }
  }

  /** Start one repeatable Knowledge action while deduplicating retries of the same caller operation.
   * @param runId - Run that owns the action intent.
   * @param target - Stable action target independent of the caller operation identity.
   * @param operationId - Caller-provided idempotency identity, or a fresh identity for direct API calls.
   * @param authorization - Audit rationale for this explicit local Knowledge action.
   * @returns The started action intent ID, or undefined when a committed operation is replayed.
   */
  private beginKnowledgeAction(
    runId: string,
    target: string,
    operationId: string | undefined,
    authorization: string,
    actor: AutoDevAuditActor = { kind: 'autodev-runtime', source: 'runtime-policy' },
  ): string | undefined {
    const operation = operationId === undefined ? randomUUID() : requireText(operationId, 'knowledge operationId')
    const key = idempotencyKey(runId, 'memory-write', `${target}\0${operation}`)
    const existing = this.store.listActionIntents(runId).find(item => item.idempotencyKey === key)
    if (existing !== undefined) {
      if (existing.status === 'COMMITTED') return undefined
      throw new Error(`knowledge operation ${operation} already exists with status ${existing.status}; use a new operationId to retry`)
    }
    const intent = this.sideEffects.plan({ runId, kind: 'memory-write', target, risk: 'low', idempotencyKey: key })
    this.sideEffects.authorize(intent.id, authorization, actor)
    this.sideEffects.start(intent.id)
    return intent.id
  }

  private failKnowledgeAction(intentId: string, summary: string): void {
    const status = this.sideEffects.require(intentId).status
    if (status === 'AUTHORIZED' || status === 'EXECUTING') this.sideEffects.fail(intentId, summary)
  }

  private requirePlanReviewAfterSemanticMutation(runId: string, reason: string): void {
    const run = this.requireRun(runId)
    if (run.status === 'DRAFT') {
      this.createReplan(runId)
      return
    }
    const currentGate = run.currentGateId === undefined ? undefined : this.store.getGate(run.currentGateId)
    if (currentGate?.status === 'OPEN') {
      this.store.saveGate({ ...currentGate, reason: `${currentGate.reason}; ${reason}`, options: ['replan', 'abandon', 'cancel'] })
      this.transitionIfAllowed(runId, 'NEEDS_INTERVENTION', { currentGateId: currentGate.id, lastError: reason })
      return
    }
    this.openGate(runId, reason, ['replan', 'abandon', 'cancel'])
  }

  private activePlan(run: Run): PlanVersion {
    if (run.activePlanId === undefined) throw new Error(`run ${run.id} has no active plan`)
    const plan = this.store.getPlan(run.activePlanId)
    if (plan === undefined) throw new Error(`run ${run.id} references missing plan ${run.activePlanId}`)
    return plan
  }

  private beginNode(run: Run, plan: PlanVersion, node: PlanNode): NodeExecution {
    const existing = this.store.listNodes(run.id).find(item => item.planId === plan.id && item.nodeId === node.id && (
      item.attempt === run.attempt || (run.attempt === 1 && item.attempt === 0 && item.status === 'READY')
    ))
    const execution: NodeExecution = existing ?? { id: `${plan.id}:${node.id}:${run.attempt}`, runId: run.id, planId: plan.id, nodeId: node.id, attempt: run.attempt, status: 'READY' }
    this.store.saveNode({ ...execution, attempt: run.attempt, status: 'RUNNING', startedAt: new Date().toISOString() })
    return this.store.getNode(execution.id) as NodeExecution
  }

  private completeNode(execution: NodeExecution, provider: string | undefined, outputTree: string): void {
    this.store.saveNode({ ...execution, status: 'COMPLETED', ...(provider === undefined ? {} : { provider }), outputTree, endedAt: new Date().toISOString() })
  }

  private failNode(execution: NodeExecution, error: string): void {
    this.store.saveNode({ ...execution, status: 'FAILED', error, endedAt: new Date().toISOString() })
  }

  private unknownNode(execution: NodeExecution, error: string): void {
    this.store.saveNode({ ...execution, status: 'UNKNOWN', error, endedAt: new Date().toISOString() })
  }

  private transition(runId: string, status: RunStatus, patch: Partial<Run> = {}): Run {
    return this.store.updateRun(runId, (current) => {
      if (current.status !== status && !ALLOWED_TRANSITIONS[current.status].includes(status)) {
        throw new Error(`invalid AutoDev transition ${current.status} -> ${status}`)
      }
      return { ...current, ...patch, status, updatedAt: new Date().toISOString() }
    })
  }

  private transitionIfAllowed(runId: string, status: RunStatus, patch: Partial<Run> = {}): void {
    const current = this.store.getRun(runId)
    if (current === undefined || (current.status !== status && !ALLOWED_TRANSITIONS[current.status].includes(status))) return
    this.transition(runId, status, patch)
  }

  private requireRun(runId: string): Run {
    const run = this.store.getRun(runId)
    if (run === undefined) throw new Error(`AutoDev run ${runId} does not exist`)
    return run
  }

  private requireOpenGateAction(runId: string, action: HumanGate['options'][number]): HumanGate {
    const run = this.requireRun(runId)
    const gate = run.currentGateId === undefined ? undefined : this.store.getGate(run.currentGateId)
    if (gate === undefined || gate.status !== 'OPEN') throw new Error(`run ${runId} has no open Human Gate`)
    if (!gate.options.includes(action)) throw new Error(`action ${action} is not allowed by gate ${gate.id}`)
    return gate
  }

  private async resolveParentAgent(runId: string, sessionId: string, signal: AbortSignal): Promise<unknown> {
    const run = this.requireRun(runId)
    const bridge = this.sessionBridge ?? getService<AutoDevSessionBridge>(this.hostContext, 'sessionController')
    if (bridge === undefined) throw new Error('DSH Session Controller is unavailable; Web startup requires a live ordinary Session')
    const inspected = await bridge.inspect(sessionId, signal)
    signal.throwIfAborted()
    if (inspected.meta.cwd === undefined || !sameExistingDirectory(inspected.meta.cwd, run.repoRoot)) {
      throw new Error(`DSH Session ${sessionId} is not bound to the AutoDev repository ${run.repoRoot}`)
    }
    const resolved = await bridge.resolveAgent(sessionId)
    signal.throwIfAborted()
    if ('error' in resolved) throw resolved.error
    if (!isParentAgentForSession(resolved.agent, sessionId)) {
      throw new Error('DSH Session Controller returned a mismatched parent Agent')
    }
    return resolved.agent
  }

  private async environment(repoRoot: string, buildDriverId?: BuildDriverId, signal?: AbortSignal): Promise<EnvironmentFingerprint> {
    const [git, java, maven] = await Promise.all([
      this.commands.run(['git', '--version'], repoRoot, { signal, timeoutMs: this.config.commandTimeoutMs }),
      this.probe(['java', '-version'], repoRoot, signal),
      buildDriverId === 'maven' ? this.probe(['mvn', '-version'], repoRoot, signal) : Promise.resolve(undefined),
    ])
    const build = buildDriverId === undefined ? undefined : commandForDriver(buildDriverId, 'build', repoRoot, this.driverSettings())
    const test = buildDriverId === undefined ? undefined : commandForDriver(buildDriverId, 'test', repoRoot, this.driverSettings())
    return {
      platform: process.platform, arch: process.arch, node: process.version,
      ...(buildDriverId === undefined ? {} : { buildDriverId }),
      ...(git.exitCode === 0 ? { git: git.stdout.trim() } : {}),
      ...(java?.exitCode === 0 ? { java: `${java.stdout}\n${java.stderr}`.trim().split(/\r?\n/)[0] } : {}),
      ...(maven?.exitCode === 0 ? { maven: `${maven.stdout}\n${maven.stderr}`.trim().split(/\r?\n/)[0] } : {}),
      ...(build === undefined ? {} : { buildArgs: [...build.argv.slice(1)] }),
      ...(test === undefined ? {} : { testArgs: [...test.argv.slice(1)] }),
      ...(process.env.DSH_VERSION === undefined ? {} : { harness: process.env.DSH_VERSION }),
      capturedAt: new Date().toISOString(),
    }
  }

  private async probe(argv: readonly string[], cwd: string, signal?: AbortSignal): Promise<CommandResult | undefined> {
    try {
      return await this.commands.run(argv, cwd, { signal, timeoutMs: this.config.commandTimeoutMs })
    } catch {
      return undefined
    }
  }

  private planDriver(plan: PlanVersion, run: Run): BuildDriverId {
    return plan.buildDriverId ?? selectBuildDriver(run.repoRoot, this.config.buildDriver)
  }

  private driverSettings(): DriverSettings {
    return { ...this.config.drivers, maven: this.config.maven }
  }

  /** Resolve only the actor category from DSH's call-bound Gateway context.
   * A Peer ID identifies the DSH connection Peer, never a person or account.
   */
  private remoteActor(): AutoDevAuditActor {
    const invocation = this.ctx.invocation
    if (invocation === undefined) return { kind: 'host-internal', source: 'direct-host-call' }
    return {
      kind: 'dsh-operator',
      source: 'dsh-gateway',
      connectionPeerId: invocation.peer.id,
    }
  }
}

/** Validated configuration consumed internally by the AutoDev runtime. */
export interface ResolvedAutoDevConfig {
  readonly dataRoot: string
  readonly worktreeRoot: string
  readonly maxAttempts: number
  readonly commandTimeoutMs: number
  readonly buildTimeoutMs: number
  readonly testTimeoutMs: number
  readonly qualityMinScore: number
  readonly jev: NonNullable<AutoDevConfig['jev']>
  readonly routes: AutoDevConfig['routes']
  readonly buildDriver: NonNullable<AutoDevConfig['buildDriver']>
  readonly drivers: NonNullable<AutoDevConfig['drivers']>
  readonly maven: Required<Pick<NonNullable<AutoDevConfig['maven']>, 'buildArgs' | 'testArgs'>> & NonNullable<AutoDevConfig['maven']>
}

function validatePrepareRetentionCleanupRequest(request: PrepareRetentionCleanupRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(request.requestId)) {
    throw new TypeError('retention cleanup requestId must be a short path-free idempotency key')
  }
  if (!/^[a-f0-9]{64}$/u.test(request.snapshotFingerprint)) throw new TypeError('retention cleanup snapshotFingerprint must be a SHA-256 digest')
  if (!Number.isSafeInteger(request.minAgeDays) || request.minAgeDays < 0 || request.minAgeDays > 3650) {
    throw new TypeError('retention cleanup minAgeDays must be an integer between 0 and 3650')
  }
  if (!Array.isArray(request.retentionIds) || request.retentionIds.length < 1 || request.retentionIds.length > MAX_CLEANUP_SELECTION) {
    throw new TypeError(`retention cleanup selection must contain 1 to ${MAX_CLEANUP_SELECTION} Worktrees`)
  }
  if (new Set(request.retentionIds).size !== request.retentionIds.length) throw new TypeError('retention cleanup selection contains duplicate Worktrees')
  if (request.retentionIds.some(id => !/^[a-f0-9]{24}$/u.test(id))) throw new TypeError('retention cleanup selection contains an invalid Worktree id')
}

function validateExecuteRetentionCleanupRequest(request: ExecuteRetentionCleanupRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(request.jobId)) throw new TypeError('retention cleanup jobId is invalid')
  if (!/^[a-f0-9]{64}$/u.test(request.snapshotFingerprint)) throw new TypeError('retention cleanup snapshotFingerprint must be a SHA-256 digest')
  if (typeof request.confirmationPhrase !== 'string' || request.confirmationPhrase.length > 64) {
    throw new TypeError('retention cleanup confirmation phrase is invalid')
  }
}

function retentionCleanupConfirmationPhrase(jobId: string): string {
  return `DELETE-${jobId.slice(-8).toUpperCase()}`
}

function cleanupJobView(job: RetentionCleanupJobRecord): AutoDevCleanupJobView {
  return {
    id: job.id,
    status: job.status,
    minAgeDays: job.minAgeDays,
    snapshotFingerprint: job.snapshotFingerprint,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    confirmationPhrase: retentionCleanupConfirmationPhrase(job.id),
    ...(job.requestedBy === undefined ? {} : { requestedBy: job.requestedBy }),
    ...(job.confirmedBy === undefined ? {} : { confirmedBy: job.confirmedBy }),
    ...(job.cancelledBy === undefined ? {} : { cancelledBy: job.cancelledBy }),
    events: job.events,
    items: job.items.map(item => ({
      retentionId: item.retentionId,
      runId: item.runId,
      attempt: item.attempt,
      status: item.status,
      ...(item.failureCode === undefined ? {} : { failureCode: item.failureCode }),
    })),
  }
}

function cleanupFailureCode(error: unknown): RetentionCleanupFailureCode {
  if (error instanceof GitWorktreeCleanupError) return error.reason
  return 'git-remove-failed'
}

function resolveConfig(config: AutoDevConfig): ResolvedAutoDevConfig {
  const dataRoot = resolve(config.dataRoot ?? defaultDataRoot())
  return {
    dataRoot,
    worktreeRoot: resolve(config.worktreeRoot ?? join(dataRoot, 'worktrees')),
    maxAttempts: positive(config.maxAttempts ?? 2, 'maxAttempts'),
    commandTimeoutMs: positive(config.commandTimeoutMs ?? 60_000, 'commandTimeoutMs'),
    buildTimeoutMs: positive(config.buildTimeoutMs ?? 10 * 60_000, 'buildTimeoutMs'),
    testTimeoutMs: positive(config.testTimeoutMs ?? 10 * 60_000, 'testTimeoutMs'),
    qualityMinScore: score(config.qualityMinScore ?? 70),
    jev: config.jev ?? {},
    routes: config.routes,
    buildDriver: config.buildDriver ?? 'auto',
    drivers: config.drivers ?? {},
    maven: {
      ...(config.maven ?? {}),
      buildArgs: config.maven?.buildArgs ?? ['-q', '-DskipTests', 'package'],
      testArgs: config.maven?.testArgs ?? ['-q', 'test'],
    },
  }
}

function runScope(run: Run): ScopeRef {
  return run.scope ?? { projectKey: run.projectKey ?? run.repoRoot }
}

function boundAgentContextCards(
  memoryCards: readonly string[],
  conceptCards: readonly string[],
  playbookCards: readonly string[],
  assumptionCards: readonly string[],
  uncertaintyCards: readonly string[],
  knowledgeCards: readonly string[],
): {
  readonly memoryCards: readonly string[]
  readonly conceptCards: readonly string[]
  readonly assumptionCards: readonly string[]
  readonly uncertaintyCards: readonly string[]
  readonly playbookCards: readonly string[]
  readonly knowledgeCards: readonly string[]
  readonly usedChars: number
} {
  const take = (cards: readonly string[], budget: number): { readonly cards: readonly string[]; readonly used: number } => {
    const result: string[] = []
    let used = 0
    for (const card of cards) {
      const separator = result.length === 0 ? 0 : 1
      const remaining = budget - used - separator
      if (remaining <= 0) break
      const marker = '…[truncated]'
      const bounded = card.length <= remaining ? card : remaining <= marker.length ? card.slice(0, remaining) : `${card.slice(0, remaining - marker.length)}${marker}`
      if (bounded.length === 0) break
      result.push(bounded)
      used += bounded.length + separator
    }
    return { cards: result, used }
  }
  let remaining = MAX_AGENT_CONTEXT_CHARS
  const memory = take(memoryCards, Math.min(1000, remaining)); remaining -= memory.used
  const concepts = take(conceptCards, Math.min(1300, remaining)); remaining -= concepts.used
  const playbooks = take(playbookCards, Math.min(1000, remaining)); remaining -= playbooks.used
  const assumptions = take(assumptionCards, Math.min(1000, remaining)); remaining -= assumptions.used
  const uncertainties = take(uncertaintyCards, Math.min(1000, remaining)); remaining -= uncertainties.used
  const knowledge = take(knowledgeCards, remaining)
  return {
    memoryCards: memory.cards,
    conceptCards: concepts.cards,
    assumptionCards: assumptions.cards,
    uncertaintyCards: uncertainties.cards,
    playbookCards: playbooks.cards,
    knowledgeCards: knowledge.cards,
    usedChars: memory.used + concepts.used + playbooks.used + assumptions.used + uncertainties.used + knowledge.used,
  }
}

function getService<T>(ctx: Context, key: string): T | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get(key) as T | undefined
}

function sameExistingDirectory(left: string, right: string): boolean {
  try {
    const normalize = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
    return normalize(realpathSync.native(left)) === normalize(realpathSync.native(right))
  } catch {
    return false
  }
}

function isParentAgentForSession(value: unknown, sessionId: string): boolean {
  if (value === null || typeof value !== 'object') return false
  const agent = value as { id?: unknown; session?: { id?: unknown } }
  return agent.id === sessionId && agent.session?.id === sessionId
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
  return value
}

function score(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new TypeError('qualityMinScore must be between 0 and 100')
  return value
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`)
  return value.trim()
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseReviewOutcome(output: string): 'PASS' | 'NEEDS_CHANGES' | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || (parsed.verdict !== 'PASS' && parsed.verdict !== 'NEEDS_CHANGES') || !Array.isArray(parsed.findings)) return undefined
  if (parsed.findings.some(item => !isRecord(item) || typeof item.message !== 'string' || !['low', 'medium', 'high', 'critical'].includes(String(item.severity)))) return undefined
  return parsed.verdict === 'PASS' && parsed.findings.length === 0 ? 'PASS' : 'NEEDS_CHANGES'
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError'))
}

function linkAbortSignals(parentSignal: AbortSignal | undefined, operationSignal: AbortSignal): {
  readonly signal: AbortSignal
  readonly dispose: () => void
} {
  const controller = new AbortController()
  const listeners = new Map<AbortSignal, () => void>()
  const sources = parentSignal === undefined ? [operationSignal] : [parentSignal, operationSignal]
  for (const source of sources) {
    if (source.aborted) {
      controller.abort(source.reason)
      break
    }
    const abort = () => controller.abort(source.reason)
    source.addEventListener('abort', abort, { once: true })
    listeners.set(source, abort)
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [source, listener] of listeners) source.removeEventListener('abort', listener)
      listeners.clear()
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class ExternalOutcomeUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ExternalOutcomeUnknownError'
  }
}

class InterventionRequiredError extends Error {
  readonly options: HumanGate['options']

  constructor(message: string, options: HumanGate['options']) {
    super(message)
    this.name = 'InterventionRequiredError'
    this.options = options
  }
}
