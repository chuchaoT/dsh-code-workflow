/** Read-only planning of aged AutoDev Worktree cleanup. */

import { createHash } from 'node:crypto'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { AutoDevRetentionPreview, CandidateRevision, RetentionBlockReason, RetentionWorktreeItem, Run, RunStatus } from './contracts.ts'
import type { AutoDevStore } from './store.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_MIN_AGE_DAYS = 30
const MAX_MIN_AGE_DAYS = 3650
const TERMINAL_RUN_STATES = new Set<RunStatus>(['PROMOTED', 'FAILED', 'CANCELLED', 'ABANDONED'])
const UNSETTLED_ACTIONS = new Set(['PLANNED', 'AUTHORIZED', 'EXECUTING', 'UNKNOWN'])

interface TrackedWorktree {
  readonly run: Run
  readonly attempt: number
  readonly path: string
  readonly candidates: readonly CandidateRevision[]
}

interface InspectedWorktree {
  readonly item: RetentionWorktreeItem
  readonly canonicalPath?: string
  readonly stateFingerprint: string
  readonly reasons: Set<RetentionBlockReason>
}

/** Host-only Worktree target resolved from durable Run/Candidate records. */
export interface RetentionCleanupTarget {
  readonly retentionId: string
  readonly run: Run
  readonly attempt: number
  readonly path: string
}

/**
 * Build a non-mutating Worktree cleanup preview. No database row, Artifact, or
 * filesystem entry is changed by this function.
 * @param store AutoDev durable state to inspect.
 * @param worktreeRoot Configured managed Worktree root.
 * @param activeRunIds Runs currently executing in this Host.
 * @param requestedMinAgeDays Minimum terminal age; defaults to 30 days.
 * @returns A path-free preview bound to the observed state by a fingerprint.
 */
export function previewAutoDevRetention(
  store: AutoDevStore,
  worktreeRoot: string,
  activeRunIds: ReadonlySet<string> = new Set(),
  requestedMinAgeDays: number = DEFAULT_MIN_AGE_DAYS,
): AutoDevRetentionPreview {
  const minAgeDays = validateMinAgeDays(requestedMinAgeDays)
  const root = realpathSync(resolve(worktreeRoot))
  if (!statSync(root).isDirectory()) throw new Error('AutoDev managed Worktree root is not a directory')
  const generatedAt = new Date().toISOString()
  const now = Date.parse(generatedAt)
  const thresholdMs = minAgeDays * DAY_MS
  const tracked = collectTrackedWorktrees(store)

  const inspected = tracked.flatMap(worktree => inspectWorktree(worktree, root, now, thresholdMs, activeRunIds, store))
  const owners = new Map<string, Set<string>>()
  for (const worktree of inspected) {
    if (worktree.canonicalPath === undefined) continue
    const runIds = owners.get(worktree.canonicalPath) ?? new Set<string>()
    runIds.add(worktree.item.retentionId)
    owners.set(worktree.canonicalPath, runIds)
  }
  for (const worktree of inspected) {
    const ownerRuns = worktree.canonicalPath === undefined ? undefined : owners.get(worktree.canonicalPath)
    if (ownerRuns !== undefined && ownerRuns.size > 1) worktree.reasons.add('worktree-path-shared')
  }

  const eligibleWorktrees = inspected
    .filter(worktree => worktree.reasons.size === 0)
    .map(worktree => worktree.item)
    .sort(compareItems)
  const blockedWorktrees = inspected
    .filter(worktree => worktree.reasons.size > 0)
    .map(worktree => ({
      ...worktree.item,
      reasons: [...worktree.reasons].sort(),
    }))
    .sort(compareItems)
  const fingerprintPayload = JSON.stringify({
    root: createHash('sha256').update(root).digest('hex'),
    minAgeDays,
    items: inspected
      .map(worktree => ({
        retentionId: worktree.item.retentionId,
        stateFingerprint: worktree.stateFingerprint,
        reasons: [...worktree.reasons].sort(),
      }))
      .sort((a, b) => a.retentionId.localeCompare(b.retentionId)),
  })
  return {
    generatedAt,
    minAgeDays,
    snapshotFingerprint: createHash('sha256').update(fingerprintPayload).digest('hex'),
    eligibleWorktrees,
    blockedWorktrees,
  }

}

/** Resolve a durable path-free Retention ID back to its Host-only source path.
 * @param store - AutoDev records that originally produced the ID.
 * @param worktreeRoot - Configured managed Worktree directory.
 * @param retentionId - Stable ID returned by a retention Preview.
 * @returns The tracked target, or undefined when its Run/Candidate reference changed.
 */
export function resolveRetentionCleanupTarget(
  store: AutoDevStore,
  worktreeRoot: string,
  retentionId: string,
): RetentionCleanupTarget | undefined {
  const root = realpathSync(resolve(worktreeRoot))
  for (const worktree of collectTrackedWorktrees(store)) {
    if (retentionIdFor(worktree, root) === retentionId) {
      return { retentionId, run: worktree.run, attempt: worktree.attempt, path: worktree.path }
    }
  }
  return undefined
}

