import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { AutoDevRuntime } from '../src/runtime.ts'
import { trustedTestDecisions } from './harness.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-autodev-${label}-`))
  roots.push(root)
  return root
}

describe('AutoDev provider settings', () => {
  it('switches Ollama/Jev/configured backends, persists role routing, and never returns credential material', () => {
    const root = tempRoot('provider-settings')
    const dataRoot = join(root, 'profile-state')
    const runtime = new AutoDevRuntime(new Context(), { dataRoot, worktreeRoot: join(root, 'worktrees') }, { decisions: trustedTestDecisions() })
    const signal = new AbortController().signal
    try {
      const initial = runtime.remoteProviderSettings()
      expect(initial.decisionBackend).toBe('configured')
      expect(initial.jevApiKeyEnv).toBe('TYPESAFE_API_KEY')
      expect(initial).not.toHaveProperty('jevApiKey')
      expect(JSON.stringify(initial)).not.toMatch(/"(?:apiKey|secret|token)"\s*:/iu)

      const ollama = runtime.remoteUpdateProviderSettings({
        ...initial,
        decisionBackend: 'ollama',
        ollamaEndpoint: 'http://127.0.0.1:11434/api/chat',
        ollamaModel: 'qwen3:8b-fast',
        analysisProvider: 'claude-code',
        engineeringProvider: 'codex',
      }, signal)
      expect(ollama.decisionBackend).toBe('ollama')
      expect(runtime.decisions.activeProvider).toBe('autodev-ollama')

      const jev = runtime.remoteUpdateProviderSettings({ ...ollama, decisionBackend: 'jev' }, signal)
      expect(jev.decisionBackend).toBe('jev')
      expect(runtime.decisions.activeProvider).toBe('jev-http')
      expect(runtime.store.getSetting('provider-settings.v1')).toMatchObject({
        decisionBackend: 'jev',
        analysisProvider: 'claude-code',
        engineeringProvider: 'codex',
      })

      const configured = runtime.remoteUpdateProviderSettings({ ...jev, decisionBackend: 'configured' }, signal)
      expect(configured.decisionBackend).toBe('configured')
      expect(runtime.decisions.activeProvider).toBeUndefined()
      expect(runtime.decisions.hasProvider('autodev-ollama')).toBe(false)
    } finally {
      runtime.store.close()
    }
  })

  it('validates Ollama endpoints and accepts valid backend settings while idle', () => {
    const root = tempRoot('provider-settings-validation')
    const runtime = new AutoDevRuntime(new Context(), { dataRoot: join(root, 'state') }, { decisions: trustedTestDecisions() })
    try {
      const settings = runtime.remoteProviderSettings()
      expect(() => runtime.remoteUpdateProviderSettings({
        ...settings,
        ollamaEndpoint: 'file:///private/secret',
      }, new AbortController().signal)).toThrow(/HTTP\(S\)/u)
      expect(() => runtime.remoteUpdateProviderSettings(settings, new AbortController().signal)).not.toThrow()
    } finally {
      runtime.store.close()
    }
  })
})
