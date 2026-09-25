import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandExecutor, CommandResult } from '../src/command.ts'
import { HarnessCommandExecutor } from '../src/command.ts'
import type { CandidateRevision, Evidence, HumanGate, PlanVersion, ProviderRunRequest, Run } from '../src/contracts.ts'
import { GitManager } from '../src/git.ts'
import { AutoDevRuntime } from '../src/runtime.ts'
import { SideEffectService } from '../src/side-effects.ts'
import { AutoDevStore } from '../src/store.ts'
import { DecisionCoordinator, HttpJevProvider, JevUnavailableError, questionsFor } from '../src/jev.ts'
import { AgentProtocol, isValidAgentSignalEnvelope, normalizeSignal, type AutoDevAgentContext, type AgentTask } from '../src/protocol.ts'
import { commandProvider, ProviderRouter } from '../src/router.ts'
import { defaultVerificationChecks, evaluateVerification } from '../src/verification.ts'
import { trustedTestDecisions } from './harness.ts'

const tempRoots: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-autodev-${label}-`))
  tempRoots.push(root)
  return root
}

function sampleRun(root: string): Run {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    id: 'run-store',
    repoPath: root,
    request: 'test persistence',
    acceptanceCriteria: [],
    status: 'READY',
    baseCommit: '0123456789abcdef0123456789abcdef01234567',
    repoRoot: root,
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  }
}

async function createGatePromotionFixture(label: string): Promise<{
  readonly runtime: AutoDevRuntime
  readonly runId: string
  readonly stateRoot: string
  readonly worktreeRoot: string
  readonly gate: HumanGate
  readonly candidate: CandidateRevision
}> {
  const repoRoot = tempRoot(`${label}-repo`)
  const stateRoot = tempRoot(`${label}-state`)
  const worktreeRoot = tempRoot(`${label}-worktrees`)
  await createGitRepo(repoRoot)
  const runtime = new AutoDevRuntime(new Context(), { dataRoot: stateRoot, worktreeRoot, jev: { mode: 'off' } }, { commands: new FakeMavenExecutor() })
  const created = await runtime.create({ repoPath: repoRoot, request: `exercise ${label}` })
  if (created.plan === undefined) throw new Error('promotion fixture has no Plan')
  const candidate: CandidateRevision = {
    id: `candidate-${label}`, runId: created.run.id, planId: created.plan.id,
    worktreePath: join(worktreeRoot, 'sealed-candidate'), baseCommit: created.run.baseCommit!,
    gitTreeHash: `sealed-tree-${label}`, attempt: created.run.attempt, createdAt: new Date().toISOString(),
  }
  const gate: HumanGate = {
    id: `gate-${label}`, runId: created.run.id, reason: 'explicit promotion decision fixture',
    options: ['promote', 'rework', 'replan', 'abandon', 'cancel'], status: 'OPEN', createdAt: new Date().toISOString(),
  }
  runtime.store.saveCandidate(candidate)
  runtime.store.saveGate(gate)
  runtime.store.updateRun(created.run.id, current => ({
    ...current, status: 'NEEDS_INTERVENTION', candidateId: candidate.id,
    worktreePath: candidate.worktreePath, currentGateId: gate.id,
  }))
  return { runtime, runId: created.run.id, stateRoot, worktreeRoot, gate, candidate }
}

describe('AutoDev persistence', () => {
  it('stores snapshots, events and content-addressed artifacts', () => {
    const root = tempRoot('store')
    const store = new AutoDevStore(root)
    const run = sampleRun(root)
    store.createRun(run)
    store.updateRun(run.id, value => ({ ...value, status: 'PAUSED' }))
    const artifact = store.writeArtifact(run.id, 'notes', 'hello\n')

    expect(store.getRun(run.id)?.status).toBe('PAUSED')
    expect(store.readArtifact(artifact).toString('utf8')).toBe('hello\n')
    expect(store.snapshot(run.id).run.id).toBe(run.id)
    expect(store.events(run.id).map(item => item.type)).toEqual([
      'run/created',
      'run/updated',
      'artifact/written',
    ])
    store.close()
  })

  it('rejects content-addressed artifacts whose stored bytes changed', () => {
    const store = new AutoDevStore(tempRoot('artifact-integrity'))
    const run = sampleRun(tempRoot('artifact-integrity-repo'))
    store.createRun(run)
    const artifact = store.writeArtifact(run.id, 'patch', 'original patch\n', '.patch')
    writeFileSync(artifact.path, 'tampered patch\n')
    expect(() => store.readArtifact(artifact)).toThrow(/SHA-256 integrity check/)
    store.close()
  })

  it('keeps Plan definitions immutable while allowing a one-way lifecycle transition', () => {
    const store = new AutoDevStore(tempRoot('plan-immutability'))
    const plan: PlanVersion = {
      schemaVersion: 1, id: 'plan-immutable', runId: 'run-immutable', version: 1,
      status: 'ACTIVE', fingerprint: 'sha256:plan-v1', nodes: [], createdAt: new Date().toISOString(),
    }
    try {
      store.createPlan(plan)
      store.createPlan(plan)
      expect(() => store.createPlan({
        ...plan,
        nodes: [{ id: 'mutated', kind: 'test', description: 'mutated plan', dependencies: [], expectedOutputs: [] }],
      }))
        .toThrow(/different immutable definition/)
      expect(store.getPlan(plan.id)).toEqual(plan)
      expect(store.updatePlanStatus(plan.id, 'SUPERSEDED').status).toBe('SUPERSEDED')
      expect(() => store.updatePlanStatus(plan.id, 'CANCELLED')).toThrow(/cannot transition from SUPERSEDED/)
      expect(store.events(plan.runId).map(event => event.type)).toEqual(['plan/created', 'plan/status-updated'])
    } finally {
      store.close()
    }
  })
})

describe('Jev boundary', () => {
  it('sends bounded state and parses a System One answer', async () => {
    const apiKeyEnv = 'DSH_AUTODEV_TEST_JEV_KEY'
    const previous = process.env[apiKeyEnv]
    process.env[apiKeyEnv] = 'test-key'
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { state: Record<string, unknown> }
      expect(body.state).not.toHaveProperty('repoPath')
      expect(body.state).not.toHaveProperty('secret')
      return new Response(JSON.stringify({
        model: 'system-one-test',
        answers: { completion: { value: 'ready_for_verify', probability: 0.91 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new HttpJevProvider({ apiKeyEnv, retryCount: 0 })
    const result = await provider.evaluate({
      purpose: 'completion',
      state: { repoPath: 'C:/private/repo', secret: 'do-not-send', evidence: ['PASS'] },
      questions: questionsFor('completion'),
      signal: new AbortController().signal,
    })

    expect(result.source).toBe('jev')
    expect(result.modelVersion).toBe('system-one-test')
    expect(result.answers[0]?.value).toBe('ready_for_verify')
    expect(fetchMock).toHaveBeenCalledOnce()
    if (previous === undefined) Reflect.deleteProperty(process.env, apiKeyEnv)
    else process.env[apiKeyEnv] = previous
  })

  it('keeps advisory runs available and blocks required runs when Jev is unavailable', async () => {
    const unavailable = { evaluate: async () => { throw new Error('offline') } }
    const signal = new AbortController().signal
    const advisory = new DecisionCoordinator({ config: { mode: 'advisory' }, provider: unavailable })
    const degraded = await advisory.evaluate('completion', {}, signal)
    expect(degraded.source).toBe('fallback')
    expect(degraded.degraded).toContain('offline')

    const required = new DecisionCoordinator({ config: { mode: 'required' }, provider: unavailable })
    await expect(required.evaluate('completion', {}, signal)).rejects.toBeInstanceOf(JevUnavailableError)
  })

  it('routes decisions through dynamically registered providers and audits their identity', async () => {
    const coordinator = new DecisionCoordinator({
      config: { mode: 'required' },
      provider: { evaluate: async () => { throw new Error('primary unavailable') } },
    })
    const dispose = coordinator.registerProvider('local-qwen', {
      async evaluate(request) {
        return {
          source: 'jev', modelVersion: 'qwen3-small-fixture',
          answers: request.questions.map(question => ({
            questionId: question.id, kind: question.type,
            value: question.type === 'choice' ? question.choices?.[0] ?? 'ready_for_verify'
              : question.type === 'score' ? question.max ?? 0 : false,
            probability: 0.9,
          })),
        }
      },
    }, 10)
    try {
      const result = await coordinator.evaluate('completion', {}, new AbortController().signal)
      expect(result.providerId).toBe('local-qwen')
      expect(result.source).toBe('jev')
    } finally {
      dispose()
    }
    await expect(coordinator.evaluate('completion', {}, new AbortController().signal))
      .rejects.toThrow(/jev-http: primary unavailable/)
  })

  it('hard-gates invalid answers and low confidence instead of trusting model output', async () => {
    const signal = new AbortController().signal
    const lowConfidence = new DecisionCoordinator({
      config: { mode: 'required', minConfidence: { completion: 0.9 } },
      provider: {
        async evaluate() {
          return {
            source: 'jev' as const,
            modelVersion: 'test',
            answers: [{ questionId: 'completion', kind: 'choice' as const, value: 'ready_for_verify', probability: 0.5 }],
          }
        },
      },
    })
    await expect(lowConfidence.evaluate('completion', {}, signal)).rejects.toBeInstanceOf(JevUnavailableError)

    const invalidChoice = new DecisionCoordinator({
      config: { mode: 'advisory' },
      provider: {
        async evaluate() {
          return {
            source: 'jev' as const,
            modelVersion: 'test',
            answers: [{ questionId: 'completion', kind: 'choice' as const, value: 'skip_tests', probability: 1 }],
          }
        },
      },
    })
    const fallback = await invalidChoice.evaluate('completion', {}, signal)
    expect(fallback.source).toBe('fallback')
    expect(fallback.degraded).toContain('outside the configured choices')
  })
})

describe('Agent Protocol', () => {
  const task: AgentTask = {
    protocolVersion: 'dsh.agent.v1',
    id: 'task-protocol',
    runId: 'run-protocol',
    planVersionId: 'plan-protocol',
    nodeId: 'implement',
    attempt: 1,
    kind: 'implement',
    instruction: 'make the requested change',
    acceptanceCriteria: ['the change is verifiable'],
    workspacePath: 'C:/worktree',
    createdAt: new Date().toISOString(),
  }
  const context: AutoDevAgentContext = {
    runId: task.runId,
    projectKey: 'C:/repo',
    repoRoot: 'C:/repo',
    baseCommit: 'base',
    workspacePath: task.workspacePath,
    planVersionId: task.planVersionId,
    nodeId: task.nodeId,
    attempt: task.attempt,
    evidenceIds: [],
  }

  it('normalizes emitted and returned signals into an ordered envelope', async () => {
    const protocol = new AgentProtocol()
    const dispose = protocol.register({
      name: 'protocol-fixture',
      kind: 'test',
      capabilities: {
        traits: ['code-edit'],
        taskKinds: ['implement'],
        workspace: 'isolated',
        supportsCancellation: true,
        supportsSignals: true,
      },
      async execute(request) {
        request.emitSignal({ type: 'AssumptionRaised', statement: 'the fixture is deterministic' })
        return {
          provider: 'spoofed-provider',
          status: 'completed',
          output: 'done',
          signals: [{ type: 'FutureSignal', detail: 'preserve me as unknown' }],
        }
      },
    })

    const result = await protocol.execute('protocol-fixture', { task, context, signal: new AbortController().signal })
    expect(result.output).toBe('done')
    expect(result.provider).toBe('protocol-fixture')
    expect(result.signals.map(item => item.sequence)).toEqual([1, 2])
    expect(result.signals[0]?.signal.type).toBe('AssumptionRaised')
    expect(result.signals[1]?.signal).toMatchObject({ type: 'UnknownSignal', name: 'FutureSignal' })
    expect(isValidAgentSignalEnvelope(result.signals[0], {
      taskId: task.id, runId: task.runId, planVersionId: task.planVersionId, nodeId: task.nodeId,
      attempt: task.attempt, provider: 'protocol-fixture', sequence: 1,
    })).toBe(true)
    expect(isValidAgentSignalEnvelope(result.signals[0], {
      taskId: task.id, runId: task.runId, planVersionId: task.planVersionId, nodeId: task.nodeId,
      attempt: task.attempt, provider: 'protocol-fixture', sequence: 2,
    })).toBe(false)
    expect(isValidAgentSignalEnvelope({ ...result.signals[0], runId: 'foreign-run' }, {
      taskId: task.id, runId: task.runId, planVersionId: task.planVersionId, nodeId: task.nodeId,
      attempt: task.attempt, provider: 'protocol-fixture', sequence: 1,
    })).toBe(false)
    expect(protocol.list()).toHaveLength(1)
    dispose()
    expect(protocol.list()).toHaveLength(0)
  })

  it('bounds foreign signal payloads without treating them as trusted protocol facts', () => {
    const signal = normalizeSignal({ type: 'ForeignSignal', path: 'C:/private', nested: { value: 'x' } })
    expect(signal).toMatchObject({ type: 'UnknownSignal', name: 'ForeignSignal' })
    expect(signal).not.toHaveProperty('path')
    expect(signal).toHaveProperty('payload.nested.value', 'x')
  })

  it('downgrades malformed known signals instead of persisting them as trusted vocabulary', () => {
    expect(normalizeSignal({ type: 'AssumptionRaised', statement: 42 })).toMatchObject({ type: 'UnknownSignal', name: 'AssumptionRaised' })
    expect(normalizeSignal({ type: 'AssumptionRaised', statement: 'an assumption', confidence: 4 })).toMatchObject({ type: 'UnknownSignal', name: 'AssumptionRaised' })
    expect(normalizeSignal({ type: 'PlaybookMatched', playbookId: 'p1', fit: 'NOPE' })).toMatchObject({ type: 'UnknownSignal', name: 'PlaybookMatched' })
    expect(normalizeSignal({ type: 'SemanticUncertainty', subject: 'refund', reason: 'partial/full', alternatives: Array.from({ length: 33 }, (_, index) => `option-${index}`) })).toMatchObject({ type: 'UnknownSignal', name: 'SemanticUncertainty' })
    expect(normalizeSignal({ type: 'UnexpectedSideEffect', description: 'external write', path: 'C:/work' })).toMatchObject({ type: 'UnexpectedSideEffect', path: 'C:/work' })
  })

  it('rejects an unsupported protocol version before invoking the provider', async () => {
    let invoked = false
    const adapter = {
      name: 'old-version-fixture', kind: 'test',
      capabilities: { traits: [], taskKinds: ['implement'] as const, workspace: 'isolated' as const, supportsCancellation: true, supportsSignals: true },
      async execute() { invoked = true; return { provider: 'fixture', status: 'completed' as const, output: 'must not run' } },
    }
    const oldTask = { ...task, protocolVersion: 'dsh.agent.v0' } as unknown as AgentTask
    await expect(new AgentProtocol().execute(adapter, {
      task: oldTask, context, signal: new AbortController().signal,
    })).rejects.toThrow(/unsupported Agent Protocol version dsh\.agent\.v0/)
    expect(invoked).toBe(false)
  })

  it('checks task/context identity and provider capability before invoking an adapter', async () => {
    const protocol = new AgentProtocol()
    let called = false
    const reviewOnlyAdapter = {
      name: 'protocol-capability-fixture', kind: 'test',
      capabilities: { traits: [], taskKinds: ['review'] as const, workspace: 'isolated' as const, supportsCancellation: true, supportsSignals: true },
      async execute() { called = true; return { provider: 'fixture', status: 'completed' as const, output: 'unexpected' } },
    }
    await expect(protocol.execute(reviewOnlyAdapter, {
      task,
      context,
      signal: new AbortController().signal,
    })).rejects.toThrow(/does not support task kind implement/)
    const implementAdapter = {
      ...reviewOnlyAdapter,
      name: 'protocol-identity-fixture',
      capabilities: { ...reviewOnlyAdapter.capabilities, taskKinds: ['implement'] as const },
    }
    const mismatchedContext = { ...context, runId: 'another-run' }
    await expect(protocol.execute(implementAdapter, {
      task,
      context: mismatchedContext,
      signal: new AbortController().signal,
    })).rejects.toThrow(/identities do not match/)
    expect(called).toBe(false)
  })

  it('rejects supplemental context cards that exceed the shared character budget', async () => {
    const adapter = {
      name: 'protocol-context-budget-fixture', kind: 'test',
      capabilities: { traits: [], taskKinds: ['implement'] as const, workspace: 'isolated' as const, supportsCancellation: true, supportsSignals: true },
      async execute() { return { provider: 'fixture', status: 'completed' as const, output: 'ok' } },
    }
    const oversizedContext = { ...context, uncertaintyCards: ['x'.repeat(6001)] }
    await expect(new AgentProtocol().execute(adapter, {
      task, context: oversizedContext, signal: new AbortController().signal,
    })).rejects.toThrow(/exceed 6000 characters/)
    const oversizedRefs = { ...context, conceptRefs: Array.from({ length: 33 }, (_, index) => `concept-${index}`) }
    await expect(new AgentProtocol().execute(adapter, {
      task, context: oversizedRefs, signal: new AbortController().signal,
    })).rejects.toThrow(/conceptRefs must contain at most 32 bounded identifiers/)
  })

  it('checks async availability and bounds provider output', async () => {
    const unavailable = {
      name: 'protocol-unavailable-fixture', kind: 'test',
      capabilities: { traits: [], taskKinds: ['implement'] as const, workspace: 'isolated' as const, supportsCancellation: true, supportsSignals: true },
      isAvailable: () => false,
      async execute() { return { provider: 'fixture', status: 'completed' as const, output: 'not reached' } },
    }
    const protocol = new AgentProtocol()
    await expect(protocol.execute(unavailable, { task, context, signal: new AbortController().signal })).rejects.toThrow(/is unavailable/)
    const outputAdapter = {
      ...unavailable,
      name: 'protocol-output-fixture',
      isAvailable: () => true,
      async execute() { return { provider: 'fixture', status: 'completed' as const, output: 'x'.repeat(140_000) } },
    }
    const result = await protocol.execute(outputAdapter, { task, context, signal: new AbortController().signal })
    expect(result.output.length).toBeLessThan(140_000)
    expect(result.output).toContain('Agent output truncated')
  })

  it('marks completion after an unconfirmed cancellation UNKNOWN and honors signal capability', async () => {
    const controller = new AbortController()
    const adapter = {
      name: 'protocol-cancel-fixture', kind: 'test',
      capabilities: { traits: [], taskKinds: ['implement'] as const, workspace: 'isolated' as const, supportsCancellation: false, supportsSignals: false },
      async execute(request: { readonly signal: AbortSignal; readonly emitSignal: (signal: { readonly type: string }) => void }) {
        request.emitSignal({ type: 'AssumptionRaised' })
        return await new Promise<{ readonly provider: string; readonly status: 'completed'; readonly output: string }>((resolve) => {
          request.signal.addEventListener('abort', () => resolve({ provider: 'fixture', status: 'completed', output: 'edited before cancellation was observed' }), { once: true })
        })
      },
    }
    const pending = new AgentProtocol().execute(adapter, { task, context, signal: controller.signal })
    controller.abort()
    const result = await pending
    expect(result.status).toBe('unknown')
    expect(result.diagnostic).toContain('workspace outcome is unknown')
    expect(result.signals).toEqual([])
  })
})

describe('Evidence verification', () => {
  it('never reports completion when a required Evidence item is absent', () => {
    const root = tempRoot('verification')
    const run = sampleRun(root)
    const plan = {
      schemaVersion: 1 as const,
      id: 'plan-verification',
      runId: run.id,
      version: 1,
      status: 'ACTIVE' as const,
      fingerprint: 'fingerprint',
      nodes: [],
      createdAt: new Date().toISOString(),
    }
    const checks = defaultVerificationChecks(run, plan, new Date().toISOString())
    const report = evaluateVerification(checks, [])
    expect(report.status).toBe('UNKNOWN')
    expect(report.results.every(result => result.status === 'UNKNOWN')).toBe(true)
  })

  it('accepts only current-Run, current-Plan Evidence for the active Candidate tree', () => {
    const root = tempRoot('verification-binding')
    const run = sampleRun(root)
    const createdAt = new Date().toISOString()
    const plan = {
      schemaVersion: 1 as const,
      id: 'plan-current',
      runId: run.id,
      version: 1,
      status: 'ACTIVE' as const,
      fingerprint: 'fingerprint',
      nodes: [],
      createdAt,
    }
    const candidate = {
      id: 'candidate-current',
      runId: run.id,
      planId: plan.id,
      gitTreeHash: 'tree-current',
    }
    const check = defaultVerificationChecks(run, plan, createdAt).find(item => item.kind === 'build')
    expect(check).toBeDefined()
    const validEvidence: Evidence = {
      id: 'build-current',
      runId: run.id,
      planId: plan.id,
      candidateId: candidate.id,
      gitTreeHash: candidate.gitTreeHash,
      type: 'BUILD',
      status: 'PASS',
      summary: 'build passed',
      createdAt,
    }
    expect(evaluateVerification([check!], [validEvidence], candidate).status).toBe('PASS')

    const invalidEvidence: readonly Evidence[] = [
      { ...validEvidence, id: 'build-other-run', runId: 'run-other' },
      { ...validEvidence, id: 'build-other-plan', planId: 'plan-old' },
      { ...validEvidence, id: 'build-other-candidate', candidateId: 'candidate-old' },
      { ...validEvidence, id: 'build-old-tree', gitTreeHash: 'tree-old' },
    ]
    for (const evidence of invalidEvidence) {
      expect(evaluateVerification([check!], [evidence], candidate).status).toBe('UNKNOWN')
    }
    expect(evaluateVerification([check!], [validEvidence]).status).toBe('UNKNOWN')
    expect(evaluateVerification([check!], [{ ...validEvidence, status: 'FAIL' }], candidate).status).toBe('FAIL')
    expect(evaluateVerification([check!], [validEvidence], { ...candidate, runId: 'run-other' }).status).toBe('UNKNOWN')
    expect(evaluateVerification([check!], [validEvidence], { ...candidate, planId: 'plan-old' }).status).toBe('UNKNOWN')

    const sideEffectCheck = defaultVerificationChecks(run, plan, createdAt).find(item => item.kind === 'side-effect')
    expect(sideEffectCheck).toBeDefined()
    const sideEffectEvidence: Evidence = {
      id: 'side-effect-current',
      runId: run.id,
      planId: plan.id,
      candidateId: candidate.id,
      type: 'SIDE_EFFECT',
      status: 'PASS',
      summary: 'side effect completed',
      createdAt,
    }
    expect(evaluateVerification([sideEffectCheck!], [sideEffectEvidence], candidate).status).toBe('PASS')
  })

  it('rejects Build/Test Evidence from an earlier attempt even when its tree hash matches', () => {
    const run = sampleRun(tempRoot('verification-attempt'))
    const createdAt = new Date().toISOString()
    const plan = {
      schemaVersion: 1 as const, id: 'plan-attempt', runId: run.id, version: 1, status: 'ACTIVE' as const,
      fingerprint: 'attempt-fingerprint', nodes: [
        { id: 'build-node', kind: 'build' as const, description: 'build', dependencies: [], expectedOutputs: [] },
        { id: 'test-node', kind: 'test' as const, description: 'test', dependencies: ['build-node'], expectedOutputs: [] },
      ], createdAt,
    }
    const candidate = { id: 'candidate-current', runId: run.id, planId: plan.id, gitTreeHash: 'same-tree', attempt: 2 }
    const checks = defaultVerificationChecks(run, plan, createdAt)
    const evidenceForAttempt = (attempt: number) => checks.map((check, index) => ({
      id: `evidence-${attempt}-${index}`, runId: run.id,
      ...(check.kind === 'baseline' ? {} : { candidateId: candidate.id, planId: plan.id }),
      ...(check.nodeId === undefined ? {} : { nodeId: check.nodeId }),
      ...(check.kind === 'baseline' ? {} : { attempt }),
      ...(check.kind === 'build' || check.kind === 'test' || check.kind === 'review' ? { gitTreeHash: candidate.gitTreeHash } : {}),
      type: check.evidenceType, status: 'PASS' as const, summary: 'fixture PASS', createdAt,
    }))
    expect(evaluateVerification(checks, evidenceForAttempt(1), candidate).status).toBe('UNKNOWN')
    expect(evaluateVerification(checks, evidenceForAttempt(2), candidate).status).toBe('PASS')
  })

  it('keeps baseline Evidence Run-scoped without requiring a Candidate', () => {
    const root = tempRoot('verification-baseline')
    const run = sampleRun(root)
    const createdAt = new Date().toISOString()
    const plan = {
      schemaVersion: 1 as const,
      id: 'plan-baseline',
      runId: run.id,
      version: 1,
      status: 'ACTIVE' as const,
      fingerprint: 'fingerprint',
      nodes: [],
      createdAt,
    }
    const check = defaultVerificationChecks(run, plan, createdAt).find(item => item.kind === 'baseline')
    expect(check).toBeDefined()
    const evidence: Evidence = {
      id: 'baseline-current',
      runId: run.id,
      type: 'REPOSITORY_BASELINE',
      status: 'PASS',
      summary: 'clean baseline',
      createdAt,
    }
    expect(evaluateVerification([check!], [evidence]).status).toBe('PASS')
    expect(evaluateVerification([check!], [{ ...evidence, runId: 'run-other' }]).status).toBe('UNKNOWN')
    expect(evaluateVerification([check!], [{ ...evidence, planId: 'plan-old' }]).status).toBe('UNKNOWN')
  })
})

describe('dynamic Provider routing', () => {
  it('delegates official Codex/Claude route names to Harness Subagent Runtime', async () => {
    const start = vi.fn(async (_name: string, _request: unknown) => ({
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'agent completed' }] }),
      dispose: vi.fn(async () => {}),
    }))
    const subagents = {
      list: () => ['codex', 'claude-code'],
      getProvider: () => ({ capabilities: { workspaceCwd: true } }),
      start,
    } as unknown as SubagentRuntime
    const router = new ProviderRouter({
      decisions: trustedTestDecisions(),
      subagents,
    })
    const signal = new AbortController().signal
    const selection = await router.select(undefined, undefined, 'agent-route', 'implement', {}, ['code-edit', 'local-workspace'], signal)
    expect(selection.candidate?.provider).toBe('codex')
    const result = await router.invoke(selection.candidate as NonNullable<typeof selection.candidate>, {
      request: 'use the parent working directory', acceptanceCriteria: [], cwd: 'C:/worktree', signal, parentAgent: { id: 'parent' },
      context: {
        runId: 'run-context', projectKey: 'C:/repo', repoRoot: 'C:/repo', baseCommit: 'base', workspacePath: 'C:/worktree',
        planVersionId: 'plan-context', nodeId: 'implement', attempt: 1, evidenceIds: [],
        conceptRefs: ['concept-context'], conceptCards: ['concept-card: reviewed refund definition'],
        assumptionRefs: ['assumption-context'], assumptionCards: ['assumption-card: status=CONFIRMED'],
        uncertaintyRefs: ['uncertainty-context'], uncertaintyCards: ['uncertainty-card: status=RESOLVED'],
      },
    })
    expect(result).toMatchObject({ provider: 'codex', status: 'completed', output: 'agent completed' })
    expect(start).toHaveBeenCalledWith('codex', expect.objectContaining({ parent: { id: 'parent' }, signal }))
    expect(start).toHaveBeenCalledWith('codex', expect.objectContaining({ workspaceCwd: 'C:/worktree' }))
    const prompt = (start.mock.calls[0]?.[1] as { prompt?: readonly { text?: string }[] } | undefined)?.prompt?.[0]?.text
    expect(prompt).toContain('C:/worktree')
    expect(prompt).toContain('Business Concepts')
    expect(prompt).toContain('concept-card: reviewed refund definition')
    expect(prompt).toContain('Assumptions')
    expect(prompt).toContain('assumption-card: status=CONFIRMED')
    expect(prompt).toContain('Semantic Uncertainty')
    expect(prompt).toContain('uncertainty-card: status=RESOLVED')
  })

  it('routes a loaded CodeBuddy ACP subagent with the exact per-run AutoDev Worktree cwd', async () => {
    const parentAgent = { id: 'parent-agent' }
    const start = vi.fn(async (_name: string, _request: unknown) => ({
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'CodeBuddy ACP completed' }] }),
      dispose: vi.fn(async () => {}),
    }))
    const codeBuddy = { name: 'codebuddy-acp', capabilities: { workspaceCwd: true } }
    const subagents = {
      list: () => ['codebuddy-acp'],
      getProvider: (name: string) => name === 'codebuddy-acp' ? codeBuddy : undefined,
      start,
    } as unknown as SubagentRuntime
    const router = new ProviderRouter({
      decisions: new DecisionCoordinator({ config: { mode: 'off' } }),
      subagents,
      routes: {
        implement: {
          candidates: [{ kind: 'subagent', provider: 'codebuddy-acp', traits: ['code-edit', 'local-workspace'] }],
          requiredTaskTraits: ['code-edit', 'local-workspace'],
        },
      },
    })
    const worktree = 'C:/managed-worktrees/run-codebuddy'
    const signal = new AbortController().signal
    const selected = await router.select('run-codebuddy', 'implement', 'agent-route', 'implement', {}, ['code-edit', 'local-workspace'], signal)
    expect(selected.candidate?.provider).toBe('codebuddy-acp')
    expect(router.list()).toContainEqual(expect.objectContaining({ name: 'codebuddy-acp', available: true, traits: ['unknown', 'worktree-cwd'] }))

    const result = await router.invoke(selected.candidate!, {
      request: 'implement in the isolated workspace',
      acceptanceCriteria: ['modify only the task files'],
      cwd: worktree,
      signal,
      parentAgent,
      context: { workspacePath: worktree } as never,
    })

    expect(result).toMatchObject({ provider: 'codebuddy-acp', status: 'completed', output: 'CodeBuddy ACP completed' })
    expect(start).toHaveBeenCalledWith('codebuddy-acp', expect.objectContaining({ parent: parentAgent, signal, workspaceCwd: worktree }))
    const prompt = (start.mock.calls[0]?.[1] as { prompt?: readonly { text?: string }[] } | undefined)?.prompt?.[0]?.text
    expect(prompt).toContain(`Working directory: ${worktree}`)
  })

  it('selects and invokes an asynchronously available custom provider', async () => {
    const root = tempRoot('router')
    const store = new AutoDevStore(root)
    const router = new ProviderRouter({
      store,
      decisions: new DecisionCoordinator({ config: { mode: 'off' } }),
      routes: {
        implement: {
          candidates: [{ kind: 'model', provider: 'ollama', traits: ['code-edit', 'local-workspace', 'worktree-cwd'] }],
          requiredTaskTraits: ['code-edit', 'local-workspace'],
        },
      },
    })
    const dispose = router.register({
      name: 'ollama',
      kind: 'model',
      traits: ['code-edit', 'local-workspace'],
      workspaceCwd: true,
      isAvailable: async () => true,
      run: async request => ({ provider: request.provider, status: 'completed', output: 'custom provider ran' }),
    })

    const selection = await router.select('run-router', 'implement', 'agent-route', 'implement', {}, ['code-edit', 'local-workspace'], new AbortController().signal)
    expect(selection.candidate?.provider).toBe('ollama')
    const result = await router.invoke(selection.candidate as NonNullable<typeof selection.candidate>, {
      request: 'do work', acceptanceCriteria: [], cwd: root, signal: new AbortController().signal,
    })
    expect(result.status).toBe('completed')
    expect(store.listDecisions('run-router')).toHaveLength(1)
    dispose()
    store.close()
  })

  it('fails closed when a custom provider cannot guarantee the Worktree cwd or overclaims route traits', async () => {
    const runWithoutWorkspace = vi.fn(async (request: ProviderRunRequest) => ({
      provider: request.provider, status: 'completed' as const, output: 'must not run',
    }))
    const runWithoutTrait = vi.fn(async (request: ProviderRunRequest) => ({
      provider: request.provider, status: 'completed' as const, output: 'must not run',
    }))
    const runWithUnknownTrait = vi.fn(async (request: ProviderRunRequest) => ({
      provider: request.provider, status: 'completed' as const, output: 'must not run',
    }))
    const router = new ProviderRouter({
      decisions: new DecisionCoordinator({ config: { mode: 'off' } }),
      routes: {
        implement: {
          candidates: [
            { kind: 'command', provider: 'no-worktree-contract', traits: ['code-edit', 'local-workspace'] },
            { kind: 'command', provider: 'trait-overclaim', traits: ['code-edit', 'local-workspace'] },
            { kind: 'command', provider: 'unknown-trait-overclaim', traits: ['code-edit', 'local-workspace'] },
          ],
          requiredTaskTraits: ['code-edit', 'local-workspace'],
        },
      },
    })
    router.register({
      name: 'no-worktree-contract', kind: 'command', workspaceCwd: false,
      traits: ['code-edit', 'local-workspace'], run: runWithoutWorkspace,
    })
    router.register({
      name: 'trait-overclaim', kind: 'command', workspaceCwd: true,
      traits: ['local-workspace'], run: runWithoutTrait,
    })
    router.register({
      name: 'unknown-trait-overclaim', kind: 'command', workspaceCwd: true,
      traits: ['unknown'], run: runWithUnknownTrait,
    })

    expect(router.list().find(item => item.name === 'no-worktree-contract')?.available).toBe(false)
    const signal = new AbortController().signal
    const selection = await router.select(undefined, 'implement', 'agent-route', 'implement', {}, ['code-edit', 'local-workspace'], signal)
    expect(selection.candidate).toBeUndefined()
    expect(selection.decision.eligible).toEqual([])
    expect(selection.decision.rejections).toEqual([
      { provider: 'no-worktree-contract', reason: 'provider is not installed or loaded' },
      { provider: 'trait-overclaim', reason: 'provider is not installed or loaded' },
      { provider: 'unknown-trait-overclaim', reason: 'provider is not installed or loaded' },
    ])

    const request = { request: 'write the feature', acceptanceCriteria: [], cwd: process.cwd(), signal }
    const refusedWorkspace = await router.invoke(router.policy('implement')!.candidates[0]!, request)
    const refusedTraits = await router.invoke(router.policy('implement')!.candidates[1]!, request)
    const refusedUnknownTraits = await router.invoke(router.policy('implement')!.candidates[2]!, request)
    expect(refusedWorkspace.diagnostic).toContain('cannot honor AutoDev\'s per-run Worktree cwd')
    expect(refusedTraits.diagnostic).toContain('does not satisfy its route candidate declaration')
    expect(refusedUnknownTraits.diagnostic).toContain('does not satisfy its route candidate declaration')
    expect(runWithoutWorkspace).not.toHaveBeenCalled()
    expect(runWithoutTrait).not.toHaveBeenCalled()
    expect(runWithUnknownTrait).not.toHaveBeenCalled()
  })

  it('provides a bounded argv adapter for a future CodeBuddy or Ollama CLI', async () => {
    const root = tempRoot('command-provider')
    let observed: readonly string[] = []
    let observedCwd = ''
    const provider = commandProvider({
      name: 'fake-codebuddy',
      executable: 'codebuddy',
      args: request => ['run', request.request],
      traits: ['code-edit', 'local-workspace'],
      executor: {
        async run(argv, cwd) {
          observed = argv
          observedCwd = cwd
          return { argv, cwd, exitCode: 0, signal: null, stdout: 'ok', stderr: '', timedOut: false, durationMs: 1 }
        },
      },
    })
    const result = await provider.run({
      provider: 'fake-codebuddy',
      request: 'implement feature',
      acceptanceCriteria: [],
      cwd: root,
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ provider: 'fake-codebuddy', status: 'completed', output: 'ok' })
    expect(observed).toEqual(['codebuddy', 'run', 'implement feature'])
    expect(observedCwd).toBe(root)
  })

  it('maps command Provider non-zero, timeout, and aborted outcomes without claiming success', async () => {
    const root = tempRoot('command-provider-outcomes')
    const outcomes = [
      {
        result: { exitCode: 7, signal: null, timedOut: false, stdout: '', stderr: 'fixture failure', durationMs: 1 },
        requestAborted: false,
        expected: { status: 'error', diagnostic: 'command provider exited 7' },
      },
      {
        result: { exitCode: null, signal: 'SIGTERM' as const, timedOut: true, stdout: '', stderr: '', durationMs: 1 },
        requestAborted: false,
        expected: { status: 'error', diagnostic: 'command provider timed out' },
      },
      {
        result: { exitCode: null, signal: 'SIGTERM' as const, timedOut: false, stdout: '', stderr: '', durationMs: 1 },
        requestAborted: false,
        expected: { status: 'aborted', diagnostic: 'command provider was aborted' },
      },
      {
        result: { exitCode: null, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1 },
        requestAborted: true,
        expected: { status: 'aborted', diagnostic: 'command provider was aborted' },
      },
    ]

    for (const [index, outcome] of outcomes.entries()) {
      const provider = commandProvider({
        name: `outcome-provider-${index}`,
        executable: 'fixture-cli',
        args: ['run'],
        traits: ['code-edit'],
        executor: {
          async run(argv, cwd) { return { argv, cwd, ...outcome.result } },
        },
      })
      const controller = new AbortController()
      if (outcome.requestAborted === true) controller.abort()
      const result = await provider.run({
        provider: provider.name,
        request: 'do the work',
        acceptanceCriteria: [],
        cwd: root,
        signal: controller.signal,
      })
      expect(result).toMatchObject(outcome.expected)
      expect(result.status).not.toBe('completed')
    }
  })

  it('excludes a command Provider when its asynchronous health check reports unavailable', async () => {
    let invocations = 0
    const router = new ProviderRouter({
      decisions: new DecisionCoordinator({ config: { mode: 'off' } }),
      routes: {
        implement: {
          candidates: [{ kind: 'command', provider: 'offline-cli', traits: ['code-edit', 'local-workspace'] }],
          requiredTaskTraits: ['code-edit', 'local-workspace'],
        },
      },
    })
    router.register(commandProvider({
      name: 'offline-cli', executable: 'offline-cli', args: ['run'], traits: ['code-edit', 'local-workspace'],
      isAvailable: async () => false,
      executor: {
        async run(argv, cwd) {
          invocations++
          return { argv, cwd, exitCode: 0, signal: null, timedOut: false, stdout: 'unexpected', stderr: '', durationMs: 1 }
        },
      },
    }))

    const selection = await router.select(undefined, 'implement', 'agent-route', 'implement', {}, ['code-edit', 'local-workspace'], new AbortController().signal)
    expect(selection.candidate).toBeUndefined()
    expect(selection.decision.eligible).toEqual([])
    expect(selection.decision.rejections).toContainEqual({ provider: 'offline-cli', reason: 'provider is not installed or loaded' })
    expect(invocations).toBe(0)
  })

  it('adds and removes a third-party CLI candidate on the default implement route', async () => {
    const router = new ProviderRouter({
      decisions: new DecisionCoordinator({ config: { mode: 'off' } }),
    })
    const root = tempRoot('dynamic-implement-provider')
    let observed: readonly string[] = []
    let observedCwd = ''
    const provider = commandProvider({
      name: 'sample-cli-agent',
      executable: 'sample-agent',
      args: request => ['run', request.request],
      traits: ['code-edit', 'local-workspace'],
      executor: {
        async run(argv, cwd) {
          observed = argv
          observedCwd = cwd
          return { argv, cwd, exitCode: 0, signal: null, stdout: 'implemented', stderr: '', timedOut: false, durationMs: 1 }
        },
      },
    })
    const unregisterProvider = router.register(provider)
    const removeCandidate = router.registerCandidate('implement', {
      kind: 'command',
      provider: provider.name,
      traits: ['code-edit', 'local-workspace'],
    })

    const signal = new AbortController().signal
    const selection = await router.select(undefined, 'implement', 'agent-route', 'implement', {}, ['code-edit', 'local-workspace'], signal)
    expect(selection.candidate?.provider).toBe('sample-cli-agent')
    const result = await router.invoke(selection.candidate!, {
      request: 'implement a small feature',
      acceptanceCriteria: [],
      cwd: root,
      signal,
    })
    expect(result).toMatchObject({ provider: 'sample-cli-agent', status: 'completed', output: 'implemented' })
    expect(observed).toEqual(['sample-agent', 'run', 'implement a small feature'])
    expect(observedCwd).toBe(root)

    removeCandidate()
    removeCandidate()
    const afterRemoval = await router.select(undefined, 'implement', 'agent-route', 'implement', {}, ['code-edit', 'local-workspace'], signal)
    expect(afterRemoval.candidate).toBeUndefined()
    unregisterProvider()
    expect(router.list().some(item => item.name === 'sample-cli-agent')).toBe(false)

    const replacement = commandProvider({
      name: 'sample-cli-agent', executable: 'replacement-agent', args: ['run'],
      traits: ['code-edit', 'local-workspace'],
      executor: {
        async run(argv, cwd) {
          return { argv, cwd, exitCode: 0, signal: null, stdout: 'replacement', stderr: '', timedOut: false, durationMs: 1 }
        },
      },
    })
    const unregisterReplacement = router.register(replacement)
    unregisterProvider() // a stale disposer must not remove a later registration with the same name
    expect(router.list().some(item => item.name === 'sample-cli-agent')).toBe(true)
    unregisterReplacement()
    expect(router.list().some(item => item.name === 'sample-cli-agent')).toBe(false)
  })

  it('terminates a real child process and settles when its AbortSignal fires', async () => {
    const root = tempRoot('command-abort')
    const started = join(root, 'child-started.txt')
    const controller = new AbortController()
    const pending = new HarnessCommandExecutor().run([
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)",
      started,
    ], root, { signal: controller.signal, timeoutMs: 10_000 })
    const deadline = Date.now() + 5_000
    while (!existsSync(started) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (!existsSync(started)) {
      controller.abort()
      const result = await pending
      throw new Error(`child process did not start before cancellation test deadline: ${result.stderr}`)
    }

    controller.abort()
    const result = await pending
    expect(result.timedOut).toBe(false)
    expect(result.exitCode === 0 && result.signal === null).toBe(false)
  })
})

describe('restart recovery', () => {
  it.each(['EXECUTING', 'BUILDING', 'TESTING', 'PROMOTING'] as const)(
    'turns a Run interrupted during %s into an explicit Human Gate without retrying it',
    (status) => {
      const root = tempRoot('recovery')
      const stateRoot = tempRoot('recovery-state')
      const worktreeRoot = tempRoot('recovery-worktrees')
      const run = {
        ...sampleRun(root), id: `run-recovery-${status.toLowerCase()}`, status,
        worktreePath: join(worktreeRoot, `run-recovery-${status.toLowerCase()}`),
        ...(status === 'PROMOTING' ? { candidateId: 'candidate-recovery' } : {}),
      }
      const firstStore = new AutoDevStore(stateRoot)
      firstStore.createRun(run)
      firstStore.createNode({
        id: `node-recovery-${status.toLowerCase()}`, runId: run.id, planId: 'plan-recovery', nodeId: status.toLowerCase(), attempt: 1, status: 'RUNNING',
      })
      const now = new Date().toISOString()
      const kind = status === 'PROMOTING' ? 'git-promotion' : status === 'EXECUTING' ? 'agent-workspace' : 'command'
      firstStore.saveActionIntent({
        id: `intent-recovery-${status.toLowerCase()}`, runId: run.id,
        ...(status === 'PROMOTING' ? {} : { nodeId: status.toLowerCase() }),
        kind,
        target: kind === 'git-promotion' ? `${root}@${run.baseCommit}` : `recovery-${status.toLowerCase()}`,
        risk: kind === 'git-promotion' ? 'destructive' : kind === 'agent-workspace' ? 'medium' : 'low',
        idempotencyKey: `recovery-${status.toLowerCase()}`,
        preconditions: [], status: 'EXECUTING', createdAt: now, updatedAt: now,
      })
      firstStore.close()

      const runtime = new AutoDevRuntime(new Context(), { dataRoot: stateRoot, worktreeRoot })
      try {
        const snapshot = runtime.snapshot(run.id)
        expect(snapshot.run.status).toBe('NEEDS_INTERVENTION')
        expect(snapshot.gates.at(-1)?.options).not.toContain('retry')
        expect(snapshot.gates.at(-1)?.reason).toContain(`Host restarted during ${status}`)
        expect(snapshot.nodes.at(-1)?.status).toBe('UNKNOWN')
        expect(snapshot.evidence.at(-1)?.summary).toContain('Host restarted')
        expect(snapshot.actionIntents.find(item => item.id === `intent-recovery-${status.toLowerCase()}`)?.status).toBe('UNKNOWN')
        expect(snapshot.evidence.some(item => item.type === 'SIDE_EFFECT' && item.status === 'UNKNOWN'
          && item.summary.includes(`Host restarted during ${status}`))).toBe(true)
        if (status === 'PROMOTING') {
          expect(snapshot.gates.at(-1)?.options).toContain('promote')
        }
      } finally {
        runtime.store.close()
      }
    },
  )

  it.each(['provider', 'build', 'test', 'promotion'] as const)(
    'kills the Host during %s after an external effect and recovers its durable action as UNKNOWN',
    { timeout: 90_000 },
    async (stage) => {
      const repo = tempRoot('host-exit-repo')
      const stateRoot = tempRoot('host-exit-state')
      const worktreeRoot = tempRoot('host-exit-worktrees')
      const fixtureRoot = tempRoot('host-exit-fixture')
      const startedPath = join(fixtureRoot, 'target-started')
      const readyPath = join(fixtureRoot, 'host-ready.json')
      const failurePath = join(fixtureRoot, 'host-failure.txt')
      await createGitRepo(repo)

      const remoteEffects: Array<{ readonly idempotencyKey: string; readonly body: string }> = []
      const effectServer = createServer((request, response) => {
        if (request.method !== 'POST' || request.url !== '/effects') {
          response.writeHead(404).end()
          return
        }
        let body = ''
        request.setEncoding('utf8')
        request.on('data', (chunk: string) => { body += chunk })
        request.on('end', () => {
          remoteEffects.push({ idempotencyKey: String(request.headers['idempotency-key'] ?? ''), body })
          response.writeHead(202, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ accepted: true }))
        })
      })
      await new Promise<void>((resolve, reject) => {
        effectServer.once('error', reject)
        effectServer.listen(0, '127.0.0.1', resolve)
      })
      const address = effectServer.address()
      if (address === null || typeof address === 'string') throw new Error('loopback effect service did not bind a TCP port')
      const effectUrl = `http://127.0.0.1:${address.port}/effects`

      const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url))
      const fixturePath = fileURLToPath(new URL('./fixtures/autodev-host-exit.ts', import.meta.url))
      const child = spawn(process.execPath, ['--import', 'tsx/esm', fixturePath, repo, stateRoot, worktreeRoot, startedPath, readyPath, failurePath, stage, effectUrl], {
        cwd: workspaceRoot,
        env: { ...process.env, TSX_TSCONFIG_PATH: join(workspaceRoot, 'tsconfig.json') },
        stdio: 'ignore',
        windowsHide: true,
      })
      const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, signal) => { resolve({ code, signal }) })
      })
      let hostExited = false
      let targetPid: number | undefined
      let targetTerminationRequested = false
      try {
        const deadline = Date.now() + 60_000
        while (!existsSync(readyPath)) {
          if (existsSync(failurePath)) throw new Error(`Host-exit fixture failed: ${readFileSync(failurePath, 'utf8')}`)
          if (Date.now() >= deadline) throw new Error('Host-exit fixture did not reach its durable in-flight state')
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        const ready = JSON.parse(readFileSync(readyPath, 'utf8')) as {
          runId: string
          targetPid: number
          stage: string
          worktreePath: string
          candidateTreeHash?: string
          repoTreeHash?: string
        }
        expect(Number.isSafeInteger(ready.targetPid)).toBe(true)
        expect(ready.stage).toBe(stage)
        targetPid = ready.targetPid

        child.kill('SIGKILL')
        const exit = await exited
        hostExited = true
        expect(exit.code === 0).toBe(false)

        const isPromotion = stage === 'promotion'
        // POSIX does not kill a Host's subprocesses when the Host receives SIGKILL.
        if (!isPromotion && targetPid !== undefined) {
          try {
            process.kill(targetPid, 'SIGKILL')
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
          targetTerminationRequested = true
        }
        await vi.waitFor(() => {
          try {
            process.kill(targetPid as number, 0)
            throw new Error(`Host-exit target for ${stage} (${String(targetPid)}) survived fixture cleanup`)
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
            throw error
          }
        }, { interval: 25, timeout: 10_000 })

        const worktreeEffectPath = join(ready.worktreePath, 'AUTODEV_INTERRUPTED_EFFECT.txt')
        const effectAtCrash = `effect-applied:${String(targetPid)}:{"accepted":true}`
        if (isPromotion) {
          expect(readFileSync(join(repo, 'AUTODEV_PROMOTION_EFFECT.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('candidate-effect\n')
          expect(ready.repoTreeHash).toBe(ready.candidateTreeHash)
          expect(remoteEffects).toHaveLength(0)
        } else {
          expect(existsSync(worktreeEffectPath)).toBe(true)
          expect(readFileSync(worktreeEffectPath, 'utf8')).toBe(effectAtCrash)
          expect(existsSync(join(repo, 'AUTODEV_INTERRUPTED_EFFECT.txt'))).toBe(false)
          expect(remoteEffects).toEqual([{
            idempotencyKey: 'host-exit-fixture-effect',
            body: '{"effect":"host-exit-fixture"}',
          }])
        }
        const interruptedStore = new AutoDevStore(stateRoot)
        try {
          const intent = interruptedStore.listActionIntents(ready.runId).find(item => stage === 'provider'
            ? item.kind === 'agent-workspace'
            : stage === 'promotion'
              ? item.kind === 'git-promotion'
              : item.kind === 'command' && item.nodeId === stage)
          expect(intent?.status).toBe('EXECUTING')
          expect(interruptedStore.listSideEffects(ready.runId).filter(item => item.intentId === intent?.id
            && ['COMMITTED', 'FAILED', 'UNKNOWN'].includes(item.status))).toHaveLength(0)
        } finally {
          interruptedStore.close()
        }

        const recovered = new AutoDevRuntime(new Context(), { dataRoot: stateRoot, worktreeRoot })
        try {
          const snapshot = recovered.snapshot(ready.runId)
          expect(snapshot.run.status).toBe('NEEDS_INTERVENTION')
          const interruptedStatus = stage === 'provider' ? 'EXECUTING' : stage === 'build' ? 'BUILDING' : stage === 'test' ? 'TESTING' : 'PROMOTING'
          const interruptedNodeId = stage === 'provider' ? 'implement' : stage === 'promotion' ? undefined : stage
          if (interruptedNodeId !== undefined) {
            expect(snapshot.nodes.find(item => item.nodeId === interruptedNodeId && item.status === 'UNKNOWN')).toBeDefined()
          }
          const recoveredIntent = snapshot.actionIntents.find(item => stage === 'provider'
            ? item.kind === 'agent-workspace'
            : stage === 'promotion'
              ? item.kind === 'git-promotion'
              : item.kind === 'command' && item.nodeId === interruptedNodeId)
          expect(recoveredIntent?.status).toBe('UNKNOWN')
          expect(snapshot.evidence.some(item => item.type === 'SIDE_EFFECT' && item.status === 'UNKNOWN'
            && item.summary.includes(`Host restarted during ${interruptedStatus}`))).toBe(true)
          expect(snapshot.sideEffects.some(item => item.intentId === recoveredIntent?.id && item.status === 'UNKNOWN')).toBe(true)
          if (isPromotion) {
            expect(readFileSync(join(repo, 'AUTODEV_PROMOTION_EFFECT.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('candidate-effect\n')
            expect(snapshot.gates.at(-1)?.options).toContain('promote')
            expect(ready.repoTreeHash).toBe(ready.candidateTreeHash)
            const reconciled = await recovered.remoteResolveGate({ runId: ready.runId, action: 'promote' }, new AbortController().signal)
            expect(reconciled.run.status).toBe('PROMOTED')
            expect(reconciled.actionIntents.find(item => item.id === recoveredIntent?.id)?.status).toBe('UNKNOWN')
            expect(reconciled.actionIntents.filter(item => item.kind === 'git-promotion' && item.status === 'COMMITTED')).toHaveLength(1)
            expect(reconciled.evidence.some(item => item.type === 'PROMOTION' && item.status === 'PASS'
              && item.candidateId === reconciled.candidate?.id)).toBe(true)
            expect(await recovered.git.treeHash(repo)).toBe(ready.candidateTreeHash)
            expect(readFileSync(join(repo, 'AUTODEV_PROMOTION_EFFECT.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('candidate-effect\n')
          } else {
            expect(readFileSync(worktreeEffectPath, 'utf8')).toBe(effectAtCrash)
            expect(existsSync(join(repo, 'AUTODEV_INTERRUPTED_EFFECT.txt'))).toBe(false)
            expect(remoteEffects).toHaveLength(1)
          }
          expect(snapshot.gates.at(-1)?.options).not.toContain('retry')
        } finally {
          recovered.store.close()
        }
      } finally {
        if (!hostExited) {
          child.kill('SIGKILL')
          await exited.catch(() => {})
        }
        // If setup failed after the external-effect child wrote its PID but
        // before the Host published host-ready.json, still reap that exact
        // fixture process. For Promotion, targetPid is the Host itself, which
        // was already killed and reaped above; never signal that PID a second time.
        const cleanupTargetPid = stage === 'promotion'
          ? undefined
          : targetPid ?? (existsSync(startedPath) ? Number(readFileSync(startedPath, 'utf8')) : undefined)
        if (Number.isSafeInteger(cleanupTargetPid) && (cleanupTargetPid as number) > 0 && !targetTerminationRequested) {
          try {
            process.kill(cleanupTargetPid as number, 'SIGKILL')
          } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
          await vi.waitFor(() => {
            try {
              process.kill(cleanupTargetPid as number, 0)
              throw new Error(`Host-exit target (${String(cleanupTargetPid)}) survived fixture cleanup`)
            } catch (error: unknown) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
              throw error
            }
          }, { interval: 25, timeout: 10_000 })
        }
        await new Promise<void>((resolve, reject) => {
          effectServer.close((error) => {
            if (error === undefined) resolve()
            else reject(error)
          })
        })
      }
    },
  )

  it('opens a visible gate when the retry budget is exhausted before execution', async () => {
    const root = tempRoot('attempt-limit')
    const stateRoot = tempRoot('attempt-limit-state')
    const worktreeRoot = tempRoot('attempt-limit-worktrees')
    await createGitRepo(root)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: stateRoot,
      worktreeRoot,
      maxAttempts: 1,
      jev: { mode: 'off' },
    }, {
      commands: new FakeMavenExecutor(),
      decisions: new DecisionCoordinator({ config: { mode: 'off' } }),
    })
    try {
      const created = await runtime.create({ repoPath: root, request: 'do not start because the budget is exhausted' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const store = runtime.store
      store.updateRun(created.run.id, current => ({ ...current, attempt: 1 }))
      const limited = await runtime.run(created.run.id)
      expect(limited.run.status).toBe('NEEDS_INTERVENTION')
      expect(limited.run.currentGateId).toBe(limited.gates.at(-1)?.id)
      expect(limited.gates.at(-1)?.options).toEqual(['rework', 'replan', 'cancel'])
    } finally {
      runtime.store.close()
    }
  })
})

class FakeMavenExecutor implements CommandExecutor {
  private readonly delegate = new HarnessCommandExecutor()

  run(...args: Parameters<CommandExecutor['run']>): ReturnType<CommandExecutor['run']> {
    const [argv, cwd] = args
    if (argv[0] === 'java' || argv[0] === 'java.exe' || argv[0] === 'mvn' || argv[0] === 'fake-mvn') {
      return Promise.resolve({
        argv,
        cwd,
        exitCode: 0,
        signal: null,
        stdout: 'fake tool ok',
        stderr: '',
        timedOut: false,
        durationMs: 1,
      } satisfies CommandResult)
    }
    return this.delegate.run(...args)
  }
}

async function createGitRepo(root: string): Promise<void> {
  const executor = new HarnessCommandExecutor()
  writeFileSync(join(root, 'pom.xml'), '<project/>\n')
  writeFileSync(join(root, 'README.md'), 'baseline\n')
  mkdirSync(join(root, '.mvn', 'wrapper'), { recursive: true })
  writeFileSync(join(root, '.mvn', 'wrapper', 'maven-wrapper.jar'), 'fake wrapper fixture for FakeMavenExecutor\n')
  const run = async (...argv: string[]) => {
    const result = await executor.run(argv, root)
    expect(result.exitCode, `${argv.join(' ')}\n${result.stderr}`).toBe(0)
  }
  await run('git', 'init')
  await run('git', 'config', 'user.email', 'autodev-test@example.invalid')
  await run('git', 'config', 'user.name', 'AutoDev Test')
  await run('git', 'add', '.')
  await run('git', 'commit', '-m', 'initial')
}

async function createNodeGitRepo(root: string): Promise<void> {
  const executor = new HarnessCommandExecutor()
  writeFileSync(join(root, 'package.json'), '{"name":"autodev-node-fixture","scripts":{"build":"node build.js","test":"node test.js"}}\n')
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n')
  writeFileSync(join(root, 'README.md'), 'node baseline\n')
  const run = async (...argv: string[]) => {
    const result = await executor.run(argv, root)
    expect(result.exitCode, `${argv.join(' ')}\n${result.stderr}`).toBe(0)
  }
  await run('git', 'init')
  await run('git', 'config', 'user.email', 'autodev-test@example.invalid')
  await run('git', 'config', 'user.name', 'AutoDev Test')
  await run('git', 'add', '.')
  await run('git', 'commit', '-m', 'initial')
}

describe('AutoDev end-to-end run', () => {
  it('starts and reworks an approved Run through its matching DSH Session', async () => {
    const root = tempRoot('web-session-start')
    const unrelated = tempRoot('web-session-other')
    const stateRoot = tempRoot('web-session-state')
    const worktreeRoot = tempRoot('web-session-worktrees')
    await createGitRepo(root)
    const parent = { id: 'session-web-1', session: { id: 'session-web-1' } }
    let sessionCwd = unrelated
    const invoked = vi.fn(async (request: { cwd: string; parentAgent?: unknown; provider: string }) => {
      expect(request.parentAgent).toBe(parent)
      writeFileSync(join(request.cwd, 'WEB_START_PROOF.txt'), 'implemented\n')
      return { provider: request.provider, status: 'completed' as const, output: 'implemented' }
    })
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: stateRoot, worktreeRoot, jev: { mode: 'off' },
      routes: { implement: { candidates: [{ kind: 'command', provider: 'web-start-fixture', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] } },
    }, {
      commands: new FakeMavenExecutor(),
      sessionBridge: {
        async inspect() { return { meta: { cwd: sessionCwd } } },
        async resolveAgent() { return { agent: parent } },
      },
      decisions: trustedTestDecisions(),
    })
    runtime.registerProvider({ name: 'web-start-fixture', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true, run: invoked })
    try {
      const created = await runtime.remoteCreate({ repoPath: root, request: 'prove Web Session startup' }, new AbortController().signal)
      await expect(runtime.remoteStart({ runId: created.run.id, sessionId: parent.id }, new AbortController().signal))
        .rejects.toThrow(/has not been explicitly approved/)
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      await expect(runtime.remoteStart({ runId: created.run.id, sessionId: parent.id }, new AbortController().signal))
        .rejects.toThrow(/not bound to the AutoDev repository/)
      expect(invoked).not.toHaveBeenCalled()
      sessionCwd = root
      const admitted = await runtime.remoteStart({ runId: created.run.id, sessionId: parent.id }, new AbortController().signal)
      expect(admitted.run.id).toBe(created.run.id)
      await vi.waitFor(() => expect(runtime.snapshot(created.run.id).run.status).toBe('VERIFY'), { timeout: 15_000 })
      expect(invoked).toHaveBeenCalledTimes(1)

      const reworkGate = {
        id: 'web-session-rework-gate', runId: created.run.id,
        reason: 'Exercise the Web rework Session bridge', options: ['rework'] as const,
        status: 'OPEN' as const, createdAt: new Date().toISOString(),
      }
      runtime.store.saveGate(reworkGate)
      runtime.store.updateRun(created.run.id, current => ({ ...current, status: 'NEEDS_INTERVENTION', currentGateId: reworkGate.id }))
      await expect(runtime.remoteResolveGate({ runId: created.run.id, action: 'rework' }, new AbortController().signal))
        .rejects.toThrow(/requires a live DSH Session/)
      sessionCwd = unrelated
      await expect(runtime.remoteResolveGate({
        runId: created.run.id, action: 'rework', sessionId: parent.id,
      }, new AbortController().signal)).rejects.toThrow(/not bound to the AutoDev repository/)
      expect(invoked).toHaveBeenCalledTimes(1)
      sessionCwd = root
      const reworkAdmission = await runtime.remoteResolveGate({
        runId: created.run.id, action: 'rework', sessionId: parent.id,
      }, new AbortController().signal)
      expect(['REWORK_REQUESTED', 'EXECUTING']).toContain(reworkAdmission.run.status)
      await vi.waitFor(() => expect(['VERIFY', 'NEEDS_INTERVENTION']).toContain(runtime.snapshot(created.run.id).run.status), { timeout: 15_000 })
      const reworked = runtime.snapshot(created.run.id)
      expect(reworked.run.status, reworked.gates.at(-1)?.reason ?? reworked.run.lastError).toBe('VERIFY')
      expect(invoked).toHaveBeenCalledTimes(2)
      await expect(runtime.remoteStart({ runId: created.run.id, sessionId: parent.id }, new AbortController().signal))
        .rejects.toThrow(/not ready for another start/)
    } finally {
      await runtime.dispose()
      runtime.store.close()
    }
  }, 30_000)

  it('creates a Web-reviewable Plan without invoking a Provider or changing the repository', async () => {
    const root = tempRoot('web-create')
    const stateRoot = tempRoot('web-create-state')
    const worktreeRoot = tempRoot('web-create-worktrees')
    await createGitRepo(root)
    const serviceContext = new Context()
    const runtime = new AutoDevRuntime(serviceContext, { dataRoot: stateRoot, worktreeRoot, jev: { mode: 'off' } }, { commands: new FakeMavenExecutor() })
    try {
      const snapshot = await runtime.remoteCreate({
        repoPath: root,
        request: 'add an auditable fixture',
        acceptanceCriteria: ['the fixture exists', 'tests pass'],
      }, new AbortController().signal)
      expect(snapshot.run.status).toBe('DRAFT')
      expect(snapshot.run.acceptanceCriteria).toEqual(['the fixture exists', 'tests pass'])
      expect(snapshot.plan?.nodes.map(node => node.kind)).toEqual(['implement', 'build', 'test'])
      expect(snapshot.run.worktreePath).toBeUndefined()
      expect(snapshot.evidence.some(item => item.type === 'REPOSITORY_BASELINE' && item.status === 'PASS')).toBe(true)
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('baseline\n')
      await expect(runtime.run(snapshot.run.id)).rejects.toThrow(/has not been explicitly approved/)
      expect(() => runtime.remoteApprovePlan({ runId: snapshot.run.id, planId: 'wrong-plan' })).toThrow(/not the active Plan/)
      const approved = runtime.remoteApprovePlan({ runId: snapshot.run.id, planId: snapshot.plan!.id })
      expect(approved.run.status).toBe('READY')
      expect(approved.run.approvedPlanFingerprint).toBe(snapshot.plan?.fingerprint)
      expect(approved.run.approvedBy).toEqual({ kind: 'host-internal', source: 'direct-host-call' })
      expect((approved.auditEvents ?? []).map(item => item.action)).toEqual(['plan-approved'])
      expect(approved.evidence.filter(item => item.type === 'PLAN_APPROVAL')).toHaveLength(1)
      expect(runtime.remoteApprovePlan({ runId: snapshot.run.id, planId: snapshot.plan!.id }).evidence.filter(item => item.type === 'PLAN_APPROVAL')).toHaveLength(1)
      const reopened = new AutoDevStore(stateRoot)
      try {
        expect(reopened.getRun(snapshot.run.id)?.approvedPlanId).toBe(snapshot.plan?.id)
        expect(reopened.listEvidence(snapshot.run.id).filter(item => item.type === 'PLAN_APPROVAL')).toHaveLength(1)
        expect(reopened.listAuditEvents(snapshot.run.id)).toEqual(approved.auditEvents ?? [])
      } finally {
        reopened.close()
      }
      const legacy = await runtime.remoteCreate({ repoPath: root, request: 'require review after a legacy READY migration' }, new AbortController().signal)
      runtime.store.updateRun(legacy.run.id, value => ({ ...value, status: 'READY' }))
      await expect(runtime.run(legacy.run.id)).rejects.toThrow(/has not been explicitly approved/)
      const peerId = 'trusted-gateway-peer'
      const invocation = {
        request: { namespace: 'autodev', method: 'approvePlan', args: { runId: legacy.run.id, planId: legacy.plan!.id } },
        service: 'autodev',
        peer: { id: peerId as never, ctx: new Context(), dispose: async () => undefined },
        signal: new AbortController().signal,
        async *uplink() { return },
      }
      const gatewayBoundRuntime = serviceContext.extend({ invocation }).get('autodev') as AutoDevRuntime
      const approvedFromGateway = gatewayBoundRuntime.remoteApprovePlan({
        runId: legacy.run.id,
        planId: legacy.plan!.id,
        actor: { kind: 'host-internal', source: 'direct-host-call' },
      } as unknown as { readonly runId: string; readonly planId: string })
      expect(approvedFromGateway.run.approvedPlanId).toBe(legacy.plan?.id)
      expect(approvedFromGateway.run.approvedBy).toEqual({ kind: 'dsh-operator', source: 'dsh-gateway', connectionPeerId: peerId })
      expect((approvedFromGateway.auditEvents ?? []).at(-1)?.actor).toEqual(approvedFromGateway.run.approvedBy)
      writeFileSync(join(root, 'README.md'), 'user edit\n')
      await expect(runtime.remoteCreate({ repoPath: root, request: 'do not inspect a dirty repository' }, new AbortController().signal))
        .rejects.toThrow(/uncommitted changes/)
    } finally {
      runtime.store.close()
    }
  })

  it('rolls back the complete initial Run aggregate when a Plan write fails', async () => {
    const root = tempRoot('create-aggregate-failure')
    const stateRoot = tempRoot('create-aggregate-failure-state')
    const worktreeRoot = tempRoot('create-aggregate-failure-worktrees')
    await createGitRepo(root)
    const runtime = new AutoDevRuntime(new Context(), { dataRoot: stateRoot, worktreeRoot, jev: { mode: 'off' } }, { commands: new FakeMavenExecutor() })
    let runId: string | undefined
    const createRun = runtime.store.createRun.bind(runtime.store)
    const createPlan = runtime.store.createPlan.bind(runtime.store)
    vi.spyOn(runtime.store, 'createRun').mockImplementation((run) => {
      runId = run.id
      createRun(run)
    })
    vi.spyOn(runtime.store, 'createPlan').mockImplementation((plan) => {
      createPlan(plan)
      throw new Error('injected Plan persistence failure')
    })
    try {
      await expect(runtime.create({ repoPath: root, request: 'exercise aggregate rollback' }))
        .rejects.toThrow(/injected Plan persistence failure/)
      expect(runId).toBeDefined()
      expect(runtime.store.getRun(runId!)).toBeUndefined()
      expect(runtime.store.events(runId!)).toEqual([])
      expect(runtime.store.listPlans(runId!)).toEqual([])
      expect(runtime.store.listNodes(runId!)).toEqual([])
      expect(runtime.store.listEvidence(runId!)).toEqual([])
    } finally {
      runtime.store.close()
    }
  })

  it('rolls back a new Gate if the matching Run suspension cannot be persisted', async () => {
    const root = tempRoot('gate-aggregate-failure')
    const stateRoot = tempRoot('gate-aggregate-failure-state')
    const worktreeRoot = tempRoot('gate-aggregate-failure-worktrees')
    await createGitRepo(root)
    const runtime = new AutoDevRuntime(new Context(), { dataRoot: stateRoot, worktreeRoot, jev: { mode: 'off' } }, { commands: new FakeMavenExecutor() })
    try {
      const created = await runtime.create({ repoPath: root, request: 'exercise Gate transaction rollback' })
      runtime.store.updateRun(created.run.id, current => ({ ...current, status: 'FAILED' }))
      const updateRunSpy = vi.spyOn(runtime.store, 'updateRun').mockImplementation(() => {
        throw new Error('injected Run suspension failure')
      })
      const openGate = (runtime as unknown as {
        openGate(runId: string, reason: string, options: readonly string[]): unknown
      }).openGate.bind(runtime)
      try {
        expect(() => openGate(created.run.id, 'exercise Gate transaction rollback', ['replan']))
          .toThrow(/injected Run suspension failure/)
      } finally {
        updateRunSpy.mockRestore()
      }
      expect(runtime.store.listGates(created.run.id)).toEqual([])
      expect(runtime.store.getRun(created.run.id)?.status).toBe('FAILED')
      expect(runtime.store.events(created.run.id).some(event => event.type === 'gate/updated')).toBe(false)
    } finally {
      runtime.store.close()
    }
  })

  it('rolls back the resolved promote Gate if the atomic PROMOTING claim fails', async () => {
    const fixture = await createGatePromotionFixture('promotion-claim-rollback')
    const { runtime, runId, gate } = fixture
    const gateEventCount = runtime.store.events(runId).filter(event => event.type === 'gate/updated').length
    const updateRunSpy = vi.spyOn(runtime.store, 'updateRun').mockImplementation(() => {
      throw new Error('injected PROMOTING claim failure')
    })
    try {
      await expect(runtime.resolveGate(runId, 'promote')).rejects.toThrow(/injected PROMOTING claim failure/)
      expect(runtime.store.getRun(runId)).toMatchObject({ status: 'NEEDS_INTERVENTION', currentGateId: gate.id })
      expect(runtime.store.getGate(gate.id)).toMatchObject({ status: 'OPEN' })
      expect(runtime.store.events(runId).filter(event => event.type === 'gate/updated')).toHaveLength(gateEventCount)
      expect(runtime.store.listActionIntents(runId).filter(intent => intent.kind === 'git-promotion')).toEqual([])
    } finally {
      updateRunSpy.mockRestore()
      runtime.store.close()
    }
  })

  it('recovers a committed promote Gate claim if the Host exits before creating an ActionIntent', async () => {
    const fixture = await createGatePromotionFixture('promotion-claim-recovery')
    const { runtime, runId, stateRoot, worktreeRoot, gate, candidate } = fixture
    let releaseGitRead!: () => void
    const gitReadHeld = new Promise<void>((resolve) => { releaseGitRead = resolve })
    let claimedRunSnapshot: Run | undefined
    const treeHashSpy = vi.spyOn(runtime.git, 'treeHash').mockImplementation(async () => {
      claimedRunSnapshot = runtime.store.getRun(runId)
      expect(claimedRunSnapshot?.status).toBe('PROMOTING')
      expect(claimedRunSnapshot?.currentGateId).toBeUndefined()
      expect(runtime.store.getGate(gate.id)).toMatchObject({ status: 'RESOLVED', selected: 'promote' })
      expect(runtime.store.listActionIntents(runId).filter(intent => intent.kind === 'git-promotion')).toEqual([])
      await gitReadHeld
      return candidate.gitTreeHash
    })
    let recovery: AutoDevRuntime | undefined
    let operation: Promise<void> | undefined
    let originalClosed = false
    try {
      operation = runtime.resolveGate(runId, 'promote').then(() => undefined, () => undefined)
      await vi.waitFor(() => { expect(treeHashSpy).toHaveBeenCalledTimes(1) }, { timeout: 5_000 })
      expect(claimedRunSnapshot?.status).toBe('PROMOTING')

      runtime.store.close()
      originalClosed = true
      recovery = new AutoDevRuntime(new Context(), { dataRoot: stateRoot, worktreeRoot, jev: { mode: 'off' } }, { commands: new FakeMavenExecutor() })
      const restored = recovery.snapshot(runId)
      const openGate = restored.gates.find(item => item.status === 'OPEN')
      expect(restored.run.status).toBe('NEEDS_INTERVENTION')
      expect(restored.gates.find(item => item.id === gate.id)).toMatchObject({ status: 'RESOLVED', selected: 'promote' })
      expect(openGate?.id).toBe(restored.run.currentGateId)
      expect(openGate?.options).toContain('promote')
      expect(restored.actionIntents.filter(intent => intent.kind === 'git-promotion')).toEqual([])
      expect(restored.sideEffects.filter(effect => effect.status === 'COMMITTED')).toEqual([])
    } finally {
      releaseGitRead()
      await operation
      recovery?.store.close()
      if (!originalClosed) runtime.store.close()
    }
  })

  it('recovers a promote Gate claim after SIGKILL before ActionIntent creation', { timeout: 90_000 }, async () => {
    const fixture = await createGatePromotionFixture('promotion-claim-host-exit')
    const { runtime, runId, stateRoot, worktreeRoot, gate } = fixture
    const run = runtime.store.getRun(runId)
    if (run === undefined) throw new Error('promotion Gate fixture Run was not persisted')
    const repoTreeBeforeClaim = await runtime.git.treeHash(run.repoRoot)
    const fixtureRoot = tempRoot('promotion-claim-host-exit-fixture')
    const readyPath = join(fixtureRoot, 'host-ready.json')
    const failurePath = join(fixtureRoot, 'host-failure.txt')
    const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const fixturePath = fileURLToPath(new URL('./fixtures/autodev-promotion-gate-exit.ts', import.meta.url))
    let child: ReturnType<typeof spawn> | undefined
    let exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> | undefined
    let originalClosed = false
    let hostExited = false
    let recovery: AutoDevRuntime | undefined
    try {
      runtime.store.close()
      originalClosed = true
      child = spawn(process.execPath, [
        '--import', 'tsx/esm', fixturePath,
        stateRoot, worktreeRoot, runId, gate.id, readyPath, failurePath,
      ], {
        cwd: workspaceRoot,
        env: { ...process.env, TSX_TSCONFIG_PATH: join(workspaceRoot, 'tsconfig.json') },
        stdio: 'ignore',
        windowsHide: true,
      })
      exited = new Promise((resolve, reject) => {
        child?.once('error', reject)
        child?.once('close', (code, signal) => { resolve({ code, signal }) })
      })

      const deadline = Date.now() + 60_000
      while (!existsSync(readyPath)) {
        if (existsSync(failurePath)) throw new Error(`Promotion Gate Host-exit fixture failed: ${readFileSync(failurePath, 'utf8')}`)
        if (child.exitCode !== null || child.signalCode !== null) {
          const exit = await exited
          throw new Error(`Promotion Gate Host-exit fixture exited before claim barrier: code=${String(exit.code)}; signal=${String(exit.signal)}`)
        }
        if (Date.now() >= deadline) throw new Error('Promotion Gate Host did not reach the post-claim, pre-intent barrier')
        await new Promise(resolve => setTimeout(resolve, 20))
      }

      const ready = JSON.parse(readFileSync(readyPath, 'utf8')) as {
        readonly processId: number
        readonly runId: string
        readonly gateId: string
        readonly runStatus: string
        readonly gateStatus: string
        readonly selected: string
        readonly actionIntentCount: number
      }
      expect(Number.isSafeInteger(ready.processId)).toBe(true)
      expect(ready.runId).toBe(runId)
      expect(ready.gateId).toBe(gate.id)
      expect(ready.runStatus).toBe('PROMOTING')
      expect(ready.gateStatus).toBe('RESOLVED')
      expect(ready.selected).toBe('promote')
      expect(ready.actionIntentCount).toBe(0)

      child.kill('SIGKILL')
      const exit = await exited
      hostExited = true
      expect(exit.code === 0).toBe(false)
      await vi.waitFor(() => {
        try {
          process.kill(ready.processId, 0)
          throw new Error(`Promotion Gate Host (${String(ready.processId)}) survived SIGKILL`)
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
          throw error
        }
      }, { interval: 25, timeout: 10_000 })

      const interruptedStore = new AutoDevStore(stateRoot)
      try {
        expect(interruptedStore.getRun(runId)?.status).toBe('PROMOTING')
        expect(interruptedStore.getRun(runId)?.currentGateId).toBeUndefined()
        expect(interruptedStore.getGate(gate.id)).toMatchObject({ status: 'RESOLVED', selected: 'promote' })
        expect(interruptedStore.listActionIntents(runId).filter(intent => intent.kind === 'git-promotion')).toEqual([])
        expect(interruptedStore.listSideEffects(runId).filter(effect => effect.status === 'COMMITTED')).toEqual([])
      } finally {
        interruptedStore.close()
      }

      recovery = new AutoDevRuntime(new Context(), { dataRoot: stateRoot, worktreeRoot, jev: { mode: 'off' } })
      const restored = recovery.snapshot(runId)
      const openGate = restored.gates.find(item => item.status === 'OPEN')
      expect(restored.run.status).toBe('NEEDS_INTERVENTION')
      expect(restored.gates.find(item => item.id === gate.id)).toMatchObject({ status: 'RESOLVED', selected: 'promote' })
      expect(openGate?.id).not.toBe(gate.id)
      expect(openGate?.id).toBe(restored.run.currentGateId)
      expect(openGate?.options).toContain('promote')
      expect(restored.actionIntents.filter(intent => intent.kind === 'git-promotion')).toEqual([])
      expect(restored.sideEffects.filter(effect => effect.status === 'COMMITTED')).toEqual([])
      expect(await recovery.git.treeHash(run.repoRoot)).toBe(repoTreeBeforeClaim)
    } finally {
      if (child !== undefined && !hostExited) {
        child.kill('SIGKILL')
        await exited?.catch(() => {})
      }
      recovery?.store.close()
      if (!originalClosed) runtime.store.close()
    }
  })

  it('allows only one competing decision to consume a PROMOTING Gate', async () => {
    const fixture = await createGatePromotionFixture('promotion-gate-race')
    const { runtime, runId, stateRoot, worktreeRoot, gate } = fixture
    const competingRuntime = new AutoDevRuntime(new Context(), { dataRoot: stateRoot, worktreeRoot, jev: { mode: 'off' } }, { commands: new FakeMavenExecutor() })
    vi.spyOn(runtime.git, 'treeHash').mockRejectedValue(new Error('injected failure before Promotion intent'))
    try {
      const results = await Promise.allSettled([
        runtime.resolveGate(runId, 'promote'),
        competingRuntime.resolveGate(runId, 'abandon'),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      expect(runtime.store.getGate(gate.id)).toMatchObject({ status: 'RESOLVED', selected: 'promote' })
      expect(runtime.store.getRun(runId)?.status).toBe('NEEDS_INTERVENTION')
      expect(runtime.store.listGates(runId).filter(item => item.status === 'OPEN')).toHaveLength(1)
      expect(runtime.store.listActionIntents(runId).filter(intent => intent.kind === 'git-promotion')).toEqual([])
    } finally {
      competingRuntime.store.close()
      runtime.store.close()
    }
  })

  it('rolls back Gate resolution and all Plan records when Replan node creation fails', async () => {
    const root = tempRoot('replan-aggregate-failure')
    const stateRoot = tempRoot('replan-aggregate-failure-state')
    const worktreeRoot = tempRoot('replan-aggregate-failure-worktrees')
    await createGitRepo(root)
    const runtime = new AutoDevRuntime(new Context(), { dataRoot: stateRoot, worktreeRoot, jev: { mode: 'off' } }, { commands: new FakeMavenExecutor() })
    try {
      const created = await runtime.create({ repoPath: root, request: 'exercise Replan rollback' })
      const initialPlan = created.plan
      if (initialPlan === undefined) throw new Error('initial Plan was not created')
      const gate = {
        id: 'gate-replan-rollback', runId: created.run.id, reason: 'exercise transaction rollback',
        options: ['replan'] as const, status: 'OPEN' as const, createdAt: new Date().toISOString(),
      }
      runtime.store.saveGate(gate)
      runtime.store.updateRun(created.run.id, current => ({ ...current, status: 'NEEDS_INTERVENTION', currentGateId: gate.id }))
      const originalCreateNode = runtime.store.createNode.bind(runtime.store)
      vi.spyOn(runtime.store, 'createNode').mockImplementation((node) => {
        if (node.planId !== initialPlan.id) throw new Error('injected NodeExecution persistence failure')
        originalCreateNode(node)
      })

      await expect(runtime.resolveGate(created.run.id, 'replan')).rejects.toThrow(/injected NodeExecution persistence failure/)
      expect(runtime.store.getRun(created.run.id)).toMatchObject({ status: 'NEEDS_INTERVENTION', activePlanId: initialPlan.id, currentGateId: gate.id })
      expect(runtime.store.getGate(gate.id)).toMatchObject({ status: 'OPEN' })
      expect(runtime.store.listPlans(created.run.id)).toEqual([initialPlan])
      expect(runtime.store.listPlans(created.run.id).filter(plan => plan.status === 'ACTIVE')).toHaveLength(1)
      expect(runtime.store.listNodes(created.run.id)).toHaveLength(initialPlan.nodes.length)
    } finally {
      runtime.store.close()
    }
  })

  it('does not automatically retry after a Provider reports an unknown outcome', async () => {
    const root = tempRoot('unknown-provider')
    const stateRoot = tempRoot('unknown-provider-state')
    const worktreeRoot = tempRoot('unknown-provider-worktrees')
    await createGitRepo(root)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: stateRoot,
      worktreeRoot,
      maxAttempts: 2,
      jev: { mode: 'off' },
      routes: {
        implement: {
          candidates: [{ kind: 'command', provider: 'crashing-agent', traits: ['code-edit', 'local-workspace'] }],
          requiredTaskTraits: ['code-edit', 'local-workspace'],
        },
      },
    }, {
      commands: new FakeMavenExecutor(),
      decisions: trustedTestDecisions(),
    })
    runtime.registerProvider({
      name: 'crashing-agent',
      kind: 'command',
      traits: ['code-edit', 'local-workspace'],
      workspaceCwd: true,
      run: async (request) => {
        writeFileSync(join(request.cwd, 'UNKNOWN_SIDE_EFFECT.txt'), 'changed before crash\n')
        return { provider: request.provider, status: 'error', output: 'crashed after editing', diagnostic: 'child process lost' }
      },
    })
    try {
      const created = await runtime.create({ repoPath: root, request: 'run an unsafe provider' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const failed = await runtime.run(created.run.id)
      expect(failed.run.status).toBe('NEEDS_INTERVENTION')
      expect(failed.nodes.find(node => node.nodeId === 'implement')?.status).toBe('UNKNOWN')
      expect(failed.gates.at(-1)?.options).not.toContain('retry')
    } finally {
      runtime.store.close()
    }
  })

  it('aborts an active Provider on cancel and keeps its unconfirmed outcome UNKNOWN', async () => {
    const root = tempRoot('cancel-provider')
    const stateRoot = tempRoot('cancel-provider-state')
    const worktreeRoot = tempRoot('cancel-provider-worktrees')
    await createGitRepo(root)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: stateRoot,
      worktreeRoot,
      maxAttempts: 2,
      jev: { mode: 'off' },
      routes: {
        implement: {
          candidates: [{ kind: 'command', provider: 'cancel-fixture', traits: ['code-edit', 'local-workspace'] }],
          requiredTaskTraits: ['code-edit', 'local-workspace'],
        },
      },
    }, {
      commands: new FakeMavenExecutor(),
      decisions: new DecisionCoordinator({ config: { mode: 'off' } }),
    })
    let announceStarted!: () => void
    const started = new Promise<void>((resolve) => { announceStarted = resolve })
    let signalObserved = false
    runtime.registerProvider({
      name: 'cancel-fixture',
      kind: 'command',
      traits: ['code-edit', 'local-workspace'],
      workspaceCwd: true,
      run: async (request) => {
        writeFileSync(join(request.cwd, 'PARTIAL_CANCELLED_EDIT.txt'), 'partial work retained\n')
        announceStarted()
        return await new Promise((resolve) => {
          request.signal.addEventListener('abort', () => {
            signalObserved = request.signal.aborted
            resolve({ provider: request.provider, status: 'completed', output: 'provider did not confirm cancellation' })
          }, { once: true })
        })
      },
    })

    try {
      const created = await runtime.create({ repoPath: root, request: 'exercise active provider cancellation' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const running = runtime.run(created.run.id)
      await started
      await expect(runtime.run(created.run.id)).rejects.toThrow(/already has an active operation/)
      const cancelled = await runtime.remoteCancel(created.run.id)
      expect(cancelled.run.status).toBe('CANCELLED')

      const settled = await running
      expect(signalObserved).toBe(true)
      expect(settled.run.status).toBe('CANCELLED')
      expect(settled.nodes.find(node => node.nodeId === 'implement')?.status).toBe('UNKNOWN')
      expect(settled.actionIntents.find(item => item.kind === 'agent-workspace')?.status).toBe('UNKNOWN')
      expect(settled.evidence.some(item => item.type === 'AGENT_OUTPUT' && item.status === 'UNKNOWN')).toBe(true)
      expect(settled.evidence.some(item => item.type === 'BUILD' || item.type === 'TEST')).toBe(false)
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('baseline\n')
      expect(settled.run.worktreePath).toBeDefined()
      expect(readFileSync(join(settled.run.worktreePath!, 'PARTIAL_CANCELLED_EDIT.txt'), 'utf8')).toContain('partial work retained')
    } finally {
      await runtime.dispose()
      runtime.store.close()
    }
  })

  it('waits for active Providers to settle before Runtime disposal completes', async () => {
    const root = tempRoot('dispose-provider')
    const stateRoot = tempRoot('dispose-provider-state')
    const worktreeRoot = tempRoot('dispose-provider-worktrees')
    await createGitRepo(root)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: stateRoot,
      worktreeRoot,
      jev: { mode: 'off' },
      routes: {
        implement: {
          candidates: [{ kind: 'command', provider: 'dispose-fixture', traits: ['code-edit', 'local-workspace'] }],
          requiredTaskTraits: ['code-edit', 'local-workspace'],
        },
      },
    }, {
      commands: new FakeMavenExecutor(),
      decisions: new DecisionCoordinator({ config: { mode: 'off' } }),
    })
    let announceStarted!: () => void
    const started = new Promise<void>((resolve) => { announceStarted = resolve })
    let announceAborted!: () => void
    const aborted = new Promise<void>((resolve) => { announceAborted = resolve })
    let releaseProvider!: () => void
    const providerBarrier = new Promise<void>((resolve) => { releaseProvider = resolve })
    runtime.registerProvider({
      name: 'dispose-fixture',
      kind: 'command',
      traits: ['code-edit', 'local-workspace'],
      workspaceCwd: true,
      run: async (request) => {
        announceStarted()
        await new Promise<void>(resolve => request.signal.addEventListener('abort', () => {
          announceAborted()
          resolve()
        }, { once: true }))
        await providerBarrier
        return { provider: request.provider, status: 'completed', output: 'settled after disposal request' }
      },
    })

    try {
      const created = await runtime.create({ repoPath: root, request: 'exercise provider disposal' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const running = runtime.run(created.run.id)
      await started
      let disposalCompleted = false
      const disposing = runtime.dispose().then(() => { disposalCompleted = true })
      await aborted
      await Promise.resolve()
      expect(disposalCompleted).toBe(false)
      releaseProvider()
      await disposing
      const settled = await running
      expect(settled.run.status).toBe('PAUSED')
      expect(settled.nodes.find(node => node.nodeId === 'implement')?.status).toBe('UNKNOWN')
      expect(settled.actionIntents.find(item => item.kind === 'agent-workspace')?.status).toBe('UNKNOWN')
      expect(settled.evidence.some(item => item.type === 'BUILD' || item.type === 'TEST')).toBe(false)
      await expect(runtime.run(created.run.id)).rejects.toThrow(/Runtime is disposing/)
    } finally {
      releaseProvider()
      await runtime.dispose()
      runtime.store.close()
    }
  })

  it('executes in a worktree, records evidence, and promotes only by patch', async () => {
    const root = tempRoot('runtime')
    const stateRoot = tempRoot('runtime-state')
    const worktreeRoot = tempRoot('runtime-worktrees')
    await createGitRepo(root)
    const context = new Context()
    const runtime = new AutoDevRuntime(context, {
      dataRoot: stateRoot,
      worktreeRoot,
      jev: { mode: 'off' },
      maven: { executable: 'fake-mvn', buildArgs: ['package'], testArgs: ['test'] },
      routes: {
        implement: {
          candidates: [{ kind: 'command', provider: 'fake-editor', traits: ['code-edit', 'local-workspace'] }],
          requiredTaskTraits: ['code-edit', 'local-workspace'],
        },
      },
    }, {
      commands: new FakeMavenExecutor(),
      decisions: trustedTestDecisions(),
    })
    runtime.registerProvider({
      name: 'fake-editor',
      kind: 'command',
      traits: ['code-edit', 'local-workspace'],
      workspaceCwd: true,
      run: async (request) => {
        request.emitSignal?.({ type: 'EvidenceProduced', summary: 'fixture implementation output' })
        writeFileSync(join(request.cwd, 'AUTO_DEV_OK.txt'), 'implemented\n')
        return { provider: request.provider, status: 'completed', output: 'created AUTO_DEV_OK.txt' }
      },
    })

    try {
      const created = await runtime.create({ repoPath: root, request: 'create a proof file', acceptanceCriteria: ['file exists'] })
      expect(created.run.status).toBe('DRAFT')
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const verified = await runtime.run(created.run.id)
      expect(verified.run.status).toBe('VERIFY')
      expect(verified.candidate).toBeDefined()
      expect(verified.signals).toHaveLength(1)
      expect(verified.signals[0]?.signal.type).toBe('EvidenceProduced')
      expect(verified.verifications.at(-1)?.status).toBe('PASS')
      expect(verified.verificationResults).toHaveLength(5)
      expect(verified.evidence.filter(item => ['BUILD', 'TEST', 'REVIEW', 'JEV_DECISION'].includes(item.type))).toHaveLength(5)
      expect(verified.evidence.find(item => item.type === 'REVIEW')?.status).toBe('PASS')
      const diff = await runtime.remoteCandidateDiff(created.run.id, new AbortController().signal)
      expect(diff?.content).toContain('AUTO_DEV_OK.txt')
      expect(diff).not.toHaveProperty('path')

      const activeCandidate = verified.candidate
      if (activeCandidate === undefined) throw new Error('verified run has no Candidate')
      const olderArtifact = runtime.store.writeArtifact(created.run.id, 'candidate-diff', 'diff --git a/OLDER.txt b/OLDER.txt\n', '.patch')
      const olderCandidate = {
        ...activeCandidate,
        id: 'candidate-older-revision',
        attempt: 0,
        gitTreeHash: 'older-tree-hash',
        diffArtifactId: olderArtifact.id,
        createdAt: '2000-01-01T00:00:00.000Z',
      }
      runtime.store.saveCandidate(olderCandidate)
      const history = runtime.snapshot(created.run.id).candidateHistory
      expect(history?.map(item => item.id)).toEqual(['candidate-older-revision', activeCandidate.id])
      expect(history?.[0]).not.toHaveProperty('worktreePath')
      expect(history?.[0]).not.toHaveProperty('diffArtifactId')
      expect(history?.[0]?.diffAvailable).toBe(true)
      const olderDiff = await runtime.remoteCandidateRevisionDiff(created.run.id, olderCandidate.id, new AbortController().signal)
      expect(olderDiff?.content).toContain('OLDER.txt')
      expect(olderDiff).not.toHaveProperty('path')

      const discarded = await runtime.create({ repoPath: root, request: 'create another proof file' })
      runtime.remoteApprovePlan({ runId: discarded.run.id, planId: discarded.plan!.id })
      const discardedVerified = await runtime.run(discarded.run.id)
      expect(discardedVerified.run.status).toBe('VERIFY')
      if (discardedVerified.candidate === undefined) throw new Error('second verified run has no Candidate')
      await expect(runtime.remoteCandidateRevisionDiff(
        created.run.id,
        discardedVerified.candidate.id,
        new AbortController().signal,
      )).rejects.toThrow(/does not belong to run/)
      const discardedRun = await runtime.remoteCancel(discarded.run.id)
      expect(discardedRun.run.status).toBe('CANCELLED')
      await expect(runtime.promote(discarded.run.id)).rejects.toThrow(/not ready for promotion/)
      expect(existsSync(join(root, 'AUTO_DEV_OK.txt'))).toBe(false)

      const promoted = await runtime.promote(created.run.id)
      expect(promoted.run.status).toBe('PROMOTED')
      expect(readFileSync(join(root, 'AUTO_DEV_OK.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('implemented\n')
      const actionCount = promoted.actionIntents.filter(item => item.kind === 'git-promotion').length
      const replayed = await runtime.promote(created.run.id)
      expect(replayed.run.status).toBe('PROMOTED')
      expect(replayed.actionIntents.filter(item => item.kind === 'git-promotion')).toHaveLength(actionCount)
      expect(replayed.evidence.filter(item => item.type === 'PROMOTION' && item.status === 'PASS')).toHaveLength(1)
    } finally {
      runtime.store.close()
    }
  })

  it('rejects promotion when the sealed Worktree tree drifts after verification', async () => {
    const root = tempRoot('promotion-worktree-drift')
    const stateRoot = tempRoot('promotion-worktree-drift-state')
    const worktreeRoot = tempRoot('promotion-worktree-drift-worktrees')
    await createGitRepo(root)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: stateRoot, worktreeRoot, jev: { mode: 'off' },
      maven: { executable: 'fake-mvn', buildArgs: ['package'], testArgs: ['test'] },
      routes: { implement: { candidates: [{ kind: 'command', provider: 'drift-editor', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] } },
    }, { commands: new FakeMavenExecutor(), decisions: trustedTestDecisions() })
    runtime.registerProvider({
      name: 'drift-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true,
      run: async (request) => {
        writeFileSync(join(request.cwd, 'DRIFT_PROOF.txt'), 'sealed candidate\n')
        return { provider: request.provider, status: 'completed', output: 'candidate created' }
      },
    })
    try {
      const created = await runtime.create({ repoPath: root, request: 'create a drift proof file' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const verified = await runtime.run(created.run.id)
      expect(verified.run.status).toBe('VERIFY')
      if (verified.candidate === undefined) throw new Error('verified run has no candidate')
      writeFileSync(join(verified.candidate.worktreePath, 'DRIFT_PROOF.txt'), 'changed after verification\n')

      const blocked = await runtime.promote(created.run.id)
      expect(blocked.run.status).toBe('NEEDS_INTERVENTION')
      expect(blocked.gates.at(-1)?.options).not.toContain('promote')
      expect(blocked.evidence.some(item => item.type === 'DRIFT' && item.status === 'FAIL' && item.summary.includes('Worktree tree changed'))).toBe(true)
      expect(existsSync(join(root, 'DRIFT_PROOF.txt'))).toBe(false)
    } finally {
      runtime.store.close()
    }
  })

  it('preserves a concurrent user file created after the clean-baseline check and marks promotion outcome unknown', async () => {
    const root = tempRoot('promotion-host-race-repo')
    const worktreeRoot = tempRoot('promotion-host-race-worktrees')
    await createGitRepo(root)
    const baseCommands = new HarnessCommandExecutor()
    const baselineManager = new GitManager(baseCommands, worktreeRoot)
    const baseline = await baselineManager.inspect(root)
    const candidatePath = await baselineManager.createWorktree('promotion-host-race', baseline)
    const concurrentPath = join(root, 'RACE_PROOF.txt')
    writeFileSync(join(candidatePath, 'RACE_PROOF.txt'), 'candidate content\n')
    const expectedTree = await baselineManager.treeHash(candidatePath)
    const patchPath = join(worktreeRoot, 'race.patch')
    writeFileSync(patchPath, await baselineManager.diff(candidatePath, baseline.baseCommit))

    let injected = false
    const racingCommands: CommandExecutor = {
      async run(argv, cwd, options) {
        const result = await baseCommands.run(argv, cwd, options)
        if (!injected && cwd === root && argv[0] === 'git' && argv[1] === 'status' && result.exitCode === 0) {
          writeFileSync(concurrentPath, 'user content written concurrently\n')
          injected = true
        }
        return result
      },
    }
    const racingManager = new GitManager(racingCommands, worktreeRoot)

    await expect(racingManager.promote(root, baseline.baseCommit, patchPath, expectedTree))
      .rejects.toMatchObject({ certainty: 'unknown' })
    expect(injected).toBe(true)
    expect(readFileSync(concurrentPath, 'utf8').replace(/\r\n/g, '\n')).toBe('user content written concurrently\n')
  })

  it.each([
    { label: 'a tracked file rewritten at the same path', candidate: 'edit' as const, concurrent: 'rewrite' as const },
    { label: 'a tracked file deleted at the same path', candidate: 'edit' as const, concurrent: 'delete' as const },
    { label: 'an unrelated untracked file added', candidate: 'add' as const, concurrent: 'add-unrelated' as const },
  ])('keeps post-check filesystem races explicit and never reports a non-candidate tree as promoted: $label', async (scenario) => {
    const root = tempRoot(`promotion-post-check-${scenario.concurrent}`)
    const worktreeRoot = tempRoot(`promotion-post-check-worktrees-${scenario.concurrent}`)
    await createGitRepo(root)
    const baseCommands = new HarnessCommandExecutor()
    const baselineManager = new GitManager(baseCommands, worktreeRoot)
    const baseline = await baselineManager.inspect(root)
    const candidatePath = await baselineManager.createWorktree(`promotion-post-check-${scenario.concurrent}`, baseline)
    const candidateFile = scenario.candidate === 'edit' ? 'README.md' : 'CANDIDATE_RACE.txt'
    writeFileSync(join(candidatePath, candidateFile), 'sealed candidate content\n')
    const expectedTree = await baselineManager.treeHash(candidatePath)
    const patchPath = join(worktreeRoot, `race-${scenario.concurrent}.patch`)
    writeFileSync(patchPath, await baselineManager.diff(candidatePath, baseline.baseCommit))

    let injected = false
    const racingCommands: CommandExecutor = {
      async run(argv, cwd, options) {
        const result = await baseCommands.run(argv, cwd, options)
        if (!injected && cwd === root && argv[0] === 'git' && argv[1] === 'status' && result.exitCode === 0) {
          if (scenario.concurrent === 'rewrite') writeFileSync(join(root, 'README.md'), 'user content rewritten after check\n')
          else if (scenario.concurrent === 'delete') rmSync(join(root, 'README.md'))
          else writeFileSync(join(root, 'USER_RACE.txt'), 'unrelated user content\n')
          injected = true
        }
        return result
      },
    }
    const racingManager = new GitManager(racingCommands, worktreeRoot)

    await expect(racingManager.promote(root, baseline.baseCommit, patchPath, expectedTree))
      .rejects.toMatchObject({ certainty: 'unknown' })
    expect(injected).toBe(true)
    if (scenario.concurrent === 'rewrite') {
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('user content rewritten after check\n')
      expect(existsSync(join(root, 'CANDIDATE_RACE.txt'))).toBe(false)
    } else if (scenario.concurrent === 'delete') {
      expect(existsSync(join(root, 'README.md'))).toBe(false)
      expect(existsSync(join(root, 'CANDIDATE_RACE.txt'))).toBe(false)
    } else {
      expect(readFileSync(join(root, 'USER_RACE.txt'), 'utf8')).toBe('unrelated user content\n')
      expect(readFileSync(join(root, 'CANDIDATE_RACE.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('sealed candidate content\n')
    }
  })

  it('revalidates current evidence before promotion instead of trusting an earlier PASS', async () => {
    const root = tempRoot('promotion-evidence-regression')
    const stateRoot = tempRoot('promotion-evidence-regression-state')
    const worktreeRoot = tempRoot('promotion-evidence-regression-worktrees')
    await createGitRepo(root)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: stateRoot, worktreeRoot, jev: { mode: 'off' },
      maven: { executable: 'fake-mvn', buildArgs: ['package'], testArgs: ['test'] },
      routes: { implement: { candidates: [{ kind: 'command', provider: 'evidence-editor', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] } },
    }, { commands: new FakeMavenExecutor(), decisions: trustedTestDecisions() })
    runtime.registerProvider({
      name: 'evidence-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true,
      run: async (request) => {
        writeFileSync(join(request.cwd, 'EVIDENCE_PROOF.txt'), 'candidate\n')
        return { provider: request.provider, status: 'completed', output: 'candidate created' }
      },
    })
    try {
      const created = await runtime.create({ repoPath: root, request: 'create an evidence proof file' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const verified = await runtime.run(created.run.id)
      expect(verified.run.status).toBe('VERIFY')
      const candidate = verified.candidate
      if (candidate === undefined) throw new Error('verified run has no candidate')
      const build = verified.evidence.find(item => item.type === 'BUILD' && item.candidateId === candidate.id)
      if (build === undefined) throw new Error('candidate has no Build Evidence')
      runtime.store.saveEvidence({
        ...build, id: 'later-build-fail', status: 'FAIL', summary: 'late failure injection',
        createdAt: new Date(Date.now() + 1000).toISOString(),
      })

      const blocked = await runtime.promote(created.run.id)
      expect(blocked.run.status).toBe('NEEDS_INTERVENTION')
      expect(blocked.verifications.at(-1)?.status).toBe('FAIL')
      expect(blocked.gates.at(-1)?.options).not.toContain('promote')
      expect(existsSync(join(root, 'EVIDENCE_PROOF.txt'))).toBe(false)
    } finally {
      runtime.store.close()
    }
  })

  it('serializes promotion across eight Host instances sharing one AutoDev database', async () => {
    const root = tempRoot('promotion-concurrent')
    const stateRoot = tempRoot('promotion-concurrent-state')
    const worktreeRoot = tempRoot('promotion-concurrent-worktrees')
    await createGitRepo(root)
    const config = {
      dataRoot: stateRoot, worktreeRoot, jev: { mode: 'off' as const },
      maven: { executable: 'fake-mvn', buildArgs: ['package'], testArgs: ['test'] },
      routes: { implement: { candidates: [{ kind: 'command' as const, provider: 'concurrent-editor', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] } },
    }
    const runtimes = Array.from({ length: 8 }, () => new AutoDevRuntime(
      new Context(), config,
      { commands: new FakeMavenExecutor(), decisions: trustedTestDecisions() },
    ))
    const runtimeA = runtimes[0]
    if (runtimeA === undefined) throw new Error('promotion concurrency fixture did not create a Host')
    runtimeA.registerProvider({
      name: 'concurrent-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true,
      run: async (request) => {
        writeFileSync(join(request.cwd, 'CONCURRENT_PROOF.txt'), 'one candidate\n')
        return { provider: request.provider, status: 'completed', output: 'candidate created' }
      },
    })
    try {
      const created = await runtimeA.create({ repoPath: root, request: 'create a concurrency proof file' })
      runtimeA.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      expect((await runtimeA.run(created.run.id)).run.status).toBe('VERIFY')
      const outcomes = await Promise.allSettled(runtimes.map(runtime => runtime.promote(created.run.id)))
      expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(7)
      expect(runtimeA.snapshot(created.run.id).run.status).toBe('PROMOTED')
      expect(readFileSync(join(root, 'CONCURRENT_PROOF.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('one candidate\n')
    } finally {
      for (const runtime of runtimes) runtime.store.close()
    }
  })

  it('serializes a real simultaneous promotion race across independent Host processes', { timeout: 180_000 }, async () => {
    const workers = Number(process.env.AUTODEV_PROMOTION_RACE_WORKERS ?? 96)
    if (!Number.isSafeInteger(workers) || workers < 2 || workers > 128) {
      throw new RangeError('AUTODEV_PROMOTION_RACE_WORKERS must be an integer between 2 and 128')
    }
    const root = tempRoot('promotion-process-race-repo')
    const stateRoot = tempRoot('promotion-process-race-state')
    const worktreeRoot = tempRoot('promotion-process-race-worktrees')
    const workerRoot = tempRoot('promotion-process-race-workers')
    await createGitRepo(root)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: stateRoot,
      worktreeRoot,
      jev: { mode: 'off' },
      routes: {
        implement: {
          candidates: [{ kind: 'command', provider: 'process-race-editor', traits: ['code-edit', 'local-workspace'] }],
          requiredTaskTraits: ['code-edit', 'local-workspace'],
        },
      },
    }, { commands: new FakeMavenExecutor(), decisions: trustedTestDecisions() })
    const startPath = join(workerRoot, 'start')
    const fixturePath = fileURLToPath(new URL('./fixtures/autodev-promotion-race.ts', import.meta.url))
    const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const children: ReturnType<typeof spawn>[] = []
    const exits: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>[] = []
    try {
      runtime.registerProvider({
        name: 'process-race-editor',
        kind: 'command',
        traits: ['code-edit', 'local-workspace'],
        workspaceCwd: true,
        run: async (request) => {
          writeFileSync(join(request.cwd, 'PROCESS_RACE_PROOF.txt'), 'single cross-process winner\n')
          return { provider: request.provider, status: 'completed', output: 'candidate created' }
        },
      })
      const created = await runtime.create({ repoPath: root, request: 'create a cross-process promotion proof file' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      expect((await runtime.run(created.run.id)).run.status).toBe('VERIFY')

      for (let index = 0; index < workers; index++) {
        const readyPath = join(workerRoot, `ready-${index}`)
        const resultPath = join(workerRoot, `result-${index}.json`)
        const failurePath = join(workerRoot, `failure-${index}.txt`)
        const child = spawn(process.execPath, [
          '--import', 'tsx/esm', fixturePath,
          stateRoot, worktreeRoot, created.run.id, readyPath, startPath, resultPath, failurePath,
        ], {
          cwd: workspaceRoot,
          env: { ...process.env, TSX_TSCONFIG_PATH: join(workspaceRoot, 'tsconfig.json') },
          stdio: 'ignore',
          windowsHide: true,
        })
        children.push(child)
        exits.push(new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal }))
        }))
      }

      const readyPaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `ready-${index}`))
      const resultPaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `result-${index}.json`))
      const failurePaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `failure-${index}.txt`))
      const readyDeadline = Date.now() + 90_000
      while (!readyPaths.every(existsSync)) {
        const failure = failurePaths.find(existsSync)
        if (failure !== undefined) throw new Error(`promotion worker failed to initialize: ${readFileSync(failure, 'utf8')}`)
        if (Date.now() >= readyDeadline) throw new Error('independent Host processes did not reach the promotion barrier')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      writeFileSync(startPath, 'go')

      const resultDeadline = Date.now() + 90_000
      while (!resultPaths.every(existsSync)) {
        const failure = failurePaths.find(existsSync)
        if (failure !== undefined) throw new Error(`promotion worker failed: ${readFileSync(failure, 'utf8')}`)
        if (Date.now() >= resultDeadline) throw new Error('independent Host processes did not settle the promotion race')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const exitsResult = await Promise.all(exits)
      expect(exitsResult.every(exit => exit.code === 0 && exit.signal === null)).toBe(true)
      const results = resultPaths.map(path => JSON.parse(readFileSync(path, 'utf8')) as {
        readonly outcome: 'fulfilled' | 'rejected'
        readonly status?: string
        readonly error?: string
        readonly errorCode?: string
        readonly sqliteCode?: number
      })
      expect(results).toHaveLength(workers)
      expect(results.some(result => result.outcome === 'fulfilled')).toBe(true)
      expect(results.filter(result => result.outcome === 'fulfilled').every(result => result.status === 'PROMOTED')).toBe(true)
      const rejectedResults = results.filter(result => result.outcome === 'rejected')
      const unexpectedRejections = rejectedResults.filter(result =>
        !/run .* (?:is not ready for promotion|changed while promotion was being claimed)/.test(result.error ?? ''),
      )
      const unexpectedSummary = Object.fromEntries([...new Set(unexpectedRejections.map(result =>
        `${result.errorCode ?? 'unknown-code'}${result.sqliteCode === undefined ? '' : `/${result.sqliteCode}`}: ${result.error ?? 'unknown error'}`,
      ))].map(message => [message, unexpectedRejections.filter(result =>
        `${result.errorCode ?? 'unknown-code'}${result.sqliteCode === undefined ? '' : `/${result.sqliteCode}`}: ${result.error ?? 'unknown error'}` === message,
      ).length]))
      expect(unexpectedRejections, `unexpected promotion race rejections: ${JSON.stringify(unexpectedSummary)}`).toHaveLength(0)

      const snapshot = runtime.snapshot(created.run.id)
      const candidate = runtime.store.getCandidate(snapshot.run.candidateId!)
      expect(snapshot.run.status).toBe('PROMOTED')
      expect(candidate).toBeDefined()
      expect(snapshot.evidence.filter(item => item.type === 'PROMOTION' && item.status === 'PASS')).toHaveLength(1)
      expect(snapshot.actionIntents.filter(item => item.kind === 'git-promotion')).toHaveLength(1)
      expect(snapshot.actionIntents.filter(item => item.kind === 'git-promotion' && item.status === 'COMMITTED')).toHaveLength(1)
      const promotionIntentId = snapshot.actionIntents.find(item => item.kind === 'git-promotion')!.id
      expect(snapshot.sideEffects.filter(item => item.intentId === promotionIntentId && item.status === 'COMMITTED')).toHaveLength(1)
      expect(snapshot.evidence.find(item => item.type === 'PROMOTION')?.candidateId).toBe(candidate!.id)
      expect(readFileSync(join(root, 'PROCESS_RACE_PROOF.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('single cross-process winner\n')
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill()
      await Promise.allSettled(exits)
      runtime.store.close()
    }
  })

  it('creates only one idempotent ActionIntent when independent Hosts plan the same side effect', { timeout: 180_000 }, async () => {
    const workers = Number(process.env.AUTODEV_ACTION_PLAN_RACE_WORKERS ?? 16)
    if (!Number.isSafeInteger(workers) || workers < 2 || workers > 128) {
      throw new RangeError('AUTODEV_ACTION_PLAN_RACE_WORKERS must be an integer between 2 and 128')
    }
    const repoRoot = tempRoot('action-plan-race-repo')
    const stateRoot = tempRoot('action-plan-race-state')
    const workerRoot = tempRoot('action-plan-race-workers')
    const runId = 'run-action-plan-race'
    const seedStore = new AutoDevStore(stateRoot)
    seedStore.createRun({ ...sampleRun(repoRoot), id: runId })
    seedStore.close()

    const startPath = join(workerRoot, 'start')
    const fixturePath = fileURLToPath(new URL('./fixtures/autodev-action-plan-race.ts', import.meta.url))
    const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const children: ReturnType<typeof spawn>[] = []
    const exits: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>[] = []
    try {
      for (let index = 0; index < workers; index++) {
        const readyPath = join(workerRoot, `ready-${index}`)
        const resultPath = join(workerRoot, `result-${index}.json`)
        const failurePath = join(workerRoot, `failure-${index}.txt`)
        const child = spawn(process.execPath, [
          '--import', 'tsx/esm', fixturePath,
          stateRoot, runId, workerRoot, String(index), String(workers), readyPath, startPath, resultPath, failurePath,
        ], {
          cwd: workspaceRoot,
          env: { ...process.env, TSX_TSCONFIG_PATH: join(workspaceRoot, 'tsconfig.json') },
          stdio: 'ignore',
          windowsHide: true,
        })
        children.push(child)
        exits.push(new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal }))
        }))
      }

      const readyPaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `ready-${index}`))
      const resultPaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `result-${index}.json`))
      const failurePaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `failure-${index}.txt`))
      const readyDeadline = Date.now() + 90_000
      while (!readyPaths.every(existsSync)) {
        const failure = failurePaths.find(existsSync)
        if (failure !== undefined) throw new Error(`action-plan worker failed to initialize: ${readFileSync(failure, 'utf8')}`)
        if (Date.now() >= readyDeadline) throw new Error('action-plan workers did not reach the start barrier')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      writeFileSync(startPath, 'go')

      const resultDeadline = Date.now() + 90_000
      while (!resultPaths.every(existsSync)) {
        const failure = failurePaths.find(existsSync)
        if (failure !== undefined) throw new Error(`action-plan worker failed: ${readFileSync(failure, 'utf8')}`)
        if (Date.now() >= resultDeadline) throw new Error('action-plan workers did not settle')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const exitsResult = await Promise.all(exits)
      expect(exitsResult.every(exit => exit.code === 0 && exit.signal === null)).toBe(true)
      const results = resultPaths.map(path => JSON.parse(readFileSync(path, 'utf8')) as { readonly intentId: string })
      expect(new Set(results.map(result => result.intentId)).size).toBe(1)

      const store = new AutoDevStore(stateRoot)
      try {
        const intents = store.listActionIntents(runId)
        expect(intents).toHaveLength(1)
        expect(intents[0]?.id).toBe(results[0]?.intentId)
        expect(store.listSideEffects(runId).filter(effect => effect.status === 'PLANNED')).toHaveLength(1)
        expect(store.events(runId).filter(event => event.type === 'action/updated')).toHaveLength(1)
        expect(store.events(runId).filter(event => event.type === 'side-effect/updated')).toHaveLength(1)
      } finally {
        store.close()
      }
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill()
      await Promise.allSettled(exits)
    }
  })

  it('grants only one independent Host the ActionIntent execution claim', { timeout: 180_000 }, async () => {
    const workers = Number(process.env.AUTODEV_ACTION_START_RACE_WORKERS ?? 16)
    if (!Number.isSafeInteger(workers) || workers < 2 || workers > 128) {
      throw new RangeError('AUTODEV_ACTION_START_RACE_WORKERS must be an integer between 2 and 128')
    }
    const repoRoot = tempRoot('action-start-race-repo')
    const stateRoot = tempRoot('action-start-race-state')
    const workerRoot = tempRoot('action-start-race-workers')
    const runId = 'run-action-start-race'
    const seedStore = new AutoDevStore(stateRoot)
    seedStore.createRun({ ...sampleRun(repoRoot), id: runId })
    const sideEffects = new SideEffectService(seedStore)
    const intent = sideEffects.plan({ runId, kind: 'command', target: 'same concurrent command', risk: 'low' })
    sideEffects.authorize(intent.id, 'test action is authorized')
    seedStore.close()

    const startPath = join(workerRoot, 'start')
    const fixturePath = fileURLToPath(new URL('./fixtures/autodev-action-start-race.ts', import.meta.url))
    const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const children: ReturnType<typeof spawn>[] = []
    const exits: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>[] = []
    try {
      for (let index = 0; index < workers; index++) {
        const readyPath = join(workerRoot, `ready-${index}`)
        const resultPath = join(workerRoot, `result-${index}.json`)
        const failurePath = join(workerRoot, `failure-${index}.txt`)
        const child = spawn(process.execPath, [
          '--import', 'tsx/esm', fixturePath,
          stateRoot, intent.id, workerRoot, String(index), String(workers), 'start', readyPath, startPath, resultPath, failurePath,
        ], {
          cwd: workspaceRoot,
          env: { ...process.env, TSX_TSCONFIG_PATH: join(workspaceRoot, 'tsconfig.json') },
          stdio: 'ignore',
          windowsHide: true,
        })
        children.push(child)
        exits.push(new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal }))
        }))
      }

      const readyPaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `ready-${index}`))
      const resultPaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `result-${index}.json`))
      const failurePaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `failure-${index}.txt`))
      const readyDeadline = Date.now() + 90_000
      while (!readyPaths.every(existsSync)) {
        const failure = failurePaths.find(existsSync)
        if (failure !== undefined) throw new Error(`action-start worker failed to initialize: ${readFileSync(failure, 'utf8')}`)
        if (Date.now() >= readyDeadline) throw new Error('action-start workers did not reach the start barrier')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      writeFileSync(startPath, 'go')

      const resultDeadline = Date.now() + 90_000
      while (!resultPaths.every(existsSync)) {
        const failure = failurePaths.find(existsSync)
        if (failure !== undefined) throw new Error(`action-start worker failed: ${readFileSync(failure, 'utf8')}`)
        if (Date.now() >= resultDeadline) throw new Error('action-start workers did not settle')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const exitsResult = await Promise.all(exits)
      expect(exitsResult.every(exit => exit.code === 0 && exit.signal === null)).toBe(true)
      const results = resultPaths.map(path => JSON.parse(readFileSync(path, 'utf8')) as {
        readonly outcome: 'success' | 'rejected'
        readonly operation: string
        readonly status?: string
        readonly diagnostic?: string
      })
      expect(results.filter(result => result.outcome === 'success')).toHaveLength(1)
      expect(results.filter(result => result.outcome === 'rejected')).toHaveLength(workers - 1)
      expect(results.filter(result => result.outcome === 'success').every(result => result.status === 'EXECUTING')).toBe(true)
      expect(results.filter(result => result.outcome === 'rejected').every(result => result.diagnostic?.includes('must be AUTHORIZED'))).toBe(true)

      const store = new AutoDevStore(stateRoot)
      try {
        expect(store.getActionIntent(intent.id)?.status).toBe('EXECUTING')
        expect(store.events(runId).filter(event => event.type === 'action/updated'
          && (event.payload as { status?: unknown }).status === 'EXECUTING')).toHaveLength(1)
        expect(store.listAuditEvents(runId).filter(event => event.action === 'action-authorized')).toHaveLength(1)
      } finally {
        store.close()
      }
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill()
      await Promise.allSettled(exits)
    }
  })

  it('serializes conflicting ActionIntent authorizations across independent Hosts', { timeout: 180_000 }, async () => {
    const workers = Number(process.env.AUTODEV_ACTION_AUTHORIZE_RACE_WORKERS ?? 16)
    if (!Number.isSafeInteger(workers) || workers < 2 || workers > 128 || workers % 2 !== 0) {
      throw new RangeError('AUTODEV_ACTION_AUTHORIZE_RACE_WORKERS must be an even integer between 2 and 128')
    }
    const repoRoot = tempRoot('action-authorize-race-repo')
    const stateRoot = tempRoot('action-authorize-race-state')
    const workerRoot = tempRoot('action-authorize-race-workers')
    const runId = 'run-action-authorize-race'
    const seedStore = new AutoDevStore(stateRoot)
    seedStore.createRun({ ...sampleRun(repoRoot), id: runId })
    const intent = new SideEffectService(seedStore).plan({
      runId, kind: 'command', target: 'same concurrent command', risk: 'low',
    })
    seedStore.close()

    const startPath = join(workerRoot, 'start')
    const fixturePath = fileURLToPath(new URL('./fixtures/autodev-action-start-race.ts', import.meta.url))
    const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const children: ReturnType<typeof spawn>[] = []
    const exits: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>[] = []
    try {
      for (let index = 0; index < workers; index++) {
        const readyPath = join(workerRoot, `ready-${index}`)
        const resultPath = join(workerRoot, `result-${index}.json`)
        const failurePath = join(workerRoot, `failure-${index}.txt`)
        const operation = index % 2 === 0 ? 'authorize-a' : 'authorize-b'
        const child = spawn(process.execPath, [
          '--import', 'tsx/esm', fixturePath,
          stateRoot, intent.id, workerRoot, String(index), String(workers), operation, readyPath, startPath, resultPath, failurePath,
        ], {
          cwd: workspaceRoot,
          env: { ...process.env, TSX_TSCONFIG_PATH: join(workspaceRoot, 'tsconfig.json') },
          stdio: 'ignore',
          windowsHide: true,
        })
        children.push(child)
        exits.push(new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal }))
        }))
      }

      const readyPaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `ready-${index}`))
      const resultPaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `result-${index}.json`))
      const failurePaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `failure-${index}.txt`))
      const readyDeadline = Date.now() + 90_000
      while (!readyPaths.every(existsSync)) {
        const failure = failurePaths.find(existsSync)
        if (failure !== undefined) throw new Error(`action-authorize worker failed to initialize: ${readFileSync(failure, 'utf8')}`)
        if (Date.now() >= readyDeadline) throw new Error('action-authorize workers did not reach the start barrier')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      writeFileSync(startPath, 'go')

      const resultDeadline = Date.now() + 90_000
      while (!resultPaths.every(existsSync)) {
        const failure = failurePaths.find(existsSync)
        if (failure !== undefined) throw new Error(`action-authorize worker failed: ${readFileSync(failure, 'utf8')}`)
        if (Date.now() >= resultDeadline) throw new Error('action-authorize workers did not settle')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const exitsResult = await Promise.all(exits)
      expect(exitsResult.every(exit => exit.code === 0 && exit.signal === null)).toBe(true)
      const results = resultPaths.map(path => JSON.parse(readFileSync(path, 'utf8')) as {
        readonly outcome: 'success' | 'rejected'
        readonly operation: 'authorize-a' | 'authorize-b'
        readonly status?: string
        readonly diagnostic?: string
      })
      const successfulOperations = new Set(results.filter(result => result.outcome === 'success').map(result => result.operation))
      expect(successfulOperations.size).toBe(1)
      expect(results.filter(result => result.outcome === 'success')).toHaveLength(workers / 2)
      expect(results.filter(result => result.outcome === 'rejected')).toHaveLength(workers / 2)
      expect(results.filter(result => result.outcome === 'rejected').every(result => result.diagnostic?.includes('different authorization data'))).toBe(true)

      const store = new AutoDevStore(stateRoot)
      try {
        const authorized = store.getActionIntent(intent.id)
        const winningAuthorization = successfulOperations.has('authorize-a')
          ? 'concurrent authorization A'
          : 'concurrent authorization B'
        expect(authorized).toMatchObject({ status: 'AUTHORIZED', authorization: winningAuthorization })
        expect(store.events(runId).filter(event => event.type === 'action/updated'
          && (event.payload as { status?: unknown }).status === 'AUTHORIZED')).toHaveLength(1)
        expect(store.listAuditEvents(runId).filter(event => event.action === 'action-authorized')).toHaveLength(1)
        expect(store.listSideEffects(runId).filter(effect => effect.intentId === intent.id)).toHaveLength(1)
      } finally {
        store.close()
      }
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill()
      await Promise.allSettled(exits)
    }
  })

  it('commits one consistent ActionIntent outcome when independent Hosts race success against failure', { timeout: 180_000 }, async () => {
    const workers = Number(process.env.AUTODEV_ACTION_FINALIZE_RACE_WORKERS ?? 16)
    if (!Number.isSafeInteger(workers) || workers < 2 || workers > 128 || workers % 2 !== 0) {
      throw new RangeError('AUTODEV_ACTION_FINALIZE_RACE_WORKERS must be an even integer between 2 and 128')
    }
    const repoRoot = tempRoot('action-finalize-race-repo')
    const stateRoot = tempRoot('action-finalize-race-state')
    const workerRoot = tempRoot('action-finalize-race-workers')
    const runId = 'run-action-finalize-race'
    const seedStore = new AutoDevStore(stateRoot)
    seedStore.createRun({ ...sampleRun(repoRoot), id: runId })
    const sideEffects = new SideEffectService(seedStore)
    const intent = sideEffects.plan({ runId, kind: 'command', target: 'same concurrent command', risk: 'low' })
    sideEffects.authorize(intent.id, 'test action is authorized')
    sideEffects.start(intent.id)
    seedStore.close()

    const startPath = join(workerRoot, 'start')
    const fixturePath = fileURLToPath(new URL('./fixtures/autodev-action-start-race.ts', import.meta.url))
    const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const children: ReturnType<typeof spawn>[] = []
    const exits: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>[] = []
    try {
      for (let index = 0; index < workers; index++) {
        const readyPath = join(workerRoot, `ready-${index}`)
        const resultPath = join(workerRoot, `result-${index}.json`)
        const failurePath = join(workerRoot, `failure-${index}.txt`)
        const operation = index % 2 === 0 ? 'commit' : 'fail'
        const child = spawn(process.execPath, [
          '--import', 'tsx/esm', fixturePath,
          stateRoot, intent.id, workerRoot, String(index), String(workers), operation, readyPath, startPath, resultPath, failurePath,
        ], {
          cwd: workspaceRoot,
          env: { ...process.env, TSX_TSCONFIG_PATH: join(workspaceRoot, 'tsconfig.json') },
          stdio: 'ignore',
          windowsHide: true,
        })
        children.push(child)
        exits.push(new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal }))
        }))
      }

      const readyPaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `ready-${index}`))
      const resultPaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `result-${index}.json`))
      const failurePaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `failure-${index}.txt`))
      const readyDeadline = Date.now() + 90_000
      while (!readyPaths.every(existsSync)) {
        const failure = failurePaths.find(existsSync)
        if (failure !== undefined) throw new Error(`action-finalize worker failed to initialize: ${readFileSync(failure, 'utf8')}`)
        if (Date.now() >= readyDeadline) throw new Error('action-finalize workers did not reach the start barrier')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      writeFileSync(startPath, 'go')

      const resultDeadline = Date.now() + 90_000
      while (!resultPaths.every(existsSync)) {
        const failure = failurePaths.find(existsSync)
        if (failure !== undefined) throw new Error(`action-finalize worker failed: ${readFileSync(failure, 'utf8')}`)
        if (Date.now() >= resultDeadline) throw new Error('action-finalize workers did not settle')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const exitsResult = await Promise.all(exits)
      expect(exitsResult.every(exit => exit.code === 0 && exit.signal === null)).toBe(true)
      const results = resultPaths.map(path => JSON.parse(readFileSync(path, 'utf8')) as {
        readonly outcome: 'success' | 'rejected'
        readonly operation: 'commit' | 'fail'
        readonly status?: string
        readonly diagnostic?: string
      })
      const successfulOperations = new Set(results.filter(result => result.outcome === 'success').map(result => result.operation))
      expect(successfulOperations.size).toBe(1)
      expect(results.filter(result => result.outcome === 'success')).toHaveLength(workers / 2)
      expect(results.filter(result => result.outcome === 'rejected')).toHaveLength(workers / 2)
      expect(results.filter(result => result.outcome === 'rejected').every(result => result.diagnostic?.includes('invalid action transition'))).toBe(true)

      const store = new AutoDevStore(stateRoot)
      try {
        const winningStatus = successfulOperations.has('commit') ? 'COMMITTED' : 'FAILED'
        expect(store.getActionIntent(intent.id)?.status).toBe(winningStatus)
        expect(store.events(runId).filter(event => event.type === 'action/updated'
          && ['COMMITTED', 'FAILED'].includes(String((event.payload as { status?: unknown }).status)))).toHaveLength(1)
        expect(store.listSideEffects(runId).filter(effect => effect.intentId === intent.id
          && ['COMMITTED', 'FAILED'].includes(effect.status))).toHaveLength(1)
        expect(store.listSideEffects(runId).find(effect => effect.intentId === intent.id
          && ['COMMITTED', 'FAILED'].includes(effect.status))?.status).toBe(winningStatus)
        expect(store.listAuditEvents(runId).filter(event => event.action === 'action-result')).toHaveLength(1)
      } finally {
        store.close()
      }
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill()
      await Promise.allSettled(exits)
    }
  })

  it('reconciles an exactly applied promotion after Host restart and requires Gate authorization', async () => {
    const root = tempRoot('promotion-recovery')
    const stateRoot = tempRoot('promotion-recovery-state')
    const worktreeRoot = tempRoot('promotion-recovery-worktrees')
    await createGitRepo(root)
    const config = {
      dataRoot: stateRoot, worktreeRoot, jev: { mode: 'off' as const },
      maven: { executable: 'fake-mvn', buildArgs: ['package'], testArgs: ['test'] },
      routes: { implement: { candidates: [{ kind: 'command' as const, provider: 'recovery-editor', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] } },
    }
    const runtime = new AutoDevRuntime(new Context(), config, { commands: new FakeMavenExecutor(), decisions: trustedTestDecisions() })
    runtime.registerProvider({
      name: 'recovery-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true,
      run: async (request) => {
        writeFileSync(join(request.cwd, 'RECOVERY_PROOF.txt'), 'recover candidate\n')
        return { provider: request.provider, status: 'completed', output: 'candidate created' }
      },
    })
    let runId: string | undefined
    try {
      const created = await runtime.create({ repoPath: root, request: 'create a recovery proof file' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      runId = created.run.id
      const verified = await runtime.run(runId)
      expect(verified.run.status).toBe('VERIFY')
      const candidate = verified.candidate
      if (candidate?.diffArtifactId === undefined) throw new Error('candidate diff artifact is missing')
      const patch = runtime.store.getArtifact(candidate.diffArtifactId)
      if (patch === undefined) throw new Error('candidate patch is missing')
      const apply = await new HarnessCommandExecutor().run(['git', 'apply', '--binary', patch.path], root)
      expect(apply.exitCode).toBe(0)

      const intent = runtime.sideEffects.plan({ runId, kind: 'git-promotion', target: `${root}@${created.run.baseCommit}#${candidate.id}`, risk: 'destructive' })
      runtime.sideEffects.authorize(intent.id, 'simulated in-flight Host promotion')
      runtime.sideEffects.start(intent.id)
      runtime.store.updateRun(runId, current => ({ ...current, status: 'PROMOTING' }))
    } finally {
      runtime.store.close()
    }
    if (runId === undefined) throw new Error('recovery Run was not created')

    const recovered = new AutoDevRuntime(new Context(), config, { commands: new FakeMavenExecutor(), decisions: new DecisionCoordinator({ config: { mode: 'off' } }) })
    try {
      const interrupted = recovered.snapshot(runId)
      expect(interrupted.run.status).toBe('NEEDS_INTERVENTION')
      expect(interrupted.gates.at(-1)?.options).toContain('promote')
      expect(interrupted.actionIntents.some(item => item.kind === 'git-promotion' && item.status === 'UNKNOWN')).toBe(true)
      await expect(recovered.promote(runId)).rejects.toThrow(/explicitly resolved Human Gate/)

      const reconciled = await recovered.remoteResolveGate({ runId, action: 'promote' }, new AbortController().signal)
      expect(reconciled.run.status).toBe('PROMOTED')
      expect(reconciled.evidence.some(item => item.type === 'PROMOTION' && item.status === 'PASS' && item.summary.includes('already applied exactly'))).toBe(true)
      expect(readFileSync(join(root, 'RECOVERY_PROOF.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('recover candidate\n')
    } finally {
      recovered.store.close()
    }
  })

  it('freezes and executes the detected Node/pnpm driver through argv in the isolated Worktree', async () => {
    const root = tempRoot('node-driver')
    const stateRoot = tempRoot('node-driver-state')
    const worktreeRoot = tempRoot('node-driver-worktrees')
    await createNodeGitRepo(root)
    const delegate = new HarnessCommandExecutor()
    const commandVectors: string[][] = []
    const commands: CommandExecutor = {
      async run(argv, cwd, options) {
        commandVectors.push([...argv])
        if (argv[0] === 'git') return delegate.run(argv, cwd, options)
        return {
          argv, cwd, exitCode: 0, signal: null, stdout: 'fake node tool ok', stderr: '', timedOut: false, durationMs: 1,
        }
      },
    }
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: stateRoot, worktreeRoot, jev: { mode: 'off' },
      routes: { implement: { candidates: [{ kind: 'command', provider: 'node-editor', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] } },
    }, { commands, decisions: trustedTestDecisions() })
    runtime.registerProvider({
      name: 'node-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true,
      run: async (request) => {
        writeFileSync(join(request.cwd, 'NODE_DRIVER_OK.txt'), 'implemented\n')
        return { provider: request.provider, status: 'completed', output: 'created driver fixture' }
      },
    })
    try {
      const created = await runtime.create({ repoPath: root, request: 'create a Node driver proof file' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      expect(created.plan?.buildDriverId).toBe('node')
      expect(created.plan?.nodes.find(node => node.kind === 'build')?.description).toContain('node build')
      const verified = await runtime.run(created.run.id)
      expect(verified.run.status).toBe('VERIFY')
      const nodeCommands = commandVectors.filter(argv => process.platform === 'win32'
        ? argv[0] === process.execPath && /pnpm[\\/]bin[\\/]pnpm\.(?:cjs|mjs)$/.test(argv[1] ?? '')
        : argv[0]?.startsWith('pnpm'))
      expect(nodeCommands.map(argv => argv.slice(process.platform === 'win32' ? 2 : 1))).toEqual([['run', 'build'], ['test']])
      expect(verified.evidence.find(item => item.type === 'BUILD')?.status).toBe('PASS')
      expect(verified.evidence.find(item => item.type === 'TEST')?.status).toBe('PASS')
    } finally {
      runtime.store.close()
    }
  })

  it('blocks unresolved Concept ambiguity before invoking a Provider', async () => {
    const root = tempRoot('concept-ambiguity-gate')
    const stateRoot = tempRoot('concept-ambiguity-state')
    const worktreeRoot = tempRoot('concept-ambiguity-worktrees')
    await createGitRepo(root)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: stateRoot,
      worktreeRoot,
      jev: { mode: 'off' },
      routes: {
        implement: {
          candidates: [{ kind: 'command', provider: 'ambiguity-editor', traits: ['code-edit', 'local-workspace'] }],
          requiredTaskTraits: ['code-edit', 'local-workspace'],
        },
      },
    }, { commands: new FakeMavenExecutor(), decisions: trustedTestDecisions() })
    const provider = vi.fn(async (request: Parameters<NonNullable<Parameters<typeof runtime.registerProvider>[0]['run']>>[0]) => {
      writeFileSync(join(request.cwd, 'UNEXPECTED.txt'), 'provider must not run\n')
      return { provider: request.provider, status: 'completed' as const, output: 'unexpected' }
    })
    runtime.registerProvider({
      name: 'ambiguity-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true, run: provider,
    })
    try {
      const scope = { projectKey: root }
      runtime.concepts.observe({
        scope, key: 'refund', name: 'Refund', definition: 'Return money to the customer',
        target: 'captured payment', effect: 'reverse the captured amount', evidenceSummary: 'initial observed meaning',
      })
      const conflict = runtime.concepts.observe({
        scope, key: 'refund', name: 'Refund', definition: 'Issue store credit',
        target: 'customer account', effect: 'issue store credit', evidenceSummary: 'conflicting observed meaning',
      })
      expect(conflict.observation.relationship).toBe('AMBIGUOUS')

      const created = await runtime.create({ repoPath: root, request: 'implement refund handling' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const gated = await runtime.run(created.run.id)
      expect(gated.run.status).toBe('NEEDS_INTERVENTION')
      expect(gated.gates.at(-1)?.reason).toContain('unresolved Business Concept observations')
      expect(gated.candidate).toBeUndefined()
      expect(provider).not.toHaveBeenCalled()
      expect(gated.nodes.some(node => node.status === 'RUNNING')).toBe(false)
    } finally {
      runtime.store.close()
    }
  })

  it('opens a replan Gate before execution when confirmed-assumption Evidence fails', async () => {
    const root = tempRoot('assumption-conflict-gate')
    const stateRoot = tempRoot('assumption-conflict-state')
    const worktreeRoot = tempRoot('assumption-conflict-worktrees')
    await createGitRepo(root)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: stateRoot, worktreeRoot, jev: { mode: 'off' },
      routes: { implement: { candidates: [{ kind: 'command', provider: 'assumption-editor', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] } },
    }, { commands: new FakeMavenExecutor(), decisions: trustedTestDecisions() })
    const provider = vi.fn(async (request: Parameters<NonNullable<Parameters<typeof runtime.registerProvider>[0]['run']>>[0]) => {
      writeFileSync(join(request.cwd, 'SHOULD_NOT_RUN.txt'), 'blocked\n')
      return { provider: request.provider, status: 'completed' as const, output: 'unexpected execution' }
    })
    runtime.registerProvider({ name: 'assumption-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true, run: provider })
    try {
      const created = await runtime.create({ repoPath: root, request: 'make an assumption-dependent change' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const baseline = created.evidence.find(item => item.type === 'REPOSITORY_BASELINE')
      if (baseline === undefined) throw new Error('Run baseline Evidence is missing')
      const assumption = runtime.semantics.raiseAssumption({
        scope: created.run.scope ?? { projectKey: root }, runId: created.run.id,
        ...(created.plan?.id === undefined ? {} : { planId: created.plan.id }),
        statement: 'the initial repository behavior is correct', evidenceIds: [baseline.id],
      })
      runtime.semantics.resolveAssumption(assumption.id, 'CONFIRMED', 'Confirmed against the captured baseline')
      runtime.store.saveEvidence({ ...baseline, status: 'FAIL', summary: 'new verification contradicts the assumption' })

      const gated = await runtime.run(created.run.id)
      expect(gated.run.status).toBe('NEEDS_INTERVENTION')
      expect(gated.assumptions.find(item => item.id === assumption.id)?.status).toBe('INVALIDATED')
      expect(gated.gates.at(-1)?.options).toContain('replan')
      expect(gated.gates.at(-1)?.reason).toContain('assumptions no longer have current supporting Evidence')
      expect(provider).not.toHaveBeenCalled()
      expect(gated.nodes.some(node => node.status === 'RUNNING')).toBe(false)
    } finally {
      runtime.store.close()
    }
  })

  it('requires Playbook fit, then uses human correction in a new Plan before continuing', async () => {
    const root = tempRoot('playbook-fit-gate')
    const stateRoot = tempRoot('playbook-fit-state')
    const worktreeRoot = tempRoot('playbook-fit-worktrees')
    await createGitRepo(root)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: stateRoot,
      worktreeRoot,
      jev: { mode: 'off' },
      maven: { executable: 'fake-mvn', buildArgs: ['package'], testArgs: ['test'] },
      routes: {
        implement: {
          candidates: [{ kind: 'command', provider: 'fit-editor', traits: ['code-edit', 'local-workspace'] }],
          requiredTaskTraits: ['code-edit', 'local-workspace'],
        },
      },
    }, { commands: new FakeMavenExecutor(), decisions: trustedTestDecisions() })
    const provider = vi.fn(async (request: Parameters<NonNullable<Parameters<typeof runtime.registerProvider>[0]['run']>>[0]) => {
      writeFileSync(join(request.cwd, 'REFUND_IMPLEMENTED.txt'), 'implemented\n')
      return { provider: request.provider, status: 'completed' as const, output: 'created refund fixture' }
    })
    runtime.registerProvider({ name: 'fit-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true, run: provider })
    try {
      const scope = { projectKey: root }
      const concept = runtime.concepts.correct({
        scope, key: 'refund', name: 'Refund', definition: 'Reverse a captured customer payment',
        target: 'store credit balance', effect: 'issue goodwill credit', evidenceSummary: 'human-confirmed current behavior',
        resolution: 'seed the test with a known but Playbook-incompatible meaning',
      })
      const playbook = runtime.playbooks.create({
        scope, key: 'refund-flow', name: 'Refund workflow', purpose: 'Refund handling',
        targets: ['captured customer payment'], effects: ['reverse captured amount'],
        conceptKeys: ['refund'], steps: ['verify capture', 'reverse captured amount'],
      })
      runtime.playbooks.activate(playbook.id)

      expect(runtime.concepts.search(scope, 'implement refund handling').map(item => item.id)).toContain(concept.id)
      expect(runtime.playbooks.search(scope, 'implement refund handling').map(item => item.id)).toContain(playbook.id)
      const created = await runtime.create({ repoPath: root, request: 'implement refund handling' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      expect(created.plan?.playbookIds).toContain(playbook.id)
      const blocked = await runtime.run(created.run.id)
      expect(blocked.playbookFits.at(-1)?.outcome).toBe('MISMATCH')
      expect(blocked.run.status).toBe('NEEDS_INTERVENTION')
      expect(blocked.gates.at(-1)?.reason).toContain('does not fit established Concept refund')
      expect(runtime.store.listPlaybookFits(created.run.id).at(-1)?.outcome).toBe('MISMATCH')
      expect(provider).not.toHaveBeenCalled()

      const corrected = runtime.remoteCorrectConcept({
        runId: created.run.id, key: 'refund', name: 'Refund', definition: 'Reverse the captured customer payment',
        target: 'captured customer payment', effect: 'reverse captured amount',
        evidenceSummary: 'product owner correction', resolution: 'Use the refund Playbook definition for this project',
      })
      expect(corrected.conceptObservations.at(-1)).toMatchObject({ relationship: 'HUMAN_CORRECTION', runId: created.run.id })

      const resumed = await runtime.remoteResolveGate({ runId: created.run.id, action: 'replan' }, new AbortController().signal)
      expect(resumed.run.status).toBe('DRAFT')
      expect(provider).not.toHaveBeenCalled()
      expect(resumed.plan).toMatchObject({ version: 2, conceptIds: [concept.id], playbookIds: [playbook.id] })
      await expect(runtime.run(created.run.id)).rejects.toThrow(/has not been explicitly approved/)
      runtime.remoteApprovePlan({ runId: created.run.id, planId: resumed.plan!.id })
      const rerun = await runtime.run(created.run.id)
      expect(rerun.run.status).toBe('VERIFY')
      expect(provider).toHaveBeenCalledTimes(1)
      expect(runtime.store.listPlaybookFits(created.run.id).at(-1)?.outcome).toBe('MATCH')
    } finally {
      runtime.store.close()
    }
  })

  it('turns a low Jev quality score into a review gate without changing deterministic passes', async () => {
    const root = tempRoot('quality-gate')
    const stateRoot = tempRoot('quality-gate-state')
    const worktreeRoot = tempRoot('quality-gate-worktrees')
    await createGitRepo(root)
    const decisions = new DecisionCoordinator({
      config: { mode: 'required', minConfidence: { quality: 0.9 } },
      provider: {
        async evaluate(request) {
          if (request.purpose === 'agent-route') {
            return { source: 'jev', modelVersion: 'test', answers: [{ questionId: 'provider', kind: 'choice', value: 'quality-editor', probability: 1 }] }
          }
          if (request.purpose === 'quality') {
            return {
              source: 'jev', modelVersion: 'test', answers: [
                { questionId: 'score', kind: 'score', value: 40, probability: 1 },
                { questionId: 'needs_review', kind: 'noul', value: false, probability: 1 },
              ],
            }
          }
          return { source: 'jev', modelVersion: 'test', answers: [{ questionId: 'completion', kind: 'choice', value: 'ready_for_verify', probability: 1 }] }
        },
      },
    })
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: stateRoot,
      worktreeRoot,
      jev: { mode: 'required' },
      routes: {
        implement: {
          candidates: [{ kind: 'command', provider: 'quality-editor', traits: ['code-edit', 'local-workspace'] }],
          requiredTaskTraits: ['code-edit', 'local-workspace'],
        },
      },
    }, { commands: new FakeMavenExecutor(), decisions })
    runtime.registerProvider({
      name: 'quality-editor',
      kind: 'command',
      traits: ['code-edit', 'local-workspace'],
      workspaceCwd: true,
      run: async (request) => {
        writeFileSync(join(request.cwd, 'QUALITY_GATE.txt'), 'implemented\n')
        return { provider: request.provider, status: 'completed', output: 'created quality fixture' }
      },
    })
    try {
      const created = await runtime.create({ repoPath: root, request: 'create a quality gate fixture' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const gated = await runtime.run(created.run.id)
      expect(gated.run.status).toBe('NEEDS_INTERVENTION')
      expect(gated.evidence.find(item => item.type === 'BUILD')?.status).toBe('PASS')
      expect(gated.evidence.find(item => item.type === 'TEST')?.status).toBe('PASS')
      expect(gated.evidence.find(item => item.type === 'REVIEW')?.status).toBe('WARN')
      expect(gated.gates.at(-1)?.reason).toContain('score 40/100')
    } finally {
      runtime.store.close()
    }
  })
})
