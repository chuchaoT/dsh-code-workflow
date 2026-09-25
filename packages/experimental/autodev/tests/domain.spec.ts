import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandExecutor, CommandResult } from '../src/command.ts'
import { HarnessCommandExecutor } from '../src/command.ts'
import type { ScopeRef } from '../src/contracts.ts'
import type { AutoDevAgentContext } from '../src/protocol.ts'
import { BusinessConceptService } from '../src/concepts.ts'
import { KnowledgeService } from '../src/knowledge.ts'
import { ProjectMemoryService } from '../src/memory.ts'
import { PlaybookService } from '../src/playbook.ts'
import { AutoDevRuntime } from '../src/runtime.ts'
import { SemanticService } from '../src/semantics.ts'
import { SideEffectService } from '../src/side-effects.ts'
import { AutoDevStore } from '../src/store.ts'
import { trustedTestDecisions } from './harness.ts'

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
  it('reads legacy source references from records and events without writing the old field again', () => {
    const root = tempRoot('legacy-source-refs')
    const store = new AutoDevStore(root)
    const sourceRefs = [{ sourceType: 'human' as const, sourceId: 'manual-1' }]
    const migratedSourceRefs = [...sourceRefs, { sourceType: 'system' as const, sourceId: 'legacy-2' }]
    const remembered = new ProjectMemoryService(store).remember({
      scope: scope('project-a'), kind: 'fact', title: 'Build rule', content: 'Use the approved build command.', sourceRefs,
    })
    store.close()

    const legacySourceRefsKey = ['pro', 'venance'].join('')
    const db = new DatabaseSync(join(root, 'autodev.sqlite'))
    const record = db.prepare('SELECT value FROM autodev_records WHERE kind = ? AND id = ?').get('memory', remembered.id) as { value: string }
    const legacyRecord = JSON.parse(record.value) as Record<string, unknown>
    legacyRecord[legacySourceRefsKey] = [{ sourceType: 'system', sourceId: 'legacy-2' }]
    db.prepare('UPDATE autodev_records SET value = ? WHERE kind = ? AND id = ?').run(JSON.stringify(legacyRecord), 'memory', remembered.id)

    const event = db.prepare('SELECT payload FROM autodev_events WHERE run_id = ? AND type = ?').get('project-a', 'memory/updated') as { payload: string }
    const legacyPayload = JSON.parse(event.payload) as Record<string, unknown>
    legacyPayload[legacySourceRefsKey] = legacyPayload.sourceRefs
    delete legacyPayload.sourceRefs
    db.prepare('UPDATE autodev_events SET payload = ? WHERE run_id = ? AND type = ?').run(JSON.stringify(legacyPayload), 'project-a', 'memory/updated')
    db.close()

    const reopened = new AutoDevStore(root)
    try {
      const restored = reopened.getMemory(remembered.id)
      expect(restored?.sourceRefs).toEqual(migratedSourceRefs)
      expect(Object.hasOwn(restored ?? {}, legacySourceRefsKey)).toBe(false)
      const payload = reopened.events('project-a')[0]?.payload as Record<string, unknown>
      expect(payload.sourceRefs).toEqual(sourceRefs)
      expect(Object.hasOwn(payload, legacySourceRefsKey)).toBe(false)

      reopened.saveMemory(restored!)
      const check = new DatabaseSync(join(root, 'autodev.sqlite'))
      try {
        const persisted = check.prepare('SELECT value FROM autodev_records WHERE kind = ? AND id = ?').get('memory', remembered.id) as { value: string }
        expect(JSON.parse(persisted.value)).toHaveProperty('sourceRefs', migratedSourceRefs)
        expect(persisted.value).not.toContain(legacySourceRefsKey)
      } finally {
        check.close()
      }
    } finally {
      reopened.close()
    }
  })

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
    expect(() => semantics.resolveAssumption(assumption.id, 'CONFIRMED', 'fabricated evidence', ['missing-evidence'])).toThrow(/Evidence missing-evidence does not exist/)
    expect(semantics.resolveAssumption(assumption.id, 'CONFIRMED', 'Confirmed by product owner').status).toBe('CONFIRMED')
    const uncertainty = semantics.raiseUncertainty({ scope: scope('project-a'), runId: 'run-a', subject: 'refund', reason: 'partial or full reversal is unclear', alternatives: ['partial', 'full'], severity: 'high' })
    expect(semantics.openForRun('run-a')).toHaveLength(1)
    expect(semantics.resolveUncertainty(uncertainty.id, 'RESOLVED', 'Product owner selected full reversal').status).toBe('RESOLVED')
    expect(semantics.openForRun('run-a')).toHaveLength(0)
    store.close()
  })

  it('invalidates a confirmed assumption when its cited Evidence later fails', () => {
    const store = new AutoDevStore(tempRoot('assumption-evidence-conflict'))
    const semantics = new SemanticService(store)
    try {
      saveEvidence(store, 'assumption-evidence', scope('project-a'))
      const evidence = store.getEvidence('assumption-evidence')
      if (evidence === undefined) throw new Error('assumption Evidence fixture was not saved')
      const assumption = semantics.raiseAssumption({
        scope: scope('project-a'), runId: evidence.runId, statement: 'baseline behavior is valid', evidenceIds: [evidence.id],
      })
      expect(semantics.resolveAssumption(assumption.id, 'CONFIRMED', 'Confirmed against the current baseline').status).toBe('CONFIRMED')

      store.saveEvidence({ ...evidence, status: 'FAIL', summary: 'later verification contradicts the assumption' })
      const reconciled = semantics.reconcileAssumptionEvidence(evidence.runId)
      expect(reconciled).toHaveLength(1)
      expect(reconciled[0]).toMatchObject({ id: assumption.id, status: 'INVALIDATED' })
      expect(reconciled[0]?.resolution).toContain(`${evidence.id}=FAIL`)
      expect(reconciled[0]?.sourceRefs.at(-1)).toMatchObject({ sourceType: 'system', evidenceIds: [evidence.id] })
      expect(store.getAssumption(assumption.id)?.status).toBe('INVALIDATED')

      const untrusted = semantics.raiseAssumption({ scope: scope('project-a'), runId: evidence.runId, statement: 'agent report is true' })
      store.saveEvidence({ ...evidence, id: 'agent-confirmation-evidence', status: 'PASS', source: 'agent' })
      expect(() => semantics.resolveAssumption(untrusted.id, 'CONFIRMED', 'Agent reported it', ['agent-confirmation-evidence']))
        .toThrow(/cannot be confirmed with non-passing, untrusted/)
    } finally {
      store.close()
    }
  })

  it('requires exact six-dimension scope alignment between an assumption and its Evidence', () => {
    const store = new AutoDevStore(tempRoot('assumption-six-dimension-scope'))
    const semantics = new SemanticService(store)
    const evidenceScope: ScopeRef = {
      projectKey: 'project-a', module: 'web', branch: 'main', language: 'typescript',
      projectVersion: '2', schemaVersion: '4', techStackVersion: 'node-22',
    }
    const dimensions = [
      ['module', evidenceScope.module],
      ['branch', evidenceScope.branch],
      ['language', evidenceScope.language],
      ['projectVersion', evidenceScope.projectVersion],
      ['schemaVersion', evidenceScope.schemaVersion],
      ['techStackVersion', evidenceScope.techStackVersion],
    ] as const
    try {
      saveEvidence(store, 'six-dimension-evidence', evidenceScope)
      const evidence = store.getEvidence('six-dimension-evidence')
      if (evidence === undefined) throw new Error('six-dimension Evidence fixture was not saved')
      for (const [dimension, value] of dimensions) {
        const conflictingScope = { ...evidenceScope, [dimension]: `${value}-other` } as ScopeRef
        expect(() => semantics.raiseAssumption({
          scope: conflictingScope, runId: evidence.runId, statement: `conflict on ${dimension}`, evidenceIds: [evidence.id],
        }), dimension).toThrow(/outside the assumption scope/)
      }
    } finally {
      store.close()
    }
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
    expect(store.listConceptObservations(scope('project-a')).map(item => item.relationship)).toContain('SUPPORTING')
    expect(store.listConceptObservations(scope('project-a')).map(item => item.relationship)).toContain('HUMAN_CORRECTION')
    expect(concepts.match(scope('project-a'), { target: 'captured payment', effect: 'full monetary reversal' })).toHaveLength(1)
    expect(concepts.match(scope('project-a'), { target: 'captured payment', effect: 'partial reversal' })).toHaveLength(0)
    const ambiguous = concepts.observe({
      scope: scope('project-a'), key: 'refund', name: 'Refund alternate', definition: 'A separate bank adjustment',
      target: 'bank account', effect: 'fee reversal', evidenceSummary: 'Unresolved alternate interpretation', confidence: 0.99,
    })
    expect(ambiguous.observation.relationship).toBe('AMBIGUOUS')
    expect(ambiguous.concept.target).toBe('captured payment')
    expect(ambiguous.concept.confidence).toBe(1)
    expect(store.listConceptObservations(scope('project-a'))).toHaveLength(3)
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
    const match = playbooks.fit(active.id, { scope: scope('project-a'), target: 'captured payment', effect: 'full monetary reversal', conceptKeys: ['refund'], evidenceTypes: ['BUILD'] }, 'run-a')
    expect(match.outcome).toBe('MATCH')
    expect(match.playbookVersion).toBe(1)
    expect(playbooks.fit(active.id, { scope: scope('project-a'), target: 'captured payment', effect: 'full monetary reversal', conceptKeys: ['refund'] }, 'run-partial').outcome).toBe('PARTIAL')
    expect(playbooks.fit(active.id, { scope: scope('project-a'), target: 'store credit balance', effect: 'issue goodwill credit', conceptKeys: ['refund'], evidenceTypes: ['BUILD'] }, 'run-semantic-mismatch').outcome).toBe('MISMATCH')
    expect(() => playbooks.fit(active.id, { scope: scope('project-a'), target: ' ', effect: 'full monetary reversal' }))
      .toThrow(/playbook fit target must be non-empty/)
    expect(() => playbooks.fit(active.id, { scope: scope('project-a'), target: 'captured payment', effect: '\t ' }))
      .toThrow(/playbook fit effect must be non-empty/)
    const revised = playbooks.revise(active.id, {
      scope: scope('project-a'), key: 'safe-refund', name: 'Safe refund v2', purpose: 'Implement a refund flow with payment audit',
      targets: ['captured payment'], effects: ['full monetary reversal'], conceptKeys: ['refund'], steps: ['validate eligibility', 'reverse payment', 'write audit'], requiredEvidence: ['BUILD'],
    })
    expect(revised.version).toBe(2)
    expect(playbooks.fit(revised.id, { scope: scope('project-a'), target: 'unrelated target', effect: 'unrelated effect' }, 'run-b').outcome).toBe('MISMATCH')
    expect(store.getPlaybook(active.id)?.status).toBe('DEPRECATED')
    expect(playbooks.list('project-a')[0]?.status).toBe('ACTIVE')
    store.close()
  })

  it('rejects a Playbook fit when any of the six scoped dimensions conflicts', () => {
    const store = new AutoDevStore(tempRoot('playbook-six-dimension-scope'))
    const playbooks = new PlaybookService(store)
    const playbookScope: ScopeRef = {
      projectKey: 'project-a', module: 'web', branch: 'main', language: 'typescript',
      projectVersion: '2', schemaVersion: '4', techStackVersion: 'node-22',
    }
    const dimensions = [
      ['module', playbookScope.module],
      ['branch', playbookScope.branch],
      ['language', playbookScope.language],
      ['projectVersion', playbookScope.projectVersion],
      ['schemaVersion', playbookScope.schemaVersion],
      ['techStackVersion', playbookScope.techStackVersion],
    ] as const
    try {
      const playbook = playbooks.activate(playbooks.create({
        scope: playbookScope, key: 'scoped-refund', name: 'Scoped refund', purpose: 'Reverse a captured payment',
        targets: ['captured payment'], effects: ['full reversal'], steps: ['validate', 'reverse'],
      }).id)
      for (const [dimension, value] of dimensions) {
        const conflictingScope = { ...playbookScope, [dimension]: `${value}-other` } as ScopeRef
        const fit = playbooks.fit(playbook.id, {
          scope: conflictingScope, target: 'captured payment', effect: 'full reversal',
        }, `run-conflict-${dimension}`)
        expect(fit.outcome, dimension).toBe('MISMATCH')
        expect(fit.missing, dimension).toContain('scope')
      }
    } finally {
      store.close()
    }
  })
})

