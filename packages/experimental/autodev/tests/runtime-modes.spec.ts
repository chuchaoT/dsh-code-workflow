import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessCommandExecutor, type CommandExecutor, type CommandResult } from '../src/command.ts'
import { GitManager } from '../src/git.ts'
import { AutoDevRuntime } from '../src/runtime.ts'
import { AUTODEV_MODES, classifyAutoDevMode, createModePlanNodes, isReadOnlyMode, resolveAutoDevMode } from '../src/mode.ts'
import { trustedTestDecisions } from './harness.ts'

const roots: string[] = []
const commands = new HarnessCommandExecutor()

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-autodev-${label}-`))
  roots.push(root)
  return root
}

async function git(root: string, ...args: string[]): Promise<CommandResult> {
  const result = await commands.run(['git', ...args], root)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result
}

async function createCommittedRepository(root: string, includeMaven = false): Promise<void> {
  await git(root, 'init', '--quiet')
  writeFileSync(join(root, 'README.md'), 'fixture repository\n')
  if (includeMaven) writeFileSync(join(root, 'pom.xml'), '<project/>\n')
  await git(root, 'add', '--all')
  await git(root, '-c', 'user.name=AutoDev Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--quiet', '-m', 'fixture baseline')
}

class FakeMavenCommands implements CommandExecutor {
  private readonly delegate = new HarnessCommandExecutor()

  async run(argv: readonly string[], cwd: string, options?: Parameters<CommandExecutor['run']>[2]): Promise<CommandResult> {
    if (argv[0] === 'fake-mvn') {
      return { argv, cwd, exitCode: 0, signal: null, stdout: 'fixture Maven check passed', stderr: '', timedOut: false, durationMs: 1 }
    }
    return await this.delegate.run(argv, cwd, options)
  }
}

describe('AutoDev modes and greenfield repositories', () => {
  it('bounds CodeBuddy by the Agent timeout rather than the shorter command timeout', async () => {
    const workspace = tempRoot('codebuddy-agent-timeout')
    const entry = join(workspace, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy')
    mkdirSync(join(workspace, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin'), { recursive: true })
    writeFileSync(entry, '')
    const originalPath = process.env.PATH
    process.env.PATH = `${workspace}${delimiter}${originalPath ?? ''}`

    const agentTimeoutMs = 12_345
    let observedTimeoutMs: number | undefined
    let observedArgv: readonly string[] | undefined
    const providerProgress: unknown[] = []
    let runtime: AutoDevRuntime | undefined
    const fakeCodeBuddyCommands: CommandExecutor = {
      async run(argv, cwd, options) {
        if (argv[0] === process.execPath && argv[1] === entry) {
          observedTimeoutMs = options?.timeoutMs
          observedArgv = argv
          const stdout = '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Working in the fixture."}}}\n{"type":"result","subtype":"success","is_error":false,"result":"fixture completed"}\n'
          options?.onOutput?.('stdout', stdout)
          return { argv, cwd, exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, durationMs: 1 }
        }
        return await commands.run(argv, cwd, options)
      },
    }

    try {
      runtime = new AutoDevRuntime(new Context(), {
        dataRoot: join(workspace, 'state'),
        worktreeRoot: join(workspace, 'worktrees'),
        agentTimeoutMs,
        commandTimeoutMs: 500,
        routes: {
          implement: {
            candidates: [],
            requiredTaskTraits: ['code-edit', 'local-workspace'],
          },
        },
      }, { decisions: trustedTestDecisions(), commands: fakeCodeBuddyCommands })

      const signal = new AbortController().signal
      const selection = await runtime.router.select(
        'codebuddy-timeout-fixture', 'implement', 'agent-route', 'implement', {}, ['code-edit', 'local-workspace'], signal,
      )
      expect(selection.candidate?.provider).toBe('codebuddy')
      const result = await runtime.router.invoke(selection.candidate!, {
        request: 'Add one focused regression test',
        acceptanceCriteria: [],
        cwd: workspace,
        signal,
        onProgress: event => providerProgress.push(event),
      })

      expect(result).toMatchObject({ provider: 'codebuddy', status: 'completed' })
      expect(observedTimeoutMs).toBe(agentTimeoutMs)
      expect(observedArgv).toContain('-y')
      expect(observedArgv).toContain('--tools')
      expect(observedArgv).toContain('--allowedTools')
      expect(observedArgv).toContain('stream-json')
      expect(observedArgv).toContain('--include-partial-messages')
      expect(observedArgv).toContain('Read,Edit,Write,Glob,Grep')
      expect(observedArgv).not.toContain('Bash')
      expect(providerProgress).toContainEqual({ type: 'assistant-delta', text: 'Working in the fixture.' })
      expect(observedArgv).not.toContain('--dangerously-skip-permissions')
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      runtime?.store.close()
    }
  })

  it('uses explicit mode over classification and defaults ambiguous requests to DEV', () => {
    expect(resolveAutoDevMode('DEV', 'review this migration').mode).toBe('DEV')
    expect(resolveAutoDevMode('AUTO', 'please review the code').mode).toBe('REVIEW')
    expect(classifyAutoDevMode('修复偶发空指针并补充回归测试')).toBe('DEBUG')
    expect(classifyAutoDevMode('只补充回归测试，不修改功能代码')).toBe('TEST')
    expect(classifyAutoDevMode('新增用户登录能力')).toBe('DEV')
  })

  it('executes all nine modes through isolated Worktrees with mode-specific Agent stages and verification', async () => {
    const workspace = tempRoot('all-mode-e2e')
    const expectedAgentKinds: Record<(typeof AUTODEV_MODES)[number], readonly string[]> = {
      EXPLORE: ['analyze'],
      IMPACT: ['impact'],
      DEV: ['implement'],
      DEBUG: ['analyze', 'implement'],
      DATABASE: ['impact', 'implement'],
      REFACTOR: ['analyze', 'implement'],
      TEST: ['analyze', 'implement'],
      REVIEW: ['review'],
      RELEASE: ['release'],
    }

    for (const mode of AUTODEV_MODES) {
      const repo = join(workspace, mode.toLowerCase(), 'repository')
      const dataRoot = join(workspace, mode.toLowerCase(), 'state')
      const worktreeRoot = join(workspace, mode.toLowerCase(), 'worktrees')
      mkdirSync(repo, { recursive: true })
      await git(repo, 'init', '--quiet')
      writeFileSync(join(repo, 'package.json'), JSON.stringify({
        name: `autodev-${mode.toLowerCase()}-fixture`,
        private: true,
        scripts: { build: 'node --check app.js', test: 'node --test' },
      }, null, 2))
      writeFileSync(join(repo, 'app.js'), 'function value() { return 42 }\nmodule.exports = { value }\n')
      writeFileSync(join(repo, 'app.test.js'), 'const { test } = require("node:test"); const assert = require("node:assert/strict"); const { value } = require("./app.js"); test("fixture baseline", () => assert.equal(value(), 42));\n')
      await git(repo, 'add', '--all')
      await git(repo, '-c', 'user.name=AutoDev Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--quiet', '-m', 'fixture baseline')

      const runtime = new AutoDevRuntime(new Context(), {
        dataRoot,
        worktreeRoot,
        routes: {
          review: { candidates: [{ kind: 'command', provider: 'claude-code', traits: ['read-only'] }], requiredTaskTraits: ['read-only'] },
          implement: { candidates: [{ kind: 'command', provider: 'codex', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] },
        },
      }, { decisions: trustedTestDecisions() })
      const invoked: string[] = []
      runtime.registerProvider({
        name: 'claude-code', kind: 'command', traits: ['read-only'], workspaceCwd: true,
        async run(request) {
          invoked.push(`${request.task?.nodeId}:${request.task?.kind}:${request.provider}`)
          expect(request.cwd).toContain(worktreeRoot)
          expect(request.task?.kind).not.toBe('implement')
          return {
            provider: request.provider,
            status: 'completed',
            output: mode === 'REVIEW' ? '{"verdict":"PASS","findings":[]}' : `Read-only ${mode} analysis completed`,
          }
        },
      })
      runtime.registerProvider({
        name: 'codex', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true,
        async run(request) {
          invoked.push(`${request.task?.nodeId}:${request.task?.kind}:${request.provider}`)
          expect(request.cwd).toContain(worktreeRoot)
          expect(request.task?.kind).toBe('implement')
          if (mode === 'TEST') {
            mkdirSync(join(request.cwd, 'tests'), { recursive: true })
            writeFileSync(join(request.cwd, 'tests', 'mode-regression.test.js'), 'const { test } = require("node:test"); const assert = require("node:assert/strict"); test("AutoDev TEST mode", () => assert.equal(6 * 7, 42));\n')
          } else if (mode === 'DATABASE') {
            mkdirSync(join(request.cwd, 'migrations'), { recursive: true })
            writeFileSync(join(request.cwd, 'migrations', '001-up-down.sql'), '-- up\nCREATE TABLE fixture (id INTEGER PRIMARY KEY);\n-- down\nDROP TABLE fixture;\n')
          } else {
            writeFileSync(join(request.cwd, `autodev-${mode.toLowerCase()}.md`), `Generated by ${mode} mode fixture.\n`)
          }
          return { provider: request.provider, status: 'completed', output: `Applied the ${mode} fixture change` }
        },
      })
      try {
        const planNodes = createModePlanNodes(mode, isReadOnlyMode(mode) ? undefined : 'node')
        expect(planNodes.filter(node => !['build', 'test'].includes(node.kind)).map(node => node.kind)).toEqual(expectedAgentKinds[mode])
        const created = await runtime.create({
          repoPath: repo,
          mode,
          ...(isReadOnlyMode(mode) ? {} : { buildDriver: 'node' as const }),
          request: `Exercise the ${mode} workflow against this fixture project`,
          acceptanceCriteria: ['Every Agent stage runs in an isolated Worktree', 'Verification evidence is captured'],
        })
        expect(created.plan?.nodes.map(node => node.kind)).toEqual(planNodes.map(node => node.kind))
        runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
        const result = await runtime.run(created.run.id)
        expect(result.run.status, `${mode}: ${result.run.lastError ?? result.gates.at(-1)?.reason ?? 'no terminal result'}`).toBe('VERIFY')
        const executedNodes = result.nodes.filter(node => node.planId === created.plan?.id && node.attempt === result.run.attempt)
        expect(executedNodes.map(node => node.status)).toEqual(planNodes.map(() => 'COMPLETED'))
        expect(invoked.map(value => value.split(':')[0])).toEqual(expectedAgentKinds[mode])
        expect(invoked.map(value => value.split(':')[2])).toEqual(expectedAgentKinds[mode].map(nodeId => nodeId === 'implement' ? 'codex' : 'claude-code'))
        expect(result.verifications.at(-1)?.status).toBe('PASS')
        if (!isReadOnlyMode(mode)) {
          expect(result.evidence.find(item => item.type === 'BUILD')?.status).toBe('PASS')
          expect(result.evidence.find(item => item.type === 'TEST')?.status).toBe('PASS')
        }
        expect((await git(repo, 'status', '--porcelain=v1', '--untracked-files=all')).stdout).toBe('')
      } finally {
        runtime.store.close()
      }
    }
  }, 60_000)

  it('runs and promotes in a truly empty unborn repository without Git author config or an initial commit', async () => {
    const repo = tempRoot('greenfield-repo')
    const dataRoot = tempRoot('greenfield-state')
    const worktreeRoot = tempRoot('greenfield-worktrees')
    await git(repo, 'init', '--quiet')
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot, worktreeRoot,
      routes: { implement: { candidates: [{ kind: 'command', provider: 'greenfield-editor', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] } },
    }, { decisions: trustedTestDecisions() })
    runtime.registerProvider({
      name: 'greenfield-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true,
      async run(request) {
        writeFileSync(join(request.cwd, 'index.html'), '<main>hello from an unborn repo</main>\n')
        return { provider: request.provider, status: 'completed', output: 'created a static HTML starting point' }
      },
    })
    try {
      const created = await runtime.create({ repoPath: repo, mode: 'DEV', request: 'Create a tiny HTML starter page' })
      expect(created.run.baselineKind).toBe('unborn')
      expect(created.run.mode).toBe('DEV')
      expect(created.run.modeSource).toBe('explicit')
      expect(created.plan?.nodes.map(node => node.kind)).toEqual(['implement'])
      expect(created.evidence.find(item => item.type === 'ENVIRONMENT')?.status).toBe('WARN')

      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const verified = await runtime.run(created.run.id)
      expect(verified.run.status, JSON.stringify({ lastError: verified.run.lastError, gate: verified.gates.at(-1)?.reason, review: verified.evidence.filter(item => item.type === 'REVIEW'), verification: verified.verifications.at(-1) })).toBe('VERIFY')
      expect(verified.candidate).toBeDefined()
      expect(verified.evidence.find(item => item.type === 'REVIEW')?.status).toBe('PASS')

      const promoted = await runtime.promote(created.run.id)
      expect(promoted.run.status).toBe('PROMOTED')
      expect(readFileSync(join(repo, 'index.html'), 'utf8')).toContain('hello from an unborn repo')
      expect((await commands.run(['git', 'rev-parse', '--verify', 'HEAD'], repo)).exitCode).not.toBe(0)
      expect((await git(repo, 'symbolic-ref', '--quiet', 'HEAD')).stdout.trim()).toMatch(/^refs\/heads\//u)
      expect((await git(repo, 'diff', '--cached', '--exit-code')).exitCode).toBe(0)
      expect((await commands.run(['git', 'config', '--local', '--get', 'user.name'], repo)).exitCode).not.toBe(0)
    } finally {
      runtime.store.close()
    }
  })

  it('runs deterministic Node build and test stages for a greenfield Worktree without touching the empty source repo', async () => {
    const repo = tempRoot('greenfield-node-repo')
    const dataRoot = tempRoot('greenfield-node-state')
    const worktreeRoot = tempRoot('greenfield-node-worktrees')
    await git(repo, 'init', '--quiet')
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot, worktreeRoot,
      routes: { implement: { candidates: [{ kind: 'command', provider: 'greenfield-node-editor', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] } },
    }, { decisions: trustedTestDecisions() })
    runtime.registerProvider({
      name: 'greenfield-node-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true,
      async run(request) {
        expect(request.cwd).toContain(worktreeRoot)
        writeFileSync(join(request.cwd, 'index.html'), '<main>greenfield Node candidate</main>\n')
        writeFileSync(join(request.cwd, 'app.js'), 'document.querySelector("main");\n')
        writeFileSync(join(request.cwd, 'package.json'), JSON.stringify({ private: true, scripts: { build: 'node --check app.js', test: 'node --test' } }))
        writeFileSync(join(request.cwd, 'candidate.test.js'), 'const test = require("node:test"); const assert = require("node:assert/strict"); test("greenfield smoke", () => assert.equal(2 + 2, 4));\n')
        return { provider: request.provider, status: 'completed', output: 'created an offline HTML app and Node built-in test script' }
      },
    })
    try {
      const created = await runtime.create({ repoPath: repo, mode: 'DEV', buildDriver: 'node', request: 'Create a small standalone HTML app with a zero-dependency Node test' })
      expect(created.run.baselineKind).toBe('unborn')
      expect(created.plan?.buildDriverId).toBe('node')
      expect(created.plan?.nodes.map(node => node.kind)).toEqual(['implement', 'build', 'test'])
      expect(created.evidence.find(item => item.type === 'ENVIRONMENT')?.status).toBe('PASS')
      expect((await git(repo, 'status', '--porcelain=v1', '--untracked-files=all')).stdout).toBe('')

      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const verified = await runtime.run(created.run.id)
      expect(verified.run.status, JSON.stringify({ lastError: verified.run.lastError, gate: verified.gates.at(-1)?.reason })).toBe('VERIFY')
      expect(verified.evidence.find(item => item.type === 'BUILD')?.status).toBe('PASS')
      expect(verified.evidence.find(item => item.type === 'TEST')?.status).toBe('PASS')
      expect(verified.verifications.at(-1)?.status).toBe('PASS')

      const promoted = await runtime.promote(created.run.id)
      expect(promoted.run.status).toBe('PROMOTED')
      expect(readFileSync(join(repo, 'index.html'), 'utf8')).toContain('greenfield Node candidate')
      expect(readFileSync(join(repo, 'package.json'), 'utf8')).toContain('"test":"node --test"')
      expect((await commands.run(['git', 'rev-parse', '--verify', 'HEAD'], repo)).exitCode).not.toBe(0)
      expect((await git(repo, 'diff', '--cached', '--exit-code')).exitCode).toBe(0)
    } finally {
      runtime.store.close()
    }
  })

  it('detects an Agent write to the original repo and stops before Build', async () => {
    const repo = tempRoot('source-repo-drift')
    const dataRoot = tempRoot('source-repo-drift-state')
    const worktreeRoot = tempRoot('source-repo-drift-worktrees')
    await git(repo, 'init', '--quiet')
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot, worktreeRoot,
      routes: { implement: { candidates: [{ kind: 'command', provider: 'escaping-editor', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] } },
    }, { decisions: trustedTestDecisions() })
    runtime.registerProvider({
      name: 'escaping-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true,
      async run(request) {
        expect(request.cwd).toContain(worktreeRoot)
        writeFileSync(join(repo, 'outside-worktree.txt'), 'must be detected, not promoted\n')
        return { provider: request.provider, status: 'completed', output: 'reported implementation completion' }
      },
    })
    try {
      const created = await runtime.create({ repoPath: repo, mode: 'DEV', buildDriver: 'node', request: 'Create a small HTML starter' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const stopped = await runtime.run(created.run.id)
      expect(stopped.run.status).toBe('NEEDS_INTERVENTION')
      expect(stopped.candidate).toBeUndefined()
      expect(stopped.evidence.find(item => item.type === 'DRIFT' && item.status === 'FAIL')?.summary)
        .toContain('original repository changed during Agent execution')
      expect(stopped.evidence.some(item => item.type === 'BUILD')).toBe(false)
      expect(readFileSync(join(repo, 'outside-worktree.txt'), 'utf8')).toContain('must be detected')
    } finally {
      runtime.store.close()
    }
  })

  it('records source-repository drift when cancellation interrupts a Provider after an out-of-Worktree write', async () => {
    const repo = tempRoot('source-repo-drift-cancel')
    const dataRoot = tempRoot('source-repo-drift-cancel-state')
    const worktreeRoot = tempRoot('source-repo-drift-cancel-worktrees')
    await git(repo, 'init', '--quiet')
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot, worktreeRoot,
      routes: { implement: { candidates: [{ kind: 'command', provider: 'escaping-cancelled-editor', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] } },
    }, { decisions: trustedTestDecisions() })
    let announceStarted!: () => void
    const started = new Promise<void>((resolve) => { announceStarted = resolve })
    runtime.registerProvider({
      name: 'escaping-cancelled-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true,
      async run(request) {
        expect(request.cwd).toContain(worktreeRoot)
        writeFileSync(join(repo, 'outside-worktree.txt'), 'written before cancellation\n')
        announceStarted()
        return await new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('provider interrupted after source write')), { once: true })
        })
      },
    })
    try {
      const created = await runtime.create({ repoPath: repo, mode: 'DEV', buildDriver: 'node', request: 'Create a small HTML starter' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const controller = new AbortController()
      const running = runtime.run(created.run.id, undefined, controller.signal)
      await started
      await runtime.cancel(created.run.id)

      const stopped = await running
      expect(stopped.run.status).toBe('CANCELLED')
      expect(stopped.nodes.find(item => item.nodeId === 'implement')?.status).toBe('FAILED')
      expect(stopped.actionIntents.find(item => item.kind === 'agent-workspace')?.status).toBe('FAILED')
      expect(stopped.evidence.find(item => item.type === 'DRIFT' && item.status === 'FAIL')?.summary)
        .toContain('original repository changed while the Agent invocation failed')
      expect(stopped.evidence.find(item => item.type === 'SIDE_EFFECT' && item.status === 'FAIL')?.summary)
        .toContain('outside its Worktree')
      expect(stopped.evidence.some(item => item.type === 'BUILD' || item.type === 'TEST')).toBe(false)
      expect(readFileSync(join(repo, 'outside-worktree.txt'), 'utf8')).toContain('written before cancellation')
    } finally {
      await runtime.dispose()
      runtime.store.close()
    }
  })

  it('aborts an Agent at its configured timeout and preserves UNKNOWN without starting Build or Test', async () => {
    const repo = tempRoot('agent-timeout-repo')
    const dataRoot = tempRoot('agent-timeout-state')
    const worktreeRoot = tempRoot('agent-timeout-worktrees')
    await git(repo, 'init', '--quiet')
    writeFileSync(join(repo, 'package.json'), JSON.stringify({
      name: 'autodev-agent-timeout-fixture',
      private: true,
      scripts: { build: 'node --check app.js', test: 'node --test' },
    }, null, 2))
    writeFileSync(join(repo, 'app.js'), 'module.exports = { value: 42 }\n')
    writeFileSync(join(repo, 'app.test.js'), 'const { test } = require("node:test"); test("fixture", () => {});\n')
    await git(repo, 'add', '--all')
    await git(repo, '-c', 'user.name=AutoDev Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--quiet', '-m', 'fixture baseline')

    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot,
      worktreeRoot,
      agentTimeoutMs: 25,
      buildDriver: 'node',
      routes: {
        implement: {
          candidates: [{ kind: 'command', provider: 'timeout-editor', traits: ['code-edit', 'local-workspace'] }],
          requiredTaskTraits: ['code-edit', 'local-workspace'],
        },
      },
    }, { decisions: trustedTestDecisions() })
    let announceStarted!: () => void
    const started = new Promise<void>((resolve) => { announceStarted = resolve })
    let observedAbort = false
    runtime.registerProvider({
      name: 'timeout-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true,
      async run(request) {
        expect(request.cwd).toContain(worktreeRoot)
        announceStarted()
        request.onProgress?.({ type: 'assistant-delta', text: 'Codex partial answer before timeout' })
        request.onProgress?.({ type: 'activity', activity: 'tool-started' })
        return await new Promise((resolve) => {
          const onAbort = () => {
            observedAbort = true
            resolve({ provider: request.provider, status: 'aborted', output: '', diagnostic: 'Provider acknowledged cancellation' })
          }
          if (request.signal.aborted) onAbort()
          else request.signal.addEventListener('abort', onAbort, { once: true })
        })
      },
    })
    try {
      const created = await runtime.create({ repoPath: repo, mode: 'DEV', buildDriver: 'node', request: 'Create a small HTML starter' })
      expect(created.plan?.nodes.map(node => node.kind)).toEqual(['implement', 'build', 'test'])
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const running = runtime.run(created.run.id)
      await started
      const stopped = await running

      expect(observedAbort).toBe(true)
      expect(stopped.run.status).toBe('NEEDS_INTERVENTION')
      expect(stopped.run.lastError).toContain('timed out after 25ms')
      expect(stopped.nodes.find(item => item.nodeId === 'implement')?.status).toBe('UNKNOWN')
      expect(stopped.nodes.find(item => item.nodeId === 'implement')?.agentProgress).toMatchObject({
        status: 'PARTIAL',
        text: 'Codex partial answer before timeout',
        activity: 'tool-started',
      })
      expect(stopped.evidence.find(item => item.type === 'AGENT_OUTPUT' && item.status === 'UNKNOWN')?.summary)
        .toContain('timed out after 25ms')
      expect(stopped.actionIntents.find(item => item.kind === 'agent-workspace')?.status).toBe('UNKNOWN')
      expect(stopped.candidate).toBeUndefined()
      expect(stopped.evidence.some(item => item.type === 'BUILD' || item.type === 'TEST')).toBe(false)
      expect((await git(repo, 'status', '--porcelain=v1', '--untracked-files=all')).stdout).toBe('')
    } finally {
      await runtime.dispose()
      runtime.store.close()
    }
  })

  it('rejects a completed write-mode Agent that leaves the Worktree unchanged before Build', async () => {
    const repo = tempRoot('empty-agent-result')
    const dataRoot = tempRoot('empty-agent-result-state')
    const worktreeRoot = tempRoot('empty-agent-result-worktrees')
    await git(repo, 'init', '--quiet')
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot, worktreeRoot,
      routes: { implement: { candidates: [{ kind: 'command', provider: 'noop-editor', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] } },
    }, { decisions: trustedTestDecisions() })
    runtime.registerProvider({
      name: 'noop-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true,
      async run(request) {
        expect(request.cwd).toContain(worktreeRoot)
        return { provider: request.provider, status: 'completed', output: 'done' }
      },
    })
    try {
      const created = await runtime.create({ repoPath: repo, mode: 'DEV', buildDriver: 'node', request: 'Create a small HTML starter' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const stopped = await runtime.run(created.run.id)
      expect(stopped.run.status).toBe('NEEDS_INTERVENTION')
      expect(stopped.candidate).toBeUndefined()
      expect(stopped.evidence.find(item => item.type === 'AGENT_OUTPUT')?.status).toBe('WARN')
      expect(stopped.evidence.find(item => item.type === 'SIDE_EFFECT' && item.status === 'FAIL')?.summary)
        .toContain('produced no changes')
      expect(stopped.evidence.some(item => item.type === 'BUILD')).toBe(false)
    } finally {
      runtime.store.close()
    }
  })

  it('keeps REVIEW read-only, produces structured review Evidence, and does not require a Build/Test driver', async () => {
    const repo = tempRoot('review-repo')
    const dataRoot = tempRoot('review-state')
    const worktreeRoot = tempRoot('review-worktrees')
    await createCommittedRepository(repo)
    const runtime = new AutoDevRuntime(new Context(), { dataRoot, worktreeRoot, jev: { mode: 'off' } })
    runtime.registerProvider({
      name: 'read-only-reviewer', kind: 'command', traits: ['read-only'], workspaceCwd: true,
      async run(request) {
        expect(request.task?.kind).toBe('review')
        return { provider: request.provider, status: 'completed', output: '{"verdict":"PASS","findings":[]}' }
      },
    })
    runtime.router.registerCandidate('review', {
      kind: 'command', provider: 'read-only-reviewer', traits: ['read-only'],
    })
    try {
      const created = await runtime.create({ repoPath: repo, mode: 'REVIEW', request: 'Review this repository for defects' })
      expect(created.plan?.buildDriverId).toBeUndefined()
      expect(created.plan?.nodes.map(node => node.kind)).toEqual(['review'])
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const reviewed = await runtime.run(created.run.id)
      expect(reviewed.run.status).toBe('VERIFY')
      expect(reviewed.candidate).toBeUndefined()
      expect(reviewed.verifications.at(-1)?.status).toBe('PASS')
      expect(reviewed.evidence.find(item => item.type === 'REVIEW')?.source).toBe('agent')
      expect((await git(repo, 'status', '--porcelain=v1', '--untracked-files=all')).stdout).toBe('')
    } finally {
      runtime.store.close()
    }
  })

  it('does not let static quality fallback create a Review PASS', async () => {
    const repo = tempRoot('static-review-repo')
    const dataRoot = tempRoot('static-review-state')
    const worktreeRoot = tempRoot('static-review-worktrees')
    await createCommittedRepository(repo, true)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot, worktreeRoot, jev: { mode: 'off' }, buildDriver: 'maven',
      maven: { executable: 'fake-mvn', buildArgs: ['package'], testArgs: ['test'] },
      routes: { implement: { candidates: [{ kind: 'command', provider: 'fixture-editor', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] } },
    }, { commands: new FakeMavenCommands() })
    runtime.registerProvider({
      name: 'fixture-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true,
      async run(request) {
        writeFileSync(join(request.cwd, 'change.txt'), 'implemented\n')
        return { provider: request.provider, status: 'completed', output: 'implemented fixture change' }
      },
    })
    try {
      const created = await runtime.create({ repoPath: repo, request: 'Add a small implementation change' })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      const gated = await runtime.run(created.run.id)
      const review = gated.evidence.find(item => item.type === 'REVIEW')
      expect(gated.run.status).toBe('NEEDS_INTERVENTION')
      expect(review?.status).toBe('WARN')
      expect(review?.source).toBe('system')
      expect(gated.gates.at(-1)?.reason).toContain('untrusted model output cannot create Review PASS Evidence')
    } finally {
      runtime.store.close()
    }
  })
})

describe('GitManager unborn baseline', () => {
  it('supports patch promotion without advancing HEAD or touching the user index', async () => {
    const repo = tempRoot('git-unborn-repo')
    const worktreeRoot = tempRoot('git-unborn-worktrees')
    const artifactRoot = tempRoot('git-unborn-artifacts')
    await git(repo, 'init', '--quiet')
    const manager = new GitManager(commands, worktreeRoot)
    const baseline = await manager.inspect(repo)
    expect(baseline.kind).toBe('unborn')
    const worktree = await manager.createWorktree('fixture-run', baseline)
    writeFileSync(join(worktree, 'hello.txt'), 'created in isolated candidate\n')
    const tree = await manager.treeHash(worktree)
    const patchPath = join(artifactRoot, 'candidate.patch')
    writeFileSync(patchPath, await manager.diff(worktree, baseline.baseCommit))

    expect(await manager.promote(repo, baseline.baseCommit, patchPath, tree, undefined, 'unborn')).toBe('applied')
    expect(await manager.promote(repo, baseline.baseCommit, patchPath, tree, undefined, 'unborn')).toBe('already-applied')
    expect(readFileSync(join(repo, 'hello.txt'), 'utf8')).toContain('isolated candidate')
    expect((await commands.run(['git', 'rev-parse', '--verify', 'HEAD'], repo)).exitCode).not.toBe(0)
    expect((await git(repo, 'diff', '--cached', '--exit-code')).exitCode).toBe(0)
    await manager.removeWorktree(worktree, repo)
  })

  it('rejects an unborn repository that already contains untracked files', async () => {
    const repo = tempRoot('git-unborn-dirty')
    const manager = new GitManager(commands, tempRoot('git-unborn-dirty-worktrees'))
    await git(repo, 'init', '--quiet')
    writeFileSync(join(repo, 'existing.txt'), 'do not overwrite\n')
    await expect(manager.inspect(repo)).rejects.toThrow(/cannot read Git HEAD/)
  })
})
