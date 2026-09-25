import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { AutoDevRuntime } from '../src/runtime.ts'
import { commandProvider } from '../src/router.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRuntime(label: string): { root: string; runtime: AutoDevRuntime } {
  const root = mkdtempSync(join(tmpdir(), `dsh-autodev-runtime-route-${label}-`))
  roots.push(root)
  return {
    root,
    runtime: new AutoDevRuntime(new Context(), {
      dataRoot: join(root, 'data'),
      worktreeRoot: join(root, 'worktrees'),
      jev: { mode: 'off' },
    }),
  }
}

describe('AutoDev Runtime dynamic route registration', () => {
  it('registers, selects, invokes, and atomically unloads a custom Provider route', async () => {
    const { root, runtime } = makeRuntime('provider')
    let observedCwd = ''
    const provider = commandProvider({
      name: 'local-code-agent',
      executable: 'local-code-agent',
      args: ['run'],
      traits: ['code-edit', 'local-workspace'],
      executor: {
        async run(argv, cwd) {
          observedCwd = cwd
          return { argv, cwd, exitCode: 0, signal: null, stdout: 'implemented', stderr: '', timedOut: false, durationMs: 1 }
        },
      },
    })

    try {
      const dispose = runtime.registerRoutedProvider('implement', provider)
      const signal = new AbortController().signal
      const selection = await runtime.router.select(
        undefined,
        'implement',
        'agent-route',
        'implement',
        {},
        ['code-edit', 'local-workspace'],
        signal,
      )

      expect(selection.candidate).toMatchObject({ kind: 'command', provider: 'local-code-agent' })
      const result = await runtime.router.invoke(selection.candidate!, {
        request: 'implement in the managed Worktree',
        acceptanceCriteria: [],
        cwd: join(root, 'worktrees', 'run-1'),
        signal,
      })
      expect(result).toMatchObject({ status: 'completed', output: 'implemented' })
      expect(observedCwd).toBe(join(root, 'worktrees', 'run-1'))

      dispose()
      dispose()
      expect(runtime.router.listRoutes().implement?.candidates).not.toContainEqual(
        expect.objectContaining({ provider: 'local-code-agent' }),
      )
      expect(runtime.listProviders()).not.toContainEqual(expect.objectContaining({ name: 'local-code-agent' }))
    } finally {
      await runtime.dispose()
      runtime.store.close()
    }
  })

  it('rolls back the Provider when the target route cannot accept its candidate', async () => {
    const { runtime } = makeRuntime('rollback')
    const provider = commandProvider({
      name: 'rollback-agent',
      executable: 'rollback-agent',
      args: ['run'],
      traits: ['code-edit', 'local-workspace'],
      executor: {
        async run(argv, cwd) {
          return { argv, cwd, exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1 }
        },
      },
    })

    try {
      expect(() => runtime.registerRoutedProvider('missing-route', provider))
        .toThrow('AutoDev route "missing-route" is not registered')

      // A same-name registration proves the first half was rolled back on failure.
      const unregister = runtime.registerProvider(provider)
      expect(runtime.listProviders()).toContainEqual(expect.objectContaining({ name: 'rollback-agent' }))
      unregister()
      expect(runtime.listProviders()).not.toContainEqual(expect.objectContaining({ name: 'rollback-agent' }))
    } finally {
      await runtime.dispose()
      runtime.store.close()
    }
  })

  it('exposes reversible candidates for Harness-loaded ACP subagents', async () => {
    const { runtime } = makeRuntime('subagent')
    const candidate = {
      kind: 'subagent' as const,
      provider: 'codebuddy-acp',
      traits: ['code-edit', 'local-workspace', 'worktree-cwd'],
    }

    try {
      const remove = runtime.registerRouteCandidate('implement', candidate)
      expect(runtime.router.listRoutes().implement?.candidates).toContainEqual(candidate)
      remove()
      expect(runtime.router.listRoutes().implement?.candidates).not.toContainEqual(candidate)
    } finally {
      await runtime.dispose()
      runtime.store.close()
    }
  })
})
