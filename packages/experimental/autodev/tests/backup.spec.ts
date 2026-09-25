import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { AutoDevBackupManifest, Run } from '../src/contracts.ts'
import { AutoDevRuntime } from '../src/runtime.ts'
import { AutoDevStore } from '../src/store.ts'
import { createAutoDevBackup, restoreAutoDevBackup } from '../src/backup.ts'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-autodev-backup-${label}-`))
  temporaryRoots.push(root)
  return root
}

function runFixture(id: string): Run {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    id,
    repoPath: 'C:/project/repo',
    repoRoot: 'C:/project/repo',
    projectKey: 'C:/project/repo',
    request: 'Preserve this run for audit',
    acceptanceCriteria: ['artifact is readable after restore'],
    status: 'NEEDS_INTERVENTION',
    baseCommit: 'baseline-commit',
    attempt: 1,
    createdAt: now,
    updatedAt: now,
  }
}

function makeStore(root: string, runId = 'run-backup-1'): { readonly store: AutoDevStore; readonly artifactId: string; readonly content: string } {
  const store = new AutoDevStore(join(root, 'store'))
  const run = runFixture(runId)
  store.createRun(run)
  const content = 'candidate diff and verification output\n'
  const artifact = store.writeArtifact(run.id, 'candidate-diff', content, '.patch')
  return { store, artifactId: artifact.id, content }
}

function loadManifest(path: string): AutoDevBackupManifest {
  return JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as AutoDevBackupManifest
}

function saveManifest(path: string, manifest: AutoDevBackupManifest): void {
  writeFileSync(join(path, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function hash(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('AutoDev state backup and restore', () => {
  it('backs up a consistent SQLite snapshot and restores Run artifacts with rebased paths', async () => {
    const root = tempRoot('roundtrip')
    const { store, artifactId, content } = makeStore(root)
    const backupPath = join(root, 'portable-backup')
    const restoredRoot = join(root, 'restored-store')

    try {
      const manifest = await createAutoDevBackup(store, backupPath)
      expect(manifest.databaseSchemaVersion).toBe(2)
      expect(manifest.included).toEqual(['sqlite', 'run-artifacts'])
      expect(manifest.excluded).toEqual(['git-worktrees'])
      expect(manifest.files.map(file => file.path)).toContain('autodev.sqlite')
      expect(manifest.files.some(file => file.path === 'runs/run-backup-1/artifacts')).toBe(false)
      expect(manifest.files.some(file => file.path.startsWith('runs/run-backup-1/artifacts/'))).toBe(true)

      const backupDb = new DatabaseSync(join(backupPath, 'autodev.sqlite'), { readOnly: true })
      try {
        const row = backupDb.prepare('SELECT value FROM autodev_records WHERE kind = ? AND id = ?').get('artifact', artifactId) as { value: string }
        const artifact = JSON.parse(row.value) as { path: string }
        expect(artifact.path).toMatch(/^runs\/run-backup-1\/artifacts\//u)
        expect(artifact.path).not.toContain(':')
      } finally {
        backupDb.close()
      }

      await expect(restoreAutoDevBackup(backupPath, restoredRoot)).resolves.toEqual(manifest)
      const restoredStore = new AutoDevStore(restoredRoot)
      try {
        expect(restoredStore.getRun('run-backup-1')).toMatchObject({ request: 'Preserve this run for audit', status: 'NEEDS_INTERVENTION' })
        const artifact = restoredStore.getArtifact(artifactId)
        expect(artifact?.path).toBe(join(restoredRoot, 'runs', 'run-backup-1', 'artifacts', basename(artifact!.path)))
        expect(restoredStore.readArtifact(artifact!).toString('utf8')).toBe(content)
      } finally {
        restoredStore.close()
      }
    } finally {
      store.close()
    }
  })

  it('exposes backup and confirmed new-root restore through the Host Remote', async () => {
    const root = tempRoot('remote')
    const dataRoot = join(root, 'live-data')
    const backupPath = join(root, 'remote-backup')
    const restoredRoot = join(root, 'remote-restored')
    const runtime = new AutoDevRuntime(new Context(), { dataRoot, worktreeRoot: join(root, 'worktrees'), jev: { mode: 'off' } })
    const run = runFixture('run-remote-backup')
    runtime.store.createRun(run)
    const artifact = runtime.store.writeArtifact(run.id, 'candidate-diff', 'remote artifact\n', '.patch')

    try {
      const signal = new AbortController().signal
      const manifest = await runtime.remoteCreateBackup({ destinationPath: backupPath }, signal)
      expect(manifest.files.some(file => file.path.startsWith('runs/run-remote-backup/artifacts/'))).toBe(true)
      await expect(runtime.remoteRestoreBackup({
        backupPath,
        targetDataRoot: restoredRoot,
        confirmedTargetDataRoot: `${restoredRoot}-other`,
      }, signal)).rejects.toThrow(/must exactly match/u)
      expect(existsSync(restoredRoot)).toBe(false)

      await runtime.remoteRestoreBackup({ backupPath, targetDataRoot: restoredRoot, confirmedTargetDataRoot: restoredRoot }, signal)
      const restored = new AutoDevStore(restoredRoot)
      try {
        expect(restored.getRun(run.id)?.request).toBe(run.request)
        const restoredArtifact = restored.getArtifact(artifact.id)
        expect(restoredArtifact?.path).toBe(join(restoredRoot, 'runs', run.id, 'artifacts', basename(artifact.path)))
        expect(restored.readArtifact(restoredArtifact!).toString('utf8')).toBe('remote artifact\n')
      } finally {
        restored.close()
      }

      const aborted = new AbortController()
      aborted.abort()
      const abortedBackupPath = join(root, 'aborted-backup')
      await expect(runtime.remoteCreateBackup({ destinationPath: abortedBackupPath }, aborted.signal)).rejects.toThrow()
      expect(existsSync(abortedBackupPath)).toBe(false)
    } finally {
      await runtime.dispose()
      runtime.store.close()
    }
  })

  it('refuses overlapping or existing destinations without overwriting operator data', async () => {
    const root = tempRoot('destination-safety')
    const { store } = makeStore(root)
    const existingBackup = join(root, 'existing-backup')
    mkdirSync(existingBackup)
    writeFileSync(join(existingBackup, 'keep.txt'), 'keep me')
    const backupPath = join(root, 'valid-backup')
    try {
      await expect(createAutoDevBackup(store, join(store.root, 'nested-backup'))).rejects.toThrow(/outside the live data root/u)
      await expect(createAutoDevBackup(store, existingBackup)).rejects.toThrow(/already exists/u)
      expect(readFileSync(join(existingBackup, 'keep.txt'), 'utf8')).toBe('keep me')

      await createAutoDevBackup(store, backupPath)
      const existingRestore = join(root, 'existing-restore')
      mkdirSync(existingRestore)
      writeFileSync(join(existingRestore, 'keep.txt'), 'leave this untouched')
      await expect(restoreAutoDevBackup(backupPath, existingRestore)).rejects.toThrow(/already exists/u)
      expect(readFileSync(join(existingRestore, 'keep.txt'), 'utf8')).toBe('leave this untouched')
    } finally {
      store.close()
    }
  })

  it.each(['path traversal', 'artifact tampering', 'database corruption'] as const)(
    'rejects %s without creating a restore target', async (scenario) => {
      const root = tempRoot(scenario.replaceAll(' ', '-'))
      const { store } = makeStore(root)
      const backupPath = join(root, 'backup')
      const restoredRoot = join(root, 'must-not-exist')
      try {
        await createAutoDevBackup(store, backupPath)
        const manifest = loadManifest(backupPath)
        if (scenario === 'path traversal') {
          const unsafe = {
            ...manifest,
            files: [...manifest.files, { path: '../escape.txt', bytes: 0, sha256: '0'.repeat(64) }],
          }
          saveManifest(backupPath, unsafe)
        } else if (scenario === 'artifact tampering') {
          const artifact = manifest.files.find(file => file.path.startsWith('runs/'))
          if (artifact === undefined) throw new Error('backup fixture did not create an artifact')
          writeFileSync(join(backupPath, ...artifact.path.split('/')), 'tampered bytes')
        } else {
          const database = manifest.files.find(file => file.path === 'autodev.sqlite')
          if (database === undefined) throw new Error('backup fixture did not create a database')
          const corrupted = 'not a SQLite database'
          writeFileSync(join(backupPath, 'autodev.sqlite'), corrupted)
          saveManifest(backupPath, {
            ...manifest,
            files: manifest.files.map(file => file.path === 'autodev.sqlite'
              ? { path: file.path, bytes: Buffer.byteLength(corrupted), sha256: hash(corrupted) }
              : file),
          })
        }

        await expect(restoreAutoDevBackup(backupPath, restoredRoot)).rejects.toThrow()
        expect(existsSync(restoredRoot)).toBe(false)
      } finally {
        store.close()
      }
    },
  )
})
