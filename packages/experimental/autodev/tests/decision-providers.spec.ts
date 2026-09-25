import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandExecutor, CommandResult } from '../src/command.ts'
import { HarnessCommandExecutor } from '../src/command.ts'
import { OllamaDecisionProvider } from '../src/ollama-decision.ts'
import { SubagentDecisionProvider } from '../src/subagent-decision.ts'
import { AutoDevRuntime } from '../src/runtime.ts'
import { DecisionCoordinator, questionsFor } from '../src/jev.ts'

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

function intentAnswer(mode: string, probability: number): string {
  return JSON.stringify({ answers: [{ questionId: 'mode', kind: 'choice', value: mode, probability }] })
}

describe('AutoDev local decision providers', () => {
  it('parses the native Ollama chat response and sends a bounded JSON-mode request', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(request.model).toBe('qwen3:8b-fast')
      expect(request.format).toBe('json')
      expect(request.stream).toBe(false)
      return new Response(JSON.stringify({
        model: 'qwen3:8b-fast',
        message: { role: 'assistant', content: intentAnswer('DEBUG', 0.94) },
        prompt_eval_count: 17,
        eval_count: 9,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new OllamaDecisionProvider()
    const result = await provider.evaluate({
      purpose: 'intent',
      state: { request: 'Find and fix an intermittent null reference' },
      questions: questionsFor('intent'),
      signal: new AbortController().signal,
    })

    expect(result.source).toBe('local-model')
    expect(result.modelVersion).toBe('qwen3:8b-fast')
    expect(result.answers[0]?.value).toBe('DEBUG')
    expect(result.usage).toEqual({ inputTokens: 17, outputTokens: 9 })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('keeps Jev disabled while using Ollama for automatic mode selection in the real Runtime', async () => {
    const repo = tempRoot('ollama-intent-repo')
    const state = tempRoot('ollama-intent-state')
    const worktrees = tempRoot('ollama-intent-worktrees')
    await createGitRepo(repo)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      model: 'qwen3:8b-fast', message: { role: 'assistant', content: intentAnswer('DEBUG', 0.93) },
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: state,
      worktreeRoot: worktrees,
      jev: { mode: 'off' },
      decisions: { mode: 'required', ollama: { model: 'qwen3:8b-fast' }, useJev: false },
    }, { commands: new TestCommandExecutor() })
    try {
      const created = await runtime.create({ repoPath: repo, request: 'Find and fix an intermittent null reference' })
      expect(created.run.mode).toBe('DEBUG')
      const intent = runtime.store.listDecisions(created.run.id).find(item => 'purpose' in item && item.purpose === 'intent')
      expect(intent).toMatchObject({ source: 'local-model', providerId: 'ollama:qwen3:8b-fast', trustedFor: ['intent', 'agent-route', 'failure-action', 'completion'] })
      expect(fetchMock).toHaveBeenCalledOnce()

      const explicit = await runtime.create({ repoPath: repo, mode: 'REVIEW', request: 'Please review this repository' })
      expect(explicit.run.mode).toBe('REVIEW')
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      runtime.store.close()
    }
  })

  it('escalates low-confidence local intent through DSH Subagent in an empty temporary directory', async () => {
    const parent = { id: 'test-parent-agent' }
    let observedCwd: string | undefined
    let observedParent: unknown
    const subagents = {
      getProvider: () => ({ capabilities: { workspaceCwd: true, toolFilter: true } }),
      start: async (_name: string, options: Record<string, unknown>) => {
        observedCwd = options.workspaceCwd as string
        observedParent = options.parent
        expect(options.toolFilter).toEqual({ allow: [] })
        expect(readdirSync(observedCwd)).toEqual([])
        return {
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: intentAnswer('IMPACT', 0.96) }] }),
          dispose: async () => undefined,
        }
      },
    } as unknown as SubagentRuntime
    const local = {
      async evaluate(request: { questions: readonly { id: string; type: 'choice' | 'score' | 'noul'; choices?: readonly string[] }[] }) {
        return {
          source: 'local-model' as const,
          modelVersion: 'qwen3:8b-fast',
          answers: request.questions.map(question => ({ questionId: question.id, kind: question.type, value: 'EXPLORE', probability: 0.3 })),
        }
      },
    }
    const escalation = new SubagentDecisionProvider(subagents, ['codex'])
    const coordinator = new DecisionCoordinator({
      config: { mode: 'required', minConfidence: { intent: 0.72 } },
      includeJevProvider: false,
      providers: [
        { id: 'ollama:qwen3:8b-fast', provider: local, priority: 100, trustedFor: ['intent'] },
        { id: 'dsh-subagents', provider: escalation, priority: 50, trustedFor: ['intent'] },
      ],
    })

    const result = await coordinator.evaluate(
      'intent', { request: 'Trace dependencies and affected modules' }, new AbortController().signal,
      questionsFor('intent'), { parentAgent: parent },
    )

    expect(result.source).toBe('subagent')
    expect(result.providerId).toBe('codex')
    expect(result.trustedFor).toEqual(['intent'])
    expect(result.answers[0]?.value).toBe('IMPACT')
    expect(observedParent).toBe(parent)
    expect(observedCwd).toBeDefined()
    expect(existsSync(observedCwd!)).toBe(false)
  })

  it('fails closed when a configured escalation has no live parent Agent', async () => {
    const subagents = {
      getProvider: () => ({ capabilities: { workspaceCwd: true } }),
      start: vi.fn(),
    } as unknown as SubagentRuntime
    const provider = new SubagentDecisionProvider(subagents, ['codex'])
    await expect(provider.evaluate({
      purpose: 'intent', state: {}, questions: questionsFor('intent'), signal: new AbortController().signal,
    })).rejects.toThrow('requires a live parent Agent')
  })

  it('continues past a high-confidence provider that is not trusted for quality', async () => {
    const local = {
      async evaluate(request: { questions: readonly { id: string; type: 'choice' | 'score' | 'noul' }[] }) {
        return {
          source: 'local-model' as const,
          modelVersion: 'qwen3:8b-fast',
          answers: request.questions.map(question => ({
            questionId: question.id,
            kind: question.type,
            value: question.id === 'score' ? 98 : false,
            probability: 0.99,
          })),
        }
      },
    }
    const trustedReviewer = {
      async evaluate(request: { questions: readonly { id: string; type: 'choice' | 'score' | 'noul' }[] }) {
        return {
          source: 'subagent' as const,
          modelVersion: 'codex-review-fixture',
          answers: request.questions.map(question => ({
            questionId: question.id,
            kind: question.type,
            value: question.id === 'score' ? 91 : false,
            probability: 0.96,
          })),
        }
      },
    }
    const coordinator = new DecisionCoordinator({
      config: { mode: 'required', minConfidence: { quality: 0.9 } },
      includeJevProvider: false,
      providers: [
        { id: 'local-qwen', provider: local, priority: 100 },
        { id: 'trusted-reviewer', provider: trustedReviewer, priority: 50, trustedFor: ['quality'] },
      ],
    })

    const result = await coordinator.evaluate(
      'quality', { candidateDiff: 'bounded patch' }, new AbortController().signal,
      questionsFor('quality'), { requireTrustedForPurpose: true },
    )

    expect(result.source).toBe('subagent')
    expect(result.providerId).toBe('trusted-reviewer')
    expect(result.trustedFor).toEqual(['quality'])
    expect(result.answers.find(answer => answer.questionId === 'score')?.value).toBe(91)
  })
})

