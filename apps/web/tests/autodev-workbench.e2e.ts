import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import type { AutoDevAgentContext } from '../../../packages/experimental/autodev/src/protocol.ts'
import type {} from '../../../packages/experimental/autodev/src/runtime.ts'
import type { WebScaffold } from './scaffold.ts'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const AUTODEV_PACKAGE = join(REPO_ROOT, 'packages', 'experimental', 'autodev')
const PROVIDER = 'web-e2e-deterministic-agent'
const FAILED_REQUEST = 'web-e2e: fail before editing'
const SEMANTIC_REQUEST = 'web-e2e: resolve refund semantics'
const SEMANTIC_ASSUMPTION = 'refund always reverses the full captured amount'
const MERGED_KNOWLEDGE_STATEMENT = 'Review the refund eligibility policy and captured payment before a partial reversal'
const COMPACTABLE_KNOWLEDGE_STATEMENT = 'web-e2e compaction restoration fixture'
const PLAYBOOK_KEY = 'web-e2e-refund-workflow'
const PLAYBOOK_NAME_V1 = 'Refund eligibility workflow'
const PLAYBOOK_NAME_V2 = 'Refund eligibility workflow v2'
const SUCCESS_REQUEST = 'web-e2e: replace the result value'
const CANDIDATE_CONTENT = 'candidate from deterministic provider\n'

