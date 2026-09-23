import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandExecutor, CommandResult } from '../src/command.ts'
import { HarnessCommandExecutor } from '../src/command.ts'
import type { ScopeRef } from '../src/contracts.ts'
import { BusinessConceptService } from '../src/concepts.ts'
import { KnowledgeService } from '../src/knowledge.ts'
import { ProjectMemoryService } from '../src/memory.ts'
import { PlaybookService } from '../src/playbook.ts'
import { AutoDevRuntime } from '../src/runtime.ts'
import { SemanticService } from '../src/semantics.ts'
import { SideEffectService } from '../src/side-effects.ts'
import { AutoDevStore } from '../src/store.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-autodev-domain-${label}-`))
  roots.push(root)
  return root
}

const scope = (projectKey: string): ScopeRef => ({ projectKey })

describe('project memory and semantic state', () => {
  it('isolates project memory and returns bounded progressive context', () => {
    const store = new AutoDevStore(tempRoot('memory'))
    try {
      const memory = new ProjectMemoryService(store)
      memory.remember({ scope: scope('project-a'), kind: 'fact', title: 'Build rule', content: 'Use the deterministic Maven build before promotion.', tags: ['maven'], status: 'ESTABLISHED', confidence: 0.9 })
      memory.remember({ scope: scope('project-b'), kind: 'fact', title: 'Other project', content: 'Use a different build rule.' })

      const hits = memory.search('project-a', 'Maven promotion', { limit: 2, maxChars: 40 })
      expect(hits).toHaveLength(1)
      expect(hits[0]?.memory.scope.projectKey).toBe('project-a')
      expect(hits[0]?.memory.content.length).toBeLessThanOrEqual(40)
      expect(memory.search('project-a', 'different')).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('keeps assumptions and semantic uncertainty explicit until resolved', () => {
    const store = new AutoDevStore(tempRoot('semantics'))
    const semantics = new SemanticService(store)
    const assumption = semantics.raiseAssumption({ scope: scope('project-a'), runId: 'run-a', statement: 'refund means full monetary reversal' })
    expect(assumption.status).toBe('PROPOSED')
    expect(semantics.resolveAssumption(assumption.id, 'CONFIRMED', 'Confirmed by product owner').status).toBe('CONFIRMED')
    const uncertainty = semantics.raiseUncertainty({ scope: scope('project-a'), runId: 'run-a', subject: 'refund', reason: 'partial or full reversal is unclear', alternatives: ['partial', 'full'], severity: 'high' })
    expect(semantics.openForRun('run-a')).toHaveLength(1)
    expect(semantics.resolveUncertainty(uncertainty.id, 'RESOLVED', 'Product owner selected full reversal').status).toBe('RESOLVED')
    expect(semantics.openForRun('run-a')).toHaveLength(0)
    store.close()
  })
})

describe('business concepts and playbooks', () => {
  it('lets human correction outrank an agent candidate and matches by semantics', () => {
    const store = new AutoDevStore(tempRoot('concepts'))
    const concepts = new BusinessConceptService(store)
    const observed = concepts.observe({
      scope: scope('project-a'), key: 'refund', name: 'Refund', definition: 'Return money to the customer',
      target: 'customer payment', effect: 'full monetary reversal', evidenceSummary: 'Agent inferred refund behavior', confidence: 0.35,
    })
    expect(observed.concept.status).toBe('CANDIDATE')
    const corrected = concepts.correct({
      scope: scope('project-a'), key: 'refund', name: 'Refund', definition: 'Reverse the captured payment after an eligible cancellation',
      target: 'captured payment', effect: 'full monetary reversal', evidenceSummary: 'Human correction', resolution: 'Product definition', confidence: 0.1,
    })
    expect(corrected.status).toBe('ESTABLISHED')
    expect(corrected.confidence).toBe(1)
    expect(concepts.match(scope('project-a'), { target: 'captured payment', effect: 'full monetary reversal' })).toHaveLength(1)
    store.close()
  })

  it('evaluates Playbook fit as advisory MATCH/PARTIAL/MISMATCH with version evidence', () => {
    const store = new AutoDevStore(tempRoot('playbook'))
    const playbooks = new PlaybookService(store)
    const draft = playbooks.create({
      scope: scope('project-a'), key: 'safe-refund', name: 'Safe refund', purpose: 'Implement a refund flow',
      targets: ['captured payment'], effects: ['full monetary reversal'], conceptKeys: ['refund'], steps: ['validate eligibility', 'reverse payment'], requiredEvidence: ['BUILD'],
    })
    const active = playbooks.activate(draft.id)
    const match = playbooks.fit(active.id, { target: 'captured payment', effect: 'full monetary reversal', conceptKeys: ['refund'], evidenceTypes: ['BUILD'] }, 'run-a')
    expect(match.outcome).toBe('MATCH')
    expect(match.playbookVersion).toBe(1)
    const revised = playbooks.revise(active.id, {
      scope: scope('project-a'), key: 'safe-refund', name: 'Safe refund v2', purpose: 'Implement a refund flow with payment audit',
      targets: ['captured payment'], effects: ['full monetary reversal'], conceptKeys: ['refund'], steps: ['validate eligibility', 'reverse payment', 'write audit'], requiredEvidence: ['BUILD'],
    })
    expect(revised.version).toBe(2)
    expect(playbooks.fit(revised.id, { target: 'unrelated target', effect: 'unrelated effect' }, 'run-b').outcome).toBe('MISMATCH')
    expect(store.getPlaybook(active.id)?.status).toBe('DEPRECATED')
    expect(playbooks.list('project-a')[0]?.status).toBe('ACTIVE')
    store.close()
  })
})

describe('knowledge evolution and side effects', () => {
  it('requires evidence for promotion and compacts duplicates with regression coverage', () => {
    const store = new AutoDevStore(tempRoot('knowledge'))
    const knowledge = new KnowledgeService(store)
    const first = knowledge.candidate({ scope: scope('project-a'), kind: 'rule', statement: 'Run tests before promotion' })
    const second = knowledge.candidate({ scope: scope('project-a'), kind: 'rule', statement: 'Run tests before promotion', content: 'Duplicate observation' })
    expect(() => knowledge.promote(first.id, [])).toThrow(/Evidence/)
    const established = knowledge.promote(first.id, ['evidence-test'])
    expect(established.status).toBe('ESTABLISHED')
    expect(knowledge.recordUse(established.id, 'success').successCount).toBe(1)
    expect(knowledge.validate(established.id, ['evidence-revalidation']).lastValidatedAt).toBeDefined()
    const testCase = knowledge.createRegressionCase({ scope: scope('project-a'), name: 'promotion rule', query: 'promotion', expectedStatements: ['Run tests before promotion'] })
    expect(knowledge.runRegression(testCase.id).status).toBe('PASS')
    const report = knowledge.compact(scope('project-a'))
    expect(report.actions.some(action => action.kind === 'deprecated' && action.inputIds.includes(second.id))).toBe(true)
    expect(knowledge.list('project-a', true).find(item => item.id === second.id)?.status).toBe('DEPRECATED')
    store.close()
  })

  it('uses idempotency keys and never retries an UNKNOWN side effect automatically', () => {
    const store = new AutoDevStore(tempRoot('effects'))
    const effects = new SideEffectService(store)
    const first = effects.plan({ runId: 'run-a', kind: 'command', target: 'mvn test', risk: 'low' })
    const same = effects.plan({ runId: 'run-a', kind: 'command', target: 'mvn test', risk: 'low' })
    expect(same.id).toBe(first.id)
    effects.authorize(first.id, 'test policy')
    effects.start(first.id)
    const unknown = effects.unknown(first.id, 'process disappeared')
    expect(unknown.status).toBe('UNKNOWN')
    expect(effects.canRetry(unknown)).toBe(false)
    expect(store.listSideEffects('run-a').at(-1)?.status).toBe('UNKNOWN')
    store.close()
  })
})

describe('Runtime signal integration', () => {
  it('opens a semantic gate before Build/Test and persists the uncertainty', async () => {
    const repo = tempRoot('runtime-repo')
    const state = tempRoot('runtime-state')
    const worktrees = tempRoot('runtime-worktrees')
    await createGitRepo(repo)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: state, worktreeRoot: worktrees, jev: { mode: 'off' },
      maven: { executable: 'fake-mvn', buildArgs: ['package'], testArgs: ['test'] },
      routes: { implement: { candidates: [{ kind: 'command', provider: 'semantic-editor', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] } },
    }, { commands: new DomainCommandExecutor() })
    runtime.registerProvider({
      name: 'semantic-editor', kind: 'command', traits: ['code-edit', 'local-workspace'],
      run: async (request) => {
        request.emitSignal?.({ type: 'SemanticUncertainty', subject: 'refund', reason: 'partial versus full reversal is not specified', alternatives: ['partial', 'full'] })
        writeFileSync(join(request.cwd, 'SEMANTIC_GATE.txt'), 'candidate\n')
        return { provider: request.provider, status: 'completed', output: 'candidate created' }
      },
    })
    try {
      const created = await runtime.create({ repoPath: repo, request: 'implement refund handling' })
      const gated = await runtime.run(created.run.id)
      expect(gated.run.status).toBe('NEEDS_INTERVENTION')
      expect(gated.uncertainties[0]?.status).toBe('OPEN')
      expect(gated.evidence.some(item => item.type === 'BUILD')).toBe(false)
      expect(gated.evidence.some(item => item.type === 'TEST')).toBe(false)
      expect(gated.gates.at(-1)?.options).toContain('replan')
      expect(gated.actionIntents.some(item => item.kind === 'agent-workspace' && item.status === 'COMMITTED')).toBe(true)
    } finally {
      runtime.store.close()
    }
  })
})

class DomainCommandExecutor implements CommandExecutor {
  private readonly delegate = new HarnessCommandExecutor()

  run(...args: Parameters<CommandExecutor['run']>): ReturnType<CommandExecutor['run']> {
    const [argv, cwd] = args
    if (argv[0] === 'java' || argv[0] === 'mvn' || argv[0] === 'fake-mvn') {
      return Promise.resolve({ argv, cwd, exitCode: 0, signal: null, stdout: 'fake ok', stderr: '', timedOut: false, durationMs: 1 } satisfies CommandResult)
    }
    return this.delegate.run(...args)
  }
}

async function createGitRepo(root: string): Promise<void> {
  const executor = new HarnessCommandExecutor()
  writeFileSync(join(root, 'pom.xml'), '<project/>\n')
  writeFileSync(join(root, 'README.md'), 'baseline\n')
  const run = async (...argv: string[]) => {
    const result = await executor.run(argv, root)
    if (result.exitCode !== 0) throw new Error(`${argv.join(' ')} failed: ${result.stderr}`)
  }
  await run('git', 'init')
  await run('git', 'config', 'user.email', 'autodev-domain@example.invalid')
  await run('git', 'config', 'user.name', 'AutoDev Domain Test')
  await run('git', 'add', '.')
  await run('git', 'commit', '-m', 'initial')
}
