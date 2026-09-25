import { writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { AutoDevRuntime } from '../../src/runtime.ts'

const [dataRoot, worktreeRoot, runId, gateId, readyPath, failurePath] = process.argv.slice(2)
if ([dataRoot, worktreeRoot, runId, gateId, readyPath, failurePath].some(value => value === undefined)) {
  throw new Error('usage: autodev-promotion-gate-exit.ts <data-root> <worktree-root> <run-id> <gate-id> <ready> <failure>')
}

function reportFailure(error: unknown): void {
  try {
    writeFileSync(failurePath as string, error instanceof Error ? error.stack ?? error.message : String(error))
  } catch (_failureReportUnavailable) {
    // The parent test also captures this process's exit status.
  }
}

const runtime = new AutoDevRuntime(new Context(), {
  dataRoot: dataRoot as string,
  worktreeRoot: worktreeRoot as string,
  jev: { mode: 'off' },
})
runtime.git.treeHash = async () => {
  const run = runtime.store.getRun(runId as string)
  const gate = runtime.store.getGate(gateId as string)
  const pendingPromotions = runtime.store.listActionIntents(runId as string).filter(intent => intent.kind === 'git-promotion')
  if (run?.status !== 'PROMOTING' || run.currentGateId !== undefined
    || gate?.status !== 'RESOLVED' || gate.selected !== 'promote' || pendingPromotions.length !== 0) {
    throw new Error(`unexpected state at pre-intent Promotion barrier: run=${run?.status ?? 'missing'}; gate=${gate?.status ?? 'missing'}/${gate?.selected ?? 'none'}; intents=${pendingPromotions.length}`)
  }
  writeFileSync(readyPath as string, JSON.stringify({
    processId: process.pid,
    runId,
    gateId,
    runStatus: run.status,
    gateStatus: gate.status,
    selected: gate.selected,
    actionIntentCount: pendingPromotions.length,
  }))
  setInterval(() => {}, 1_000)
  await new Promise<void>(() => {})
  return ''
}

void runtime.resolveGate(runId as string, 'promote').then(
  () => {
    reportFailure(new Error('Promotion settled before the Host could be terminated'))
  },
  reportFailure,
)
