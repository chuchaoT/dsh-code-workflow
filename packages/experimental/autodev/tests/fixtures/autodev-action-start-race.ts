import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SideEffectService } from '../../src/side-effects.ts'
import { AutoDevStore } from '../../src/store.ts'

const [
  dataRoot,
  intentId,
  workerRoot,
  workerIndex,
  workerCount,
  operation,
  readyPath,
  startPath,
  resultPath,
  failurePath,
] = process.argv.slice(2)
if ([
  dataRoot,
  intentId,
  workerRoot,
  workerIndex,
  workerCount,
  operation,
  readyPath,
  startPath,
  resultPath,
  failurePath,
].some(value => value === undefined)) {
  throw new Error([
    'usage: autodev-action-start-race.ts <data-root> <intent-id> <worker-root> <worker-index>',
    '<worker-count> <operation> <ready> <start> <result> <failure>',
  ].join(' '))
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

try {
  const store = new AutoDevStore(dataRoot as string)
  try {
    const updateActionIntent = store.updateActionIntent.bind(store)
    store.updateActionIntent = (requestedId, update, createSideEffect) => {
      if (requestedId === intentId) {
        // Force every Host to contend at the atomic update boundary before any
        // one can acquire SQLite's write transaction.
        writeFileSync(join(workerRoot as string, `observed-action-${workerIndex as string}`), 'arrived')
        const lookupDeadline = Date.now() + 120_000
        while (!Array.from({ length: Number(workerCount) }, (_, index) => existsSync(join(workerRoot as string, `observed-action-${index}`))).every(Boolean)) {
          if (Date.now() >= lookupDeadline) throw new Error('ActionIntent race barrier timed out')
        }
      }
      return updateActionIntent(requestedId, update, createSideEffect)
    }

    writeFileSync(readyPath as string, 'ready')
    const deadline = Date.now() + 120_000
    while (!existsSync(startPath as string)) {
      if (Date.now() >= deadline) throw new Error('action-start start barrier timed out')
      await wait(5)
    }

    try {
      const service = new SideEffectService(store)
      const intent = operation === 'start'
        ? service.start(intentId as string)
        : operation === 'authorize-a'
          ? service.authorize(intentId as string, 'concurrent authorization A')
          : operation === 'authorize-b'
            ? service.authorize(intentId as string, 'concurrent authorization B')
            : operation === 'commit'
              ? service.commit(intentId as string, 'concurrent completion committed', undefined, undefined, ['race-evidence'])
              : operation === 'fail'
                ? service.fail(intentId as string, 'concurrent completion failed', ['race-evidence'])
                : (() => { throw new Error(`unsupported ActionIntent race operation ${operation as string}`) })()
      writeFileSync(resultPath as string, JSON.stringify({ outcome: 'success', operation, status: intent.status }))
    } catch (error: unknown) {
      writeFileSync(resultPath as string, JSON.stringify({
        outcome: 'rejected',
        operation,
        diagnostic: error instanceof Error ? error.message : String(error),
      }))
    }
  } finally {
    store.close()
  }
} catch (error: unknown) {
  try {
    writeFileSync(failurePath as string, error instanceof Error ? error.stack ?? error.message : String(error))
  } catch (_failureReportUnavailable) {
    // The parent test also captures the process exit status.
  }
  process.exitCode = 1
}