describe.skipIf(process.env.DSH_AUTODEV_OLLAMA_E2E !== '1')('live local Ollama smoke', () => {
  it('asks the installed local model for one bounded AutoDev mode decision', async () => {
    const provider = new OllamaDecisionProvider({
      ...(process.env.DSH_AUTODEV_OLLAMA_ENDPOINT === undefined ? {} : { endpoint: process.env.DSH_AUTODEV_OLLAMA_ENDPOINT }),
      model: process.env.DSH_AUTODEV_OLLAMA_MODEL ?? 'qwen3:8b-fast',
      timeoutMs: 120_000,
    })
    const result = await provider.evaluate({
      purpose: 'intent',
      state: { request: '只读梳理这个项目的模块结构和调用关系，不修改代码。' },
      questions: questionsFor('intent'),
      signal: new AbortController().signal,
    })
    expect(result.source).toBe('local-model')
    expect(questionsFor('intent')[0]?.choices).toContain(result.answers[0]?.value)
    expect(result.answers[0]?.probability).toEqual(expect.any(Number))
  }, 150_000)

  it('creates and audits a real AutoDev Run through Ollama while Jev is off', async () => {
    const repo = tempRoot('ollama-live-runtime-repo')
    const state = tempRoot('ollama-live-runtime-state')
    const worktrees = tempRoot('ollama-live-runtime-worktrees')
    await createGitRepo(repo)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: state,
      worktreeRoot: worktrees,
      jev: { mode: 'off' },
      decisions: {
        mode: 'required',
        ollama: {
          ...(process.env.DSH_AUTODEV_OLLAMA_ENDPOINT === undefined ? {} : { endpoint: process.env.DSH_AUTODEV_OLLAMA_ENDPOINT }),
          model: process.env.DSH_AUTODEV_OLLAMA_MODEL ?? 'qwen3:8b-fast',
          timeoutMs: 120_000,
        },
        useJev: false,
        minConfidence: { intent: 0 },
      },
    }, { commands: new TestCommandExecutor() })
    try {
      const created = await runtime.create({ repoPath: repo, request: '只读梳理项目模块和调用关系，不修改任何代码。' })
      expect(['EXPLORE', 'IMPACT']).toContain(created.run.mode)
      expect(runtime.store.listDecisions(created.run.id)).toContainEqual(expect.objectContaining({
        purpose: 'intent', source: 'local-model', providerId: `ollama:${process.env.DSH_AUTODEV_OLLAMA_MODEL ?? 'qwen3:8b-fast'}`,
      }))
    } finally {
      runtime.store.close()
    }
  }, 150_000)
})

