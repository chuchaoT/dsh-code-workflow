import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandExecutor, CommandResult } from '../src/command.ts'
import { HarnessCommandExecutor } from '../src/command.ts'
import type { Run } from '../src/contracts.ts'
import { AutoDevRuntime } from '../src/runtime.ts'
import { AutoDevStore } from '../src/store.ts'
import { DecisionCoordinator, HttpJevProvider, JevUnavailableError, questionsFor } from '../src/jev.ts'
import { AgentProtocol, normalizeSignal, type AgentContext, type AgentTask } from '../src/protocol.ts'
import { commandProvider, ProviderRouter } from '../src/router.ts'
import { defaultVerificationChecks, evaluateVerification } from '../src/verification.ts'

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
  const context: AgentContext = {
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
          provider: 'protocol-fixture',
          status: 'completed',
          output: 'done',
          signals: [{ type: 'FutureSignal', detail: 'preserve me as unknown' }],
        }
      },
    })

    const result = await protocol.execute('protocol-fixture', { task, context, signal: new AbortController().signal })
    expect(result.output).toBe('done')
    expect(result.signals.map(item => item.sequence)).toEqual([1, 2])
    expect(result.signals[0]?.signal.type).toBe('AssumptionRaised')
    expect(result.signals[1]?.signal).toMatchObject({ type: 'UnknownSignal', name: 'FutureSignal' })
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
    const report = evaluateVerification(checks, [], new Date().toISOString())
    expect(report.status).toBe('UNKNOWN')
    expect(report.results.every(result => result.status === 'UNKNOWN')).toBe(true)
  })
})

describe('dynamic Provider routing', () => {
  it('delegates official Codex/Claude route names to Harness Subagent Runtime', async () => {
    const start = vi.fn(async (_name: string, _request: unknown) => ({
      result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'agent completed' }] }),
      dispose: vi.fn(async () => {}),
    }))
    const subagents = { list: () => ['codex', 'claude-code'], start } as unknown as SubagentRuntime
    const router = new ProviderRouter({
      decisions: new DecisionCoordinator({ config: { mode: 'off' } }),
      subagents,
    })
    const signal = new AbortController().signal
    const selection = await router.select(undefined, undefined, 'agent-route', 'implement', {}, ['code-edit', 'local-workspace'], signal)
    expect(selection.candidate?.provider).toBe('codex')
    const result = await router.invoke(selection.candidate as NonNullable<typeof selection.candidate>, {
      request: 'use the parent working directory', acceptanceCriteria: [], cwd: 'C:/worktree', signal, parentAgent: { id: 'parent' },
    })
    expect(result).toMatchObject({ provider: 'codex', status: 'completed', output: 'agent completed' })
    expect(start).toHaveBeenCalledWith('codex', expect.objectContaining({ parent: { id: 'parent' }, signal }))
    const prompt = (start.mock.calls[0]?.[1] as { prompt?: readonly { text?: string }[] } | undefined)?.prompt?.[0]?.text
    expect(prompt).toContain('C:/worktree')
  })

  it('selects and invokes an asynchronously available custom provider', async () => {
    const root = tempRoot('router')
    const store = new AutoDevStore(root)
    const router = new ProviderRouter({
      store,
      decisions: new DecisionCoordinator({ config: { mode: 'off' } }),
      routes: {
        implement: {
          candidates: [{ kind: 'model', provider: 'ollama', traits: ['code-edit', 'local-workspace'] }],
          requiredTaskTraits: ['code-edit', 'local-workspace'],
        },
      },
    })
    const dispose = router.register({
      name: 'ollama',
      kind: 'model',
      traits: ['code-edit', 'local-workspace'],
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
})

describe('restart recovery', () => {
  it('turns an interrupted node into an explicit Human Gate without retrying it', () => {
    const root = tempRoot('recovery')
    const stateRoot = tempRoot('recovery-state')
    const worktreeRoot = tempRoot('recovery-worktrees')
    const run = { ...sampleRun(root), id: 'run-recovery', status: 'BUILDING' as const, worktreePath: join(worktreeRoot, 'run-recovery') }
    const firstStore = new AutoDevStore(stateRoot)
    firstStore.createRun(run)
    firstStore.createNode({
      id: 'node-recovery', runId: run.id, planId: 'plan-recovery', nodeId: 'build', attempt: 1, status: 'RUNNING',
    })
    firstStore.close()

    const runtime = new AutoDevRuntime(new Context(), { dataRoot: stateRoot, worktreeRoot })
    try {
      const snapshot = runtime.snapshot(run.id)
      expect(snapshot.run.status).toBe('NEEDS_INTERVENTION')
      expect(snapshot.gates.at(-1)?.options).not.toContain('retry')
      expect(snapshot.nodes.at(-1)?.status).toBe('UNKNOWN')
      expect(snapshot.evidence.at(-1)?.summary).toContain('Host restarted')
    } finally {
      runtime.store.close()
    }
  })

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
    if (argv[0] === 'java' || argv[0] === 'mvn' || argv[0] === 'fake-mvn') {
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
      decisions: new DecisionCoordinator({ config: { mode: 'off' } }),
    })
    runtime.registerProvider({
      name: 'crashing-agent',
      kind: 'command',
      traits: ['code-edit', 'local-workspace'],
      run: async (request) => {
        writeFileSync(join(request.cwd, 'UNKNOWN_SIDE_EFFECT.txt'), 'changed before crash\n')
        return { provider: request.provider, status: 'error', output: 'crashed after editing', diagnostic: 'child process lost' }
      },
    })
    try {
      const created = await runtime.create({ repoPath: root, request: 'run an unsafe provider' })
      const failed = await runtime.run(created.run.id)
      expect(failed.run.status).toBe('NEEDS_INTERVENTION')
      expect(failed.nodes.find(node => node.nodeId === 'implement')?.status).toBe('UNKNOWN')
      expect(failed.gates.at(-1)?.options).not.toContain('retry')
    } finally {
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
      decisions: new DecisionCoordinator({ config: { mode: 'off' } }),
    })
    runtime.registerProvider({
      name: 'fake-editor',
      kind: 'command',
      traits: ['code-edit', 'local-workspace'],
      run: async (request) => {
        request.emitSignal?.({ type: 'EvidenceProduced', summary: 'fixture implementation output' })
        writeFileSync(join(request.cwd, 'AUTO_DEV_OK.txt'), 'implemented\n')
        return { provider: request.provider, status: 'completed', output: 'created AUTO_DEV_OK.txt' }
      },
    })

    try {
      const created = await runtime.create({ repoPath: root, request: 'create a proof file', acceptanceCriteria: ['file exists'] })
      expect(created.run.status).toBe('READY')
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

      const promoted = await runtime.promote(created.run.id)
      expect(promoted.run.status).toBe('PROMOTED')
      expect(readFileSync(join(root, 'AUTO_DEV_OK.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('implemented\n')
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
      run: async (request) => {
        writeFileSync(join(request.cwd, 'QUALITY_GATE.txt'), 'implemented\n')
        return { provider: request.provider, status: 'completed', output: 'created quality fixture' }
      },
    })
    try {
      const created = await runtime.create({ repoPath: root, request: 'create a quality gate fixture' })
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
