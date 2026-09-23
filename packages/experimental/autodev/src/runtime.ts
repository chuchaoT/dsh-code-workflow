/** AutoDev's durable Run state machine and serial software-engineering scheduler. */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AutoDevConfig,
  AutoDevSnapshot,
  ArtifactContent,
  BusinessConcept,
  CandidateRevision,
  CreateRunRequest,
  DecisionPurpose,
  EnvironmentFingerprint,
  FailureAction,
  HumanGate,
  JevDecision,
  KnowledgeCandidate,
  MemorySearchHit,
  NodeExecution,
  PlanNode,
  PlanVersion,
  Playbook,
  ProjectMemory,
  ProviderCatalog,
  ProviderInfo,
  Run,
  RunStatus,
  VerificationReport,
} from './contracts.ts'
import { HarnessCommandExecutor, type CommandExecutor, type CommandResult } from './command.ts'
import { GitManager } from './git.ts'
import { answerOf, DecisionCoordinator, JevUnavailableError } from './jev.ts'
import { ProviderRouter } from './router.ts'
import { AgentProtocol, type AgentContext, type AgentSignalEnvelope, type AgentTask } from './protocol.ts'
import { AutoDevStore, defaultDataRoot } from './store.ts'
import { defaultVerificationChecks, evaluateVerification } from './verification.ts'
import { BusinessConceptService } from './concepts.ts'
import { KnowledgeService } from './knowledge.ts'
import { ProjectMemoryService } from './memory.ts'
import { PlaybookService } from './playbook.ts'
import { SemanticService } from './semantics.ts'
import { SideEffectService } from './side-effects.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host AutoDev service and Remote namespace owner. */
    autodev: AutoDevRuntime
  }
}

export interface AutoDevRuntimeOptions {
  readonly store?: AutoDevStore
  readonly commands?: CommandExecutor
  readonly decisions?: DecisionCoordinator
}

const ALLOWED_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  DRAFT: ['READY', 'CANCELLED'],
  READY: ['EXECUTING', 'PAUSED', 'CANCELLED', 'REWORK_REQUESTED', 'NEEDS_INTERVENTION'],
  EXECUTING: ['BUILDING', 'FAILED', 'NEEDS_INTERVENTION', 'PAUSED', 'CANCELLED'],
  BUILDING: ['TESTING', 'FAILED', 'NEEDS_INTERVENTION', 'PAUSED', 'CANCELLED'],
  TESTING: ['VERIFY', 'FAILED', 'NEEDS_INTERVENTION', 'PAUSED', 'CANCELLED'],
  VERIFY: ['PROMOTING', 'REWORK_REQUESTED', 'NEEDS_INTERVENTION', 'ABANDONED'],
  PROMOTING: ['PROMOTED', 'NEEDS_INTERVENTION'],
  PROMOTED: [],
  PAUSED: ['READY', 'CANCELLED'],
  NEEDS_INTERVENTION: ['READY', 'REWORK_REQUESTED', 'ABANDONED', 'CANCELLED', 'PROMOTING'],
  FAILED: ['NEEDS_INTERVENTION', 'REWORK_REQUESTED', 'ABANDONED', 'CANCELLED'],
  CANCELLED: [],
  ABANDONED: [],
  REWORK_REQUESTED: ['READY', 'NEEDS_INTERVENTION', 'CANCELLED'],
}

const MAX_REMOTE_ARTIFACT_BYTES = 512 * 1024

/** Main Host-owned AutoDev service. */
export class AutoDevRuntime extends TypertRemoteService {
  readonly store: AutoDevStore
  readonly commands: CommandExecutor
  readonly git: GitManager
  readonly decisions: DecisionCoordinator
  readonly router: ProviderRouter
  readonly protocol: AgentProtocol
  readonly semantics: SemanticService
  readonly memory: ProjectMemoryService
  readonly concepts: BusinessConceptService
  readonly playbooks: PlaybookService
  readonly knowledge: KnowledgeService
  readonly sideEffects: SideEffectService
  readonly config: ResolvedAutoDevConfig

