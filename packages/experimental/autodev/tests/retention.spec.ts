import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Run } from '../src/contracts.ts'
import { previewAutoDevRetention } from '../src/retention.ts'
import { SideEffectService } from '../src/side-effects.ts'
import { AutoDevStore } from '../src/store.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-autodev-retention-${label}-`))
  roots.push(root)
  return root
}

function runFixture(id: string, status: Run['status'], updatedAt: string, worktreePath: string): Run {
  return {
    schemaVersion: 1,
    id,
    repoPath: 'C:/project/repo',
    repoRoot: 'C:/project/repo',
    projectKey: 'C:/project/repo',
    request: 'retention preview fixture',
    acceptanceCriteria: [],
    status,
    baseCommit: 'baseline-commit',
    attempt: 1,
    worktreePath,
    createdAt: updatedAt,
    updatedAt,
  }
}

function makeWorktree(root: string, runId: string, attempt = 1): string {
  const path = join(root, runId, `attempt-${attempt}`)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'user-visible.txt'), 'keep until cleanup is explicitly executed')
  return path
}

describe('AutoDev retention preview', () => {
  it('lists only aged terminal managed Worktrees and makes no database or filesystem changes', () => {
    const root = tempRoot('read-only')
    const store = new AutoDevStore(join(root, 'state'))
    const worktreeRoot = join(root, 'worktrees')
    mkdirSync(worktreeRoot)
    const updatedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    const worktreePath = makeWorktree(worktreeRoot, 'eligible-run')
    const run = runFixture('eligible-run', 'PROMOTED', updatedAt, worktreePath)
    store.createRun(run)
    store.saveCandidate({
      id: 'candidate-old', runId: run.id, planId: 'plan-1', worktreePath, baseCommit: run.baseCommit,
      gitTreeHash: 'tree-1', attempt: 1, createdAt: updatedAt,
    })
    const recordsBefore = store.listRuns()
    const filesBefore = existsSync(join(worktreePath, 'user-visible.txt'))

    try {
      const preview = previewAutoDevRetention(store, worktreeRoot, new Set(), 30)
      const repeatedPreview = previewAutoDevRetention(store, worktreeRoot, new Set(), 30)
      expect(preview.eligibleWorktrees).toHaveLength(1)
      expect(preview.eligibleWorktrees[0]).toMatchObject({ runId: run.id, attempt: 1, ageDays: expect.any(Number) })
      expect(preview.blockedWorktrees).toEqual([])
      expect(preview.snapshotFingerprint).toMatch(/^[a-f0-9]{64}$/u)
      expect(repeatedPreview.generatedAt).not.toBe(preview.generatedAt)
      expect(repeatedPreview.snapshotFingerprint).toBe(preview.snapshotFingerprint)
      expect(JSON.stringify(preview)).not.toContain(worktreeRoot)
      expect(JSON.stringify(preview)).not.toContain(worktreePath)
      expect(store.listRuns()).toEqual(recordsBefore)
      expect(existsSync(join(worktreePath, 'user-visible.txt'))).toBe(filesBefore)
    } finally {
      store.close()
    }
  })

  it('changes the stable confirmation fingerprint when persisted Run state changes', () => {
    const root = tempRoot('stable-fingerprint')
    const store = new AutoDevStore(join(root, 'state'))
    const worktreeRoot = join(root, 'worktrees')
    mkdirSync(worktreeRoot)
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    const path = makeWorktree(worktreeRoot, 'fingerprint-run')
    const run = runFixture('fingerprint-run', 'PROMOTED', old, path)
    store.createRun(run)
    const first = previewAutoDevRetention(store, worktreeRoot, new Set(), 30)
    store.updateRun(run.id, current => ({ ...current, request: 'changed after review' }))
    const changed = previewAutoDevRetention(store, worktreeRoot, new Set(), 30)
    expect(changed.snapshotFingerprint).not.toBe(first.snapshotFingerprint)
    store.close()
  })

  it('protects active, non-terminal, fresh, gated, and unresolved-side-effect Worktrees', () => {
    const root = tempRoot('protection')
    const store = new AutoDevStore(join(root, 'state'))
    const worktreeRoot = join(root, 'worktrees')
    mkdirSync(worktreeRoot)
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    const fresh = new Date().toISOString()
    const fixtures = [
      runFixture('active-runtime', 'PROMOTED', old, makeWorktree(worktreeRoot, 'active-runtime')),
      runFixture('not-terminal', 'EXECUTING', old, makeWorktree(worktreeRoot, 'not-terminal')),
      runFixture('open-gate', 'ABANDONED', old, makeWorktree(worktreeRoot, 'open-gate')),
      runFixture('unknown-effect', 'CANCELLED', old, makeWorktree(worktreeRoot, 'unknown-effect')),
      runFixture('too-fresh', 'FAILED', fresh, makeWorktree(worktreeRoot, 'too-fresh')),
    ]
    for (const run of fixtures) store.createRun(run)
    store.saveGate({ id: 'open-gate-1', runId: 'open-gate', reason: 'manual review', options: ['abandon'], status: 'OPEN', createdAt: old })
    const effects = new SideEffectService(store)
    const intent = effects.plan({ runId: 'unknown-effect', kind: 'command', target: 'fixture', risk: 'low' })
    effects.authorize(intent.id, 'test fixture')
    effects.start(intent.id)
    effects.unknown(intent.id, 'outcome uncertain')

    try {
      const preview = previewAutoDevRetention(store, worktreeRoot, new Set(['active-runtime']), 30)
      expect(preview.eligibleWorktrees).toEqual([])
      const reasons = new Map(preview.blockedWorktrees.map(item => [item.runId, item.reasons]))
      expect(reasons.get('active-runtime')).toContain('active-runtime-operation')
      expect(reasons.get('not-terminal')).toContain('run-not-terminal')
      expect(reasons.get('open-gate')).toContain('open-gate')
      expect(reasons.get('unknown-effect')).toContain('unsettled-side-effect')
      expect(reasons.get('too-fresh')).toContain('retention-period-not-elapsed')
    } finally {
      store.close()
    }
  })

  it('refuses Worktrees outside the configured managed root and omits missing paths', () => {
    const root = tempRoot('path-boundary')
    const store = new AutoDevStore(join(root, 'state'))
    const worktreeRoot = join(root, 'worktrees')
    const outsideRoot = join(root, 'outside')
    mkdirSync(worktreeRoot)
    mkdirSync(outsideRoot)
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    const outsidePath = makeWorktree(outsideRoot, 'outside-run')
    store.createRun(runFixture('outside-run', 'PROMOTED', old, outsidePath))
    store.createRun(runFixture('missing-run', 'PROMOTED', old, join(worktreeRoot, 'missing', 'attempt-1')))

    try {
      const preview = previewAutoDevRetention(store, worktreeRoot, new Set(), 30)
      expect(preview.eligibleWorktrees).toEqual([])
      expect(preview.blockedWorktrees).toHaveLength(1)
      expect(preview.blockedWorktrees[0]).toMatchObject({ runId: 'outside-run', reasons: ['worktree-outside-managed-root'] })
      expect(existsSync(join(outsidePath, 'user-visible.txt'))).toBe(true)
    } finally {
      store.close()
    }
  })

  it('protects a managed directory ambiguously referenced by multiple Runs', () => {
    const root = tempRoot('shared-path')
    const store = new AutoDevStore(join(root, 'state'))
    const worktreeRoot = join(root, 'worktrees')
    mkdirSync(worktreeRoot)
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    const sharedPath = makeWorktree(worktreeRoot, 'shared')
    store.createRun(runFixture('shared-run-a', 'PROMOTED', old, sharedPath))
    store.createRun(runFixture('shared-run-b', 'CANCELLED', old, sharedPath))

    try {
      const preview = previewAutoDevRetention(store, worktreeRoot, new Set(), 30)
      expect(preview.eligibleWorktrees).toEqual([])
      expect(preview.blockedWorktrees).toHaveLength(2)
      expect(preview.blockedWorktrees.every(item => item.reasons.includes('worktree-path-shared'))).toBe(true)
    } finally {
      store.close()
    }
  })

  it('validates the configured retention period', () => {
    const root = tempRoot('invalid-policy')
    const store = new AutoDevStore(join(root, 'state'))
    const worktreeRoot = join(root, 'worktrees')
    mkdirSync(worktreeRoot)
    try {
      expect(() => previewAutoDevRetention(store, worktreeRoot, new Set(), -1)).toThrow(/minAgeDays/u)
      expect(() => previewAutoDevRetention(store, worktreeRoot, new Set(), 3651)).toThrow(/minAgeDays/u)
      expect(() => previewAutoDevRetention(store, worktreeRoot, new Set(), 1.5)).toThrow(/minAgeDays/u)
    } finally {
      store.close()
    }
  })
})
