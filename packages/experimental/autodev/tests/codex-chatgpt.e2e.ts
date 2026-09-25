import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as Codex from '@deepseek-ai/dsh-subagent-codex'
import { AutoDevRuntime } from '../src/runtime.ts'

const execFileAsync = promisify(execFile)
const enabled = process.env.DSH_AUTODEV_CODEX_E2E === '1'
const runDeadlineMs = 45_000

describe.skipIf(!enabled)('AutoDev with the ChatGPT-authenticated Codex Provider', () => {
  it('runs an approved Plan through Worktree, Build/Test, Evidence, and explicit Promotion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-autodev-codex-e2e-'))
    const repoRoot = join(root, 'repository')
    const stateRoot = join(root, 'state')
    const worktreeRoot = join(root, 'worktrees')
    let ctx: Context | undefined
    let runtime: AutoDevRuntime | undefined
    try {
      mkdirSync(repoRoot)
      mkdirSync(join(repoRoot, 'scripts'))
      mkdirSync(join(repoRoot, 'src'))
      writeFileSync(join(repoRoot, 'README.md'), 'AutoDev Codex E2E fixture\n')
      writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
        name: 'autodev-codex-e2e-fixture',
        private: true,
        scripts: {
          build: 'node scripts/check-result.mjs',
          test: 'node scripts/check-result.mjs',
        },
      }, null, 2) + '\n')
      writeFileSync(join(repoRoot, 'scripts/check-result.mjs'), [
        "import { readFileSync } from 'node:fs'",
        "const expected = 'AutoDev Codex E2E PASS\\n'",
        "const actual = readFileSync('src/result.txt', 'utf8')",
        'if (actual !== expected) throw new Error(`unexpected result: ${JSON.stringify(actual)}`)',
        "console.log('fixture check passed')",
        '',
      ].join('\n'))
      await execFileAsync('git', ['init', '--quiet', repoRoot])
      await execFileAsync('git', ['-C', repoRoot, 'add', '--all'])
      await execFileAsync('git', [
        '-C', repoRoot,
        '-c', 'user.name=DSH AutoDev Codex E2E',
        '-c', 'user.email=dsh-autodev-codex-e2e@example.invalid',
        'commit', '--quiet', '-m', 'Create isolated AutoDev fixture',
      ])

      ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(Codex, {
        permissionMode: 'approve-for-me',
        disposeGraceMs: 2_000,
      })
      runtime = new AutoDevRuntime(ctx, {
        dataRoot: stateRoot,
        worktreeRoot,
        jev: { mode: 'off' },
        buildTimeoutMs: 20_000,
        testTimeoutMs: 20_000,
        commandTimeoutMs: 20_000,
      })

      const created = await runtime.create({
        repoPath: repoRoot,
        request: 'Create src/result.txt containing exactly "AutoDev Codex E2E PASS" followed by one newline. Do not modify any other file.',
        acceptanceCriteria: [
          'src/result.txt contains exactly AutoDev Codex E2E PASS followed by one newline',
          'the configured Node build command succeeds',
          'the configured Node test command succeeds',
        ],
      })
      expect(created.plan?.buildDriverId).toBe('node')
      expect(created.run.status).toBe('DRAFT')
      expect(existsSync(join(repoRoot, 'src', 'result.txt'))).toBe(false)

      const approved = runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      expect(approved.run.status).toBe('READY')
      const parent = {
        id: 'autodev-codex-e2e-parent',
        session: { header: { cwd: repoRoot } },
      } as unknown as Agent
      const controller = new AbortController()
      let deadlineExceeded = false
      const deadline = setTimeout(() => {
        deadlineExceeded = true
        controller.abort(new Error(`AutoDev Codex E2E exceeded its ${runDeadlineMs}ms deadline`))
      }, runDeadlineMs)
      deadline.unref()

      let verified: Awaited<ReturnType<AutoDevRuntime['run']>>
      try {
        verified = await runtime.run(created.run.id, parent, controller.signal)
      } finally {
        clearTimeout(deadline)
      }

      expect(deadlineExceeded, `AutoDev Codex E2E exceeded its ${runDeadlineMs}ms deadline`).toBe(false)
      expect(verified.run.status).toBe('VERIFY')
      const candidate = verified.candidate
      if (candidate === undefined) throw new Error('verified Run has no sealed Candidate')
      expect(candidate.worktreePath).not.toBe(repoRoot)
      expect(readFileSync(join(candidate.worktreePath, 'src', 'result.txt'), 'utf8'))
        .toBe('AutoDev Codex E2E PASS\n')
      expect(existsSync(join(repoRoot, 'src', 'result.txt'))).toBe(false)
      const baseCommit = created.run.baseCommit
      if (baseCommit === undefined) throw new Error('created Run has no repository baseline commit')
      expect((await execFileAsync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'])).stdout.trim())
        .toBe(baseCommit)
      const changedPaths = await execFileAsync('git', [
        '-C', candidate.worktreePath,
        'diff', '--name-only', baseCommit, '--',
      ])
      expect(changedPaths.stdout.trim()).toBe('src/result.txt')
      expect(await runtime.git.treeHash(candidate.worktreePath)).toBe(candidate.gitTreeHash)

      for (const type of ['BUILD', 'TEST'] as const) {
        expect(verified.evidence.some(evidence => evidence.type === type
          && evidence.status === 'PASS'
          && evidence.candidateId === candidate.id)).toBe(true)
      }
      const diff = candidate.diffArtifactId === undefined
        ? undefined
        : runtime.store.getArtifact(candidate.diffArtifactId)
      if (diff === undefined) throw new Error('Candidate diff Artifact is missing')
      expect(runtime.store.readArtifact(diff).toString('utf8')).toContain('src/result.txt')
      expect(verified.verifications.at(-1)?.status).toBe('PASS')

      const promoted = await runtime.remotePromote(created.run.id, new AbortController().signal)
      expect(promoted.run.status).toBe('PROMOTED')
      expect(readFileSync(join(repoRoot, 'src', 'result.txt'), 'utf8'))
        .toBe('AutoDev Codex E2E PASS\n')
      expect(promoted.evidence.some(evidence => evidence.type === 'PROMOTION'
        && evidence.status === 'PASS'
        && evidence.candidateId === candidate.id)).toBe(true)
      expect(runtime.store.listActionIntents(created.run.id)
        .some(intent => intent.kind === 'git-promotion' && intent.status === 'COMMITTED')).toBe(true)
    } finally {
      try {
        if (runtime !== undefined) {
          try {
            await runtime.dispose()
          } finally {
            runtime.store.close()
          }
        }
      } finally {
        try {
          if (ctx !== undefined) await ctx.fiber.dispose()
        } finally {
          rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        }
      }
    }
  }, 65_000)
})