async function createGitRepo(root: string): Promise<void> {
  writeFileSync(join(root, 'pom.xml'), '<project/>\n')
  writeFileSync(join(root, 'README.md'), 'decision provider fixture\n')
  mkdirSync(join(root, '.mvn', 'wrapper'), { recursive: true })
  writeFileSync(join(root, '.mvn', 'wrapper', 'maven-wrapper.jar'), 'fixture')
  const executor = new TestCommandExecutor()
  for (const args of [
    ['git', 'init', '-q'],
    ['git', 'config', 'user.email', 'autodev-test@example.invalid'],
    ['git', 'config', 'user.name', 'AutoDev Test'],
    ['git', 'add', '.'],
    ['git', 'commit', '-m', 'initial'],
  ]) {
    const result = await executor.run(args, root)
    if (result.exitCode !== 0) throw new Error(`${args.join(' ')} failed: ${result.stderr}`)
  }
}

class TestCommandExecutor implements CommandExecutor {
  private readonly delegate = new HarnessCommandExecutor()

  run(...args: Parameters<CommandExecutor['run']>): ReturnType<CommandExecutor['run']> {
    const [argv, cwd] = args
    if (['java', 'java.exe', 'mvn', 'mvn.exe', 'fake-mvn'].includes(argv[0] ?? '')) {
      return Promise.resolve({ argv, cwd, exitCode: 0, signal: null, stdout: 'fixture', stderr: '', timedOut: false, durationMs: 1 } satisfies CommandResult)
    }
    return this.delegate.run(...args)
  }
}
