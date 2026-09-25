import { existsSync, writeFileSync } from 'node:fs'
import { AutoDevStore } from '../../src/store.ts'

const [dataRoot, workerIndex, readyPath, startPath, resultPath, failurePath] = process.argv.slice(2)
if ([dataRoot, workerIndex, readyPath, startPath, resultPath, failurePath].some(value => value === undefined)) {
  throw new Error('usage: autodev-migration-open.ts <data-root> <worker-index> <ready> <start> <result> <failure>')
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

try {
  writeFileSync(readyPath as string, String(workerIndex))
  const deadline = Date.now() + 30_000
  while (!existsSync(startPath as string)) {
    if (Date.now() >= deadline) throw new Error('migration worker start barrier timed out')
    await wait(5)
  }
  const store = new AutoDevStore(dataRoot as string)
  store.close()
  writeFileSync(resultPath as string, 'opened')
} catch (error: unknown) {
  try {
    writeFileSync(failurePath as string, error instanceof Error ? error.stack ?? error.message : String(error))
  } catch {
    // The parent also captures the process exit status.
  }
  process.exitCode = 1
}
