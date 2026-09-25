/** Git baseline, Worktree, candidate, drift and promotion operations. */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CommandExecutor, CommandResult } from './command.ts'
import type { RepositoryBaseline } from './contracts.ts'

/** Reconciled outcome of applying a sealed Candidate patch. */
export type GitPromotionOutcome = 'applied' | 'already-applied'

/** Promotion failure with an explicit statement about whether writes may have occurred. */
export class GitPromotionError extends Error {
  constructor(
    message: string,
    readonly certainty: 'conflict' | 'not-applied' | 'unknown',
  ) {
    super(message)
    this.name = 'GitPromotionError'
  }
}

/** Safe Worktree removal failure with a path-free reason for durable audit. */
export class GitWorktreeCleanupError extends Error {
  constructor(
    message: string,
    readonly reason: 'path-unsafe' | 'git-registration-mismatch' | 'worktree-dirty' | 'git-remove-failed',
  ) {
    super(message)
    this.name = 'GitWorktreeCleanupError'
  }
}

/** Owns baseline inspection, managed Worktrees, candidate sealing, and promotion. */
export class GitManager {
  constructor(
    private readonly commands: CommandExecutor,
    private readonly worktreeRoot: string,
  ) {
    mkdirSync(this.worktreeRoot, { recursive: true })
  }

  /** Capture the canonical repository root, HEAD, and clean-state baseline.
   * @param repoPath - User-selected path that must resolve to a Git checkout.
   * @param signal - Optional cancellation signal for the Git queries.
   * @returns The canonical repository identity and observed baseline.
   */
  async inspect(repoPath: string, signal?: AbortSignal): Promise<RepositoryBaseline> {
    const requested = resolve(repoPath)
    const rootResult = await this.commands.run(['git', 'rev-parse', '--show-toplevel'], requested, { signal })
    if (rootResult.exitCode !== 0) {
      throw new Error(`not a Git repository: ${rootResult.stderr.trim() || requested}`)
    }
    const repoRoot = resolve(rootResult.stdout.trim())
    const [head, status] = await Promise.all([
      this.commands.run(['git', 'rev-parse', 'HEAD'], repoRoot, { signal }),
      this.commands.run(['git', 'status', '--porcelain=v1'], repoRoot, { signal }),
    ])
    if (head.exitCode !== 0) throw new Error(`cannot read Git HEAD: ${head.stderr.trim()}`)
    const lines = status.stdout.split(/\r?\n/).filter(Boolean)
    return {
      repoPath: requested,
      repoRoot,
      baseCommit: head.stdout.trim(),
      clean: lines.length === 0,
      status: lines,
      capturedAt: new Date().toISOString(),
    }
  }

  /** Create or reuse one Worktree below the configured managed root.
   * @param runId - Durable Run identity used to partition Worktree paths.
   * @param baseline - Repository baseline whose commit the Worktree checks out.
   * @param signal - Optional cancellation signal for the Git command.
   * @param attempt - Positive Attempt number used in the managed path.
   * @returns The absolute managed Worktree path.
   */
  async createWorktree(runId: string, baseline: RepositoryBaseline, signal?: AbortSignal, attempt: number = 1): Promise<string> {
    if (!Number.isSafeInteger(attempt) || attempt <= 0) throw new TypeError('worktree attempt must be a positive integer')
    const path = resolve(this.worktreeRoot, runId, `attempt-${attempt}`)
    this.assertManagedPath(path)
    if (existsSync(path)) {
      const existing = await this.commands.run(['git', 'rev-parse', '--show-toplevel'], path, { signal })
      if (existing.exitCode === 0 && resolve(existing.stdout.trim()) === path) return path
      throw new Error(`AutoDev worktree path already exists and is not reusable: ${path}`)
    }
    mkdirSync(resolve(this.worktreeRoot, runId), { recursive: true })
    const result = await this.commands.run(
      ['git', 'worktree', 'add', '--detach', path, baseline.baseCommit],
      baseline.repoRoot,
      { signal },
    )
    if (result.exitCode !== 0) throw new Error(`git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`)
    return path
  }

  /** Stage Worktree contents in its index and seal the resulting tree hash.
   * @param worktreePath - Managed Worktree to fingerprint.
   * @param signal - Optional cancellation signal for Git.
   * @returns The Git tree object ID representing the Candidate contents.
   */
  async treeHash(worktreePath: string, signal?: AbortSignal): Promise<string> {
    const add = await this.commands.run(['git', 'add', '-A', '--', '.'], worktreePath, { signal })
    if (add.exitCode !== 0) throw new Error(`git add failed while sealing candidate: ${add.stderr.trim()}`)
    const result = await this.commands.run(['git', 'write-tree'], worktreePath, { signal })
    if (result.exitCode !== 0) throw new Error(`git write-tree failed: ${result.stderr.trim()}`)
    return result.stdout.trim()
  }