describe('scope-aware project knowledge', () => {
  it('isolates module and version records while allowing broad records to apply', () => {
    const store = new AutoDevStore(tempRoot('scopes'))
    try {
      const memory = new ProjectMemoryService(store)
      const concepts = new BusinessConceptService(store)
      const playbooks = new PlaybookService(store)
      const knowledge = new KnowledgeService(store)
      const webScope: ScopeRef = { projectKey: 'project-a', module: 'web', branch: 'main', projectVersion: '2' }
      const apiScope: ScopeRef = { projectKey: 'project-a', module: 'api', branch: 'main', projectVersion: '2' }

      memory.remember({ scope: scope('project-a'), kind: 'rule', title: 'Shared invariant', content: 'Keep shared-refund behavior consistent.' })
      memory.remember({ scope: webScope, kind: 'rule', title: 'Web invariant', content: 'Keep shared-refund behavior consistent in the web module.' })
      memory.remember({ scope: apiScope, kind: 'rule', title: 'API invariant', content: 'Keep shared-refund behavior consistent in the api module.' })
      const scopedMemoryHits = memory.search(webScope, 'shared-refund behavior')
      expect(scopedMemoryHits.map(hit => hit.memory.title)).toEqual(['Web invariant', 'Shared invariant'])
      expect(memory.search('project-a', 'shared-refund behavior').map(hit => hit.memory.title)).toEqual(['Shared invariant'])

      const webConcept = concepts.observe({ scope: webScope, key: 'refund', name: 'Web refund', definition: 'Web payment reversal', target: 'web payment', effect: 'web reversal', evidenceCriteria: ['settled payment'], evidenceSummary: 'web evidence' }).concept
      const apiConcept = concepts.observe({ scope: apiScope, key: 'refund', name: 'API refund', definition: 'API payment reversal', target: 'api payment', effect: 'api reversal', evidenceSummary: 'api evidence' }).concept
      expect(webConcept.id).not.toBe(apiConcept.id)
      const corrected = concepts.correct({ scope: webScope, key: 'refund', name: 'Corrected web refund', definition: 'Human-defined web payment reversal', target: 'web payment', effect: 'web reversal', evidenceSummary: 'correction', resolution: 'scope test' })
      expect(corrected.id).toBe(webConcept.id)
      expect(store.getConcept(apiConcept.id)?.name).toBe('API refund')
      expect(concepts.search(webScope, 'refund')[0]?.name).toBe('Corrected web refund')
      expect(concepts.match(webScope, { target: 'web payment', effect: 'web reversal', evidence: ['unrelated evidence'] })).toHaveLength(0)
      expect(concepts.match(webScope, { target: 'web payment', effect: 'web reversal', evidence: ['settled payment'] })).toHaveLength(1)

      const webPlaybook = playbooks.activate(playbooks.create({
        scope: webScope, key: 'web-refund', name: 'Web refund', purpose: 'Handle web refunds', targets: ['web payment'], effects: ['web reversal'], exclusions: ['chargeback'], steps: ['reverse web payment'],
      }).id)
      const apiPlaybook = playbooks.activate(playbooks.create({
        scope: apiScope, key: 'api-refund', name: 'API refund', purpose: 'Handle API refunds', targets: ['api payment'], effects: ['api reversal'], steps: ['reverse API payment'],
      }).id)
      expect(playbooks.list(webScope).map(item => item.id)).toContain(webPlaybook.id)
      expect(playbooks.list(webScope).map(item => item.id)).not.toContain(apiPlaybook.id)
      expect(playbooks.fit(webPlaybook.id, { scope: apiScope, target: 'web payment', effect: 'web reversal' }).outcome).toBe('MISMATCH')
      expect(playbooks.fit(webPlaybook.id, { scope: webScope, target: 'web payment', effect: 'web reversal' }).outcome).toBe('MATCH')
      expect(playbooks.fit(webPlaybook.id, { scope: webScope, target: 'web payment', effect: 'web reversal after chargeback' }).missing).toContain('excluded:chargeback')

      const webKnowledge = knowledge.candidate({ scope: webScope, kind: 'rule', statement: 'same statement', content: 'same statement' })
      const apiKnowledge = knowledge.candidate({ scope: apiScope, kind: 'rule', statement: 'same statement', content: 'same statement' })
      expect(knowledge.list(webScope).map(item => item.id)).toContain(webKnowledge.id)
      expect(knowledge.list(webScope).map(item => item.id)).not.toContain(apiKnowledge.id)
      expect(knowledge.list('project-a')).toHaveLength(0)
      knowledge.compact(scope('project-a'))
      expect(knowledge.get(webKnowledge.id)?.status).toBe('CANDIDATE')
      expect(knowledge.get(apiKnowledge.id)?.status).toBe('CANDIDATE')

      memory.compact(scope('project-a'))
      expect(memory.list(webScope).some(item => item.status === 'DEPRECATED')).toBe(false)
      expect(memory.list(apiScope).some(item => item.status === 'DEPRECATED')).toBe(false)
    } finally {
      store.close()
    }
  })

  it('keeps Knowledge regression suites isolated across project versions', () => {
    const store = new AutoDevStore(tempRoot('knowledge-version-regression'))
    try {
      const knowledge = new KnowledgeService(store)
      const versionOne: ScopeRef = { projectKey: 'project-a', module: 'billing', projectVersion: '1' }
      const versionTwo: ScopeRef = { projectKey: 'project-a', module: 'billing', projectVersion: '2' }
      const legacy = knowledge.candidate({ scope: versionOne, kind: 'rule', statement: 'Legacy refund permits partial reversal' })
      const current = knowledge.candidate({ scope: versionTwo, kind: 'rule', statement: 'Current refund requires full reversal' })
      const legacyCase = knowledge.createRegressionCase({
        scope: versionOne, name: 'v1 refund contract', query: 'refund reversal',
        expectedStatements: ['Legacy refund permits partial reversal'],
      })
      const currentCase = knowledge.createRegressionCase({
        scope: versionTwo, name: 'v2 refund contract', query: 'refund reversal',
        expectedStatements: ['Current refund requires full reversal'],
        forbiddenStatements: ['Legacy refund permits partial reversal'],
      })

      const legacySuite = knowledge.runRegressionSuite(versionOne)
      const currentSuite = knowledge.runRegressionSuite(versionTwo)
      expect(legacySuite).toMatchObject({ status: 'PASS', caseIds: [legacyCase.id], testedKnowledgeVersions: [{ id: legacy.id, version: 1 }] })
      expect(currentSuite).toMatchObject({ status: 'PASS', caseIds: [currentCase.id], testedKnowledgeVersions: [{ id: current.id, version: 1 }] })
      expect(store.listRegressionResults(currentCase.id)[0]).toMatchObject({
        status: 'PASS', missing: [], unexpected: [], testedKnowledgeVersions: [{ id: current.id, version: 1 }],
      })
      expect(knowledge.search(versionTwo, 'legacy refund')).not.toContainEqual(expect.objectContaining({ id: legacy.id }))
      expect(knowledge.search(versionTwo, 'current refund').map(item => item.id)).toContain(current.id)
    } finally {
      store.close()
    }
  })

  it('compares immutable Playbook versions against a version-specific intent', () => {
    const store = new AutoDevStore(tempRoot('playbook-version-regression'))
    try {
      const playbooks = new PlaybookService(store)
      const versionOne: ScopeRef = { projectKey: 'project-a', projectVersion: '1' }
      const versionTwo: ScopeRef = { projectKey: 'project-a', projectVersion: '2' }
      const previous = playbooks.activate(playbooks.create({
        scope: versionOne, key: 'refund', name: 'Refund v1', purpose: 'Reverse a captured payment',
        targets: ['captured payment'], effects: ['full reversal'], steps: ['validate capture', 'reverse payment'],
      }).id)
      const revised = playbooks.revise(previous.id, {
        scope: versionTwo, key: 'refund', name: 'Refund v2', purpose: 'Partially reverse an eligible settled payment',
        targets: ['settled payment'], effects: ['partial reversal'], steps: ['validate settlement', 'reverse eligible amount'],
      })

      const oldVersionFit = playbooks.fit(previous.id, {
        scope: versionOne, target: 'settled payment', effect: 'partial reversal',
      }, 'run-version-one')
      const newVersionFit = playbooks.fit(revised.id, {
        scope: versionTwo, target: 'settled payment', effect: 'partial reversal',
      }, 'run-version-two')
      expect(oldVersionFit).toMatchObject({ outcome: 'MISMATCH', playbookId: previous.id, playbookVersion: 1 })
      expect(newVersionFit).toMatchObject({ outcome: 'MATCH', playbookId: revised.id, playbookVersion: 2 })
      expect(store.listPlaybookFits('run-version-one')).toContainEqual(oldVersionFit)
      expect(store.listPlaybookFits('run-version-two')).toContainEqual(newVersionFit)
      expect(store.getPlaybook(previous.id)).toMatchObject({ status: 'DEPRECATED', version: 1, supersededBy: revised.id, targets: ['captured payment'] })
      expect(store.getPlaybook(revised.id)).toMatchObject({ status: 'ACTIVE', version: 2, parentId: previous.id, scope: versionTwo })
    } finally {
      store.close()
    }
  })
})

