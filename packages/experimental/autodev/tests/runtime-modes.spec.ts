import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessCommandExecutor, type CommandExecutor, type CommandResult } from '../src/command.ts'
import { GitManager } from '../src/git.ts'
import { AutoDevRuntime } from '../src/runtime.ts'
import { classifyAutoDevMode, resolveAutoDevMode } from '../src/mode.ts'
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
  it('uses explicit mode over classification and defaults ambiguous requests to DEV', () => {
    expect(resolveAutoDevMode('DEV', 'review this migration').mode).toBe('DEV')
    expect(resolveAutoDevMode('AUTO', 'please review the code').mode).toBe('REVIEW')
    expect(classifyAutoDevMode('修复偶发空指针并补充回归测试')).toBe('DEBUG')
    expect(classifyAutoDevMode('只补充回归测试，不修改功能代码')).toBe('TEST')
    expect(classifyAutoDevMode('新增用户登录能力')).toBe('DEV')
  })

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
      expect(gated.gates.at(-1)?.reason).toContain('static/advisory fallback cannot create Review PASS')
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