function collectTrackedWorktrees(store: AutoDevStore): TrackedWorktree[] {
  const tracked: TrackedWorktree[] = []
  for (const run of store.listRuns()) {
    const byPath = new Map<string, { attempt: number; candidates: CandidateRevision[] }>()
    if (run.worktreePath !== undefined) addTrackedPath(byPath, run.attempt, run.worktreePath)
    for (const candidate of store.listCandidates(run.id)) {
      addTrackedPath(byPath, candidate.attempt ?? run.attempt, candidate.worktreePath, candidate)
    }
    for (const [path, value] of byPath) tracked.push({ run, attempt: value.attempt, path, candidates: value.candidates })
  }
  return tracked
}

function addTrackedPath(
  byPath: Map<string, { attempt: number; candidates: CandidateRevision[] }>,
  attempt: number,
  path: string,
  candidate?: CandidateRevision,
): void {
  const existing = byPath.get(path)
  if (existing !== undefined) {
    if (candidate !== undefined && !existing.candidates.some(item => item.id === candidate.id)) existing.candidates.push(candidate)
    return
  }
  byPath.set(path, { attempt, candidates: candidate === undefined ? [] : [candidate] })
}

function validateMinAgeDays(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MIN_AGE_DAYS) {
    throw new TypeError(`retention minAgeDays must be an integer between 0 and ${MAX_MIN_AGE_DAYS}`)
  }
  return value
}

function inspectWorktree(
  worktree: TrackedWorktree,
  root: string,
  now: number,
  thresholdMs: number,
  activeRunIds: ReadonlySet<string>,
  store: AutoDevStore,
): InspectedWorktree[] {
  const { run, path } = worktree
  const reasons = new Set<RetentionBlockReason>()
  let canonicalPath: string | undefined
  let relativePath = path
  let exists = false
  let filesystemIdentity: { readonly kind: 'symlink' | 'file' | 'directory'; readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number } | undefined

  if (!isAbsolute(path)) {
    reasons.add('worktree-outside-managed-root')
    exists = true
  } else {
    const absolutePath = resolve(path)
    relativePath = relative(root, absolutePath)
    if (relativePath === '' || isOutside(relativePath)) reasons.add('worktree-outside-managed-root')
    try {
      const stat = lstatSync(absolutePath)
      exists = true
      filesystemIdentity = {
        kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
      }
      if (stat.isSymbolicLink()) reasons.add('worktree-is-symlink')
      else if (!stat.isDirectory()) reasons.add('worktree-is-not-directory')
      else {
        canonicalPath = realpathSync(absolutePath)
        const canonicalRelative = relative(root, canonicalPath)
        if (canonicalRelative === '' || isOutside(canonicalRelative)) {
          reasons.add('worktree-outside-managed-root')
          canonicalPath = undefined
        }
      }
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      exists = true
      reasons.add('worktree-unavailable')
    }
  }

  if (activeRunIds.has(run.id)) reasons.add('active-runtime-operation')
  if (!TERMINAL_RUN_STATES.has(run.status)) reasons.add('run-not-terminal')
  if (store.listGates(run.id).some(gate => gate.status === 'OPEN')) reasons.add('open-gate')
  if (store.listActionIntents(run.id).some(intent => UNSETTLED_ACTIONS.has(intent.status))) reasons.add('unsettled-side-effect')

  const updatedAt = Date.parse(run.updatedAt)
  let ageDays = 0
  if (!Number.isFinite(updatedAt)) reasons.add('invalid-run-timestamp')
  else {
    const ageMs = now - updatedAt
    if (ageMs < 0) reasons.add('future-run-timestamp')
    else {
      ageDays = Math.floor(ageMs / DAY_MS)
      if (ageMs < thresholdMs) reasons.add('retention-period-not-elapsed')
    }
  }

  const relativeIdentity = isAbsolute(path) ? relative(root, resolve(path)).split(sep).join('/') : path
  const id = retentionIdFor(worktree, root)
  const item: RetentionWorktreeItem = {
    retentionId: id,
    runId: run.id,
    attempt: worktree.attempt,
    ageDays,
  }
  const candidates = worktree.candidates
    .map(candidate => ({
      id: candidate.id,
      attempt: candidate.attempt,
      planId: candidate.planId,
      baseCommit: candidate.baseCommit,
      gitTreeHash: candidate.gitTreeHash,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const stateFingerprint = createHash('sha256').update(JSON.stringify({
    run,
    candidates,
    gates: store.listGates(run.id).map(value => createHash('sha256').update(JSON.stringify(value)).digest('hex')).sort(),
    actionIntents: store.listActionIntents(run.id).map(value => createHash('sha256').update(JSON.stringify(value)).digest('hex')).sort(),
    relativeIdentity,
    filesystemIdentity,
  })).digest('hex')
  return exists ? [{ item, stateFingerprint, ...(canonicalPath === undefined ? {} : { canonicalPath }), reasons }] : []
}

function retentionIdFor(worktree: TrackedWorktree, root: string): string {
  const relativeIdentity = isAbsolute(worktree.path) ? relative(root, resolve(worktree.path)).split(sep).join('/') : worktree.path
  const candidateIds = worktree.candidates.map(candidate => candidate.id).sort().join(',')
  const identity = [worktree.run.id, String(worktree.attempt), candidateIds, relativeIdentity].join('\0')
  return createHash('sha256').update(identity).digest('hex').slice(0, 24)
}

function isOutside(path: string): boolean {
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
}

function compareItems(a: RetentionWorktreeItem, b: RetentionWorktreeItem): number {
  return a.runId.localeCompare(b.runId) || a.attempt - b.attempt || a.retentionId.localeCompare(b.retentionId)
}