  /** Read porcelain status lines for a Worktree.
   * @param worktreePath - Repository or managed Worktree to inspect.
   * @param signal - Optional cancellation signal for Git.
   * @returns Unmodified porcelain status rows.
   */
  async status(worktreePath: string, signal?: AbortSignal): Promise<readonly string[]> {
    const result = await this.commands.run(['git', 'status', '--porcelain=v1'], worktreePath, { signal })
    if (result.exitCode !== 0) throw new Error(`git status failed: ${result.stderr.trim()}`)
    return result.stdout.split(/\r?\n/).filter(Boolean)
  }

  /** Produce a binary-safe patch from a base commit to the Candidate Worktree.
   * @param worktreePath - Candidate Worktree containing proposed changes.
   * @param baseCommit - Commit against which the patch is computed.
   * @param signal - Optional cancellation signal for Git.
   * @returns The complete patch text captured from Git.
   */
  async diff(worktreePath: string, baseCommit: string, signal?: AbortSignal): Promise<string> {
    const result = await this.commands.run(['git', 'diff', '--binary', baseCommit, '--'], worktreePath, { signal })
    if (result.exitCode !== 0) throw new Error(`git diff failed: ${result.stderr.trim()}`)
    return result.stdout
  }

  /** Read the current HEAD of the target repository.
   * @param repoRoot - Canonical target repository root.
   * @param signal - Optional cancellation signal for Git.
   * @returns The current commit object ID.
   */
  async currentHead(repoRoot: string, signal?: AbortSignal): Promise<string> {
    const result = await this.commands.run(['git', 'rev-parse', 'HEAD'], repoRoot, { signal })
    if (result.exitCode !== 0) throw new Error(`cannot read Git HEAD: ${result.stderr.trim()}`)
    return result.stdout.trim()
  }

  /** Apply a sealed patch only to the expected clean baseline, then reconcile its tree.
   * @param repoRoot - Original checkout authorized for promotion.
   * @param baseCommit - Expected HEAD captured when the Run was created.
   * @param patchPath - Stored patch artifact for the verified Candidate.
   * @param expectedTreeHash - Sealed Candidate tree required after application.
   * @param signal - Optional cancellation signal for Git.
   * @returns Whether the patch was applied now or was already applied exactly.
   * @throws GitPromotionError when the baseline conflicts or the write outcome is uncertain.
   */
  async promote(
    repoRoot: string,
    baseCommit: string,
    patchPath: string,
    expectedTreeHash: string,
    signal?: AbortSignal,
  ): Promise<GitPromotionOutcome> {
    const head = await this.currentHead(repoRoot, signal)
    if (head !== baseCommit) {
      throw new GitPromotionError(`target repository drifted from ${baseCommit} to ${head}`, 'conflict')
    }

    const observedTree = await this.workingTreeHash(repoRoot, baseCommit, signal)
    if (observedTree === expectedTreeHash) return 'already-applied'

    const status = await this.status(repoRoot, signal)
    if (status.length > 0) {
      throw new GitPromotionError('target repository has changes that do not exactly match the sealed candidate; promotion is blocked', 'conflict')
    }

    let result: CommandResult
    try {
      result = await this.commands.run(['git', 'apply', '--binary', patchPath], repoRoot, { signal })
    } catch (error: unknown) {
      const reconciled = await this.tryWorkingTreeHash(repoRoot, baseCommit)
      if (reconciled === expectedTreeHash) return 'applied'
      throw new GitPromotionError(`git apply outcome is unknown: ${errorMessage(error)}`, 'unknown')
    }

    const resultingTree = await this.tryWorkingTreeHash(repoRoot, baseCommit)
    if (resultingTree === expectedTreeHash) return 'applied'
    if (result.exitCode !== 0 && resultingTree !== undefined && resultingTree === await this.commitTreeHash(repoRoot, baseCommit, signal)) {
      throw new GitPromotionError(`git apply promotion failed: ${result.stderr.trim() || result.stdout.trim()}`, 'not-applied')
    }
    throw new GitPromotionError(
      result.exitCode === 0
        ? 'git apply reported success, but the resulting repository does not match the sealed candidate'
        : `git apply left a repository state that does not match the sealed candidate: ${result.stderr.trim() || result.stdout.trim()}`,
      'unknown',
    )
  }