describe('knowledge evolution and side effects', () => {
  it('proposes bounded same-scope Knowledge merges and requires a version-safe human decision', () => {
    const store = new AutoDevStore(tempRoot('knowledge-merge-proposals'))
    const knowledge = new KnowledgeService(store)
    const scopeRef = scope('project-a')
    try {
      const paymentOne = knowledge.candidate({ scope: scopeRef, kind: 'rule', statement: 'Use bounded retries for transient payment failures' })
      const paymentTwo = knowledge.candidate({ scope: scopeRef, kind: 'rule', statement: 'Use bounded retries for temporary payment failures' })
      const cacheOne = knowledge.candidate({ scope: scopeRef, kind: 'experience', statement: 'Cache stable product lookup results' })
      const cacheTwo = knowledge.candidate({ scope: scopeRef, kind: 'experience', statement: 'Cache stable product search results' })
      const foreign = knowledge.candidate({ scope: scope('project-b'), kind: 'rule', statement: 'Use bounded retries for transient payment failures' })
      const wrongKind = knowledge.candidate({ scope: scopeRef, kind: 'fact', statement: 'Cache stable product lookup results' })

      const proposals = knowledge.proposeMerges(scopeRef, { minSimilarity: 0.65, limit: 20 })
      const pair = (leftId: string, rightId: string) => proposals.find(proposal =>
        proposal.inputIds.includes(leftId) && proposal.inputIds.includes(rightId))
      const paymentProposal = pair(paymentOne.id, paymentTwo.id)
      const cacheProposal = pair(cacheOne.id, cacheTwo.id)
      expect(paymentProposal?.reason).toContain('Jaccard token overlap')
      expect(paymentProposal?.similarity).toBeGreaterThanOrEqual(0.7)
      expect(proposals.some(proposal => proposal.inputIds.includes(foreign.id))).toBe(false)
      expect(proposals.some(proposal => proposal.inputIds.includes(wrongKind.id) && proposal.inputIds.includes(cacheOne.id))).toBe(false)
      expect(store.getKnowledge(paymentOne.id)?.version).toBe(1)
      expect(store.getKnowledge(paymentTwo.id)?.status).toBe('CANDIDATE')

      const moduleScope = { ...scopeRef, module: 'web' }
      const moduleOne = knowledge.candidate({ scope: moduleScope, kind: 'rule', statement: 'Require bounded retries for gateway requests' })
      const moduleTwo = knowledge.candidate({ scope: moduleScope, kind: 'rule', statement: 'Require bounded retries for gateway calls' })
      const moduleProposals = knowledge.proposeMerges(moduleScope, { minSimilarity: 0.6, limit: 20 })
      expect(moduleProposals.some(proposal =>
        proposal.inputIds.includes(moduleOne.id) && proposal.inputIds.includes(moduleTwo.id),
      )).toBe(true)
      expect(moduleProposals.every(proposal => proposal.scope.module === 'web')).toBe(true)

      if (paymentProposal === undefined || cacheProposal === undefined) throw new Error('expected semantic merge proposals are missing')
      const rejected = knowledge.rejectMergeProposal(paymentProposal.id, 'The payment terms refer to different retry classes.')
      expect(rejected).toMatchObject({ status: 'REJECTED', resolution: 'The payment terms refer to different retry classes.' })

      const merged = knowledge.acceptMergeProposal(cacheProposal.id, {
        statement: 'Cache product lookup and search results only when their stable keys match',
        content: 'Human-reviewed guidance for caching semantically related product retrieval results.',
        resolution: 'Both records describe the same cache key and invalidation behavior.',
      })
      expect(merged).toMatchObject({ kind: 'experience', status: 'CANDIDATE', scope: scopeRef })
      expect(merged.sourceRefs.some(item => item.sourceType === 'human' && item.note?.includes('same cache key'))).toBe(true)
      expect(merged.sourceRefs.some(item => item.sourceType === 'system' && item.sourceId === `knowledge-merge:${cacheProposal.id}`)).toBe(true)
      expect(store.getKnowledge(cacheOne.id)).toMatchObject({ status: 'CANDIDATE', version: 1 })
      expect(store.getKnowledge(cacheTwo.id)).toMatchObject({ status: 'CANDIDATE', version: 1 })
      expect(store.getKnowledgeMergeProposal(cacheProposal.id)).toMatchObject({ status: 'ACCEPTED', outputKnowledgeId: merged.id })

      const staleOne = knowledge.candidate({ scope: scopeRef, kind: 'rule', statement: 'Validate payment settlement token' })
      const staleTwo = knowledge.candidate({ scope: scopeRef, kind: 'rule', statement: 'Validate payment settlement receipt' })
      const staleProposal = knowledge.proposeMerges(scopeRef, { minSimilarity: 0.6, limit: 20 })
        .find(proposal => proposal.inputIds.includes(staleOne.id) && proposal.inputIds.includes(staleTwo.id))
      if (staleProposal === undefined) throw new Error('stale merge proposal was not generated')
      knowledge.recordUse(staleOne.id, 'success')
      expect(() => knowledge.acceptMergeProposal(staleProposal.id, {
        statement: 'Validate settlement artifacts', resolution: 'Cannot accept a stale input snapshot.',
      })).toThrow(/became stale/)
      expect(store.getKnowledgeMergeProposal(staleProposal.id)?.status).toBe('STALE')
      expect(store.getKnowledgeMergeProposal(staleProposal.id)?.outputKnowledgeId).toBeUndefined()

      const expiringOne = knowledge.candidate({ scope: scopeRef, kind: 'fact', statement: 'Reject expired session token requests' })
      const expiringTwo = knowledge.candidate({ scope: scopeRef, kind: 'fact', statement: 'Reject expired session token calls' })
      const expiringProposal = knowledge.proposeMerges(scopeRef, { minSimilarity: 0.65, limit: 20 })
        .find(proposal => proposal.inputIds.includes(expiringOne.id) && proposal.inputIds.includes(expiringTwo.id))
      if (expiringProposal === undefined) throw new Error('expiring merge proposal was not generated')
      store.saveKnowledge({ ...expiringTwo, expiresAt: '2000-01-01T00:00:00.000Z' })
      expect(store.getKnowledge(expiringTwo.id)?.version).toBe(
        expiringProposal.inputVersions.find(item => item.id === expiringTwo.id)?.version,
      )
      expect(() => knowledge.acceptMergeProposal(expiringProposal.id, {
        statement: 'Reject expired session tokens', resolution: 'Expired source knowledge is not eligible for merging.',
      })).toThrow(/became stale/)
      expect(store.getKnowledgeMergeProposal(expiringProposal.id)?.status).toBe('STALE')
      expect(store.getKnowledgeMergeProposal(expiringProposal.id)?.outputKnowledgeId).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('bounds semantic merge proposals to the newest 200 same-scope records', () => {
    const store = new AutoDevStore(tempRoot('knowledge-merge-window'))
    const knowledge = new KnowledgeService(store)
    const scopeRef = scope('project-merge-window')
    const oldTime = '2000-01-01T00:00:00.000Z'
    const recentTime = '2099-01-01T00:00:00.000Z'
    try {
      const oldOne = knowledge.candidate({ scope: scopeRef, kind: 'rule', statement: 'Use archived payment reversal idempotency key' })
      const oldTwo = knowledge.candidate({ scope: scopeRef, kind: 'rule', statement: 'Use archived payment reversal idempotency token' })
      store.saveKnowledge({ ...oldOne, updatedAt: oldTime })
      store.saveKnowledge({ ...oldTwo, updatedAt: oldTime })

      for (let index = 0; index < 198; index++) {
        const candidate = knowledge.candidate({
          scope: scopeRef, kind: 'fact', statement: `Scoped candidate unique item-${String(index).padStart(3, '0')}`,
        })
        store.saveKnowledge({ ...candidate, updatedAt: recentTime })
      }
      const recentOne = knowledge.candidate({ scope: scopeRef, kind: 'rule', statement: 'Bounded semantic merge window policy alpha' })
      const recentTwo = knowledge.candidate({ scope: scopeRef, kind: 'rule', statement: 'Bounded semantic merge window policy beta' })
      store.saveKnowledge({ ...recentOne, updatedAt: recentTime })
      store.saveKnowledge({ ...recentTwo, updatedAt: recentTime })

      const proposals = knowledge.proposeMerges(scopeRef, { minSimilarity: 0.7, limit: 20 })
      expect(proposals, JSON.stringify(proposals.map(proposal => ({
        inputIds: proposal.inputIds,
        statements: proposal.inputIds.map(id => store.getKnowledge(id)?.statement),
        similarity: proposal.similarity,
      })))).toHaveLength(1)
      expect(proposals[0]?.inputIds).toEqual([recentOne.id, recentTwo.id].sort())
      expect(proposals[0]?.inputIds).not.toContain(oldOne.id)
      expect(proposals[0]?.inputIds).not.toContain(oldTwo.id)
      expect(knowledge.proposeMerges(scopeRef, { minSimilarity: 0.7, limit: 20 })).toEqual(proposals)
    } finally {
      store.close()
    }
  })

  it('exposes scoped Knowledge merge proposal, acceptance, and rejection through Host Remotes', async () => {
    const repo = tempRoot('knowledge-merge-remote-repo')
    const state = tempRoot('knowledge-merge-remote-state')
    const worktrees = tempRoot('knowledge-merge-remote-worktrees')
    await createGitRepo(repo)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: state, worktreeRoot: worktrees, jev: { mode: 'off' },
      maven: { executable: 'fake-mvn', buildArgs: ['package'], testArgs: ['test'] },
    }, { commands: new DomainCommandExecutor() })
    try {
      const created = await runtime.create({ repoPath: repo, request: 'review project knowledge merges' })
      const runScope = created.run.scope ?? { projectKey: repo }
      const acceptedLeft = runtime.knowledge.candidate({ scope: runScope, kind: 'rule', statement: 'Use bounded retry windows for service failures' })
      const acceptedRight = runtime.knowledge.candidate({ scope: runScope, kind: 'rule', statement: 'Use bounded retry windows for API failures' })
      const rejectedLeft = runtime.knowledge.candidate({ scope: runScope, kind: 'fact', statement: 'Catalog search uses stable product keys' })
      const rejectedRight = runtime.knowledge.candidate({ scope: runScope, kind: 'fact', statement: 'Catalog lookup uses stable product keys' })

      const proposed = runtime.remoteProposeKnowledgeMerges({ runId: created.run.id, minSimilarity: 0.6, limit: 20 })
      const acceptedProposal = proposed.knowledgeMergeProposals.find(item =>
        item.inputIds.includes(acceptedLeft.id) && item.inputIds.includes(acceptedRight.id),
      )
      const rejectedProposal = proposed.knowledgeMergeProposals.find(item =>
        item.inputIds.includes(rejectedLeft.id) && item.inputIds.includes(rejectedRight.id),
      )
      if (acceptedProposal === undefined || rejectedProposal === undefined) throw new Error('Host Remote did not expose both merge proposals')

      const accepted = runtime.remoteAcceptKnowledgeMerge({
        runId: created.run.id, proposalId: acceptedProposal.id,
        statement: 'Service retries use bounded windows with stable API-specific behavior',
        resolution: 'Reviewed as one policy with API-specific examples.',
      })
      const acceptedProposalState = accepted.knowledgeMergeProposals.find(item => item.id === acceptedProposal.id)
      expect(acceptedProposalState?.status).toBe('ACCEPTED')
      expect(accepted.knowledge.find(item => item.id === acceptedProposalState?.outputKnowledgeId)).toMatchObject({ status: 'CANDIDATE', kind: 'rule' })
      expect(accepted.actionIntents.some(item => item.target === `knowledge-merge:${acceptedProposal.id}` && item.status === 'COMMITTED')).toBe(true)
      expect(accepted.knowledge.find(item => item.id === acceptedLeft.id)?.version).toBe(1)
      expect(accepted.knowledge.find(item => item.id === acceptedRight.id)?.version).toBe(1)

      const rejected = runtime.remoteRejectKnowledgeMerge({
        runId: created.run.id, proposalId: rejectedProposal.id,
        resolution: 'Search and lookup require separate invalidation rules.',
      })
      expect(rejected.knowledgeMergeProposals.find(item => item.id === rejectedProposal.id)?.status).toBe('REJECTED')
    } finally {
      runtime.store.close()
    }
  })

  it('requires evidence for promotion and compacts duplicates with regression coverage', () => {
    const store = new AutoDevStore(tempRoot('knowledge'))
    const knowledge = new KnowledgeService(store)
    const first = knowledge.candidate({ scope: scope('project-a'), kind: 'rule', statement: 'Run tests before promotion' })
    const second = knowledge.candidate({ scope: scope('project-a'), kind: 'rule', statement: 'Run tests before promotion', content: 'Duplicate observation' })
    const testCase = knowledge.createRegressionCase({ scope: scope('project-a'), name: 'promotion rule', query: 'promotion', expectedStatements: ['Run tests before promotion'] })
    const suite = knowledge.runRegressionSuite(scope('project-a'))
    expect(suite.status).toBe('PASS')
    expect(suite.caseIds).toContain(testCase.id)
    expect(suite.testedKnowledgeVersions.some(item => item.id === first.id && item.version === first.version)).toBe(true)
    saveEvidence(store, 'evidence-test', scope('project-a'))
    expect(() => knowledge.promote(first.id, [], testCase.id)).toThrow(/Evidence/)
    expect(() => knowledge.promote(first.id, ['fabricated-evidence'], testCase.id)).toThrow(/does not exist/)
    const established = knowledge.promote(first.id, ['evidence-test'], testCase.id)
    expect(established.status).toBe('ESTABLISHED')
    expect(knowledge.recordUse(established.id, 'success').successCount).toBe(1)
    expect(knowledge.validate(established.id, ['evidence-test']).lastValidatedAt).toBeDefined()
    const report = knowledge.compact(scope('project-a'))
    expect(report.actions.some(action => action.kind === 'deprecated' && action.inputIds.includes(second.id))).toBe(true)
    expect(report.actions.find(action => action.kind === 'merged')?.reason).toContain('Exact normalized statement')
    expect(report.snapshots.map(item => item.id)).toEqual([first.id, second.id])
    expect(knowledge.list('project-a', true).find(item => item.id === second.id)?.status).toBe('DEPRECATED')
    expect(knowledge.restoreCompaction(report.id)).toEqual([first.id, second.id])
    expect(knowledge.get(first.id)?.status).toBe('ESTABLISHED')
    expect(knowledge.get(second.id)?.status).toBe('CANDIDATE')
    expect(store.getCompaction(report.id)?.restoredAt).toBeDefined()
    store.close()
  })

  it('rolls back partial Knowledge compaction writes when a middle record update fails', () => {
    const store = new AutoDevStore(tempRoot('knowledge-compaction-atomic'))
    const knowledge = new KnowledgeService(store)
    const first = knowledge.candidate({ scope: scope('project-atomic'), kind: 'rule', statement: 'Validate payment before reversal' })
    const second = knowledge.candidate({ scope: scope('project-atomic'), kind: 'rule', statement: 'Validate payment before reversal', content: 'Duplicate candidate.' })
    const originalSave = store.saveKnowledge.bind(store)
    let saveCount = 0
    store.saveKnowledge = (candidate) => {
      saveCount += 1
      if (saveCount === 2) throw new Error('injected mid-compaction write failure')
      originalSave(candidate)
    }

    try {
      expect(() => knowledge.compact(scope('project-atomic'))).toThrow(/injected mid-compaction/)
      expect(store.getKnowledge(first.id)).toEqual(first)
      expect(store.getKnowledge(second.id)).toEqual(second)
      expect(store.listCompactions(scope('project-atomic'))).toEqual([])
      expect(store.events('project-atomic').some(event => event.type === 'knowledge/compacted')).toBe(false)
    } finally {
      store.saveKnowledge = originalSave
      store.close()
    }
  })

  it('evaluates regression against query retrieval and reports UNKNOWN without an active knowledge base', () => {
    const store = new AutoDevStore(tempRoot('knowledge-retrieval-regression'))
    const knowledge = new KnowledgeService(store)
    const scopeRef = scope('project-a')
    knowledge.candidate({ scope: scopeRef, kind: 'rule', statement: 'Refund reverses the captured balance.' })
    knowledge.candidate({ scope: scopeRef, kind: 'rule', statement: 'Invoice cancellation archives an invoice.' })
    const refundCase = knowledge.createRegressionCase({
      scope: scopeRef, name: 'refund retrieval', query: 'refund balance',
      expectedStatements: ['Refund reverses the captured balance.'],
      forbiddenStatements: ['Invoice cancellation archives an invoice.'],
    })
    expect(knowledge.runRegression(refundCase.id)).toMatchObject({ status: 'PASS', matched: ['Refund reverses the captured balance.'], unexpected: [] })

    const emptyScope = scope('project-empty')
    const emptyStoreCase = knowledge.createRegressionCase({ scope: emptyScope, name: 'empty knowledge', query: 'anything', expectedStatements: [] })
    expect(knowledge.runRegression(emptyStoreCase.id).status).toBe('UNKNOWN')
    expect(knowledge.runRegressionSuite(emptyScope).status).toBe('UNKNOWN')
    store.close()
  })

  it('bounds Knowledge retrieval and ranks hot/warm/cold records by explainable freshness', () => {
    const store = new AutoDevStore(tempRoot('knowledge-temperature'))
    const knowledge = new KnowledgeService(store)
    const scopeRef = scope('project-a')
    const cold = knowledge.candidate({ scope: scopeRef, kind: 'rule', statement: 'Risk guidance for releases', content: 'cold '.repeat(100) })
    const warmCandidate = knowledge.candidate({ scope: scopeRef, kind: 'rule', statement: 'Risk guidance for releases' })
    const warm = { ...warmCandidate, status: 'ESTABLISHED' as const, lastValidatedAt: '2026-08-01T00:00:00.000Z', version: 2 }
    store.saveKnowledge(warm)
    const hotCandidate = knowledge.candidate({ scope: scopeRef, kind: 'rule', statement: 'Risk guidance for releases' })
    const hot = {
      ...hotCandidate, status: 'ESTABLISHED' as const, lastUsedAt: '2026-09-22T00:00:00.000Z',
      successCount: 3, failureCount: 0, version: 2,
    }
    store.saveKnowledge(hot)

    const hits = knowledge.searchHits(scopeRef, 'risk releases', { now: '2026-09-23T00:00:00.000Z', limit: 3, maxChars: 40 })
    expect(hits.map(hit => [hit.knowledge.id, hit.temperature])).toEqual([
      [hot.id, 'hot'], [warm.id, 'warm'], [cold.id, 'cold'],
    ])
    expect(hits[2]?.knowledge.content.length).toBeLessThanOrEqual(40)
    expect(knowledge.search(scopeRef, 'risk releases', { limit: 2 })).toHaveLength(2)
    store.close()
  })

  it('preserves retrieval and compaction invariants across a 100-cycle Knowledge growth soak', { timeout: 60_000 }, () => {
    const store = new AutoDevStore(tempRoot('knowledge-growth-cycles'))
    try {
      const knowledge = new KnowledgeService(store)
      const currentScope: ScopeRef = { projectKey: 'project-long-lived', module: 'billing', projectVersion: '2' }
      const previousScope: ScopeRef = { ...currentScope, projectVersion: '1' }
      const statement = 'Billing reversal policy requires an idempotency key.'
      const regressionCase = knowledge.createRegressionCase({
        scope: currentScope,
        name: 'current billing reversal policy remains retrievable',
        query: 'billing reversal policy',
        expectedStatements: [statement],
        forbiddenStatements: ['Legacy billing reversal skips the idempotency key.'],
      })
      const legacy = knowledge.candidate({
        scope: previousScope, kind: 'rule', statement: 'Legacy billing reversal skips the idempotency key.',
      })
      const sameStatementOtherKind = knowledge.candidate({ scope: currentScope, kind: 'fact', statement })
      const evidenceIds: string[] = []
      const memoryIds: string[] = []
      const sourceIds: string[] = []
      let restorationCount = 0

      for (let cycle = 0; cycle < 100; cycle++) {
        for (let observation = 0; observation < 2; observation++) {
          const suffix = `${cycle}-${observation}`
          const evidenceId = `growth-evidence-${suffix}`
          const memoryId = `growth-memory-${suffix}`
          const sourceId = `growth-source-${suffix}`
          evidenceIds.push(evidenceId)
          memoryIds.push(memoryId)
          sourceIds.push(sourceId)
          const candidate = knowledge.candidate({
            scope: currentScope,
            kind: 'rule',
            statement,
            content: `Observed in growth cycle ${cycle}; ${statement}`,
            evidenceIds: [evidenceId],
            relatedMemoryIds: [memoryId],
            sourceRefs: [{ sourceType: 'human', sourceId, note: `Reviewed in cycle ${cycle}` }],
          })
          knowledge.recordUse(candidate.id, 'success')
        }

        for (let record = 0; record < 24; record++) {
          knowledge.candidate({
            scope: currentScope,
            kind: 'experience',
            statement: `Billing maintenance pressure record ${cycle}-${record}`,
          })
        }

        expect(knowledge.runRegressionSuite(currentScope).status).toBe('PASS')
        const report = knowledge.compact(currentScope)
        const merged = report.actions.filter(action => action.kind === 'merged')
        expect(merged).toHaveLength(1)
        expect(merged[0]?.inputIds).toHaveLength(cycle === 0 ? 2 : cycle > 0 && cycle % 3 === 0 ? 5 : 3)
        expect(report.inputIds).not.toContain(legacy.id)
        expect(report.outputIds).toContain(sameStatementOtherKind.id)
        expect(knowledge.get(sameStatementOtherKind.id)?.status).toBe('CANDIDATE')
        expect(knowledge.list(currentScope).filter(item => item.kind === 'rule' && item.statement === statement)).toHaveLength(1)
        expect(knowledge.runRegressionSuite(currentScope).status).toBe('PASS')

        const hits = knowledge.searchHits(currentScope, 'billing reversal policy', { limit: 9, maxChars: 80 })
        expect(hits.length).toBeLessThanOrEqual(9)
        for (const hit of hits) {
          expect(hit.knowledge.statement.length).toBeLessThanOrEqual(80)
          expect(hit.knowledge.content.length).toBeLessThanOrEqual(80)
          expect(hit.reason).not.toBe('')
        }

        if (cycle % 3 === 2) {
          expect(knowledge.restoreCompaction(report.id).length).toBeGreaterThanOrEqual(2)
          expect(store.getCompaction(report.id)?.restoredAt).toBeDefined()
          expect(knowledge.runRegressionSuite(currentScope).status).toBe('PASS')
          restorationCount++
        }
      }

      const activeRules = knowledge.list(currentScope).filter(item => item.kind === 'rule' && item.statement === statement)
      expect(activeRules).toHaveLength(1)
      const finalRule = activeRules[0]
      expect(finalRule).toBeDefined()
      expect(finalRule?.usageCount).toBe(200)
      expect(finalRule?.successCount).toBe(200)
      expect(finalRule?.evidenceIds).toEqual(expect.arrayContaining(evidenceIds))
      expect(finalRule?.relatedMemoryIds).toEqual(expect.arrayContaining(memoryIds))
      expect(finalRule?.sourceRefs.map(ref => ref.sourceId)).toEqual(expect.arrayContaining(sourceIds))
      const compactions = store.listCompactions(currentScope)
      expect(compactions).toHaveLength(100)
      expect(compactions.filter(report => report.restoredAt !== undefined)).toHaveLength(33)
      expect(restorationCount).toBe(33)
      expect(store.listRegressionResults(regressionCase.id)).toHaveLength(233)
      expect(knowledge.search(previousScope, 'legacy billing reversal').map(item => item.id)).toContain(legacy.id)
      expect(knowledge.search(currentScope, 'legacy billing reversal').map(item => item.id)).not.toContain(legacy.id)
    } finally {
      store.close()
    }
  })

  it('refuses compaction restoration after any affected knowledge version changed', () => {
    const store = new AutoDevStore(tempRoot('knowledge-restore-stale'))
    const knowledge = new KnowledgeService(store)
    const first = knowledge.candidate({ scope: scope('project-a'), kind: 'rule', statement: 'restore-safe duplicate' })
    knowledge.candidate({ scope: scope('project-a'), kind: 'rule', statement: 'restore-safe duplicate', content: 'source duplicate' })
    const report = knowledge.compact(scope('project-a'))
    knowledge.recordUse(first.id, 'success')
    expect(() => knowledge.restoreCompaction(report.id)).toThrow(/is stale/)
    expect(() => knowledge.restoreCompaction('missing-report')).toThrow(/does not exist/)
    store.close()
  })

  it('rejects incomplete or corrupted compaction snapshots atomically', () => {
    const store = new AutoDevStore(tempRoot('knowledge-restore-corrupt'))
    const knowledge = new KnowledgeService(store)
    const first = knowledge.candidate({ scope: scope('project-a'), kind: 'rule', statement: 'atomic restore duplicate' })
    const second = knowledge.candidate({ scope: scope('project-a'), kind: 'rule', statement: 'atomic restore duplicate', content: 'duplicate source' })
    const report = knowledge.compact(scope('project-a'))
    store.saveCompaction({ ...report, snapshots: [] })

    expect(() => knowledge.restoreCompaction(report.id)).toThrow(/inconsistent/)
    expect(knowledge.get(first.id)?.version).toBe(report.resultingVersions.find(item => item.id === first.id)?.version)
    expect(knowledge.get(second.id)?.status).toBe('DEPRECATED')
    expect(store.getCompaction(report.id)?.restoredAt).toBeUndefined()
    store.close()
  })

  it('rejects foreign, failing, expired, Agent-reported, and stale promotion inputs', () => {
    const store = new AutoDevStore(tempRoot('knowledge-evidence'))
    const knowledge = new KnowledgeService(store)
    const candidate = knowledge.candidate({ scope: scope('project-a'), kind: 'rule', statement: 'preserve evidence scope' })
    const regressionCase = knowledge.createRegressionCase({ scope: scope('project-a'), name: 'scope rule', query: 'scope', expectedStatements: ['preserve evidence scope'] })
    expect(knowledge.runRegressionSuite(scope('project-a')).status).toBe('PASS')
    saveEvidence(store, 'evidence-pass', scope('project-a'))
    saveEvidence(store, 'evidence-fail', scope('project-a'), 'FAIL')
    saveEvidence(store, 'evidence-agent', scope('project-a'), 'PASS', 'agent')
    saveEvidence(store, 'evidence-expired', scope('project-a'), 'PASS', 'human', '2000-01-01T00:00:00.000Z')
    saveEvidence(store, 'evidence-foreign', scope('project-b'))
    expect(() => knowledge.promote(candidate.id, ['missing-evidence'], regressionCase.id)).toThrow(/does not exist/)
    expect(() => knowledge.promote(candidate.id, ['evidence-fail'], regressionCase.id)).toThrow(/not PASS/)
    expect(() => knowledge.promote(candidate.id, ['evidence-agent'], regressionCase.id)).toThrow(/untrusted Agent/)
    expect(() => knowledge.promote(candidate.id, ['evidence-expired'], regressionCase.id)).toThrow(/expired/)
    expect(() => knowledge.promote(candidate.id, ['evidence-foreign'], regressionCase.id)).toThrow(/outside the candidate scope/)
    expect(() => knowledge.promote(candidate.id, ['evidence-pass'], 'missing-regression')).toThrow(/regression case .* does not exist/)

    const staleCandidate = knowledge.candidate({ scope: scope('project-a'), kind: 'rule', statement: 'change after regression' })
    const staleCase = knowledge.createRegressionCase({ scope: scope('project-a'), name: 'stale rule', query: 'change after regression', expectedStatements: ['change after regression'] })
    expect(knowledge.runRegressionSuite(scope('project-a')).status).toBe('PASS')
    knowledge.recordUse(staleCandidate.id, 'success')
    expect(() => knowledge.promote(staleCandidate.id, ['evidence-pass'], staleCase.id)).toThrow(/stale/)

    const failedCase = knowledge.createRegressionCase({ scope: scope('project-a'), name: 'negative rule', query: 'scope', expectedStatements: [], forbiddenStatements: ['preserve evidence scope'] })
    const failedSuite = knowledge.runRegressionSuite(scope('project-a'))
    expect(failedSuite.status).toBe('FAIL')
    const failedResult = store.listRegressionResults(failedCase.id)[0]
    expect(failedResult?.unexpected).toContain('preserve evidence scope')
    expect(() => knowledge.promote(candidate.id, ['evidence-pass'], regressionCase.id)).toThrow(/PASS regression suite/)

    const expiredCandidate = knowledge.candidate({ scope: scope('project-a'), kind: 'rule', statement: 'expired candidate', expiresAt: '2000-01-01T00:00:00.000Z' })
    expect(() => knowledge.promote(expiredCandidate.id, ['evidence-pass'], regressionCase.id)).toThrow(/candidate .* expired/)
    store.close()
  })

  it('requires a fresh passing batch suite rather than a lone case result', () => {
    const store = new AutoDevStore(tempRoot('knowledge-suite-required'))
    const knowledge = new KnowledgeService(store)
    const candidate = knowledge.candidate({ scope: scope('project-a'), kind: 'rule', statement: 'suite is required' })
    const testCase = knowledge.createRegressionCase({ scope: scope('project-a'), name: 'suite gate', query: 'suite', expectedStatements: ['suite is required'] })
    saveEvidence(store, 'suite-evidence', scope('project-a'))
    expect(knowledge.runRegression(testCase.id).status).toBe('PASS')
    expect(() => knowledge.promote(candidate.id, ['suite-evidence'], testCase.id)).toThrow(/PASS regression suite/)
    expect(knowledge.runRegressionSuite(scope('project-a')).status).toBe('PASS')
    knowledge.createRegressionCase({ scope: scope('project-a'), name: 'new negative check', query: 'suite', expectedStatements: [], forbiddenStatements: ['suite is required'] })
    expect(() => knowledge.promote(candidate.id, ['suite-evidence'], testCase.id)).toThrow(/suite .* stale/)
    expect(knowledge.runRegressionSuite(scope('project-a')).status).toBe('FAIL')
    expect(() => knowledge.promote(candidate.id, ['suite-evidence'], testCase.id)).toThrow(/PASS regression suite/)
    store.close()
  })

  it('uses idempotency keys and never retries an UNKNOWN side effect automatically', () => {
    const store = new AutoDevStore(tempRoot('effects'))
    const effects = new SideEffectService(store)
    const first = effects.plan({ runId: 'run-a', kind: 'command', target: 'mvn test', risk: 'low' })
    const same = effects.plan({ runId: 'run-a', kind: 'command', target: 'mvn test', risk: 'low' })
    expect(same.id).toBe(first.id)
    const actor = { kind: 'dsh-operator', source: 'dsh-gateway', connectionPeerId: 'peer-test-1' } as const
    const authorized = effects.authorize(first.id, 'test policy', actor)
    expect(effects.authorize(first.id, 'test policy', actor)).toEqual(authorized)
    expect(() => effects.authorize(first.id, 'conflicting policy', actor)).toThrow(/different authorization data/)
    effects.start(first.id)
    const unknown = effects.unknown(first.id, 'process disappeared')
    expect(unknown.status).toBe('UNKNOWN')
    expect(unknown.authorizedBy).toEqual(actor)
    expect(effects.unknown(first.id, 'process disappeared')).toEqual(unknown)
    expect(() => effects.unknown(first.id, 'different result')).toThrow(/does not match its durable SideEffect record/)
    expect(effects.canRetry(unknown)).toBe(false)
    expect(store.listSideEffects('run-a').at(-1)?.status).toBe('UNKNOWN')
    expect(store.listSideEffects('run-a').filter(effect => effect.status === 'UNKNOWN')).toHaveLength(1)
    expect(store.listAuditEvents('run-a').map(event => [event.action, event.actor.kind, event.result])).toEqual([
      ['action-authorized', 'dsh-operator', 'AUTHORIZED'],
      ['action-result', 'dsh-operator', 'UNKNOWN'],
    ])
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
    }, { commands: new DomainCommandExecutor(), decisions: trustedTestDecisions() })
    let conflictAssumptionId: string | undefined
    const capturedContexts: AutoDevAgentContext[] = []
    runtime.registerProvider({
      name: 'semantic-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true,
      run: async (request) => {
        if (request.context !== undefined) capturedContexts.push(request.context)
        if (request.context?.attempt === 1) {
          request.emitSignal?.({ type: 'SemanticUncertainty', subject: 'refund', reason: 'partial versus full reversal is not specified', alternatives: ['partial', 'full'] })
          request.emitSignal?.({ type: 'AssumptionRaised', statement: 'refund always reverses the full captured amount', ...(conflictAssumptionId === undefined ? {} : { conflictsWith: [conflictAssumptionId] }) })
        }
        writeFileSync(join(request.cwd, 'SEMANTIC_GATE.txt'), 'candidate\n')
        return { provider: request.provider, status: 'completed', output: 'candidate created' }
      },
    })
    try {
      const scopedRequest = {
        module: 'web', branch: 'main', language: 'typescript', projectVersion: '2',
        schemaVersion: '4', techStackVersion: 'node-22',
      }
      const establishedConcept = runtime.concepts.correct({
        scope: { projectKey: repo, ...scopedRequest }, key: 'refund', name: 'Refund policy',
        definition: 'A captured payment may be partially reversed when the request is eligible.',
        target: 'captured payment', effect: 'eligible partial reversal',
        evidenceSummary: 'Human-reviewed refund rule', resolution: 'Use the current reviewed refund policy.',
      })
      const outOfScopeConcept = runtime.concepts.correct({
        scope: { projectKey: repo, ...scopedRequest, module: 'api' }, key: 'refund', name: 'API refund policy',
        definition: 'API refunds use a separate settlement rule.', target: 'API settlement', effect: 'settle through API',
        evidenceSummary: 'Separate API rule', resolution: 'Keep this definition scoped to the API module.',
      })
      const oldVersionConcept = runtime.concepts.correct({
        scope: { projectKey: repo, ...scopedRequest, projectVersion: '1' }, key: 'refund', name: 'Legacy refund policy',
        definition: 'Version 1 refunds use a legacy settlement rule.', target: 'captured payment', effect: 'legacy full reversal',
        evidenceSummary: 'Version 1 policy', resolution: 'Retain only for project version 1.',
      })
      const created = await runtime.create({ repoPath: repo, request: 'implement refund handling', scope: scopedRequest })
      const otherRun = await runtime.create({ repoPath: repo, request: 'review another scoped task', scope: scopedRequest })
      runtime.remoteApprovePlan({ runId: created.run.id, planId: created.plan!.id })
      expect(created.run.scope).toMatchObject({ module: 'web', branch: 'main', projectVersion: '2' })
      expect(created.plan?.conceptIds).toContain(establishedConcept.id)
      expect(created.plan?.conceptIds).not.toContain(outOfScopeConcept.id)
      expect(created.plan?.conceptIds).not.toContain(oldVersionConcept.id)
      const runScope = created.run.scope
      if (runScope === undefined) throw new Error('created Run is missing its scope')
      const foreignScopeAssumption = runtime.semantics.raiseAssumption({
        scope: { ...runScope, schemaVersion: '3' }, runId: created.run.id,
        statement: 'must not cross schema scope',
      })
      expect(() => runtime.remoteResolveAssumption({
        runId: otherRun.run.id, assumptionId: foreignScopeAssumption.id, status: 'INVALIDATED', resolution: 'foreign run',
      })).toThrow(/not part of this run scope/)
      expect(() => runtime.remoteResolveAssumption({
        runId: created.run.id, assumptionId: foreignScopeAssumption.id, status: 'INVALIDATED', resolution: 'foreign scope',
      })).toThrow(/not part of this run scope/)
      expect(runtime.store.getAssumption(foreignScopeAssumption.id)?.status).toBe('PROPOSED')
      const foreignScopeUncertainty = runtime.semantics.raiseUncertainty({
        scope: { ...runScope, techStackVersion: 'node-20' }, runId: created.run.id,
        subject: 'foreign toolchain assumption', reason: 'must not cross toolchain scope',
      })
      expect(() => runtime.remoteResolveUncertainty({
        runId: otherRun.run.id, uncertaintyId: foreignScopeUncertainty.id, status: 'RESOLVED', resolution: 'foreign run',
      })).toThrow(/not part of this run scope/)
      expect(() => runtime.remoteResolveUncertainty({
        runId: created.run.id, uncertaintyId: foreignScopeUncertainty.id, status: 'RESOLVED', resolution: 'foreign scope',
      })).toThrow(/not part of this run scope/)
      expect(runtime.store.getUncertainty(foreignScopeUncertainty.id)?.status).toBe('OPEN')
      expect(runtime.snapshot(created.run.id).assumptions.map(item => item.id)).not.toContain(foreignScopeAssumption.id)
      expect(runtime.snapshot(created.run.id).uncertainties.map(item => item.id)).not.toContain(foreignScopeUncertainty.id)
      conflictAssumptionId = runtime.semantics.raiseAssumption({ scope: runScope, runId: created.run.id, ...(created.run.activePlanId === undefined ? {} : { planId: created.run.activePlanId }), statement: 'A refund may be partial.' }).id
      const inScopeKnowledge = runtime.knowledge.candidate({ scope: runScope, kind: 'rule', statement: 'Refund handling validates the captured amount before reversal', content: 'Check the captured amount before reversing the payment.' })
      const outOfScopeKnowledge = runtime.knowledge.candidate({
        scope: { ...runScope, module: 'api' }, kind: 'rule', statement: 'API settlement uses a separate rule',
      })
      runtime.knowledge.candidate({ scope: runScope, kind: 'rule', statement: 'run scoped knowledge is isolated' })
      expect(runtime.remoteKnowledgeDetail({ runId: created.run.id, knowledgeId: inScopeKnowledge.id })).toEqual(inScopeKnowledge)
      expect(() => runtime.remoteKnowledgeDetail({ runId: created.run.id, knowledgeId: outOfScopeKnowledge.id }))
        .toThrow(/knowledge is outside the run scope/)
      expect(runtime.remoteKnowledgeSearch({ runId: created.run.id, query: 'refund handling' }).map(hit => hit.knowledge.statement)).toContain('Refund handling validates the captured amount before reversal')
      const regressionDraft = runtime.remoteCreateKnowledgeRegression({
        runId: created.run.id, name: 'run scope visibility', query: 'run scope', expectedStatements: ['run scoped knowledge is isolated'],
      })
      expect(regressionDraft.regressionCases[0]?.scope).toEqual(runScope)
      const regressionSnapshot = runtime.remoteRunKnowledgeRegressionSuite(created.run.id)
      expect(regressionSnapshot.regressionSuites.at(-1)?.status).toBe('PASS')
      const webMemory = runtime.memory.remember({ scope: runScope, kind: 'fact', title: 'Web scope fact', content: 'scope-isolation-token applies to web.' })
      const oldVersionMemory = runtime.memory.remember({ scope: { ...runScope, projectVersion: '1' }, kind: 'fact', title: 'Legacy version scope fact', content: 'scope-isolation-token applies only to version 1.' })
      runtime.memory.remember({ scope: runScope, kind: 'rule', title: 'Refund policy', content: 'Partial refunds apply only to a captured payment.', status: 'ESTABLISHED', confidence: 0.9 })
      runtime.playbooks.activate(runtime.playbooks.create({
        scope: runScope, key: 'refund-workflow', name: 'Refund workflow', purpose: 'Handle refund requests',
        targets: ['captured payment'], effects: ['partial reversal'], steps: ['check eligibility', 'reverse balance'],
      }).id)
      runtime.memory.remember({ scope: { ...runScope, module: 'api' }, kind: 'fact', title: 'API scope fact', content: 'scope-isolation-token applies to api.' })
      expect(runtime.remoteMemorySearch({ runId: created.run.id, query: 'scope-isolation-token' }).map(hit => hit.memory.id)).toEqual([webMemory.id])
      expect(() => runtime.remoteMemoryDetail({ runId: created.run.id, memoryId: webMemory.id })).not.toThrow()
      const outOfScope = runtime.memory.remember({ scope: { ...runScope, module: 'api' }, kind: 'fact', title: 'Out of scope', content: 'not visible to this Run.' })
      expect(() => runtime.remoteMemoryDetail({ runId: created.run.id, memoryId: outOfScope.id })).toThrow(/run scope/)
      const gated = await runtime.run(created.run.id)
      expect(gated.candidate?.attempt).toBe(1)
      expect(capturedContexts[0]?.memoryCards?.join('\n')).toContain('Refund policy')
      expect(capturedContexts[0]?.conceptCards?.join('\n')).toContain('eligible partial reversal')
      expect(capturedContexts[0]?.conceptRefs).toContain(establishedConcept.id)
      expect(capturedContexts[0]?.conceptRefs).not.toContain(outOfScopeConcept.id)
      expect(capturedContexts[0]?.conceptRefs).not.toContain(oldVersionConcept.id)
      expect(capturedContexts[0]?.memoryRefs).not.toContain(oldVersionMemory.id)
      expect(capturedContexts[0]?.playbookCards?.join('\n')).toContain('Refund workflow')
      expect(capturedContexts[0]?.memoryCards?.join('\n')).not.toContain('Legacy version scope fact')
      expect(capturedContexts[0]?.knowledgeCards?.join('\n')).toContain('Refund handling validates the captured amount')
      expect(capturedContexts[0]?.knowledgeRefs?.length).toBeGreaterThan(0)
      expect(capturedContexts[0]?.contextBudget?.usedChars).toBeLessThanOrEqual(capturedContexts[0]?.contextBudget?.maxChars ?? 0)
      const contextEvidence = gated.evidence.find(item => item.type === 'AGENT_CONTEXT')
      const contextArtifact = contextEvidence?.artifactId === undefined ? undefined : runtime.store.getArtifact(contextEvidence.artifactId)
      expect(contextArtifact).toBeDefined()
      expect(contextArtifact === undefined ? '' : runtime.store.readArtifact(contextArtifact).toString('utf8')).toContain('contextBudget')
      expect(gated.signals.every(item => item.planVersionId === gated.run.activePlanId && item.attempt === 1)).toBe(true)
      expect(gated.run.status).toBe('NEEDS_INTERVENTION')
      expect(gated.assumptions.find(item => item.id === conflictAssumptionId)?.status).toBe('PROPOSED')
      expect(gated.evidence.some(item => item.source === 'agent' && item.status === 'UNKNOWN' && item.summary.includes('claims a conflict'))).toBe(true)
      expect(gated.uncertainties[0]?.status).toBe('OPEN')
      expect(gated.evidence.some(item => item.type === 'BUILD')).toBe(false)
      expect(gated.evidence.some(item => item.type === 'TEST')).toBe(false)
      expect(gated.gates.at(-1)?.options).toContain('replan')
      expect(gated.actionIntents.some(item => item.kind === 'agent-workspace' && item.status === 'COMMITTED')).toBe(true)
      expect(gated.memories.map(item => item.id)).toContain(webMemory.id)
      expect(gated.memories.map(item => item.id)).not.toContain(outOfScope.id)
      expect(gated.memories.map(item => item.id)).not.toContain(oldVersionMemory.id)
      const assumptionId = gated.assumptions[0]?.id
      if (assumptionId === undefined) throw new Error('Agent Assumption signal was not persisted')
      const invalidated = runtime.remoteResolveAssumption({ runId: created.run.id, assumptionId, status: 'INVALIDATED', resolution: 'The product owner confirmed partial refunds are possible.' })
      expect(invalidated.run.status).toBe('NEEDS_INTERVENTION')
      expect(invalidated.gates.at(-1)?.reason).toContain('assumption invalidated')
      expect(invalidated.gates.at(-1)?.options).toContain('replan')

      const uncertainty = invalidated.uncertainties.find(item => item.subject === 'refund')
      if (uncertainty === undefined) throw new Error('Agent SemanticUncertainty was not persisted')
      runtime.remoteResolveUncertainty({
        runId: created.run.id, uncertaintyId: uncertainty.id, status: 'RESOLVED',
        resolution: 'The product owner confirms eligible partial reversals are supported.',
      })
      const replanned = await runtime.resolveGate(created.run.id, 'replan')
      expect(replanned.plan?.version).toBe(2)
      expect(replanned.plan?.conceptIds).toContain(establishedConcept.id)
      expect(replanned.plan?.assumptionIds).toEqual(expect.arrayContaining(gated.assumptions.map(item => item.id)))
      runtime.remoteApprovePlan({ runId: created.run.id, planId: replanned.plan!.id })
      const resumed = await runtime.run(created.run.id)
      expect(resumed.run.status).toBe('VERIFY')
      expect(capturedContexts[1]?.conceptRefs).toContain(establishedConcept.id)
      expect(capturedContexts[1]?.assumptionCards?.join('\n')).toContain('status=INVALIDATED')
      expect(capturedContexts[1]?.assumptionCards?.join('\n')).toContain('status=PROPOSED')
      expect(capturedContexts[1]?.uncertaintyCards?.join('\n')).toContain('status=RESOLVED')
      expect(capturedContexts[1]?.uncertaintyCards?.join('\n')).toContain('eligible partial reversals are supported')
      const resumedContextEvidence = resumed.evidence.find(item => item.type === 'AGENT_CONTEXT' && item.attempt === 2)
      const resumedContextArtifact = resumedContextEvidence?.artifactId === undefined
        ? undefined
        : runtime.store.getArtifact(resumedContextEvidence.artifactId)
      expect(resumedContextArtifact).toBeDefined()
      const serializedContext = resumedContextArtifact === undefined ? '' : runtime.store.readArtifact(resumedContextArtifact).toString('utf8')
      expect(serializedContext).toContain('conceptCards')
      expect(serializedContext).toContain('uncertaintyCards')
    } finally {
      runtime.store.close()
    }
  })

  it('replans across immutable Playbook versions while preserving resolved semantic context snapshots', async () => {
    const repo = tempRoot('semantic-playbook-lifecycle-repo')
    const state = tempRoot('semantic-playbook-lifecycle-state')
    const worktrees = tempRoot('semantic-playbook-lifecycle-worktrees')
    await createGitRepo(repo)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: state, worktreeRoot: worktrees, jev: { mode: 'off' },
      maven: { executable: 'fake-mvn', buildArgs: ['package'], testArgs: ['test'] },
      routes: { implement: { candidates: [{ kind: 'command', provider: 'lifecycle-editor', traits: ['code-edit', 'local-workspace'] }], requiredTaskTraits: ['code-edit', 'local-workspace'] } },
    }, { commands: new DomainCommandExecutor(), decisions: trustedTestDecisions() })
    const capturedContexts: AutoDevAgentContext[] = []
    runtime.registerProvider({
      name: 'lifecycle-editor', kind: 'command', traits: ['code-edit', 'local-workspace'], workspaceCwd: true,
      run: async (request) => {
        if (request.context !== undefined) capturedContexts.push(request.context)
        if (request.context?.attempt === 1) {
          request.emitSignal?.({ type: 'SemanticUncertainty', subject: 'refund', reason: 'the reversal amount is unclear', alternatives: ['partial', 'full'] })
          request.emitSignal?.({ type: 'AssumptionRaised', statement: 'all refunds reverse the full captured amount' })
        }
        writeFileSync(join(request.cwd, 'SEMANTIC_PLAYBOOK_LIFECYCLE.txt'), `attempt ${request.context?.attempt ?? 0}\n`)
        return { provider: request.provider, status: 'completed', output: 'candidate updated' }
      },
    })

    try {
      const created = await runtime.create({ repoPath: repo, request: 'implement refund handling' })
      const draft = runtime.remoteCreatePlaybook({
        runId: created.run.id, key: 'refund-flow', name: 'Refund workflow v1', purpose: 'Process eligible refunds',
        targets: ['captured payment'], effects: ['eligible reversal'], conceptKeys: ['refund'],
        exclusions: ['uncaptured payment'], steps: ['check eligibility', 'reverse the captured amount'], requiredEvidence: ['TEST'],
      })
      const playbookV1 = draft.playbooks.find(item => item.key === 'refund-flow')
      if (playbookV1 === undefined) throw new Error('Playbook v1 draft was not persisted')
      const activated = runtime.remoteActivatePlaybook({ runId: created.run.id, playbookId: playbookV1.id })
      expect(activated.plan?.version).toBe(2)
      expect(activated.plan?.playbookIds).toContain(playbookV1.id)
      const frozenPlan = activated.plan
      if (frozenPlan === undefined) throw new Error('activated Plan v2 was not persisted')
      runtime.remoteApprovePlan({ runId: created.run.id, planId: frozenPlan.id })

      const gated = await runtime.run(created.run.id)
      expect(gated.run.status).toBe('NEEDS_INTERVENTION')
      const assumption = gated.assumptions.find(item => item.statement === 'all refunds reverse the full captured amount')
      const uncertainty = gated.uncertainties.find(item => item.subject === 'refund')
      if (assumption === undefined || uncertainty === undefined) throw new Error('Agent semantic signals were not persisted')
      expect(capturedContexts[0]?.playbookCards?.join('\n')).toContain('Refund workflow v1')
      const firstContextEvidence = gated.evidence.find(item => item.type === 'AGENT_CONTEXT' && item.attempt === 1)
      const firstContextArtifact = firstContextEvidence?.artifactId === undefined
        ? undefined
        : runtime.store.getArtifact(firstContextEvidence.artifactId)
      expect(firstContextArtifact).toBeDefined()
      const firstContextSnapshot = firstContextArtifact === undefined ? '' : runtime.store.readArtifact(firstContextArtifact).toString('utf8')
      expect(firstContextSnapshot).toContain('Refund workflow v1')

      runtime.remoteResolveAssumption({
        runId: created.run.id, assumptionId: assumption.id, status: 'INVALIDATED',
        resolution: 'The product owner confirmed eligible partial reversals.',
      })
      runtime.remoteResolveUncertainty({
        runId: created.run.id, uncertaintyId: uncertainty.id, status: 'RESOLVED',
        resolution: 'Only the eligible captured balance may be reversed.',
      })
      const revised = runtime.remoteRevisePlaybook({
        runId: created.run.id, playbookId: playbookV1.id, name: 'Refund workflow v2',
        purpose: 'Process eligible partial refunds with an audit trail', targets: ['captured payment'],
        effects: ['eligible partial reversal'], conceptKeys: ['refund'], exclusions: ['uncaptured payment'],
        steps: ['check eligibility', 'reverse only the eligible balance', 'record the v2 audit'],
        requiredEvidence: ['TEST'], resolution: 'Align with the approved partial-refund policy.',
      })
      const playbookV2 = revised.playbooks.find(item => item.parentId === playbookV1.id)
      if (playbookV2 === undefined) throw new Error('Playbook v2 was not persisted')
      expect(playbookV2).toMatchObject({ status: 'ACTIVE', version: 2, parentId: playbookV1.id })
      expect(revised.playbooks.find(item => item.id === playbookV1.id)?.status).toBe('DEPRECATED')
      expect(runtime.store.getPlan(frozenPlan.id)).toEqual(frozenPlan)
      expect(revised.gates.at(-1)?.options).toContain('replan')

      const replanned = await runtime.resolveGate(created.run.id, 'replan')
      expect(replanned.run.status).toBe('DRAFT')
      expect(replanned.plan?.version).toBe(3)
      expect(runtime.store.getPlan(created.plan!.id)?.status).toBe('SUPERSEDED')
      expect(runtime.store.listPlans(created.run.id).filter(item => item.status === 'ACTIVE').map(item => item.id)).toEqual([replanned.plan?.id])
      expect(replanned.plan?.playbookIds).toContain(playbookV2.id)
      expect(replanned.plan?.playbookIds).not.toContain(playbookV1.id)
      expect(replanned.plan?.assumptionIds).toContain(assumption.id)
      runtime.remoteApprovePlan({ runId: created.run.id, planId: replanned.plan!.id })

      const resumed = await runtime.run(created.run.id)
      expect(resumed.run.status).toBe('VERIFY')
      expect(capturedContexts[1]?.playbookCards?.join('\n')).toContain('Refund workflow v2')
      expect(capturedContexts[1]?.playbookCards?.join('\n')).not.toContain('Refund workflow v1')
      expect(capturedContexts[1]?.assumptionCards?.join('\n')).toContain('status=INVALIDATED')
      expect(capturedContexts[1]?.uncertaintyCards?.join('\n')).toContain('status=RESOLVED')
      expect(capturedContexts[1]?.uncertaintyCards?.join('\n')).toContain('eligible captured balance')
      expect(runtime.store.readArtifact(firstContextArtifact!).toString('utf8')).toBe(firstContextSnapshot)
      const resumedContext = resumed.evidence.find(item => item.type === 'AGENT_CONTEXT' && item.attempt === 2)
      const resumedArtifact = resumedContext?.artifactId === undefined ? undefined : runtime.store.getArtifact(resumedContext.artifactId)
      expect(resumedArtifact).toBeDefined()
      const resumedSnapshot = resumedArtifact === undefined ? '' : runtime.store.readArtifact(resumedArtifact).toString('utf8')
      expect(resumedSnapshot).toContain('Refund workflow v2')
      expect(resumedSnapshot).not.toContain('Refund workflow v1')
      expect(resumedSnapshot).toContain('status=INVALIDATED')
      expect(resumedSnapshot).toContain('status=RESOLVED')
    } finally {
      runtime.store.close()
    }
  })
})