  constructor(
    ctx: Context,
    config: AutoDevConfig = {},
    options: AutoDevRuntimeOptions = {},
  ) {
    super(ctx, 'autodev')
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

  /** Host Remote: list durable runs for the web dashboard. */
  @Remote('list')
  listRuns(): readonly Run[] {
    return this.store.listRuns()
  }

  /** Host Remote: read one complete authoritative snapshot. */
  @Remote('snapshot')
  remoteSnapshot(runId: string): AutoDevSnapshot {
    return this.snapshot(runId)
  }

  /** Host Remote: inspect the current dynamic provider registry and routes. */
  @Remote('providers')
  remoteProviders(): ProviderCatalog {
    return { providers: this.listProviders(), routes: this.router.listRoutes() }
  }

  /** Host-owned progressive memory query; project scope is derived from run. */
  @Remote('memorySearch')
  remoteMemorySearch(request: {
    readonly runId: string
    readonly query: string
    readonly limit?: number
    readonly maxChars?: number
  }): readonly MemorySearchHit[] {
    const run = this.requireRun(request.runId)
    return this.memory.search(run.projectKey ?? run.repoRoot, request.query, {
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
    })
  }

  @Remote('memoryDetail')
  remoteMemoryDetail(request: { readonly runId: string; readonly memoryId: string }): ProjectMemory | undefined {
    const run = this.requireRun(request.runId)
    const memory = this.memory.get(request.memoryId)
    if (memory !== undefined && memory.scope.projectKey !== (run.projectKey ?? run.repoRoot)) throw new Error('memory is outside the run project scope')
    return memory
  }

  @Remote('semanticState')
  remoteSemanticState(runId: string): { readonly assumptions: AutoDevSnapshot['assumptions']; readonly uncertainties: AutoDevSnapshot['uncertainties'] } {
    this.requireRun(runId)
    return {
      assumptions: this.store.listAssumptions(runId),
      uncertainties: this.semantics.openForRun(runId),
    }
  }

  @Remote('concepts')
  remoteConcepts(runId: string): readonly BusinessConcept[] {
    const run = this.requireRun(runId)
    return this.concepts.search(run.projectKey ?? run.repoRoot, run.request).slice(0, 8)
  }

  @Remote('conceptDetail')
  remoteConceptDetail(request: { readonly runId: string; readonly conceptId: string }): BusinessConcept | undefined {
    const run = this.requireRun(request.runId)
    const concept = this.store.getConcept(request.conceptId)
    if (concept !== undefined && concept.scope.projectKey !== (run.projectKey ?? run.repoRoot)) throw new Error('concept is outside the run project scope')
    return concept
  }

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
      scope: { projectKey: run.projectKey ?? run.repoRoot }, key: request.key, name: request.name, definition: request.definition,
      target: request.target, effect: request.effect, evidenceSummary: request.evidenceSummary,
      ...(request.evidenceIds === undefined ? {} : { evidenceIds: request.evidenceIds }),
      ...(request.confidence === undefined ? {} : { confidence: request.confidence }),
      provenance: [{ sourceType: 'run', sourceId: run.id, runId: run.id }],
    })
    this.store.updateRun(run.id, current => ({
      ...current,
      conceptIds: [...new Set([...(current.conceptIds ?? []), observed.concept.id])],
    }))
    return this.snapshot(run.id)
  }

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
    const corrected = this.concepts.correct({
      scope: { projectKey: run.projectKey ?? run.repoRoot }, key: request.key, name: request.name, definition: request.definition,
      target: request.target, effect: request.effect, evidenceSummary: request.evidenceSummary, resolution: request.resolution,
      ...(request.evidenceIds === undefined ? {} : { evidenceIds: request.evidenceIds }),
    })
    this.store.updateRun(run.id, current => ({ ...current, conceptIds: [...new Set([...(current.conceptIds ?? []), corrected.id])] }))
    return this.snapshot(run.id)
  }

  @Remote('playbooks')
  remotePlaybooks(runId: string): readonly Playbook[] {
    const run = this.requireRun(runId)
    return this.playbooks.list(run.projectKey ?? run.repoRoot).slice(0, 8)
  }

  @Remote('playbookDetail')
  remotePlaybookDetail(request: { readonly runId: string; readonly playbookId: string }): Playbook {
    const run = this.requireRun(request.runId)
    const playbook = this.playbooks.require(request.playbookId)
    if (playbook.scope !== undefined && playbook.scope.projectKey !== (run.projectKey ?? run.repoRoot)) throw new Error('playbook is outside the run project scope')
    return playbook
  }

  @Remote('knowledge')
  remoteKnowledge(runId: string): readonly KnowledgeCandidate[] {
    const run = this.requireRun(runId)
    return this.knowledge.list(run.projectKey ?? run.repoRoot).slice(0, 20)
  }

  @Remote('knowledgeDetail')
  remoteKnowledgeDetail(request: { readonly runId: string; readonly knowledgeId: string }): KnowledgeCandidate | undefined {
    const run = this.requireRun(request.runId)
    const knowledge = this.knowledge.get(request.knowledgeId)
    if (knowledge !== undefined && knowledge.scope.projectKey !== (run.projectKey ?? run.repoRoot)) throw new Error('knowledge is outside the run project scope')
    return knowledge
  }

  @Remote('resolveUncertainty')
  remoteResolveUncertainty(request: { readonly runId: string; readonly uncertaintyId: string; readonly status: 'RESOLVED' | 'DISMISSED'; readonly resolution: string }): AutoDevSnapshot {
    const uncertainty = this.store.getUncertainty(request.uncertaintyId)
    if (uncertainty === undefined || uncertainty.runId !== request.runId) throw new Error('uncertainty is not part of this run')
    this.semantics.resolveUncertainty(request.uncertaintyId, request.status, request.resolution)
    return this.snapshot(request.runId)
  }

  @Remote('resolveAssumption')
  remoteResolveAssumption(request: { readonly runId: string; readonly assumptionId: string; readonly status: 'CONFIRMED' | 'INVALIDATED' | 'UNKNOWN'; readonly resolution: string }): AutoDevSnapshot {
    const assumption = this.store.getAssumption(request.assumptionId)
    if (assumption === undefined || assumption.runId !== request.runId) throw new Error('assumption is not part of this run')
    this.semantics.resolveAssumption(request.assumptionId, request.status, request.resolution)
    return this.snapshot(request.runId)
  }

  @Remote('compactKnowledge')
  remoteCompactKnowledge(runId: string): AutoDevSnapshot {
    const run = this.requireRun(runId)
    const intent = this.sideEffects.plan({ runId, kind: 'memory-write', target: `knowledge-compaction:${run.projectKey ?? run.repoRoot}`, risk: 'low' })
    this.sideEffects.authorize(intent.id, 'explicit knowledge compaction')
    this.sideEffects.start(intent.id)
    const report = this.knowledge.compact({ projectKey: run.projectKey ?? run.repoRoot })
    this.sideEffects.commit(intent.id, `knowledge compaction ${report.id} completed`)
    return this.snapshot(runId)
  }

  @Remote('promoteKnowledge')
  remotePromoteKnowledge(request: {
    readonly runId: string
    readonly knowledgeId: string
    readonly evidenceIds: readonly string[]
    readonly regressionCaseId?: string
  }): AutoDevSnapshot {
    const run = this.requireRun(request.runId)
    const knowledge = this.knowledge.get(request.knowledgeId)
    if (knowledge === undefined || knowledge.scope.projectKey !== (run.projectKey ?? run.repoRoot)) throw new Error('knowledge candidate is outside the run project scope')
    const intent = this.sideEffects.plan({ runId: request.runId, kind: 'knowledge-promotion', target: request.knowledgeId, risk: 'medium' })
    this.sideEffects.authorize(intent.id, 'explicit knowledge promotion')
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

  /** Host Remote: safe non-agent gate actions exposed to the browser. */
  @Remote('resolveGate')
  async remoteResolveGate(request: { readonly runId: string; readonly action: 'promote' | 'abandon' | 'cancel' }, signal: AbortSignal): Promise<AutoDevSnapshot> {
    return this.resolveGate(request.runId, request.action, undefined, signal)
  }

  /** Host Remote: explicit promotion after the browser has shown evidence. */
  @Remote('promote')
  async remotePromote(runId: string, signal: AbortSignal): Promise<AutoDevSnapshot> {
    return this.promote(runId, signal)
  }

  /** Host Remote: cancel while retaining the Worktree and artifacts. */
  @Remote('cancel')
  async remoteCancel(runId: string): Promise<AutoDevSnapshot> {
    return this.cancel(runId)
  }

  /** Return only a bounded, path-free Candidate Diff view to the Web Client. */
  @Remote('candidateDiff')
  async remoteCandidateDiff(runId: string, signal: AbortSignal): Promise<ArtifactContent | undefined> {
    signal.throwIfAborted()
    const run = this.requireRun(runId)
    const candidate = run.candidateId === undefined ? undefined : this.store.getCandidate(run.candidateId)
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

  async create(request: CreateRunRequest, signal?: AbortSignal): Promise<AutoDevSnapshot> {
    const baseline = await this.git.inspect(request.repoPath, signal)
    if (!baseline.clean) {
      throw new Error(`target repository has uncommitted changes; AutoDev requires a clean baseline:\n${baseline.status.join('\n')}`)
    }
    const id = randomUUID()
    const now = new Date().toISOString()
    const run: Run = {
      schemaVersion: 1,
      id,
      repoPath: baseline.repoRoot,
      request: requireText(request.request, 'request'),
      acceptanceCriteria: (request.acceptanceCriteria ?? []).map(item => requireText(item, 'acceptance criterion')),
      status: 'DRAFT',
      baseCommit: baseline.baseCommit,
      repoRoot: baseline.repoRoot,
      projectKey: baseline.repoRoot,
      ...(request.goalId === undefined ? {} : { goalId: request.goalId }),
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.store.createRun(run)
    const plan = this.makePlan(run)
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
      summary: `Clean baseline ${baseline.baseCommit} at ${baseline.repoRoot}`,
      createdAt: now,
    })
    this.store.saveEvidence({
      id: randomUUID(),
      runId: id,
      type: 'ENVIRONMENT',
      status: 'PASS',
      summary: `Host ${process.platform}/${process.arch}, Node ${process.version}`,
      environment: await this.environment(baseline.repoRoot, signal),
      createdAt: new Date().toISOString(),
    })
    this.transition(id, 'READY', { activePlanId: plan.id })
    return this.snapshot(id)
  }

  snapshot(runId: string): AutoDevSnapshot {
    return this.store.snapshot(runId)
  }

  listProviders(): readonly ProviderInfo[] {
    return this.router.list()
  }

  registerProvider(provider: Parameters<ProviderRouter['register']>[0]): () => void {
    return this.router.register(provider)
  }

  async run(runId: string, parentAgent?: unknown, signal?: AbortSignal): Promise<AutoDevSnapshot> {
    const run = this.requireRun(runId)
    if (!['READY', 'REWORK_REQUESTED'].includes(run.status)) {
      throw new Error(`run ${runId} is ${run.status}; only READY or REWORK_REQUESTED runs can start`)
    }
    if (run.attempt >= this.config.maxAttempts) {
      this.openGate(runId, `maximum AutoDev attempts (${this.config.maxAttempts}) reached; review the retained Worktree before continuing`, ['rework', 'replan', 'cancel'])
      return this.snapshot(runId)
    }
    const operationSignal = signal ?? new AbortController().signal
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
          clean: true,
          status: [],
          capturedAt: run.createdAt,
        }, operationSignal, nextAttempt)
      if (run.worktreePath !== worktreePath) {
        this.store.updateRun(run.id, current => ({ ...current, worktreePath, status: current.status }))
      }
      this.transition(run.id, 'EXECUTING', { attempt: run.attempt + 1, lastError: undefined, currentGateId: undefined })
      await this.executeImplementation(run.id, worktreePath, parentAgent, operationSignal)
      await this.executeBuild(run.id, worktreePath, operationSignal)
      await this.executeTest(run.id, worktreePath, operationSignal)
      if (!await this.executeQuality(run.id, operationSignal)) return this.snapshot(run.id)
      await this.executeCompletion(run.id, operationSignal)
      return this.snapshot(run.id)
    } catch (error: unknown) {
      if (error instanceof InterventionRequiredError) {
        this.openGate(run.id, error.message, error.options)
      } else if (error instanceof JevUnavailableError) {
        this.openGate(run.id, `Jev is required but unavailable: ${error.message}`, ['retry', 'rework', 'cancel'])
      } else if (isAbort(error, operationSignal)) {
        this.transitionIfAllowed(run.id, 'PAUSED', { lastError: 'operation cancelled; worktree retained for recovery' })
      } else {
        const message = errorMessage(error)
        this.transitionIfAllowed(run.id, 'FAILED', { lastError: message })
        const gate = await this.failureGate(run.id, message, error, operationSignal)
        this.openGate(run.id, gate.reason, gate.options)
      }
      return this.snapshot(run.id)
    }
  }

  async resolveGate(runId: string, action: 'retry' | 'rework' | 'replan' | 'abandon' | 'promote' | 'cancel', parentAgent?: unknown, signal?: AbortSignal): Promise<AutoDevSnapshot> {
    const run = this.requireRun(runId)
    const gate = run.currentGateId === undefined ? undefined : this.store.getGate(run.currentGateId)
    if (gate === undefined || gate.status !== 'OPEN') throw new Error(`run ${runId} has no open Human Gate`)
    if (!gate.options.includes(action)) throw new Error(`action ${action} is not allowed by gate ${gate.id}`)
    this.store.saveGate({ ...gate, status: 'RESOLVED', selected: action, resolvedAt: new Date().toISOString() })
    if (action === 'abandon') {
      this.transition(runId, 'ABANDONED', { currentGateId: undefined })
      return this.snapshot(runId)
    }
    if (action === 'cancel') {
      this.transition(runId, 'CANCELLED', { currentGateId: undefined })
      return this.snapshot(runId)
    }
    if (action === 'promote') return this.promote(runId, signal)
    if (action === 'replan') this.createReplan(runId)
    this.transition(runId, action === 'rework' || action === 'replan' ? 'REWORK_REQUESTED' : 'READY', { currentGateId: undefined })
    return this.run(runId, parentAgent, signal)
  }

  async promote(runId: string, signal?: AbortSignal): Promise<AutoDevSnapshot> {
    const run = this.requireRun(runId)
    if (run.status !== 'VERIFY' && run.status !== 'NEEDS_INTERVENTION') throw new Error(`run ${runId} is not ready for promotion`)
    if (run.worktreePath === undefined || run.candidateId === undefined) throw new Error('run has no sealed candidate')
    this.transition(runId, 'PROMOTING')
    const intent = this.sideEffects.plan({
      runId,
      kind: 'git-promotion',
      target: `${run.repoRoot}@${run.baseCommit}`,
      risk: 'destructive',
      preconditions: ['run is in VERIFY or explicitly approved Human Gate', 'candidate is sealed', 'original baseline is unchanged'],
      idempotencyKey: `${runId}:git-promotion:${Date.now()}`,
    })
    try {
      this.sideEffects.authorize(intent.id, 'explicit promote operation')
      this.sideEffects.start(intent.id)
      const diff = await this.git.diff(run.worktreePath, run.baseCommit, signal)
      const artifact = this.store.writeArtifact(runId, 'promotion', diff, '.patch')
      await this.git.promote(run.repoRoot, run.baseCommit, artifact.path, signal)
      const evidence = {
        id: randomUUID(), runId, candidateId: run.candidateId, type: 'PROMOTION', status: 'PASS',
        summary: `Applied candidate patch ${artifact.sha256} to ${run.repoRoot}`, artifactId: artifact.id, createdAt: new Date().toISOString(),
      } as const
      this.store.saveEvidence(evidence)
      this.sideEffects.commit(intent.id, evidence.summary, run.baseCommit, artifact.sha256, [evidence.id])
      this.transition(runId, 'PROMOTED')
    } catch (error: unknown) {
      this.sideEffects.unknown(intent.id, `promotion outcome is unknown: ${errorMessage(error)}`)
      this.transitionIfAllowed(runId, 'NEEDS_INTERVENTION', { lastError: errorMessage(error) })
      this.openGate(runId, `promotion outcome is unknown: ${errorMessage(error)}`, ['promote', 'abandon', 'cancel'])
    }
    return this.snapshot(runId)
  }

  async cancel(runId: string): Promise<AutoDevSnapshot> {
    const run = this.requireRun(runId)
    this.transitionIfAllowed(runId, 'CANCELLED', { lastError: 'cancelled by user' })
    return this.snapshot(run.id)
  }

  private async executeImplementation(runId: string, worktreePath: string, parentAgent: unknown, signal: AbortSignal): Promise<void> {
    const run = this.requireRun(runId)
    const plan = this.activePlan(run)
    const node = plan.nodes.find(item => item.kind === 'implement')
    if (node === undefined) throw new Error('active plan has no implement node')
    const execution = this.beginNode(run, plan, node)
    const selection = await this.router.select(runId, node.id, 'agent-route', node.routeName ?? 'implement', {
      request: run.request,
      acceptanceCriteria: run.acceptanceCriteria,
      availableProviders: this.router.list(),
    }, ['code-edit', 'local-workspace'], signal)
    if (selection.candidate === undefined) {
      this.failNode(execution, 'no eligible Coding Agent Provider is loaded')
      throw new Error('no eligible Coding Agent Provider is loaded')
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
      kind: node.kind === 'implement' ? 'implement' : 'custom',
      instruction: run.request,
      acceptanceCriteria: run.acceptanceCriteria,
      workspacePath: worktreePath,
      createdAt: new Date().toISOString(),
    }
    const context: AgentContext = {
      runId,
      projectKey: run.repoRoot,
      repoRoot: run.repoRoot,
      baseCommit: run.baseCommit,
      workspacePath: worktreePath,
      planVersionId: plan.id,
      nodeId: node.id,
      attempt: run.attempt,
      evidenceIds: this.store.listEvidence(runId).map(item => item.id).slice(-16),
      memoryRefs: this.memory.search(run.projectKey ?? run.repoRoot, run.request, { limit: 4, maxChars: 400 }).map(item => item.memory.id),
      playbookRefs: this.playbooks.search(run.projectKey ?? run.repoRoot, run.request).slice(0, 4).map(item => item.id),
    }
    let result: Awaited<ReturnType<AgentProtocol['execute']>>
    try {
      result = await this.protocol.execute(this.router.agentAdapter(selection.candidate), {
        task,
        context,
        signal,
        parentAgent,
      })
      for (const signal of result.signals) this.store.saveAgentSignal(signal)
    } catch (error: unknown) {
      this.sideEffects.unknown(action.id, `${selection.candidate.provider} invocation outcome is unknown`)
      this.store.saveEvidence({ id: randomUUID(), runId, planId: plan.id, nodeId: node.id, type: 'SIDE_EFFECT', status: 'UNKNOWN', source: 'system', summary: `${selection.candidate.provider} workspace side effect outcome is unknown`, createdAt: new Date().toISOString() })
      this.unknownNode(execution, errorMessage(error))
      this.store.saveEvidence({
        id: randomUUID(),
        runId,
        type: 'AGENT_OUTPUT',
        status: 'UNKNOWN',
        summary: `${selection.candidate.provider} threw after start; file and external side effects are unknown`,
        createdAt: new Date().toISOString(),
      })
      throw new ExternalOutcomeUnknownError(`${selection.candidate.provider} invocation outcome is unknown`, { cause: error })
    }
    const outputArtifact = this.store.writeArtifact(runId, 'agent-output', result.output)
    const outputTree = await this.git.treeHash(worktreePath, signal)
    const agentEvidence = {
      id: randomUUID(), runId, type: 'AGENT_OUTPUT', status: result.status === 'completed' ? 'PASS' : 'FAIL',
      summary: result.status === 'completed' ? `Provider ${result.provider} completed implementation` : `${result.provider}: ${result.diagnostic ?? result.status}`,
      gitTreeHash: outputTree, artifactId: outputArtifact.id, createdAt: new Date().toISOString(),
    } as const
    this.store.saveEvidence(agentEvidence)
    if (result.status !== 'completed') {
      const diagnostic = result.diagnostic ?? `Provider ${result.provider} ended with ${result.status}`
      this.sideEffects.unknown(action.id, diagnostic, [agentEvidence.id])
      this.store.saveEvidence({ id: randomUUID(), runId, planId: plan.id, nodeId: node.id, type: 'SIDE_EFFECT', status: 'UNKNOWN', source: 'system', summary: `Agent workspace side effect is unknown: ${diagnostic}`, createdAt: new Date().toISOString() })
      this.unknownNode(execution, diagnostic)
      throw new ExternalOutcomeUnknownError(diagnostic)
    }
    const diff = await this.git.diff(worktreePath, run.baseCommit, signal)
    const diffArtifact = this.store.writeArtifact(runId, 'candidate-diff', diff, '.patch')
    const candidate: CandidateRevision = {
      id: randomUUID(), runId, planId: plan.id, worktreePath, baseCommit: run.baseCommit,
      gitTreeHash: outputTree, diffArtifactId: diffArtifact.id, createdAt: new Date().toISOString(),
    }
    this.store.saveCandidate(candidate)
    this.store.updateRun(runId, current => ({ ...current, candidateId: candidate.id }))
    this.completeNode(execution, selection.candidate.provider, outputTree)
    const intervention = this.ingestAgentSignals(run, plan.id, result.signals)
    if (intervention.unknownSideEffect) {
      this.sideEffects.unknown(action.id, intervention.reason ?? 'unexpected Agent side effect was reported', [agentEvidence.id])
      this.store.saveEvidence({ id: randomUUID(), runId, planId: plan.id, nodeId: node.id, type: 'SIDE_EFFECT', status: 'UNKNOWN', source: 'agent', summary: intervention.reason ?? 'unexpected Agent side effect was reported', createdAt: new Date().toISOString() })
    } else {
      this.sideEffects.commit(action.id, `sealed candidate ${candidate.id}`, undefined, outputTree, [agentEvidence.id])
      this.store.saveEvidence({ id: randomUUID(), runId, candidateId: candidate.id, planId: plan.id, nodeId: node.id, gitTreeHash: outputTree, type: 'SIDE_EFFECT', status: 'PASS', source: 'system', summary: `Agent workspace side effect committed at ${outputTree}`, createdAt: new Date().toISOString() })
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
    const result = await this.runMaven(runId, node.id, worktreePath, this.config.maven.buildArgs, this.config.buildTimeoutMs, signal)
    const after = await this.git.treeHash(worktreePath, signal)
    this.saveCommandEvidence(runId, 'BUILD', result, before, after)
    if (before !== after) {
      this.store.saveEvidence({ id: randomUUID(), runId, type: 'DRIFT', status: 'FAIL', gitTreeHash: after, summary: 'Build changed tracked files after the candidate was sealed', createdAt: new Date().toISOString() })
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
    const result = await this.runMaven(runId, node.id, worktreePath, this.config.maven.testArgs, this.config.testTimeoutMs, signal)
    const after = await this.git.treeHash(worktreePath, signal)
    this.saveCommandEvidence(runId, 'TEST', result, before, after)
    if (before !== after) {
      this.store.saveEvidence({ id: randomUUID(), runId, type: 'DRIFT', status: 'FAIL', gitTreeHash: after, summary: 'Tests changed tracked files after the candidate was sealed', createdAt: new Date().toISOString() })
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
      this.openGate(runId, `deterministic verification is ${verification.status}: ${verification.summary}`, ['rework', 'replan', 'promote', 'abandon', 'cancel'])
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
    envelopes: readonly AgentSignalEnvelope[],
  ): { readonly reason?: string; readonly options: HumanGate['options']; readonly unknownSideEffect: boolean } {
    const reasons: string[] = []
    let options: HumanGate['options'] = ['rework', 'replan', 'abandon', 'cancel']
    let unknownSideEffect = false
    const assumptionIds = [...(run.assumptionIds ?? [])]
    for (const envelope of envelopes) {
      const signal = envelope.signal
      const provenance = [{ sourceType: 'signal' as const, sourceId: envelope.id, runId: run.id }]
      switch (signal.type) {
        case 'AssumptionRaised': {
          if (signal.statement === undefined || signal.statement.trim() === '') break
          const assumption = this.semantics.raiseAssumption({
            scope: { projectKey: run.projectKey ?? run.repoRoot }, runId: run.id, planId,
            statement: signal.statement, ...(signal.confidence === undefined ? {} : { confidence: signal.confidence }), provenance,
          })
          assumptionIds.push(assumption.id)
          for (const conflictingId of signal.conflictsWith ?? []) {
            const conflicting = this.store.getAssumption(conflictingId)
            if (conflicting?.runId === run.id && conflicting.status !== 'INVALIDATED') {
              this.semantics.resolveAssumption(conflicting.id, 'INVALIDATED', `Agent signal ${envelope.id} reported conflicting evidence`, [])
              reasons.push(`assumption ${conflicting.id} was invalidated by Agent evidence`)
            }
          }
          break
        }
        case 'SemanticUncertainty': {
          const uncertainty = this.semantics.raiseUncertainty({
            scope: { projectKey: run.projectKey ?? run.repoRoot }, runId: run.id,
            subject: signal.subject ?? 'Agent semantic interpretation',
            reason: signal.reason ?? 'Agent reported unresolved semantic uncertainty',
            ...(signal.alternatives === undefined ? {} : { alternatives: signal.alternatives }), provenance,
          })
          reasons.push(`semantic uncertainty ${uncertainty.id}: ${uncertainty.reason}`)
          break
        }
        case 'KnowledgeCandidate': {
          const statement = signal.subject ?? signal.summary
          if (statement === undefined || statement.trim() === '') break
          this.knowledge.candidate({
            scope: { projectKey: run.projectKey ?? run.repoRoot }, kind: 'experience', statement,
            content: signal.summary ?? statement, ...(signal.confidence === undefined ? {} : { confidence: signal.confidence }), provenance,
          })
          break
        }
        case 'PlaybookMatched':
        case 'PlaybookMismatch': {
          if (signal.playbookId === undefined || this.store.getPlaybook(signal.playbookId) === undefined) break
          const fit = this.playbooks.fit(signal.playbookId, { target: run.request, effect: run.request }, run.id)
          if (signal.type === 'PlaybookMismatch') reasons.push(`playbook ${signal.playbookId} mismatch: ${signal.reason ?? fit.reasons.join('; ')}`)
          break
        }
        case 'EvidenceProduced': {
          const id = signal.evidenceId ?? randomUUID()
          if (this.store.listEvidence(run.id).some(item => item.id === id)) break
          this.store.saveEvidence({
            id, runId: run.id, planId, nodeId: envelope.nodeId, type: 'AGENT_OUTPUT', status: 'UNKNOWN',
            source: 'agent', summary: `Agent-reported Evidence is untrusted until Runtime verification: ${signal.summary ?? 'no summary'}`,
            createdAt: envelope.createdAt,
          })
          break
        }
        case 'VerificationFailed': {
          this.store.saveEvidence({
            id: randomUUID(), runId: run.id, planId, nodeId: envelope.nodeId, type: 'VERIFICATION', status: 'FAIL', source: 'agent',
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
          this.store.saveEvidence({ id: randomUUID(), runId: run.id, planId, nodeId: envelope.nodeId, type: 'SIDE_EFFECT', status: 'UNKNOWN', source: 'agent', summary, createdAt: envelope.createdAt })
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
    const projectKey = run.projectKey ?? run.repoRoot
    const sourceId = `run:${run.id}:${candidate.id}`
    const evidenceIds = this.store.listEvidence(run.id).filter(item => item.status === 'PASS').map(item => item.id)
    if (!this.memory.list(projectKey, true).some(item => item.provenance.some(ref => ref.sourceId === sourceId))) {
      this.memory.remember({
        scope: { projectKey }, kind: 'experience', title: `AutoDev run ${run.id} candidate`,
        content: `Request: ${run.request}. Candidate tree ${candidate.gitTreeHash} passed deterministic verification (${verification.id}).`,
        tags: ['autodev', 'candidate', 'verification'], status: 'CANDIDATE', confidence: 0.7,
        provenance: [{ sourceType: 'run', sourceId, runId: run.id }], evidenceIds,
      })
    }
    if (!this.knowledge.list(projectKey, true).some(item => item.provenance.some(ref => ref.sourceId === sourceId))) {
      this.knowledge.candidate({
        scope: { projectKey }, kind: 'experience', statement: `A candidate for "${run.request}" passed deterministic verification`,
        content: `Candidate ${candidate.id} at tree ${candidate.gitTreeHash} passed verification ${verification.id}.`, confidence: 0.7,
        provenance: [{ sourceType: 'run', sourceId, runId: run.id }], evidenceIds,
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
    const result = await this.decisions.evaluate('quality', {
      request: run.request,
      acceptanceCriteria: run.acceptanceCriteria,
      candidateTree: candidate?.gitTreeHash,
      evidence: evidence.map(item => ({ type: item.type, status: item.status, summary: item.summary })),
    }, signal)
    this.recordJev(runId, 'quality', result, result.degraded === undefined ? 'accepted' : 'degraded', result.degraded ?? 'quality decision recorded')
    const score = answerOf(result, 'score')?.value
    const needsReview = answerOf(result, 'needs_review')?.value === true
    const scorePass = typeof score === 'number' && score >= this.config.qualityMinScore
    const reviewStatus = scorePass && !needsReview ? 'PASS' : 'WARN'
    this.store.saveEvidence({
      id: randomUUID(),
      runId,
      type: 'REVIEW',
      planId: this.activePlan(run).id,
      status: reviewStatus,
      ...(candidate === undefined ? {} : { candidateId: candidate.id, gitTreeHash: candidate.gitTreeHash }),
      summary: typeof score === 'number'
        ? `Jev quality score ${score}/${100}; minimum ${this.config.qualityMinScore}${needsReview ? '; additional human review requested' : ''}`
        : 'Jev quality score was not available; human review is required',
      createdAt: new Date().toISOString(),
    })
    this.recordVerification(runId)
    if (!scorePass || needsReview) {
      this.openGate(runId, `quality review required${typeof score === 'number' ? `: score ${score}/${100}` : ''}`, ['rework', 'replan', 'promote', 'abandon', 'cancel'])
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
    const evaluation = evaluateVerification(checks, this.store.listEvidence(runId), new Date().toISOString(), run.candidateId)
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

  private async runMaven(
    runId: string,
    nodeId: string,
    worktreePath: string,
    configuredArgs: readonly string[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    if (!existsSync(join(worktreePath, 'pom.xml'))) throw new Error('v1 Java driver requires pom.xml in the Worktree')
    const executable = this.config.maven.executable ?? (process.platform === 'win32' && existsSync(join(worktreePath, 'mvnw.cmd'))
      ? 'mvnw.cmd'
      : existsSync(join(worktreePath, 'mvnw')) ? './mvnw' : 'mvn')
    const intent = this.sideEffects.plan({ runId, nodeId, kind: 'command', target: `${executable} ${configuredArgs.join(' ')}`, risk: 'low', preconditions: ['candidate is sealed'] })
    this.sideEffects.authorize(intent.id, 'AutoDev deterministic command policy')
    this.sideEffects.start(intent.id)
    try {
      const result = await this.commands.run([executable, ...configuredArgs], worktreePath, {
        signal,
        timeoutMs,
        maxOutputBytes: 8 * 1024 * 1024,
      })
      const summary = result.timedOut ? 'command timed out' : `command exited ${String(result.exitCode)}`
      const passed = result.exitCode === 0 && !result.timedOut
      const evidenceId = randomUUID()
      const currentRun = this.requireRun(runId)
      this.store.saveEvidence({ id: evidenceId, runId, ...(currentRun.candidateId === undefined ? {} : { candidateId: currentRun.candidateId }), ...(currentRun.activePlanId === undefined ? {} : { planId: currentRun.activePlanId }), nodeId, type: 'SIDE_EFFECT', status: passed ? 'PASS' : 'FAIL', source: 'command', summary: `Command side effect: ${summary}`, createdAt: new Date().toISOString() })
      if (passed) this.sideEffects.commit(intent.id, summary, undefined, undefined, [evidenceId])
      else this.sideEffects.fail(intent.id, summary, [evidenceId])
      return result
    } catch (error: unknown) {
      this.sideEffects.unknown(intent.id, `command outcome is unknown: ${errorMessage(error)}`)
      const currentRun = this.requireRun(runId)
      this.store.saveEvidence({ id: randomUUID(), runId, ...(currentRun.candidateId === undefined ? {} : { candidateId: currentRun.candidateId }), ...(currentRun.activePlanId === undefined ? {} : { planId: currentRun.activePlanId }), nodeId, type: 'SIDE_EFFECT', status: 'UNKNOWN', source: 'command', summary: `Command side effect outcome is unknown: ${errorMessage(error)}`, createdAt: new Date().toISOString() })
      throw error
    }
  }

  private saveCommandEvidence(runId: string, type: 'BUILD' | 'TEST', result: CommandResult, before: string, after: string): void {
    const run = this.requireRun(runId)
    const plan = this.activePlan(run)
    const output = [`$ ${result.argv.join(' ')}`, result.stdout, result.stderr].filter(Boolean).join('\n')
    const artifact = this.store.writeArtifact(runId, type.toLowerCase(), output, '.log')
    this.store.saveEvidence({
      id: randomUUID(),
      runId,
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
    this.store.saveGate(gate)
    this.transitionIfAllowed(runId, 'NEEDS_INTERVENTION', { currentGateId: gate.id, lastError: reason })
    return gate
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
        ['rework', 'replan', 'abandon', 'cancel'],
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
      fingerprint: fingerprint(current.nodes),
      createdAt: new Date().toISOString(),
    }
    this.store.createPlan(plan)
    this.store.updateRun(runId, value => ({ ...value, activePlanId: plan.id }))
    for (const [index, node] of plan.nodes.entries()) {
      this.store.createNode({ id: `${plan.id}:${node.id}:${run.attempt + 1}`, runId, planId: plan.id, nodeId: node.id, attempt: run.attempt + 1, status: index === 0 ? 'READY' : 'PENDING' })
    }
    return plan
  }

  private makePlan(run: Run): PlanVersion {
    const nodes: PlanNode[] = [
      { id: 'implement', kind: 'implement', description: 'Implement the requested change in the isolated Worktree', dependencies: [], expectedOutputs: ['source diff'], routeName: 'implement' },
      { id: 'build', kind: 'build', description: 'Run the Maven build and capture immutable evidence', dependencies: ['implement'], expectedOutputs: ['BUILD PASS'] },
      { id: 'test', kind: 'test', description: 'Run the Maven/JUnit test suite and capture immutable evidence', dependencies: ['build'], expectedOutputs: ['TEST PASS'] },
    ]
    const playbookIds = this.playbooks.search(run.projectKey ?? run.repoRoot, run.request).slice(0, 8).map(item => item.id)
    return {
      schemaVersion: 1, id: randomUUID(), runId: run.id, version: 1, status: 'ACTIVE', fingerprint: fingerprint(nodes), nodes, createdAt: new Date().toISOString(),
      ...(playbookIds.length === 0 ? {} : { playbookIds }),
    }
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
    if (current === undefined || current.status === status || !ALLOWED_TRANSITIONS[current.status].includes(status)) return
    this.transition(runId, status, patch)
  }

  private requireRun(runId: string): Run {
    const run = this.store.getRun(runId)
    if (run === undefined) throw new Error(`AutoDev run ${runId} does not exist`)
    return run
  }

  private async environment(repoRoot: string, signal?: AbortSignal): Promise<EnvironmentFingerprint> {
    const [git, java, maven] = await Promise.all([
      this.commands.run(['git', '--version'], repoRoot, { signal, timeoutMs: this.config.commandTimeoutMs }),
      this.commands.run(['java', '-version'], repoRoot, { signal, timeoutMs: this.config.commandTimeoutMs }),
      this.commands.run(['mvn', '-version'], repoRoot, { signal, timeoutMs: this.config.commandTimeoutMs }),
    ])
    return {
      platform: process.platform, arch: process.arch, node: process.version,
      ...(git.exitCode === 0 ? { git: git.stdout.trim() } : {}),
      ...(java.exitCode === 0 ? { java: `${java.stdout}\n${java.stderr}`.trim().split(/\r?\n/)[0] } : {}),
      ...(maven.exitCode === 0 ? { maven: `${maven.stdout}\n${maven.stderr}`.trim().split(/\r?\n/)[0] } : {}),
      buildArgs: [...this.config.maven.buildArgs],
      testArgs: [...this.config.maven.testArgs],
      ...(process.env.DSH_VERSION === undefined ? {} : { harness: process.env.DSH_VERSION }),
      capturedAt: new Date().toISOString(),
    }
  }
}

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
  readonly maven: Required<Pick<NonNullable<AutoDevConfig['maven']>, 'buildArgs' | 'testArgs'>> & NonNullable<AutoDevConfig['maven']>
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
    maven: {
      ...(config.maven ?? {}),
      buildArgs: config.maven?.buildArgs ?? ['-q', '-DskipTests', 'package'],
      testArgs: config.maven?.testArgs ?? ['-q', 'test'],
    },
  }
}

function getService<T>(ctx: Context, key: string): T | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get(key) as T | undefined
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

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError'))
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
