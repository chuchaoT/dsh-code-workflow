import { existsSync, writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { AutoDevRuntime } from '../../src/runtime.ts'

const [dataRoot, worktreeRoot, runId, readyPath, startPath, resultPath, failurePath] = process.argv.slice(2)
if ([dataRoot, worktreeRoot, runId, readyPath, startPath, resultPath, failurePath].some(value => value === undefined)) {
  throw new Error('usage: autodev-promotion-race.ts <data-root> <worktree-root> <run-id> <ready> <start> <result> <failure>')
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

try {
  const runtime = new AutoDevRuntime(new Context(), {
    dataRoot: dataRoot as string,
    worktreeRoot: worktreeRoot as string,
    jev: { mode: 'off' },
  })
  try {
    writeFileSync(readyPath as string, 'ready')
    const deadline = Date.now() + 120_000
    while (!existsSync(startPath as string)) {
      if (Date.now() >= deadline) throw new Error('promotion race start barrier timed out')
      await wait(5)
    }

    try {
      const snapshot = await runtime.promote(runId as string)
      writeFileSync(resultPath as string, JSON.stringify({ outcome: 'fulfilled', status: snapshot.run.status }))
    } catch (error: unknown) {
      const details = error instanceof Error
        ? error as Error & { readonly code?: unknown; readonly errcode?: unknown; readonly errno?: unknown }
        : undefined
      writeFileSync(resultPath as string, JSON.stringify({
        outcome: 'rejected',
        error: error instanceof Error ? error.message : String(error),
        ...(details?.code === undefined ? {} : { errorCode: details.code }),
        ...(details?.errcode === undefined ? {} : { sqliteCode: details.errcode }),
        ...(details?.errno === undefined ? {} : { sqliteErrno: details.errno }),
      }))
    }
  } finally {
    runtime.store.close()
  }
} catch (error: unknown) {
  try {
    writeFileSync(failurePath as string, error instanceof Error ? error.stack ?? error.message : String(error))
  } catch (_failureReportUnavailable) {
    // The parent test also captures the process exit status.
  }
  process.exitCode = 1
}