describe('Runtime Knowledge compaction Remote', () => {
  it('commits successful compaction and audits a failed compaction intent', async () => {
    const repo = tempRoot('knowledge-remote-repo')
    const state = tempRoot('knowledge-remote-state')
    const worktrees = tempRoot('knowledge-remote-worktrees')
    await createGitRepo(repo)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: state, worktreeRoot: worktrees, jev: { mode: 'off' },
      maven: { executable: 'fake-mvn', buildArgs: ['package'], testArgs: ['test'] },
    }, { commands: new DomainCommandExecutor() })
    try {
      const created = await runtime.create({ repoPath: repo, request: 'compact scoped knowledge' })
      const runScope = created.run.scope
      if (runScope === undefined) throw new Error('created Run is missing its scope')
      runtime.knowledge.candidate({ scope: runScope, kind: 'rule', statement: 'Check payment before reversal' })
      runtime.knowledge.candidate({ scope: runScope, kind: 'rule', statement: 'Check payment before reversal', content: 'Duplicate record.' })

      const compacted = runtime.remoteCompactKnowledge(created.run.id, 'compact-success')
      expect(compacted.compactions).toHaveLength(1)
      expect(compacted.actionIntents.at(-1)).toMatchObject({ kind: 'memory-write', status: 'COMMITTED' })
      const replayed = runtime.remoteCompactKnowledge(created.run.id, 'compact-success')
      expect(replayed.compactions).toHaveLength(1)
      expect(replayed.actionIntents).toHaveLength(compacted.actionIntents.length)

      runtime.knowledge.compact = () => { throw new Error('injected compaction service failure') }
      expect(() => runtime.remoteCompactKnowledge(created.run.id, 'compact-failure')).toThrow(/injected compaction service failure/)
      const failed = runtime.snapshot(created.run.id)
      expect(failed.actionIntents.at(-1)).toMatchObject({ kind: 'memory-write', status: 'FAILED' })
      expect(failed.sideEffects.at(-1)?.summary).toContain('knowledge compaction failed')
      expect(() => runtime.remoteCompactKnowledge(created.run.id, 'compact-failure')).toThrow(/already exists with status FAILED/)
      expect(runtime.snapshot(created.run.id).actionIntents).toHaveLength(failed.actionIntents.length)
    } finally {
      runtime.store.close()
    }
  })
})

