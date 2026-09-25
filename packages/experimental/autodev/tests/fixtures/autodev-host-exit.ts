import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import LocalSubprocessRuntime from '../../../../subprocess/subprocess-local/src/index.ts'
import { HarnessCommandExecutor, type CommandExecutor } from '../../src/command.ts'
import { AutoDevRuntime } from '../../src/runtime.ts'

const [repoPath, dataRoot, worktreeRoot, startedPath, readyPath, failurePath, requestedStage, requestedEffectUrl] = process.argv.slice(2)
if ([repoPath, dataRoot, worktreeRoot, startedPath, readyPath, failurePath].some(value => value === undefined)) {
  throw new Error('usage: autodev-host-exit.ts <repo> <data-root> <worktree-root> <started> <ready> <failure> [provider|build|test] <effect-url>')
}
const stage = requestedStage ?? 'provider'
if (!['provider', 'build', 'test', 'promotion'].includes(stage)) throw new Error(`unsupported Host-exit stage ${stage}`)
if (requestedEffectUrl === undefined) throw new Error('Host-exit fixture requires a loopback effect URL')

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function reportFailure(error: unknown): void {
  try {
    writeFileSync(failurePath as string, error instanceof Error ? error.stack ?? error.message : String(error))
  } catch (_failureReportUnavailable) {
    // The parent test also captures this process's exit status.
  }
}

const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
const interruptedCommand = [
  '-e',
  "const fs=require('node:fs'); const http=require('node:http'); const request=http.request(process.argv[2], {method:'POST',headers:{'content-type':'application/json','idempotency-key':'host-exit-fixture-effect'}}, response=>{let body=''; response.setEncoding('utf8'); response.on('data',chunk=>body+=chunk); response.on('end',()=>{if(response.statusCode!==202) throw new Error('loopback service did not accept effect'); fs.writeFileSync('AUTODEV_INTERRUPTED_EFFECT.txt', 'effect-applied:'+process.pid+':'+body); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)})}); request.on('error', error=>{console.error(error); process.exit(1)}); request.end(JSON.stringify({effect:'host-exit-fixture'}))",
  startedPath as string,
  requestedEffectUrl,
]
const shortCommand = ['-e', 'process.exit(0)']
const promotionDelegate = new HarnessCommandExecutor()
const promotionCommands: CommandExecutor = {
  async run(argv, cwd, options) {
    const result = await promotionDelegate.run(argv, cwd, options)
    if (stage === 'promotion' && argv[0] === 'git' && argv[1] === 'apply' && result.exitCode === 0) {
      writeFileSync(startedPath as string, String(process.pid))
      await new Promise<void>(() => {})
    }
    return result
  },
}
const runtime = new AutoDevRuntime(ctx, {
  dataRoot: dataRoot as string,
  worktreeRoot: worktreeRoot as string,
  jev: { mode: 'off' },
  ...(stage === 'provider' ? {} : {
    buildDriver: 'maven' as const,
    maven: {
      executable: process.execPath,
      buildArgs: stage === 'build' ? interruptedCommand : shortCommand,
      testArgs: stage === 'test' ? interruptedCommand : shortCommand,
    },
  }),
  routes: {
    implement: {
      candidates: [{ kind: 'command', provider: 'host-exit-fixture', traits: ['code-edit', 'local-workspace'] }],
      requiredTaskTraits: ['code-edit', 'local-workspace'],
    },
  },
}, stage === 'promotion' ? { commands: promotionCommands } : {})
runtime.registerProvider({
  name: 'host-exit-fixture',
  kind: 'command',
  traits: ['code-edit', 'local-workspace'],
  workspaceCwd: true,
  async run(request) {
    if (stage === 'provider') {
      await runtime.commands.run([process.execPath, ...interruptedCommand], request.cwd, { signal: request.signal, timeoutMs: 60_000 })
      return { provider: request.provider, status: 'completed', output: 'unexpectedly completed' }
    }
    if (stage === 'promotion') {
      writeFileSync(join(request.cwd, 'AUTODEV_PROMOTION_EFFECT.txt'), 'candidate-effect\n')
      return { provider: request.provider, status: 'completed', output: 'candidate ready for promotion interruption' }
    }
    return { provider: request.provider, status: 'completed', output: `implementation ready for ${stage} interruption` }
  },
})

try {
  const created = await runtime.create({ repoPath: repoPath as string, request: 'exercise host-exit recovery' })
  runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
  if (stage === 'promotion') {
    const verified = await runtime.run(created.run.id)
    if (verified.run.status !== 'VERIFY' || verified.candidate === undefined) {
      throw new Error(`promotion fixture did not produce a verified Candidate: ${verified.run.status}`)
    }
    void runtime.promote(created.run.id).then((snapshot) => {
      reportFailure(new Error(`Promotion unexpectedly settled as ${snapshot.run.status} before Host termination`))
    }, reportFailure)
  } else {
    void runtime.run(created.run.id).then((snapshot) => {
      reportFailure(new Error(`Run unexpectedly settled as ${snapshot.run.status} before Host termination`))
    }, reportFailure)
  }

  const deadline = Date.now() + 60_000
  while (!existsSync(startedPath as string)) {
    if (existsSync(failurePath as string)) throw new Error(readFileSync(failurePath as string, 'utf8'))
    if (Date.now() >= deadline) throw new Error(`${stage} interruption did not reach its effect marker`)
    await wait(10)
  }
  const snapshot = runtime.snapshot(created.run.id)
  const expectedStatus = stage === 'provider' ? 'EXECUTING' : stage === 'build' ? 'BUILDING' : stage === 'test' ? 'TESTING' : 'PROMOTING'
  const expectedNodeId = stage === 'provider' ? 'implement' : stage === 'promotion' ? undefined : stage
  const worktreePath = snapshot.run.worktreePath
  const runningIntent = snapshot.actionIntents.find(item => stage === 'provider'
    ? item.kind === 'agent-workspace'
    : stage === 'promotion'
      ? item.kind === 'git-promotion'
      : item.kind === 'command' && item.nodeId === expectedNodeId)
  const runningNode = expectedNodeId === undefined || snapshot.nodes.some(item => item.nodeId === expectedNodeId && item.status === 'RUNNING')
  if (snapshot.run.status !== expectedStatus || worktreePath === undefined || !runningNode || runningIntent?.status !== 'EXECUTING') {
    throw new Error(`AutoDev in-flight state mismatch for ${stage}: run=${snapshot.run.status}; runningNode=${runningNode}; intent=${runningIntent?.status ?? 'missing'}`)
  }
  const candidateTreeHash = snapshot.candidate?.gitTreeHash
  const repoTreeHash = stage === 'promotion' ? await runtime.git.treeHash(snapshot.run.repoRoot) : undefined
  if (stage === 'promotion' && (candidateTreeHash === undefined || repoTreeHash !== candidateTreeHash)) {
    throw new Error(`Git patch effect was not fully applied before simulated Host failure: repo=${repoTreeHash ?? 'missing'}; candidate=${candidateTreeHash ?? 'missing'}`)
  }
  writeFileSync(readyPath as string, JSON.stringify({
    runId: created.run.id,
    targetPid: Number(readFileSync(startedPath as string, 'utf8')),
    stage,
    worktreePath,
    ...(candidateTreeHash === undefined ? {} : { candidateTreeHash }),
    ...(repoTreeHash === undefined ? {} : { repoTreeHash }),
  }))
  await new Promise<void>(() => {})
} catch (error: unknown) {
  reportFailure(error)
  process.exit(1)
}