it('creates and approves a Run, restores a failed gate after Host restart, then verifies and explicitly promotes a Candidate', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'dsh-autodev-web-e2e-'))
  const repoRoot = join(testRoot, 'project')
  const dataRoot = join(testRoot, 'autodev-data')
  const worktreeRoot = join(testRoot, 'autodev-worktrees')
  const overlayPath = join(testRoot, 'autodev.patch.yml')
  const packageDir = join(testRoot, 'home-one')
  const testScript = [
    "const fs = require('node:fs')",
    `if (fs.readFileSync('src/result.txt', 'utf8') !== ${JSON.stringify(CANDIDATE_CONTENT)}) process.exit(17)`,
  ].join('; ')

  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  const providerWorkspaces: string[] = []
  const providerContexts: AutoDevAgentContext[] = []
  const providerInstructions: string[] = []

  const launch = async (harnessHome: string): Promise<void> => {
    scaffold = await launchWebScaffold({
      harnessHome,
      profile: { packages: [{ dir: AUTODEV_PACKAGE, enabled: true }] },
      extraOverlayPath: overlayPath,
    })
    scaffold.ctx.autodev.registerDecisionProvider('web-e2e-quality-decisions', {
      async evaluate(request) {
        return {
          source: 'jev',
          modelVersion: 'web-e2e-deterministic-decision',
          answers: request.questions.map(question => ({
            questionId: question.id,
            kind: question.type,
            value: question.type === 'choice' ? question.choices?.[0] ?? 'ready_for_verify'
              : question.type === 'score' ? question.max ?? 100 : false,
            probability: 1,
          })),
        }
      },
    }, 10)
    scaffold.ctx.autodev.registerProvider({
      name: PROVIDER,
      kind: 'command',
      traits: ['code-edit', 'local-workspace'],
      workspaceCwd: true,
      async run(request) {
        request.signal.throwIfAborted()
        providerWorkspaces.push(request.cwd)
        if (request.context !== undefined) providerContexts.push(request.context)
        if (request.task !== undefined) providerInstructions.push(request.task.instruction)
        if (request.task?.instruction.includes(FAILED_REQUEST)) {
          return { provider: PROVIDER, status: 'error', output: 'controlled fixture failure', diagnostic: 'controlled fixture failure' }
        }
        if (request.task?.instruction.includes(SEMANTIC_REQUEST) && request.context?.attempt === 1) {
          request.emitSignal?.({
            type: 'SemanticUncertainty',
            subject: 'refund',
            reason: 'partial versus full reversal is not specified',
            alternatives: ['partial', 'full'],
          })
          request.emitSignal?.({ type: 'AssumptionRaised', statement: SEMANTIC_ASSUMPTION })
        }
        const root = resolve(request.cwd)
        const target = resolve(root, 'src', 'result.txt')
        const rel = relative(root, target)
        if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== target) {
          throw new Error('fixture provider refused a path outside the AutoDev Worktree')
        }
        await mkdir(join(root, 'src'), { recursive: true })
        await writeFile(target, CANDIDATE_CONTENT)
        return { provider: PROVIDER, status: 'completed', output: 'updated src/result.txt in the supplied Worktree' }
      },
    })
    scaffold.ctx.autodev.router.registerCandidate('implement', {
      kind: 'command',
      provider: PROVIDER,
      traits: ['code-edit', 'local-workspace'],
    })

    // CI keeps Playwright's pinned Chromium default. Local acceptance can use
    // an already-installed Edge when the matching Playwright revision is absent.
    browser = await chromium.launch(process.env.DSH_AUTODEV_WEB_E2E_BROWSER === 'msedge'
      ? { channel: 'msedge' }
      : {})
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, testRoot, 'project')
    await openAutoDev(page)
  }

  const dispose = async (): Promise<void> => {
    await browser?.close()
    browser = undefined
    await scaffold?.close()
    scaffold = undefined
    page = undefined
  }

  try {
    await mkdir(join(repoRoot, 'src'), { recursive: true })
    await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ name: 'autodev-web-fixture', private: true }, null, 2) + '\n')
    await writeFile(join(repoRoot, 'src', 'result.txt'), 'original\n')
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repoRoot, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'AutoDev Web E2E'], { cwd: repoRoot, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'autodev-web-e2e@example.invalid'], { cwd: repoRoot, stdio: 'ignore' })
    execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' })
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture baseline'], { cwd: repoRoot, stdio: 'ignore' })

    const overlay = [{
      id: 'autodev',
      config: {
        dataRoot,
        worktreeRoot,
        maxAttempts: 3,
        jev: { mode: 'required' },
        routes: {
          implement: {
            candidates: [],
            requiredTaskTraits: ['code-edit', 'local-workspace'],
            minConfidence: 0,
          },
        },
        drivers: {
          node: {
            executable: process.execPath,
            buildArgs: ['-e', 'process.exit(0)'],
            testArgs: ['-e', testScript],
          },
        },
      },
    }]
    // JSON is valid YAML and avoids hand-escaping Windows executable paths.
    await writeFile(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`)

    await launch(packageDir)
    expect(page).toBeDefined()
    const panel = page!.locator('[data-autodev-panel]')
    await panel.getByLabel('Absolute Git repository path').fill(repoRoot)
    await panel.getByLabel('Requested change').fill(FAILED_REQUEST)
    expect(await panel.getByLabel('Work mode').inputValue()).toBe('AUTO')
    await panel.getByLabel('Work mode').selectOption('DEBUG')
    await panel.getByLabel('Acceptance criteria (one per line)').fill('Keep the original repository unchanged until Promotion.')
    await panel.getByRole('button', { name: 'Create task and Plan' }).click()
    await panel.getByRole('button', { name: 'Approve this Plan version' }).waitFor({ timeout: 20_000 })

    const failedRun = scaffold!.ctx.autodev.listRuns().find(run => run.request === FAILED_REQUEST)
    expect(failedRun).toBeDefined()
    expect(failedRun).toMatchObject({ mode: 'DEBUG', modeSource: 'explicit' })
    expect(scaffold!.ctx.autodev.snapshot(failedRun!.id).run.status).toBe('DRAFT')
    await panel.getByRole('button', { name: 'Approve this Plan version' }).click()
    await panel.getByRole('button', { name: 'Start in this DSH Session' }).waitFor({ timeout: 10_000 })
    await panel.getByRole('button', { name: 'Start in this DSH Session' }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(failedRun!.id).run.status,
      { timeout: 30_000, interval: 100 },
    ).toBe('NEEDS_INTERVENTION')
    expect(providerContexts[0]?.mode).toBe('DEBUG')
    expect(providerInstructions[0]).toContain('[AutoDev mode: DEBUG]')
    expect((await readFile(join(repoRoot, 'src', 'result.txt'), 'utf8'))).toBe('original\n')
    expect(scaffold!.ctx.autodev.snapshot(failedRun!.id).gates.at(-1)?.options).toContain('abandon')

    await dispose()

    await launch(join(testRoot, 'home-two'))
    const recoveredPanel = page!.locator('[data-autodev-panel]')
    const failedRunRow = recoveredPanel.locator('button').filter({ hasText: FAILED_REQUEST }).first()
    await failedRunRow.waitFor({ timeout: 20_000 })
    await failedRunRow.click()
    await recoveredPanel.locator('article').getByText('NEEDS_INTERVENTION', { exact: true }).waitFor({ state: 'visible' })
    await recoveredPanel.getByRole('button', { name: 'Abandon', exact: true }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(failedRun!.id).run.status,
      { timeout: 10_000, interval: 100 },
    ).toBe('ABANDONED')

    await recoveredPanel.getByLabel('Absolute Git repository path').fill(repoRoot)
    await recoveredPanel.getByLabel('Requested change').fill(SEMANTIC_REQUEST)
    expect(await recoveredPanel.getByLabel('Work mode').inputValue()).toBe('AUTO')
    await recoveredPanel.getByLabel('Acceptance criteria (one per line)').fill('Resolve the refund meaning before running deterministic checks.')
    await recoveredPanel.getByRole('button', { name: 'Create task and Plan' }).click()
    await recoveredPanel.getByRole('button', { name: 'Approve this Plan version' }).waitFor({ timeout: 20_000 })
    const semanticRun = scaffold!.ctx.autodev.listRuns().find(run => run.request === SEMANTIC_REQUEST)
    expect(semanticRun).toBeDefined()
    expect(semanticRun).toMatchObject({ mode: 'DEV', modeSource: 'auto' })
    const seededConcept = scaffold!.ctx.autodev.concepts.observe({
      scope: semanticRun!.scope ?? { projectKey: repoRoot },
      runId: semanticRun!.id,
      ...(semanticRun!.activePlanId === undefined ? {} : { planId: semanticRun!.activePlanId }),
      key: 'refund',
      name: 'Refund',
      definition: 'A refund reverses the complete captured payment.',
      target: 'captured payment',
      effect: 'full reversal',
      evidenceSummary: 'Initial unreviewed observation seeded for the browser scenario.',
      confidence: 0.4,
    }).concept
    await recoveredPanel.getByRole('button', { name: 'Approve this Plan version' }).click()
    await recoveredPanel.getByRole('button', { name: 'Start in this DSH Session' }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(semanticRun!.id).run.status,
      { timeout: 30_000, interval: 100 },
    ).toBe('NEEDS_INTERVENTION')

    const semanticGate = scaffold!.ctx.autodev.snapshot(semanticRun!.id)
    expect(semanticGate.gates.at(-1)?.options).toContain('replan')
    expect(semanticGate.evidence.some(item => item.type === 'BUILD' || item.type === 'TEST')).toBe(false)
    const conceptReview = recoveredPanel.locator('section[aria-labelledby="autodev-concept-review-title"]')
    await conceptReview.getByLabel('Concept name').fill('Refund policy')
    await conceptReview.getByLabel('Concept definition').fill('Eligible refund requests may partially reverse a captured payment.')
    await conceptReview.getByLabel('Target').fill('captured payment')
    await conceptReview.getByLabel('Business effect').fill('eligible partial reversal')
    await conceptReview.getByLabel('Evidence summary').fill('Product owner confirmed the partial-refund policy.')
    await conceptReview.getByLabel('Human correction rationale').fill('Use the current eligibility policy, not the original full-reversal assumption.')
    await conceptReview.getByRole('button', { name: 'Save correction as a new version' }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(semanticRun!.id).concepts.find(item => item.id === seededConcept.id)?.version,
      { timeout: 10_000, interval: 100 },
    ).toBe(2)
    const correctedConceptState = scaffold!.ctx.autodev.snapshot(semanticRun!.id)
    const correctionHistory = correctedConceptState.conceptObservations.filter(item => item.conceptId === seededConcept.id)
    expect(correctionHistory).toHaveLength(2)
    expect(correctionHistory[0]?.version).toBe(1)
    expect(correctionHistory[1]?.relationship).toBe('HUMAN_CORRECTION')
    expect(correctionHistory[1]?.sourceRefs.some(ref => ref.sourceType === 'human'
      && ref.note === 'Use the current eligibility policy, not the original full-reversal assumption.')).toBe(true)
    expect(correctedConceptState.gates.at(-1)?.options).toContain('replan')
    await recoveredPanel.getByLabel(`Assumption resolution notes: ${SEMANTIC_ASSUMPTION}`).fill('Product owner confirms partial reversals are allowed.')
    await recoveredPanel.getByRole('button', { name: 'Invalidate assumption', exact: true }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(semanticRun!.id).assumptions[0]?.status,
      { timeout: 10_000, interval: 100 },
    ).toBe('INVALIDATED')
    await recoveredPanel.getByLabel('Uncertainty resolution notes: refund').fill('Use the eligible partial reversal policy.')
    await recoveredPanel.getByRole('button', { name: 'Resolve uncertainty', exact: true }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(semanticRun!.id).uncertainties[0]?.status,
      { timeout: 10_000, interval: 100 },
    ).toBe('RESOLVED')
    await recoveredPanel.getByRole('button', { name: 'Create a new Plan', exact: true }).click()
    await recoveredPanel.getByRole('button', { name: 'Approve this Plan version' }).waitFor({ timeout: 20_000 })
    const semanticReplanned = scaffold!.ctx.autodev.snapshot(semanticRun!.id)
    expect(semanticReplanned.plan?.version).toBe(2)
    expect(semanticReplanned.plan?.conceptIds).toContain(seededConcept.id)
    await recoveredPanel.getByRole('button', { name: 'Approve this Plan version' }).click()
    await recoveredPanel.getByRole('button', { name: 'Start in this DSH Session' }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(semanticRun!.id).run.status,
      { timeout: 30_000, interval: 100 },
    ).toBe('VERIFY')

    const semanticVerified = scaffold!.ctx.autodev.snapshot(semanticRun!.id)
    const semanticContext = providerContexts.find(context => context.runId === semanticRun!.id && context.attempt === 2)
    expect(semanticContext?.mode).toBe('DEV')
    expect(semanticContext?.conceptRefs).toContain(seededConcept.id)
    expect(semanticContext?.conceptCards?.join('\n')).toContain('version=2')
    expect(semanticContext?.conceptCards?.join('\n')).toContain('eligible partial reversal')
    expect(semanticContext?.assumptionCards?.join('\n')).toContain('status=INVALIDATED')
    expect(semanticContext?.uncertaintyCards?.join('\n')).toContain('status=RESOLVED')
    const semanticContextEvidence = semanticVerified.evidence.find(item => item.type === 'AGENT_CONTEXT' && item.attempt === 2)
    const semanticContextArtifact = semanticContextEvidence?.artifactId === undefined
      ? undefined
      : scaffold!.ctx.autodev.store.getArtifact(semanticContextEvidence.artifactId)
    expect(semanticContextArtifact).toBeDefined()
    const serializedSemanticContext = semanticContextArtifact === undefined ? '' : scaffold!.ctx.autodev.store.readArtifact(semanticContextArtifact).toString('utf8')
    expect(serializedSemanticContext).toContain('Product owner confirms partial reversals are allowed.')
    expect(serializedSemanticContext).toContain('Use the eligible partial reversal policy.')
    expect(semanticVerified.evidence.some(item => item.type === 'BUILD' && item.status === 'PASS')).toBe(true)
    expect(semanticVerified.evidence.some(item => item.type === 'TEST' && item.status === 'PASS')).toBe(true)

    const semanticScope = semanticRun!.scope ?? { projectKey: repoRoot }
    const mergeInputOne = scaffold!.ctx.autodev.knowledge.candidate({
      scope: semanticScope,
      kind: 'rule',
      statement: 'Refund eligibility policy requires reviewing captured payment before reversal',
      content: 'Review the captured payment and eligibility rule before reversing funds.',
    })
    const mergeInputTwo = scaffold!.ctx.autodev.knowledge.candidate({
      scope: semanticScope,
      kind: 'rule',
      statement: 'Refund eligibility policy requires reviewing captured payment before partial reversal',
      content: 'Review the captured payment and eligibility rule before a partial reversal.',
    })
    const knowledgeMergeReview = recoveredPanel.locator('section[aria-labelledby="autodev-knowledge-merge-title"]')
    await knowledgeMergeReview.getByRole('button', { name: 'Generate merge proposals' }).click()
    const proposedSnapshot = scaffold!.ctx.autodev.snapshot(semanticRun!.id)
    const mergeProposal = proposedSnapshot.knowledgeMergeProposals.find(proposal =>
      proposal.inputIds.includes(mergeInputOne.id) && proposal.inputIds.includes(mergeInputTwo.id))
    expect(mergeProposal).toBeDefined()
    const mergeProposalCard = knowledgeMergeReview.locator('article').filter({ hasText: mergeInputOne.id })
    const mergeResolution = 'These observations describe the same eligibility precondition.'
    await mergeProposalCard.getByLabel(`Merged Knowledge statement: ${mergeProposal!.id}`).fill(MERGED_KNOWLEDGE_STATEMENT)
    await mergeProposalCard.getByLabel(`Merged Knowledge content (optional): ${mergeProposal!.id}`).fill('Review the approved refund policy and captured payment before a partial reversal.')
    await mergeProposalCard.getByLabel(`Review rationale: ${mergeProposal!.id}`).fill(mergeResolution)
    await mergeProposalCard.getByLabel(`Accept as a new Candidate: ${mergeProposal!.id}`).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(semanticRun!.id).knowledgeMergeProposals.find(item => item.id === mergeProposal!.id)?.status,
      { timeout: 10_000, interval: 100 },
    ).toBe('ACCEPTED')
    const acceptedMerge = scaffold!.ctx.autodev.snapshot(semanticRun!.id).knowledgeMergeProposals.find(
      item => item.id === mergeProposal!.id,
    )
    const mergedKnowledge = acceptedMerge?.outputKnowledgeId === undefined
      ? undefined
      : scaffold!.ctx.autodev.knowledge.get(acceptedMerge.outputKnowledgeId)
    expect(mergedKnowledge).toMatchObject({ statement: MERGED_KNOWLEDGE_STATEMENT, status: 'CANDIDATE', version: 1 })
    expect(mergedKnowledge?.sourceRefs.some(ref => ref.sourceType === 'human' && ref.note === mergeResolution)).toBe(true)
    expect(scaffold!.ctx.autodev.knowledge.get(mergeInputOne.id)).toMatchObject({ status: 'CANDIDATE', version: 1 })
    expect(scaffold!.ctx.autodev.knowledge.get(mergeInputTwo.id)).toMatchObject({ status: 'CANDIDATE', version: 1 })

    const regressionSection = recoveredPanel.locator('section[aria-labelledby="autodev-knowledge-regression-title"]')
    await regressionSection.getByLabel('Case name').fill('Web reviewed refund Knowledge retrieval')
    await regressionSection.getByLabel('Retrieval query').fill('refund')
    await regressionSection.getByLabel('Knowledge that must be retrieved (one per line)').fill(MERGED_KNOWLEDGE_STATEMENT)
    await regressionSection.getByRole('button', { name: 'Save regression case' }).click()
    const regressionCase = scaffold!.ctx.autodev.snapshot(semanticRun!.id).regressionCases.find(item => item.name === 'Web reviewed refund Knowledge retrieval')
    expect(regressionCase).toBeDefined()
    await regressionSection.getByRole('button', { name: 'Run complete regression suite' }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(semanticRun!.id).regressionSuites.at(-1)?.status,
      { timeout: 10_000, interval: 100 },
    ).toBe('PASS')
    const trustedTestEvidence = semanticVerified.evidence.find(item => item.type === 'TEST' && item.status === 'PASS' && item.source !== 'agent')
    expect(trustedTestEvidence).toBeDefined()
    const knowledgePromotionSection = recoveredPanel.locator('section[aria-labelledby="autodev-knowledge-promotion-title"]')
    const mergedKnowledgeCard = knowledgePromotionSection.locator('article').filter({ hasText: MERGED_KNOWLEDGE_STATEMENT })
    await mergedKnowledgeCard.locator('fieldset label').filter({ hasText: trustedTestEvidence!.id }).locator('input').check()
    await mergedKnowledgeCard.getByLabel('Fresh PASS regression case').selectOption(regressionCase!.id)
    await mergedKnowledgeCard.getByLabel('I reviewed the Candidate, Evidence, and PASS regression results and confirm promotion to Established.').check()
    await mergedKnowledgeCard.getByRole('button', { name: 'Promote to Established' }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.knowledge.get(mergedKnowledge!.id)?.status,
      { timeout: 10_000, interval: 100 },
    ).toBe('ESTABLISHED')
    expect(scaffold!.ctx.autodev.knowledge.get(mergedKnowledge!.id)?.version).toBe(2)
    expect(scaffold!.ctx.autodev.snapshot(semanticRun!.id).actionIntents.at(-1)).toMatchObject({ kind: 'knowledge-promotion', status: 'COMMITTED' })

    const compactInputOne = scaffold!.ctx.autodev.knowledge.candidate({
      scope: semanticScope, kind: 'fact', statement: COMPACTABLE_KNOWLEDGE_STATEMENT, content: 'Same scoped compaction content.',
    })
    const compactInputTwo = scaffold!.ctx.autodev.knowledge.candidate({
      scope: semanticScope, kind: 'fact', statement: COMPACTABLE_KNOWLEDGE_STATEMENT, content: 'Same scoped compaction content.',
    })
    const compactionSection = recoveredPanel.locator('section[aria-labelledby="autodev-knowledge-compaction-title"]')
    await compactionSection.getByRole('button', { name: 'Review and compact Knowledge' }).click()
    await compactionSection.getByRole('button', { name: 'Confirm compaction' }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(semanticRun!.id).compactions.some(report =>
        report.snapshots.some(item => item.id === compactInputOne.id) &&
        report.snapshots.some(item => item.id === compactInputTwo.id),
      ),
      { timeout: 10_000, interval: 100 },
    ).toBe(true)
    const compactionReport = scaffold!.ctx.autodev.snapshot(semanticRun!.id).compactions.find(report =>
      report.snapshots.some(item => item.id === compactInputOne.id),
    )
    expect(compactionReport).toBeDefined()
    const compactionCard = compactionSection.locator('article').filter({ hasText: compactionReport!.id })
    await compactionCard.getByRole('button', { name: 'Restore this compaction' }).click()
    await compactionCard.getByRole('button', { name: 'Confirm restoration' }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(semanticRun!.id).compactions.find(report => report.id === compactionReport!.id)?.restoredAt,
      { timeout: 10_000, interval: 100 },
    ).toBeDefined()
    expect(scaffold!.ctx.autodev.knowledge.get(compactInputOne.id)?.status).toBe('CANDIDATE')
    expect(scaffold!.ctx.autodev.knowledge.get(compactInputTwo.id)?.status).toBe('CANDIDATE')

    const playbookReview = recoveredPanel.locator('section[aria-labelledby="autodev-playbook-review-title"]')
    await playbookReview.locator('details').first().locator('summary').click()
    const playbookDraftForm = playbookReview.locator('details').first()
    await playbookDraftForm.getByLabel('Playbook key: Create Playbook draft').fill(PLAYBOOK_KEY)
    await playbookDraftForm.getByLabel('Name: Create Playbook draft').fill(PLAYBOOK_NAME_V1)
    await playbookDraftForm.getByLabel('Purpose: Create Playbook draft').fill('Handle eligible partial refunds for captured payments.')
    await playbookDraftForm.getByLabel('Applicable targets (one per line): Create Playbook draft').fill('captured payment')
    await playbookDraftForm.getByLabel('Expected effects (one per line): Create Playbook draft').fill('eligible partial reversal')
    await playbookDraftForm.getByLabel('Related Concept keys (one per line, optional): Create Playbook draft').fill('refund')
    await playbookDraftForm.getByLabel('Steps (one per line): Create Playbook draft').fill('Check refund eligibility\nVerify captured payment\nApply partial reversal')
    await playbookDraftForm.getByRole('button', { name: 'Create Playbook draft' }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(semanticRun!.id).playbooks.find(item => item.key === PLAYBOOK_KEY && item.version === 1)?.status,
      { timeout: 10_000, interval: 100 },
    ).toBe('DRAFT')
    const playbookV1 = scaffold!.ctx.autodev.snapshot(semanticRun!.id).playbooks.find(
      item => item.key === PLAYBOOK_KEY && item.version === 1,
    )
    expect(playbookV1).toBeDefined()
    const playbookV1Card = playbookReview.locator('article').filter({ hasText: `${PLAYBOOK_KEY} · v1 · DRAFT` })
    await playbookV1Card.getByRole('button', { name: 'Activate Playbook' }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(semanticRun!.id).run.status,
      { timeout: 10_000, interval: 100 },
    ).toBe('NEEDS_INTERVENTION')
    expect(scaffold!.ctx.autodev.snapshot(semanticRun!.id).playbooks.find(item => item.id === playbookV1!.id)?.status).toBe('ACTIVE')
    expect(scaffold!.ctx.autodev.snapshot(semanticRun!.id).gates.at(-1)?.options).toContain('replan')

    const activePlaybookCard = playbookReview.locator('article').filter({ hasText: `${PLAYBOOK_KEY} · v1 · ACTIVE` })
    await activePlaybookCard.locator('details').locator('summary').click()
    await activePlaybookCard.getByLabel(`Name: ${PLAYBOOK_KEY}`).fill(PLAYBOOK_NAME_V2)
    await activePlaybookCard.getByLabel(`Purpose: ${PLAYBOOK_KEY}`).fill('Apply the reviewed eligibility rule to an allowed partial refund.')
    await activePlaybookCard.getByLabel(`Applicable targets (one per line): ${PLAYBOOK_KEY}`).fill('captured payment')
    await activePlaybookCard.getByLabel(`Expected effects (one per line): ${PLAYBOOK_KEY}`).fill('eligible partial reversal')
    await activePlaybookCard.getByLabel(`Related Concept keys (one per line, optional): ${PLAYBOOK_KEY}`).fill('refund')
    await activePlaybookCard.getByLabel(`Steps (one per line): ${PLAYBOOK_KEY}`).fill('Review the refund eligibility decision\nVerify the captured payment\nApply only the eligible partial reversal')
    await activePlaybookCard.getByLabel(`Revision rationale: ${PLAYBOOK_KEY}`).fill('Retain the reviewed v1 lineage while clarifying the eligibility decision step.')
    await activePlaybookCard.getByRole('button', { name: 'Save new version' }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(semanticRun!.id).playbooks.find(item => item.key === PLAYBOOK_KEY && item.version === 2)?.status,
      { timeout: 10_000, interval: 100 },
    ).toBe('ACTIVE')
    const playbookV2 = scaffold!.ctx.autodev.snapshot(semanticRun!.id).playbooks.find(
      item => item.key === PLAYBOOK_KEY && item.version === 2,
    )
    expect(playbookV2).toBeDefined()
    expect(scaffold!.ctx.autodev.snapshot(semanticRun!.id).playbooks.find(item => item.id === playbookV1!.id)).toMatchObject({ status: 'DEPRECATED', supersededBy: playbookV2!.id })
    await recoveredPanel.getByRole('button', { name: 'Create a new Plan', exact: true }).click()
    await recoveredPanel.getByRole('button', { name: 'Approve this Plan version' }).waitFor({ timeout: 20_000 })
    const playbookReplanned = scaffold!.ctx.autodev.snapshot(semanticRun!.id)
    expect(playbookReplanned.plan?.version).toBe(3)
    expect(playbookReplanned.plan?.playbookIds).toContain(playbookV2!.id)
    expect(playbookReplanned.plan?.playbookIds).not.toContain(playbookV1!.id)
    await recoveredPanel.getByRole('button', { name: 'Approve this Plan version' }).click()
    await recoveredPanel.getByRole('button', { name: 'Start in this DSH Session' }).click()
    await expect.poll(
      () => {
        const current = scaffold!.ctx.autodev.snapshot(semanticRun!.id)
        return current.run.status === 'VERIFY' ? 'VERIFY' : JSON.stringify({
          status: current.run.status,
          lastError: current.run.lastError,
          gate: current.gates.at(-1)?.reason,
          gateOptions: current.gates.at(-1)?.options,
          assumptions: current.assumptions.map(item => ({ statement: item.statement, status: item.status, evidenceIds: item.evidenceIds })),
          unresolvedConcepts: scaffold!.ctx.autodev.concepts.unresolvedAmbiguities(semanticScope, semanticRun!.request),
          playbook: current.playbooks.find(item => item.id === playbookV2!.id),
          concepts: current.concepts.filter(item => item.key === 'refund').map(item => ({
            id: item.id, version: item.version, status: item.status, target: item.target, effect: item.effect, scope: item.scope,
          })),
          playbookFits: current.playbookFits.filter(item => item.playbookId === playbookV2!.id),
        })
      },
      { timeout: 30_000, interval: 100 },
    ).toBe('VERIFY')
    const playbookVerified = scaffold!.ctx.autodev.snapshot(semanticRun!.id)
    expect(playbookVerified.run.attempt).toBe(3)
    expect(playbookVerified.playbookFits.find(item => item.playbookId === playbookV2!.id && item.playbookVersion === 2)?.outcome).toBe('MATCH')
    const playbookContext = providerContexts.find(context =>
      context.runId === semanticRun!.id && context.planVersionId === playbookReplanned.plan!.id,
    )
    expect(playbookContext?.playbookRefs).toContain(playbookV2!.id)
    expect(playbookContext?.playbookCards?.join('\n')).toContain('v2')
    expect(playbookContext?.playbookCards?.join('\n')).toContain('Review the refund eligibility decision')
    const playbookV2Card = playbookReview.locator('article').filter({ hasText: PLAYBOOK_NAME_V2 })
    await playbookV2Card.getByRole('button', { name: 'Deprecate Playbook' }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(semanticRun!.id).playbooks.find(item => item.id === playbookV2!.id)?.status,
      { timeout: 10_000, interval: 100 },
    ).toBe('DEPRECATED')
    const deprecatedSnapshot = scaffold!.ctx.autodev.snapshot(semanticRun!.id)
    expect(deprecatedSnapshot.run.status).toBe('NEEDS_INTERVENTION')
    expect(deprecatedSnapshot.gates.at(-1)?.options).toContain('replan')

    await recoveredPanel.getByLabel('Absolute Git repository path').fill(repoRoot)
    await recoveredPanel.getByLabel('Requested change').fill(SUCCESS_REQUEST)
    await recoveredPanel.getByLabel('Acceptance criteria (one per line)').fill('Set src/result.txt to the candidate value and pass the Node checks.')
    await recoveredPanel.getByRole('button', { name: 'Create task and Plan' }).click()
    await recoveredPanel.getByRole('button', { name: 'Approve this Plan version' }).waitFor({ timeout: 20_000 })
    const successRun = scaffold!.ctx.autodev.listRuns().find(run => run.request === SUCCESS_REQUEST)
    expect(successRun).toBeDefined()
    await recoveredPanel.getByRole('button', { name: 'Approve this Plan version' }).click()
    await recoveredPanel.getByRole('button', { name: 'Start in this DSH Session' }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(successRun!.id).run.status,
      { timeout: 30_000, interval: 100 },
    ).toBe('VERIFY')

    const verified = scaffold!.ctx.autodev.snapshot(successRun!.id)
    expect(verified.verifications.at(-1)?.status).toBe('PASS')
    expect(verified.evidence.map(item => `${item.type}:${item.status}`)).toEqual(expect.arrayContaining([
      'AGENT_CONTEXT:PASS', 'AGENT_OUTPUT:PASS', 'BUILD:PASS', 'TEST:PASS', 'REVIEW:PASS',
    ]))
    expect(verified.candidate?.worktreePath).toBeDefined()
    expect(providerWorkspaces.at(-1)).toBe(verified.candidate?.worktreePath)
    expect(verified.evidence.some(item => item.candidateId === verified.candidate?.id && item.type === 'TEST' && item.status === 'PASS')).toBe(true)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim()).toBe('')
    expect(await readFile(join(repoRoot, 'src', 'result.txt'), 'utf8')).toBe('original\n')

    await recoveredPanel.getByRole('button', { name: 'Refresh' }).click()
    await recoveredPanel.locator('pre').filter({ hasText: 'candidate from deterministic provider' }).first()
      .waitFor({ state: 'visible', timeout: 10_000 })
    await recoveredPanel.getByRole('button', { name: 'Promote candidate' }).click()
    const confirmation = recoveredPanel.getByRole('group', {
      name: 'Review the Candidate Diff and Evidence before applying it to the original repository.',
    })
    await confirmation.waitFor()
    await confirmation.getByRole('button', { name: 'Confirm promotion' }).click()
    await expect.poll(
      () => scaffold!.ctx.autodev.snapshot(successRun!.id).run.status,
      { timeout: 15_000, interval: 100 },
    ).toBe('PROMOTED')

    expect((await readFile(join(repoRoot, 'src', 'result.txt'), 'utf8')).replace(/\r\n/gu, '\n')).toBe(CANDIDATE_CONTENT)
    expect(execFileSync('git', ['diff', '--name-only'], { cwd: repoRoot, encoding: 'utf8' }).trim().split(/\r?\n/u)).toEqual(['src/result.txt'])
    const promoted = scaffold!.ctx.autodev.snapshot(successRun!.id)
    expect(promoted.evidence.some(item => item.type === 'PROMOTION' && item.status === 'PASS' && item.candidateId === promoted.candidate?.id)).toBe(true)
    expect(promoted.actionIntents.some(item => item.kind === 'git-promotion' && item.status === 'COMMITTED')).toBe(true)
  } catch (error: unknown) {
    if (page !== undefined) await saveFailureShot(page, 'web-e2e-autodev-workbench')
    throw error
  } finally {
    await dispose()
    await rm(testRoot, { recursive: true, force: true })
  }
}, 180_000)

async function openAutoDev(page: Page): Promise<void> {
  const column = page.locator('[data-rightbar-col]').first()
  const expand = page.locator('[data-sidebar-right-expand]').first()
  if (await column.locator('[data-sidebar-right-open]').count() === 0) await expand.click()
  await column.locator('[data-sidebar-right-open]').waitFor({ timeout: 10_000 })
  await column.locator('[data-sidebar-right-guide-entry="autodev"]').click()
  await page.locator('[data-autodev-panel]').waitFor({ timeout: 15_000 })
}