describe('Runtime project semantic edit Remotes', () => {
  it('creates scoped Playbook drafts, versions corrections, and requires Plan re-review', async () => {
    const repo = tempRoot('playbook-edit-repo')
    const state = tempRoot('playbook-edit-state')
    const worktrees = tempRoot('playbook-edit-worktrees')
    await createGitRepo(repo)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: state, worktreeRoot: worktrees, jev: { mode: 'off' },
      maven: { executable: 'fake-mvn', buildArgs: ['package'], testArgs: ['test'] },
    }, { commands: new DomainCommandExecutor() })
    try {
      const created = await runtime.create({ repoPath: repo, request: 'implement refund workflow' })
      const draft = runtime.remoteCreatePlaybook({
        runId: created.run.id, key: 'refund-workflow', name: 'Refund workflow', purpose: 'Process eligible refunds',
        targets: ['captured payment'], effects: ['reverse payment'], conceptKeys: ['refund'], exclusions: ['uncaptured payment'],
        steps: ['check eligibility', 'reverse payment'], requiredEvidence: ['TEST'],
      })
      const draftRecord = draft.playbooks.find(item => item.key === 'refund-workflow')
      expect(draftRecord).toMatchObject({ status: 'DRAFT', version: 1, scope: created.run.scope })
      if (draftRecord === undefined) throw new Error('Playbook draft was not persisted')

      const activated = runtime.remoteActivatePlaybook({ runId: created.run.id, playbookId: draftRecord.id })
      expect(activated.plan?.version).toBe(2)
      expect(activated.plan?.playbookIds).toContain(draftRecord.id)
      runtime.remoteApprovePlan({ runId: created.run.id, planId: activated.plan!.id })

      const revised = runtime.remoteRevisePlaybook({
        runId: created.run.id, playbookId: draftRecord.id, name: 'Safe refund workflow',
        purpose: 'Process eligible refunds and retain an audit', targets: ['captured payment'], effects: ['reverse payment'],
        conceptKeys: ['refund'], exclusions: ['uncaptured payment'], steps: ['check eligibility', 'reverse payment', 'record audit'],
        requiredEvidence: ['TEST', 'REVIEW'], resolution: 'The updated policy requires an auditable human review.',
      })
      const revisedRecord = revised.playbooks.find(item => item.parentId === draftRecord.id)
      expect(revisedRecord).toMatchObject({ status: 'ACTIVE', version: 2, parentId: draftRecord.id, requiredEvidence: ['TEST', 'REVIEW'] })
      expect(revised.playbooks.find(item => item.id === draftRecord.id)?.status).toBe('DEPRECATED')
      expect(revised.run.status).toBe('NEEDS_INTERVENTION')
      expect(revised.gates.at(-1)?.options).toEqual(['replan', 'abandon', 'cancel'])
      if (revisedRecord === undefined) throw new Error('revised Playbook was not persisted')

      const replanned = await runtime.resolveGate(created.run.id, 'replan')
      expect(replanned.run.status).toBe('DRAFT')
      expect(replanned.plan?.version).toBe(3)
      expect(replanned.plan?.playbookIds).toContain(revisedRecord.id)
      expect(replanned.plan?.playbookIds).not.toContain(draftRecord.id)

      const deprecated = runtime.remoteDeprecatePlaybook({ runId: created.run.id, playbookId: revisedRecord.id })
      expect(deprecated.playbooks.find(item => item.id === revisedRecord.id)?.status).toBe('DEPRECATED')
      expect(deprecated.plan?.version).toBe(4)
      expect(deprecated.plan?.playbookIds).not.toContain(revisedRecord.id)

      const foreign = runtime.playbooks.create({
        scope: { projectKey: 'another-project' }, key: 'foreign', name: 'Foreign', purpose: 'Out of scope',
        targets: ['other'], effects: ['other'], steps: ['do not apply'],
      })
      expect(() => runtime.remoteActivatePlaybook({ runId: created.run.id, playbookId: foreign.id })).toThrow(/outside the run scope/)
    } finally {
      runtime.store.close()
    }
  })

  it('versions a human Concept correction and gates an already approved Plan for re-review', async () => {
    const repo = tempRoot('concept-edit-repo')
    const state = tempRoot('concept-edit-state')
    const worktrees = tempRoot('concept-edit-worktrees')
    await createGitRepo(repo)
    const runtime = new AutoDevRuntime(new Context(), {
      dataRoot: state, worktreeRoot: worktrees, jev: { mode: 'off' },
      maven: { executable: 'fake-mvn', buildArgs: ['package'], testArgs: ['test'] },
    }, { commands: new DomainCommandExecutor() })
    try {
      const created = await runtime.create({ repoPath: repo, request: 'implement refund handling' })
      const observed = runtime.remoteObserveConcept({
        runId: created.run.id, key: 'refund', name: 'Refund', definition: 'Return money',
        target: 'payment', effect: 'reverse payment', evidenceSummary: 'Initial observation',
      })
      const firstConcept = observed.concepts.find(item => item.key === 'refund')
      if (firstConcept === undefined) throw new Error('Concept observation was not persisted')

      const corrected = runtime.remoteCorrectConcept({
        runId: created.run.id, key: 'refund', name: 'Refund', definition: 'Reverse an eligible captured payment',
        target: 'captured payment', effect: 'full or partial reversal', evidenceSummary: 'Product policy reviewed',
        resolution: 'Human correction from the approved product definition.',
      })
      expect(corrected.concepts.find(item => item.id === firstConcept.id)).toMatchObject({ status: 'ESTABLISHED', version: 2 })
      expect(corrected.run.status).toBe('DRAFT')
      expect(corrected.plan?.version).toBe(2)
      expect(corrected.plan?.conceptIds).toContain(firstConcept.id)

      runtime.remoteApprovePlan({ runId: created.run.id, planId: corrected.plan!.id })
      const correctedAgain = runtime.remoteCorrectConcept({
        runId: created.run.id, key: 'refund', name: 'Refund', definition: 'Reverse a captured payment after eligibility checks',
        target: 'captured payment', effect: 'eligible payment reversal', evidenceSummary: 'Re-reviewed product policy',
        resolution: 'Clarified the eligibility condition.',
      })
      expect(correctedAgain.concepts.find(item => item.id === firstConcept.id)?.version).toBe(3)
      expect(correctedAgain.run.status).toBe('NEEDS_INTERVENTION')
      expect(correctedAgain.gates.at(-1)?.options).toEqual(['replan', 'abandon', 'cancel'])
      const replanned = await runtime.resolveGate(created.run.id, 'replan')
      expect(replanned.run.status).toBe('DRAFT')
      expect(replanned.plan?.version).toBe(3)
    } finally {
      runtime.store.close()
    }
  })
})

