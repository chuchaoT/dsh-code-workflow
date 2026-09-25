import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as Codex from '../src/index.ts'
import { cleanupRealProduct } from './real-product-cleanup.ts'

const execFileAsync = promisify(execFile)
const enabled = process.env.DSH_CODEX_CHATGPT_E2E === '1'
const runDeadlineMs = 45_000
const roots: string[] = []
const fixtures: never[] = []
const contexts: Context[] = []

afterEach(() => cleanupRealProduct({ contexts, fixtures, roots }))

describe.skipIf(!enabled)('real Codex ChatGPT-authenticated DSH subagent', () => {
  it('edits exactly one file inside the invocation workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-codex-chatgpt-e2e-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'README.md'), 'Status: pending\n')
    await execFileAsync('git', ['init', '--quiet', workspace])
    await execFileAsync('git', ['-C', workspace, 'add', 'README.md'])
    await execFileAsync('git', [
      '-C', workspace,
      '-c', 'user.name=DSH Codex E2E',
      '-c', 'user.email=dsh-codex-e2e@example.invalid',
      'commit', '--quiet', '-m', 'Create isolated Codex fixture',
    ])

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(Codex, { permissionMode: 'approve-for-me', disposeGraceMs: 2_000 })

    const spawnSpecs: SubprocessSpawnSpec[] = []
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      spawnSpecs.push(spec)
      return spawn(spec)
    })
    const parent = {
      id: 'chatgpt-auth-e2e-parent',
      session: { header: { cwd: root } },
    } as unknown as Agent
    const controller = new AbortController()
    let deadlineExceeded = false
    const deadline = setTimeout(() => {
      deadlineExceeded = true
      controller.abort(new Error(`Codex E2E exceeded its ${runDeadlineMs}ms deadline`))
    }, runDeadlineMs)
    deadline.unref()

    try {
      const run = await ctx.subagents.start('codex', {
        prompt: [{
          type: 'text',
          text: 'In README.md change only the status line to "Status: codex-e2e-ok". Do not edit any other file. Then report the exact final line.',
        }],
        parent,
        signal: controller.signal,
        workspaceCwd: workspace,
      })

      try {
        const result = await run.result
        expect(deadlineExceeded, `Codex E2E exceeded its ${runDeadlineMs}ms deadline`)
          .toBe(false)
        expect(result.stopReason, result.diagnostic).toBe('completed')
        expect(result.output.map(block => block.type === 'text' ? block.text : '').join(''))
          .toMatch(/Status: codex-e2e-ok/)
        expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe('Status: codex-e2e-ok\n')
        expect(spawnSpecs).toHaveLength(1)
        expect(spawnSpecs[0]?.cwd).toBe(workspace)
        const status = await execFileAsync('git', ['-C', workspace, 'status', '--short'])
        expect(status.stdout.trim()).toBe('M README.md')
      } finally {
        await run.dispose()
      }
    } finally {
      clearTimeout(deadline)
    }
  }, 65_000)
})
