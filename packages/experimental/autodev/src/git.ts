/** Git baseline, Worktree, candidate, drift and promotion operations. */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { CommandExecutor } from './command.ts'
import type { RepositoryBaseline } from './contracts.ts'

export class GitManager {
  constructor(
    private readonly commands: CommandExecutor,
    private readonly worktreeRoot: string,
  ) {
    mkdirSync(this.worktreeRoot, { recursive: true })
  }

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

  async treeHash(worktreePath: string, signal?: AbortSignal): Promise<string> {
    const add = await this.commands.run(['git', 'add', '-A', '--', '.'], worktreePath, { signal })
    if (add.exitCode !== 0) throw new Error(`git add failed while sealing candidate: ${add.stderr.trim()}`)
    const result = await this.commands.run(['git', 'write-tree'], worktreePath, { signal })
    if (result.exitCode !== 0) throw new Error(`git write-tree failed: ${result.stderr.trim()}`)
    return result.stdout.trim()
  }

  async status(worktreePath: string, signal?: AbortSignal): Promise<readonly string[]> {
    const result = await this.commands.run(['git', 'status', '--porcelain=v1'], worktreePath, { signal })
    if (result.exitCode !== 0) throw new Error(`git status failed: ${result.stderr.trim()}`)
    return result.stdout.split(/\r?\n/).filter(Boolean)
  }

  async diff(worktreePath: string, baseCommit: string, signal?: AbortSignal): Promise<string> {
    const result = await this.commands.run(['git', 'diff', '--binary', baseCommit, '--'], worktreePath, { signal })
    if (result.exitCode !== 0) throw new Error(`git diff failed: ${result.stderr.trim()}`)
    return result.stdout
  }

  async currentHead(repoRoot: string, signal?: AbortSignal): Promise<string> {
    const result = await this.commands.run(['git', 'rev-parse', 'HEAD'], repoRoot, { signal })
    if (result.exitCode !== 0) throw new Error(`cannot read Git HEAD: ${result.stderr.trim()}`)
    return result.stdout.trim()
  }

  async promote(
    repoRoot: string,
    baseCommit: string,
    patchPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const status = await this.status(repoRoot, signal)
    if (status.length > 0) throw new Error('target repository has uncommitted changes; promotion is blocked')
    const head = await this.currentHead(repoRoot, signal)
    if (head !== baseCommit) throw new Error(`target repository drifted from ${baseCommit} to ${head}`)
    const result = await this.commands.run(['git', 'apply', '--binary', patchPath], repoRoot, { signal })
    if (result.exitCode !== 0) throw new Error(`git apply promotion failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }

  async removeWorktree(worktreePath: string, repoRoot: string, signal?: AbortSignal): Promise<void> {
    this.assertManagedPath(worktreePath)
    const result = await this.commands.run(['git', 'worktree', 'remove', '--force', worktreePath], repoRoot, { signal })
    if (result.exitCode !== 0 && existsSync(worktreePath)) {
      throw new Error(`git worktree remove failed: ${result.stderr.trim() || result.stdout.trim()}`)
    }
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true })
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