function saveEvidence(
  store: AutoDevStore,
  id: string,
  evidenceScope: ScopeRef,
  status: 'PASS' | 'FAIL' = 'PASS',
  source: 'human' | 'agent' = 'human',
  expiresAt?: string,
): void {
  const now = new Date().toISOString()
  const runId = `run-for-${id}`
  store.createRun({
    schemaVersion: 1, id: runId, repoPath: evidenceScope.projectKey, request: 'Evidence fixture', acceptanceCriteria: [],
    status: 'PROMOTED', baseCommit: 'fixture-base', repoRoot: evidenceScope.projectKey, projectKey: evidenceScope.projectKey,
    scope: evidenceScope, attempt: 0, createdAt: now, updatedAt: now,
  })
  store.saveEvidence({
    id, runId, type: 'VERIFICATION', status, source, summary: `fixture ${id}`,
    ...(expiresAt === undefined ? {} : { expiresAt }), createdAt: now,
  })
}

class DomainCommandExecutor implements CommandExecutor {
  private readonly delegate = new HarnessCommandExecutor()

  run(...args: Parameters<CommandExecutor['run']>): ReturnType<CommandExecutor['run']> {
    const [argv, cwd] = args
    if (argv[0] === 'java' || argv[0] === 'java.exe' || argv[0] === 'mvn' || argv[0] === 'fake-mvn') {
      return Promise.resolve({ argv, cwd, exitCode: 0, signal: null, stdout: 'fake ok', stderr: '', timedOut: false, durationMs: 1 } satisfies CommandResult)
    }
    return this.delegate.run(...args)
  }
}

async function createGitRepo(root: string): Promise<void> {
  const executor = new HarnessCommandExecutor()
  writeFileSync(join(root, 'pom.xml'), '<project/>\n')
  writeFileSync(join(root, 'README.md'), 'baseline\n')
  mkdirSync(join(root, '.mvn', 'wrapper'), { recursive: true })
  writeFileSync(join(root, '.mvn', 'wrapper', 'maven-wrapper.jar'), 'fake wrapper fixture for DomainCommandExecutor\n')
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
