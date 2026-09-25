import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessCommandExecutor } from '../src/command.ts'
import type { Run } from '../src/contracts.ts'
import { GitManager } from '../src/git.ts'
import { AutoDevRuntime } from '../src/runtime.ts'
import { AutoDevStore } from '../src/store.ts'

const roots: string[] = []
const runtimes: AutoDevRuntime[] = []

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    try { runtime.store.close() } catch { /* fixture may already have been closed for recovery */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-autodev-cleanup-${label}-`))
  roots.push(root)
  return root
}

async function git(executor: HarnessCommandExecutor, cwd: string, ...args: string[]): Promise<void> {
  const result = await executor.run(['git', ...args], cwd)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
}

async function createRepository(executor: HarnessCommandExecutor, root: string): Promise<void> {
  mkdirSync(root, { recursive: true })
  await git(executor, root, 'init')
  await git(executor, root, 'config', 'user.email', 'cleanup-test@example.invalid')
  await git(executor, root, 'config', 'user.name', 'AutoDev cleanup test')
  writeFileSync(join(root, 'README.md'), 'clean baseline\n')
  await git(executor, root, 'add', 'README.md')
  await git(executor, root, 'commit', '-m', 'initial')
}

async function createFixture(label: string) {
  const root = tempRoot(label)
  const repository = join(root, 'repository')
  const dataRoot = join(root, 'state')
  const worktreeRoot = join(root, 'managed-worktrees')
  const commands = new HarnessCommandExecutor()
  await createRepository(commands, repository)
  const gitManager = new GitManager(commands, worktreeRoot)
  const baseline = await gitManager.inspect(repository)
  const runId = `cleanup-${label}`
  const worktreePath = await gitManager.createWorktree(runId, baseline)
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  const run: Run = {
    schemaVersion: 1,
    id: runId,
    repoPath: repository,
    repoRoot: baseline.repoRoot,
    projectKey: repository,
    request: 'retention cleanup integration fixture',
    acceptanceCriteria: [],
    status: 'PROMOTED',
    baseCommit: baseline.baseCommit,
    attempt: 1,
    worktreePath,
    createdAt: old,
    updatedAt: old,
  }
  const config = { dataRoot, worktreeRoot, jev: { mode: 'off' as const } }
  const runtime = new AutoDevRuntime(new Context(), config, { commands })
  runtimes.push(runtime)
  runtime.store.createRun(run)
  const evidence = {
    id: `evidence-${label}`,
    runId,
    type: 'TEST' as const,
    status: 'PASS' as const,
    summary: 'retention fixture evidence must survive cleanup',
    source: 'command' as const,
    createdAt: old,
  }
  runtime.store.saveEvidence(evidence)
  const artifact = runtime.store.writeArtifact(runId, 'retention-audit', 'keep audit bytes\n')
  return { root, repository, dataRoot, worktreeRoot, worktreePath, run, runtime, commands, gitManager, evidence, artifact }
}

async function addTerminalRunWorktree(fixture: Awaited<ReturnType<typeof createFixture>>, suffix: string) {
  const baseline = await fixture.gitManager.inspect(fixture.repository)
  const id = `${fixture.run.id}-${suffix}`
  const worktreePath = await fixture.gitManager.createWorktree(id, baseline)
  const run: Run = {
    ...fixture.run,
    id,
    request: 'second terminal retention fixture',
    worktreePath,
  }
  fixture.runtime.store.createRun(run)
  return { run, worktreePath }
}

async function prepare(fixture: Awaited<ReturnType<typeof createFixture>>, requestId = 'cleanup-operation-00000001') {
  const preview = fixture.runtime.remoteRetentionPreview({ minAgeDays: 30 }, new AbortController().signal)
  expect(preview.eligibleWorktrees).toHaveLength(1)
  const job = fixture.runtime.remotePrepareRetentionCleanup({
    requestId,
    minAgeDays: 30,
    snapshotFingerprint: preview.snapshotFingerprint,
    retentionIds: [preview.eligibleWorktrees[0]!.retentionId],
  })
  return { preview, job }
}

function executeRequest(jobId: string, snapshotFingerprint: string, confirmationPhrase = `DELETE-${jobId.slice(-8).toUpperCase()}`) {
  return { jobId, snapshotFingerprint, confirmationPhrase }
}

describe('retention cleanup execution', () => {
  it('requires a fresh fingerprint and a typed confirmation, then removes only the selected clean Worktree', async () => {
    const fixture = await createFixture('success')
    const eventsBefore = fixture.runtime.store.events(fixture.run.id)
    const runBefore = fixture.runtime.store.getRun(fixture.run.id)
    const { preview, job } = await prepare(fixture)
    expect(job.status).toBe('AWAITING_CONFIRMATION')
    expect(JSON.stringify(job)).not.toContain(fixture.worktreeRoot)
    expect(JSON.stringify(job)).not.toContain(fixture.worktreePath)
    expect(fixture.runtime.store.getRun(fixture.run.id)).toEqual(runBefore)

    await expect(fixture.runtime.remoteExecuteRetentionCleanup(
      executeRequest(job.id, preview.snapshotFingerprint, 'DELETE-WRONG'),
      new AbortController().signal,
    )).rejects.toThrow(/confirmation text/u)
    expect(readFileSync(join(fixture.worktreePath, 'README.md'), 'utf8')).toMatch(/^clean baseline\r?\n$/u)

    const repeated = await fixture.runtime.remoteExecuteRetentionCleanup(
      executeRequest(job.id, preview.snapshotFingerprint),
      new AbortController().signal,
    )
    expect(repeated.status).toBe('COMPLETED')
    expect(repeated.items[0]?.status).toBe('REMOVED')
    expect(JSON.stringify(repeated)).not.toContain(fixture.worktreePath)
    expect(fixture.runtime.store.getRun(fixture.run.id)).toEqual(runBefore)
    expect(fixture.runtime.store.getEvidence(fixture.evidence.id)).toEqual(fixture.evidence)
    expect(fixture.runtime.store.readArtifact(fixture.artifact).toString('utf8')).toBe('keep audit bytes\n')
    const eventsAfter = fixture.runtime.store.events(fixture.run.id)
    expect(eventsAfter.filter(event => event.type !== 'audit/action')).toEqual(eventsBefore)
    expect(fixture.runtime.store.listAuditEvents(fixture.run.id).map(event => event.action)).toEqual([
      'cleanup-prepared', 'cleanup-confirmed',
    ])
    expect(await fixture.gitManager.isRegisteredWorktree(fixture.worktreePath, fixture.run.repoRoot)).toBe(false)
    fixture.runtime.store.close()
  })

  it('executes a bounded multi-Worktree Job sequentially while retaining each Run record', async () => {
    const fixture = await createFixture('multi-item')
    const second = await addTerminalRunWorktree(fixture, 'second')
    const preview = fixture.runtime.remoteRetentionPreview({ minAgeDays: 30 }, new AbortController().signal)
    expect(preview.eligibleWorktrees).toHaveLength(2)
    const job = fixture.runtime.remotePrepareRetentionCleanup({
      requestId: 'cleanup-multiple-0001',
      minAgeDays: 30,
      snapshotFingerprint: preview.snapshotFingerprint,
      retentionIds: preview.eligibleWorktrees.map(item => item.retentionId),
    })
    const result = await fixture.runtime.remoteExecuteRetentionCleanup(
      executeRequest(job.id, preview.snapshotFingerprint),
      new AbortController().signal,
    )
    expect(result.status).toBe('COMPLETED')
    expect(result.items).toHaveLength(2)
    expect(result.items.every(item => item.status === 'REMOVED')).toBe(true)
    expect(fixture.runtime.store.getRun(fixture.run.id)).toEqual(fixture.run)
    expect(fixture.runtime.store.getRun(second.run.id)).toEqual(second.run)
    expect(fixture.runtime.store.listEvidence(fixture.run.id)).toHaveLength(1)
    fixture.runtime.store.close()
  })

  it('invalidates an unconfirmed Job when authoritative Run state changes after selection', async () => {
    const fixture = await createFixture('stale')
    const { job } = await prepare(fixture)
    fixture.runtime.store.updateRun(fixture.run.id, run => ({ ...run, request: 'changed after the cleanup review' }))
    const current = fixture.runtime.remoteRetentionPreview({ minAgeDays: 30 }, new AbortController().signal)
    await expect(fixture.runtime.remoteExecuteRetentionCleanup(
      executeRequest(job.id, current.snapshotFingerprint),
      new AbortController().signal,
    )).rejects.toThrow(/selection is stale/u)
    expect(fixture.runtime.store.getRetentionCleanupJob(job.id)?.status).toBe('AWAITING_CONFIRMATION')
    expect(readFileSync(join(fixture.worktreePath, 'README.md'), 'utf8')).toMatch(/^clean baseline\r?\n$/u)
    fixture.runtime.store.close()
  })

  it('enforces selection limits and makes preparation idempotent by request id', async () => {
    const fixture = await createFixture('idempotency')
    const { preview, job } = await prepare(fixture, 'cleanup-idempotency-0001')
    const retry = fixture.runtime.remotePrepareRetentionCleanup({
      requestId: 'cleanup-idempotency-0001',
      minAgeDays: 30,
      snapshotFingerprint: preview.snapshotFingerprint,
      retentionIds: [job.items[0]!.retentionId],
    })
    expect(retry).toEqual(job)
    expect(fixture.runtime.remoteRetentionCleanupJobs()).toHaveLength(1)
    expect(() => fixture.runtime.remotePrepareRetentionCleanup({
      requestId: 'cleanup-idempotency-too-many',
      minAgeDays: 30,
      snapshotFingerprint: preview.snapshotFingerprint,
      retentionIds: Array.from({ length: 11 }, (_, index) => index.toString(16).padStart(24, '0')),
    })).toThrow(/1 to 10/u)
    expect(() => fixture.runtime.remotePrepareRetentionCleanup({
      requestId: 'cleanup-idempotency-duplicate',
      minAgeDays: 30,
      snapshotFingerprint: preview.snapshotFingerprint,
      retentionIds: [job.items[0]!.retentionId, job.items[0]!.retentionId],
    })).toThrow(/duplicate/u)
    fixture.runtime.store.close()
  })

  it('records dirty Worktrees as protected and preserves their contents', async () => {
    const fixture = await createFixture('dirty')
    const { preview, job } = await prepare(fixture)
    writeFileSync(join(fixture.worktreePath, 'README.md'), 'operator changes must remain\n')
    const current = fixture.runtime.remoteRetentionPreview({ minAgeDays: 30 }, new AbortController().signal)
    expect(current.snapshotFingerprint).toBe(preview.snapshotFingerprint)
    const result = await fixture.runtime.remoteExecuteRetentionCleanup(
      executeRequest(job.id, current.snapshotFingerprint),
      new AbortController().signal,
    )
    expect(result.status).toBe('NEEDS_ATTENTION')
    expect(result.items[0]).toMatchObject({ status: 'BLOCKED', failureCode: 'worktree-dirty' })
    expect(readFileSync(join(fixture.worktreePath, 'README.md'), 'utf8')).toBe('operator changes must remain\n')
    fixture.runtime.store.close()
  })

  it('blocks untracked files before invoking Git removal', async () => {
    const fixture = await createFixture('untracked')
    const { preview, job } = await prepare(fixture)
    fixture.runtime.store.confirmRetentionCleanupJob(job.id, 'peer-untracked-test')
    fixture.runtime.store.pauseRetentionCleanupJob(job.id)
    const userFile = join(fixture.worktreePath, 'keep-untracked.txt')
    writeFileSync(userFile, 'user-created data')
    const current = fixture.runtime.remoteRetentionPreview({ minAgeDays: 30 }, new AbortController().signal)
    const result = await fixture.runtime.remoteExecuteRetentionCleanup(
      executeRequest(job.id, current.snapshotFingerprint),
      new AbortController().signal,
    )
    expect(current.snapshotFingerprint).not.toBe(preview.snapshotFingerprint)
    expect(result.items[0]).toMatchObject({ status: 'BLOCKED', failureCode: 'worktree-dirty' })
    expect(readFileSync(userFile, 'utf8')).toBe('user-created data')
    fixture.runtime.store.close()
  })

  it('reconciles a crash after Git removal but before the durable item outcome', async () => {
    const fixture = await createFixture('recovery')
    const { job } = await prepare(fixture)
    fixture.runtime.store.confirmRetentionCleanupJob(job.id, 'peer-before-crash')
    const itemId = job.items[0]!.retentionId
    const claim = fixture.runtime.store.claimRetentionCleanupItem(
      job.id,
      itemId,
      'crashed-host',
      '2000-01-01T00:00:00.000Z',
    )
    expect(claim.result).toBe('CLAIMED')
    await fixture.gitManager.removeWorktreeSafely(fixture.worktreePath, fixture.run.repoRoot)
    fixture.runtime.store.close()

    const recovered = new AutoDevRuntime(new Context(), {
      dataRoot: fixture.dataRoot,
      worktreeRoot: fixture.worktreeRoot,
      jev: { mode: 'off' },
    }, { commands: fixture.commands })
    runtimes.push(recovered)
    const freshPreview = recovered.remoteRetentionPreview({ minAgeDays: 30 }, new AbortController().signal)
    const result = await recovered.remoteExecuteRetentionCleanup(
      executeRequest(job.id, freshPreview.snapshotFingerprint),
      new AbortController().signal,
    )
    expect(result.status).toBe('COMPLETED')
    expect(result.items[0]?.status).toBe('REMOVED')
    expect(recovered.store.getEvidence(fixture.evidence.id)).toEqual(fixture.evidence)
    recovered.store.close()
  })

  it('reclaims an expired pre-removal lease only after the persisted Job is explicitly reconfirmed', async () => {
    const fixture = await createFixture('recovery-before')
    const { job } = await prepare(fixture)
    fixture.runtime.store.confirmRetentionCleanupJob(job.id, 'peer-before-delete')
    const itemId = job.items[0]!.retentionId
    const claim = fixture.runtime.store.claimRetentionCleanupItem(
      job.id,
      itemId,
      'interrupted-before-delete',
      '2000-01-01T00:00:00.000Z',
    )
    expect(claim.result).toBe('CLAIMED')
    expect(readFileSync(join(fixture.worktreePath, 'README.md'), 'utf8')).toMatch(/^clean baseline\r?\n$/u)
    fixture.runtime.store.close()

    const recovered = new AutoDevRuntime(new Context(), {
      dataRoot: fixture.dataRoot,
      worktreeRoot: fixture.worktreeRoot,
      jev: { mode: 'off' },
    }, { commands: fixture.commands })
    runtimes.push(recovered)
    const freshPreview = recovered.remoteRetentionPreview({ minAgeDays: 30 }, new AbortController().signal)
    const result = await recovered.remoteExecuteRetentionCleanup(
      executeRequest(job.id, freshPreview.snapshotFingerprint),
      new AbortController().signal,
    )
    expect(result.status).toBe('COMPLETED')
    expect(result.items[0]?.status).toBe('REMOVED')
  })

  it('uses a live SQLite lease to block concurrent Run transitions and allows them after settlement', async () => {
    const fixture = await createFixture('run-lock')
    const { job } = await prepare(fixture)
    fixture.runtime.store.confirmRetentionCleanupJob(job.id, 'peer-lock-test')
    const itemId = job.items[0]!.retentionId
    const claimed = fixture.runtime.store.claimRetentionCleanupItem(
      job.id,
      itemId,
      'host-lock-test',
      new Date(Date.now() + 60_000).toISOString(),
    )
    expect(claimed.result).toBe('CLAIMED')
    const concurrentStore = new AutoDevStore(fixture.dataRoot)
    const competingClaim = concurrentStore.claimRetentionCleanupItem(
      job.id,
      itemId,
      'other-host',
      new Date(Date.now() + 60_000).toISOString(),
    )
    expect(competingClaim.result).toBe('BUSY')
    expect(() => concurrentStore.updateRun(fixture.run.id, run => ({ ...run, request: 'concurrent update' })))
      .toThrow(/locked by retention cleanup/u)
    fixture.runtime.store.settleRetentionCleanupItem(job.id, itemId, 'host-lock-test', 'BLOCKED', 'target-not-eligible')
    expect(concurrentStore.updateRun(fixture.run.id, run => ({ ...run, request: 'update after cleanup lease' })).request)
      .toBe('update after cleanup lease')
    concurrentStore.close()
    fixture.runtime.store.close()
  })

  it('rejects a symbolic-link path and leaves an unregistered directory untouched', async () => {
    const fixture = await createFixture('path-safety')
    const outside = join(fixture.root, 'outside')
    const outsideWorktree = join(outside, 'attempt-1')
    mkdirSync(outsideWorktree, { recursive: true })
    writeFileSync(join(outsideWorktree, 'keep.txt'), 'outside data')
    const linkParent = join(fixture.worktreeRoot, 'linked-run')
    symlinkSync(outside, linkParent, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(fixture.gitManager.removeWorktreeSafely(join(linkParent, 'attempt-1'), fixture.run.repoRoot))
      .rejects.toMatchObject({ reason: 'path-unsafe' })
    await expect(fixture.gitManager.removeWorktreeSafely(outsideWorktree, fixture.run.repoRoot))
      .rejects.toMatchObject({ reason: 'path-unsafe' })
    expect(readFileSync(join(outsideWorktree, 'keep.txt'), 'utf8')).toBe('outside data')
    fixture.runtime.store.close()
  })
})
