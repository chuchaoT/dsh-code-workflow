import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SideEffectService } from '../../src/side-effects.ts'
import { AutoDevStore } from '../../src/store.ts'

const [
  dataRoot,
  runId,
  workerRoot,
  workerIndex,
  workerCount,
  readyPath,
  startPath,
  resultPath,
  failurePath,
] = process.argv.slice(2)
if ([
  dataRoot,
  runId,
  workerRoot,
  workerIndex,
  workerCount,
  readyPath,
  startPath,
  resultPath,
  failurePath,
].some(value => value === undefined)) {
  throw new Error([
    'usage: autodev-action-plan-race.ts <data-root> <run-id> <worker-root> <worker-index>',
    '<worker-count> <ready> <start> <result> <failure>',
  ].join(' '))
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

try {
  const store = new AutoDevStore(dataRoot as string)
  try {
    const listActionIntents = store.listActionIntents.bind(store)
    store.listActionIntents = (requestedRunId?: string) => {
      const intents = listActionIntents(requestedRunId)
      // Recreate the old check-then-write race deterministically: all Hosts
      // observe the absent key before any is allowed to return from the lookup.
      writeFileSync(join(workerRoot as string, `looked-up-${workerIndex as string}`), 'read')
      const deadline = Date.now() + 120_000
      while (!Array.from({ length: Number(workerCount) }, (_, index) => existsSync(join(workerRoot as string, `looked-up-${index}`))).every(Boolean)) {
        if (Date.now() >= deadline) throw new Error('action-plan lookup barrier timed out')
      }
      return intents
    }

    writeFileSync(readyPath as string, 'ready')
    const deadline = Date.now() + 120_000
    while (!existsSync(startPath as string)) {
      if (Date.now() >= deadline) throw new Error('action-plan start barrier timed out')
      await wait(5)
    }

    const intent = new SideEffectService(store).plan({
      runId: runId as string,
      kind: 'command',
      target: 'same concurrent command',
      risk: 'low',
    })
    writeFileSync(resultPath as string, JSON.stringify({ intentId: intent.id }))
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