  private async workingTreeHash(repoRoot: string, baseCommit: string, signal?: AbortSignal): Promise<string> {
    const tempRoot = resolve(mkdtempSync(join(tmpdir(), 'dsh-autodev-index-')))
    const tempBase = resolve(tmpdir())
    const prefix = tempBase.endsWith(sep) ? tempBase : `${tempBase}${sep}`
    if (!tempRoot.startsWith(prefix)) throw new Error('temporary Git index escaped the system temporary directory')
    try {
      const indexPath = resolve(tempRoot, 'index')
      const options = { signal, env: { GIT_INDEX_FILE: indexPath } }
      for (const argv of [
        ['git', 'read-tree', baseCommit],
        ['git', 'add', '-A', '--', '.'],
      ]) {
        const result = await this.commands.run(argv, repoRoot, options)
        if (result.exitCode !== 0) throw new Error(`${argv.slice(1).join(' ')} failed while checking the target tree: ${result.stderr.trim()}`)
      }
      const result = await this.commands.run(['git', 'write-tree'], repoRoot, options)
      if (result.exitCode !== 0) throw new Error(`git write-tree failed while checking the target tree: ${result.stderr.trim()}`)
      return result.stdout.trim()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }

  private async tryWorkingTreeHash(repoRoot: string, baseCommit: string): Promise<string | undefined> {
    try {
      return await this.workingTreeHash(repoRoot, baseCommit)
    } catch {
      return undefined
    }
  }

  private async commitTreeHash(repoRoot: string, commit: string, signal?: AbortSignal): Promise<string> {
    const result = await this.commands.run(['git', 'rev-parse', `${commit}^{tree}`], repoRoot, { signal })
    if (result.exitCode !== 0) throw new Error(`cannot read base tree ${commit}: ${result.stderr.trim()}`)
    return result.stdout.trim()
  }

  /** Remove a managed Worktree and reconcile any remaining directory.
   * @param worktreePath - Worktree path previously returned by `createWorktree`.
   * @param repoRoot - Owning repository root used for `git worktree remove`.
   * @param signal - Optional cancellation signal for Git.
   * @returns Resolves after Git and filesystem cleanup complete.
   */
  async removeWorktree(worktreePath: string, repoRoot: string, signal?: AbortSignal): Promise<void> {
    this.assertManagedPath(worktreePath)
    const result = await this.commands.run(['git', 'worktree', 'remove', '--force', worktreePath], repoRoot, { signal })
    if (result.exitCode !== 0 && existsSync(worktreePath)) {
      throw new Error(`git worktree remove failed: ${result.stderr.trim() || result.stdout.trim()}`)
    }
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true })
  }

  /** Remove one clean, registered managed Worktree without force or filesystem fallback.
   * @param worktreePath - Stored path for the explicitly selected managed Worktree.
   * @param repoRoot - Owning Git repository recorded on the terminal Run.
   * @returns Resolves only after both the directory and Git registration are absent.
   * @throws GitWorktreeCleanupError when path ownership, registration, cleanliness, or removal cannot be verified.
   */
  async removeWorktreeSafely(worktreePath: string, repoRoot: string): Promise<void> {
    const target = this.canonicalManagedWorktree(worktreePath)
    const repository = this.canonicalRepository(repoRoot)
    const registeredBefore = await this.registeredWorktrees(repository)
    if (!registeredBefore.has(pathKey(target))) {
      throw new GitWorktreeCleanupError('selected directory is not registered to the recorded Git repository', 'git-registration-mismatch')
    }

    const status = await this.commands.run(['git', 'status', '--porcelain=v1', '--untracked-files=all'], target)
    if (status.exitCode !== 0) {
      throw new GitWorktreeCleanupError('Git could not verify the selected Worktree status', 'git-remove-failed')
    }
    if (status.stdout.trim() !== '') {
      throw new GitWorktreeCleanupError('selected Worktree contains tracked or untracked changes', 'worktree-dirty')
    }

    let removalError: unknown
    try {
      const result = await this.commands.run(['git', 'worktree', 'remove', target], repository)
      if (result.exitCode !== 0) removalError = new Error('Git refused the non-forced Worktree removal')
    } catch (error: unknown) {
      removalError = error
    }

    const stillExists = existsSync(target)
    let registeredAfter: Set<string>
    try {
      registeredAfter = await this.registeredWorktrees(repository)
    } catch {
      throw new GitWorktreeCleanupError('Git removal outcome could not be reconciled', 'git-remove-failed')
    }
    if (!stillExists && !registeredAfter.has(pathKey(target))) return
    if (removalError !== undefined) {
      throw new GitWorktreeCleanupError('Git could not remove the selected Worktree without force', 'git-remove-failed')
    }
    throw new GitWorktreeCleanupError('selected Worktree remains present or registered after removal', 'git-remove-failed')
  }

  /** Check whether Git still registers a managed path, including a missing directory.
   * @param worktreePath - Stored path for the selected Worktree.
   * @param repoRoot - Recorded owning Git repository.
   * @returns Whether the exact managed path is still registered.
   */
  async isRegisteredWorktree(worktreePath: string, repoRoot: string): Promise<boolean> {
    const target = this.assertNoSymlinkAncestors(worktreePath, true)
    const repository = this.canonicalRepository(repoRoot)
    return (await this.registeredWorktrees(repository)).has(pathKey(target))
  }

  private canonicalManagedWorktree(path: string): string {
    const target = this.assertManagedLexicalPath(path)
    const root = realpathSync(resolve(this.worktreeRoot))
    let current = root
    const pathFromRoot = relative(root, target)
    for (const segment of pathFromRoot.split(sep).filter(Boolean)) {
      current = resolve(current, segment)
      let stat
      try {
        stat = lstatSync(current)
      } catch {
        throw new GitWorktreeCleanupError('selected managed Worktree path is unavailable', 'path-unsafe')
      }
      if (stat.isSymbolicLink()) {
        throw new GitWorktreeCleanupError('selected managed Worktree path contains a symbolic link', 'path-unsafe')
      }
    }
    let canonical: string
    try {
      canonical = realpathSync(target)
      if (!lstatSync(target).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new GitWorktreeCleanupError('selected managed Worktree is not an accessible directory', 'path-unsafe')
    }
    const canonicalRelative = relative(root, canonical)
    if (canonicalRelative === '' || isOutsideManagedPath(canonicalRelative)) {
      throw new GitWorktreeCleanupError('selected managed Worktree resolves outside its configured root', 'path-unsafe')
    }
    return canonical
  }

  private assertManagedLexicalPath(path: string): string {
    const target = resolve(path)
    const root = resolve(this.worktreeRoot)
    const prefix = root.endsWith(sep) ? root : root + sep
    if (!isAbsolute(target) || (target !== root && !target.startsWith(prefix))) {
      throw new GitWorktreeCleanupError('selected Worktree path is outside the configured root', 'path-unsafe')
    }
    const relativePath = relative(root, target)
    if (relativePath === '' || isOutsideManagedPath(relativePath)) {
      throw new GitWorktreeCleanupError('selected Worktree path is not a child of the configured root', 'path-unsafe')
    }
    return target
  }

  private assertNoSymlinkAncestors(path: string, allowMissing: boolean): string {
    const target = this.assertManagedLexicalPath(path)
    const relativePath = relative(resolve(this.worktreeRoot), target)
    let current = resolve(this.worktreeRoot)
    for (const segment of relativePath.split(sep).filter(Boolean)) {
      current = resolve(current, segment)
      let stat
      try {
        stat = lstatSync(current)
      } catch (error: unknown) {
        if (allowMissing && error instanceof Error && 'code' in error && error.code === 'ENOENT') return target
        throw new GitWorktreeCleanupError('selected managed Worktree path is unavailable', 'path-unsafe')
      }
      if (stat.isSymbolicLink()) {
        throw new GitWorktreeCleanupError('selected managed Worktree path contains a symbolic link', 'path-unsafe')
      }
    }
    return target
  }

  private canonicalRepository(repoRoot: string): string {
    try {
      return realpathSync(resolve(repoRoot))
    } catch {
      throw new GitWorktreeCleanupError('recorded owning Git repository is unavailable', 'git-registration-mismatch')
    }
  }

  private async registeredWorktrees(repoRoot: string): Promise<Set<string>> {
    const result = await this.commands.run(['git', 'worktree', 'list', '--porcelain', '-z'], repoRoot)
    if (result.exitCode !== 0) {
      throw new GitWorktreeCleanupError('Git Worktree registrations could not be read', 'git-registration-mismatch')
    }
    const paths = result.stdout.split('\0')
      .filter(entry => entry.startsWith('worktree '))
      .map(entry => entry.slice('worktree '.length))
    return new Set(paths.map(value => pathKey(resolve(value))))
  }

  private assertManagedPath(path: string): void {
    const target = resolve(path)
    const root = resolve(this.worktreeRoot)
    const prefix = root.endsWith(sep) ? root : root + sep
    if (!isAbsolute(target) || (target !== root && !target.startsWith(prefix))) {
      throw new Error(`worktree path must stay below ${root}`)
    }
    if (relative(root, target).includes('..')) throw new Error('worktree path escapes managed root')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isOutsideManagedPath(path: string): boolean {
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
}

function pathKey(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
