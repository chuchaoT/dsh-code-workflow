// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutoDevPanel, type AutoDevPanelProps } from '../src/client/AutoDevPanel.tsx'
import { zh, type AutoDevKey } from '../src/client/locales.ts'
import type { AutoDevSnapshot } from '../src/contracts.ts'

afterEach(cleanup)

function chooseTab(label: string): void {
  fireEvent.click(screen.getByRole('tab', { name: label }))
}

describe('AutoDev sidebar task authoring', () => {
  it('requires explicit selection, a durable cleanup Job, and a typed second confirmation', async () => {
    const retentionPreview = {
      generatedAt: new Date().toISOString(), minAgeDays: 30, snapshotFingerprint: 'f'.repeat(64),
      eligibleWorktrees: [{ retentionId: 'retention-1', runId: 'run-old', attempt: 2, ageDays: 60 }],
      blockedWorktrees: [{ retentionId: 'retention-2', runId: 'run-active', attempt: 1, ageDays: 60, reasons: ['run-not-terminal'] }],
    }
    let jobs: readonly Record<string, unknown>[] = []
    const job = {
      id: 'cleanup-job-12345678', status: 'AWAITING_CONFIRMATION', minAgeDays: 30,
      snapshotFingerprint: 'f'.repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      confirmationPhrase: 'DELETE-12345678',
      items: [{ retentionId: 'retention-1', runId: 'run-old', attempt: 2, status: 'PENDING' }],
      requestedBy: { kind: 'dsh-operator', source: 'dsh-gateway', connectionPeerId: 'peer-ui-test' },
      events: [{ at: new Date().toISOString(), type: 'prepared', actor: { kind: 'dsh-operator', source: 'dsh-gateway', connectionPeerId: 'peer-ui-test' } }],
    }
    const completedJob = { ...job, status: 'COMPLETED', items: [{ ...job.items[0]!, status: 'REMOVED' }] }
    const remote = {
      list: vi.fn(async () => ({ ok: true as const, value: [] })),
      retentionPreview: vi.fn(async () => ({ ok: true as const, value: retentionPreview })),
      retentionCleanupJobs: vi.fn(async () => ({ ok: true as const, value: jobs })),
      prepareRetentionCleanup: vi.fn(async () => {
        jobs = [job]
        return { ok: true as const, value: job }
      }),
      executeRetentionCleanup: vi.fn(async () => {
        jobs = [completedJob]
        return { ok: true as const, value: completedJob }
      }),
      cancelRetentionCleanup: vi.fn(async () => ({ ok: true as const, value: { ...job, status: 'CANCELLED' } })),
    }
    const props = {
      useTabInfo: () => ({ tab: { id: 'autodev-retention-tab' } }),
      sessionId: 'session-retention', remote,
      t: (key: AutoDevKey) => zh[key],
    } as unknown as AutoDevPanelProps
    render(<AutoDevPanel {...props} />)

    chooseTab(zh.settingsTab)
    expect(await screen.findByText(zh.providerSettingsUnavailable)).toBeTruthy()
    chooseTab(zh.maintenanceTab)
    fireEvent.change(screen.getByLabelText(zh.minAgeDays), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: zh.previewRetention }))
    expect(await screen.findByText(/run-old · #2 · 60d/u)).toBeTruthy()
    expect(screen.getByText(/run-active · #1: run-not-terminal/u)).toBeTruthy()
    expect(screen.getByText(zh.retentionNotice)).toBeTruthy()
    expect(remote.retentionPreview).toHaveBeenCalledWith({ minAgeDays: 30 })
    expect(screen.queryByRole('button', { name: zh.executeRetentionCleanup })).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: `${zh.selectRetentionWorktree}: run-old #2` }))
    fireEvent.click(screen.getByRole('button', { name: zh.prepareRetentionCleanup }))
    await waitFor(() => expect(remote.prepareRetentionCleanup).toHaveBeenCalledWith({
      requestId: expect.any(String), minAgeDays: 30, snapshotFingerprint: 'f'.repeat(64), retentionIds: ['retention-1'],
    }))
    await waitFor(() => expect(screen.getByLabelText(zh.retentionCleanupJobs).textContent).toContain(zh.auditOperator))
    expect(screen.getByLabelText(zh.retentionCleanupJobs).textContent).toContain(zh.cleanupEventPrepared)
    expect((await screen.findByRole('button', { name: zh.executeRetentionCleanup }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(zh.retentionConfirmationInput), { target: { value: 'DELETE-12345678' } })
    fireEvent.click(screen.getByRole('button', { name: zh.executeRetentionCleanup }))
    await waitFor(() => expect(remote.executeRetentionCleanup).toHaveBeenCalledWith({
      jobId: 'cleanup-job-12345678', snapshotFingerprint: 'f'.repeat(64), confirmationPhrase: 'DELETE-12345678',
    }))
    expect(await screen.findByText(/COMPLETED/u)).toBeTruthy()
  })

  it('loads and saves Profile-scoped provider settings without persisting Jev credentials', async () => {
    const providerSettings = {
      decisionBackend: 'ollama' as const,
      ollamaEndpoint: 'http://127.0.0.1:11434',
      ollamaModel: 'qwen3-coder',
      analysisProvider: 'claude-code',
      engineeringProvider: 'codex',
      jevApiKeyEnv: 'TYPESAFE_API_KEY',
      jevCredentialConfigured: false,
      providers: [
        { name: 'claude-code', kind: 'subagent' as const, available: true, traits: [] },
        { name: 'codex', kind: 'subagent' as const, available: true, traits: [] },
        { name: 'codebuddy', kind: 'command' as const, available: true, traits: ['cost-efficient'] },
      ],
      analysisProviders: [
        { name: 'claude-code', kind: 'subagent' as const, available: true, traits: [] },
        { name: 'codex', kind: 'subagent' as const, available: true, traits: [] },
      ],
      engineeringProviders: [
        { name: 'codex', kind: 'subagent' as const, available: true, traits: [] },
        { name: 'claude-code', kind: 'subagent' as const, available: true, traits: [] },
        { name: 'codebuddy', kind: 'command' as const, available: true, traits: ['cost-efficient'] },
      ],
      activeRunCount: 0,
    }
    const providerSettingsRemote = vi.fn(async () => ({ ok: true as const, value: providerSettings }))
    const updateProviderSettings = vi.fn(async (next: typeof providerSettings) => ({
      ok: true as const, value: { ...providerSettings, ...next, decisionBackend: next.decisionBackend },
    }))
    const remote = {
      list: vi.fn(async () => ({ ok: true as const, value: [] })),
      providerSettings: providerSettingsRemote,
      updateProviderSettings,
    }
    const props = {
      useTabInfo: () => ({ tab: { id: 'autodev-provider-settings-tab' } }),
      sessionId: 'session-provider-settings', remote,
      t: (key: AutoDevKey) => zh[key],
    } as unknown as AutoDevPanelProps
    render(<AutoDevPanel {...props} />)

    chooseTab(zh.settingsTab)
    const backend = await screen.findByLabelText(zh.decisionBackend) as HTMLSelectElement
    expect(backend.value).toBe('ollama')
    expect((screen.getByLabelText(zh.ollamaModel) as HTMLInputElement).value).toBe('qwen3-coder')
    fireEvent.change(backend, { target: { value: 'jev' } })
    expect(screen.getByText(zh.jevCredentialSetup)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.saveProviderSettings }))
    await waitFor(() => expect(updateProviderSettings).toHaveBeenCalledWith({
      decisionBackend: 'jev',
      ollamaEndpoint: 'http://127.0.0.1:11434',
      ollamaModel: 'qwen3-coder',
      analysisProvider: 'claude-code',
      engineeringProvider: 'codex',
    }))
    expect(JSON.stringify(updateProviderSettings.mock.calls[0]?.[0])).not.toContain('TYPESAFE_API_KEY')
  })

  it('separates task creation, Run list/details, provider settings, and maintenance into navigable tabs', async () => {
    const snapshot = {
      run: { id: 'run-tabs', status: 'DRAFT', request: 'Browse selected run', updatedAt: new Date().toISOString(), acceptanceCriteria: [] },
      plan: undefined, nodes: [], evidence: [], verifications: [], verificationResults: [], signals: [], assumptions: [], uncertainties: [],
      memories: [], knowledge: [], concepts: [], playbooks: [], knowledgeMergeProposals: [], actionIntents: [], gates: [], auditEvents: [],
    } as unknown as AutoDevSnapshot
    const remote = {
      list: vi.fn(async () => ({ ok: true as const, value: [snapshot.run] })),
      snapshot: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      candidateDiff: vi.fn(async () => ({ ok: true as const, value: undefined })),
    }
    const props = {
      useTabInfo: () => ({ tab: { id: 'autodev-navigation-tab' } }),
      sessionId: 'session-navigation', remote,
      t: (key: AutoDevKey) => zh[key],
    } as unknown as AutoDevPanelProps
    render(<AutoDevPanel {...props} />)

    const tabPanel = screen.getByRole('tabpanel')
    expect(screen.getAllByRole('tab')).toHaveLength(5)
    expect(screen.getByRole('tab', { name: zh.taskCreateTab }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('heading', { name: zh.create })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: zh.runHistory })).toBeNull()
    expect(screen.queryByRole('heading', { name: zh.providerSettingsTitle })).toBeNull()

    chooseTab(zh.settingsTab)
    expect(screen.getByRole('heading', { name: zh.providerSettingsTitle })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: zh.create })).toBeNull()
    chooseTab(zh.maintenanceTab)
    expect(screen.getByRole('region', { name: zh.backupRecovery })).toBeTruthy()

    chooseTab(zh.taskCreateTab)
    chooseTab(zh.runListTab)
    expect(screen.getByRole('heading', { name: zh.runHistory })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: zh.create })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: /Browse selected run/u }))
    await screen.findByRole('heading', { name: zh.details })
    expect(screen.getByRole('tab', { name: zh.runDetailsTab }).getAttribute('aria-selected')).toBe('true')
    expect(tabPanel.getAttribute('aria-labelledby')).toContain('details')
  })

  it('creates a task with separate acceptance criteria and displays its Plan without auto-starting', async () => {
    const snapshot = {
      run: { id: 'run-web-1', status: 'DRAFT', request: 'Add a test', updatedAt: new Date().toISOString(), acceptanceCriteria: ['file exists', 'tests pass'] },
      plan: { id: 'plan-web-1', version: 1, fingerprint: 'plan-fingerprint', nodes: [{ id: 'implement', kind: 'implement', description: 'Implement the change' }] },
      nodes: [], evidence: [], verifications: [], verificationResults: [], signals: [], assumptions: [], uncertainties: [],
      memories: [], knowledge: [], concepts: [], playbooks: [], knowledgeMergeProposals: [], actionIntents: [], gates: [], auditEvents: [],
    } as unknown as AutoDevSnapshot
    let current = snapshot
    let runs: readonly AutoDevSnapshot['run'][] = []
    const create = vi.fn(async () => { runs = [snapshot.run]; return { ok: true as const, value: snapshot } })
    const approvePlan = vi.fn(async () => {
      const actor = { kind: 'dsh-operator', source: 'dsh-gateway' } as const
      current = {
        ...snapshot,
        run: { ...snapshot.run, status: 'READY', approvedPlanId: snapshot.plan!.id, approvedBy: actor },
        auditEvents: [{
          id: 'audit-plan-1', runId: snapshot.run.id, action: 'plan-approved', actor,
          resourceKind: 'run', resourceId: snapshot.run.id, result: 'APPROVED', createdAt: new Date().toISOString(),
        }],
      }
      runs = [current.run]
      return { ok: true as const, value: current }
    })
    const start = vi.fn(async () => {
      current = { ...current, run: { ...current.run, status: 'EXECUTING' } }
      runs = [current.run]
      return { ok: true as const, value: current }
    })
    const remote = {
      list: vi.fn(async () => ({ ok: true as const, value: runs })),
      snapshot: vi.fn(async () => ({ ok: true as const, value: current })),
      candidateDiff: vi.fn(async () => ({ ok: true as const, value: undefined })),
      create, approvePlan, start,
    }
    const props = {
      useTabInfo: () => ({ tab: { id: 'autodev-test-tab' } }),
      sessionId: 'session-web-panel',
      remote,
      t: (key: AutoDevKey) => zh[key],
    } as unknown as AutoDevPanelProps
    render(<AutoDevPanel {...props} />)

    fireEvent.change(screen.getByLabelText(zh.repoPath), { target: { value: ' C:/isolated/repo ' } })
    fireEvent.change(screen.getByLabelText(zh.requestInput), { target: { value: ' Add a test ' } })
    fireEvent.change(screen.getByLabelText(zh.mode), { target: { value: 'TEST' } })
    fireEvent.change(screen.getByLabelText(zh.acceptanceCriteria), { target: { value: 'file exists\n\ntests pass' } })
    fireEvent.change(screen.getByLabelText(zh.buildDriver), { target: { value: 'node' } })
    fireEvent.click(screen.getByRole('button', { name: zh.create }))

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      repoPath: 'C:/isolated/repo', request: 'Add a test', mode: 'TEST', acceptanceCriteria: ['file exists', 'tests pass'], buildDriver: 'node',
    }))
    expect(screen.getByRole('tab', { name: zh.runDetailsTab }).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByText(zh.reviewBeforeRun)).toBeTruthy()
    expect(screen.getByText(/Implement the change/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.approvePlan }))
    await waitFor(() => expect(approvePlan).toHaveBeenCalledWith({ runId: 'run-web-1', planId: 'plan-web-1' }))
    expect(await screen.findByText(zh.planApproved)).toBeTruthy()
    expect(screen.getByLabelText(zh.auditTitle).textContent).toContain(zh.auditOperator)
    expect(screen.getByLabelText(zh.auditTitle).textContent).toContain(zh.auditPlanApproved)
    fireEvent.click(screen.getByRole('button', { name: zh.startRun }))
    await waitFor(() => expect(start).toHaveBeenCalledWith({ runId: 'run-web-1', sessionId: 'session-web-panel' }))
  })

  it('renders partial Agent progress as unverified output on the active node', async () => {
    const snapshot = {
      run: {
        id: 'run-progress', status: 'NEEDS_INTERVENTION', activePlanId: 'plan-progress',
        request: 'Finish the implementation', updatedAt: new Date().toISOString(), acceptanceCriteria: [],
      },
      plan: {
        id: 'plan-progress', version: 1, fingerprint: 'progress-fingerprint',
        nodes: [{ id: 'implement', kind: 'implement', description: 'Implement the requested change' }],
      },
      nodes: [{
        id: 'node-progress', runId: 'run-progress', planId: 'plan-progress', nodeId: 'implement',
        attempt: 1, status: 'UNKNOWN',
        agentProgress: {
          status: 'PARTIAL', text: 'The Agent began editing but did not return a terminal response.',
          activity: 'tool-started', updatedAt: new Date().toISOString(),
        },
      }],
      evidence: [], verifications: [], verificationResults: [], signals: [], assumptions: [], uncertainties: [],
      memories: [], knowledge: [], concepts: [], playbooks: [], knowledgeMergeProposals: [],
      actionIntents: [], gates: [], auditEvents: [],
    } as unknown as AutoDevSnapshot
    const remote = {
      list: vi.fn(async () => ({ ok: true as const, value: [snapshot.run] })),
      snapshot: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      candidateDiff: vi.fn(async () => ({ ok: true as const, value: undefined })),
    }
    const props = {
      useTabInfo: () => ({ tab: { id: 'autodev-progress-tab' } }),
      sessionId: 'session-progress', remote,
      t: (key: AutoDevKey) => zh[key],
    } as unknown as AutoDevPanelProps
    render(<AutoDevPanel {...props} />)
    chooseTab(zh.runDetailsTab)

    expect(await screen.findByText(zh.agentOutputUnverified)).toBeTruthy()
    expect(screen.getByText(new RegExp(zh.agentProgressPartial, 'u'))).toBeTruthy()
    expect(screen.getByText(new RegExp(zh.agentActivityToolStarted, 'u'))).toBeTruthy()
    expect(screen.getByText('The Agent began editing but did not return a terminal response.')).toBeTruthy()
  })

  it('compares two Candidate revisions from the same Run with versioned verification metadata', async () => {
    const candidates = [
      { id: 'candidate-revision-a', runId: 'run-compare', planId: 'plan-v1', baseCommit: 'base-commit', gitTreeHash: 'tree-a', attempt: 1, diffAvailable: true, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'candidate-revision-b', runId: 'run-compare', planId: 'plan-v2', baseCommit: 'base-commit', gitTreeHash: 'tree-b', attempt: 2, diffAvailable: true, createdAt: '2026-01-02T00:00:00.000Z' },
    ]
    const snapshot = {
      run: { id: 'run-compare', status: 'NEEDS_INTERVENTION', candidateId: 'candidate-revision-b', request: 'Compare Candidate revisions', updatedAt: new Date().toISOString(), acceptanceCriteria: [] },
      candidateHistory: candidates,
      plan: undefined,
      nodes: [],
      evidence: [
        { id: 'evidence-a', candidateId: 'candidate-revision-a', type: 'TEST', status: 'PASS', summary: 'Revision A tests pass' },
        { id: 'evidence-b', candidateId: 'candidate-revision-b', type: 'TEST', status: 'WARN', summary: 'Revision B tests need review' },
      ],
      verifications: [
        { id: 'verification-a', candidateId: 'candidate-revision-a', status: 'PASS', summary: 'A verified' },
        { id: 'verification-b', candidateId: 'candidate-revision-b', status: 'WARN', summary: 'B needs review' },
      ],
      verificationResults: [],
      signals: [],
      assumptions: [],
      uncertainties: [],
      memories: [],
      knowledge: [],
      concepts: [],
      playbooks: [],
      knowledgeMergeProposals: [],
      actionIntents: [],
      gates: [{ id: 'gate-compare', runId: 'run-compare', reason: 'Review revisions', options: ['abandon'], status: 'OPEN', createdAt: new Date().toISOString() }],
    } as unknown as AutoDevSnapshot
    const remote = {
      list: vi.fn(async () => ({ ok: true as const, value: [snapshot.run] })),
      snapshot: vi.fn(async () => ({ ok: true as const, value: snapshot })),
      candidateDiff: vi.fn(async () => ({ ok: true as const, value: undefined })),
      candidateRevisionDiff: vi.fn(async (_runId: string, candidateId: string) => ({
        ok: true as const,
        value: { id: `diff-${candidateId}`, runId: 'run-compare', kind: 'candidate-diff', sha256: 'hash', bytes: 12, content: `diff for ${candidateId}`, truncated: false },
      })),
    }
    const props = {
      useTabInfo: () => ({ tab: { id: 'autodev-compare-tab' } }),
      sessionId: 'session-compare', remote,
      t: (key: AutoDevKey) => zh[key],
    } as unknown as AutoDevPanelProps
    render(<AutoDevPanel {...props} />)
    chooseTab(zh.runDetailsTab)

    expect(await screen.findByText(zh.candidateComparison)).toBeTruthy()
    expect(await screen.findByText('diff for candidate-revision-a')).toBeTruthy()
    expect(await screen.findByText('diff for candidate-revision-b')).toBeTruthy()
    expect(screen.getByText(/tree-a/)).toBeTruthy()
    expect(screen.getByText(/PASS · .*1/)).toBeTruthy()
    expect(screen.getByText(/WARN · .*1/)).toBeTruthy()
    expect(remote.candidateRevisionDiff).toHaveBeenCalledWith('run-compare', 'candidate-revision-a')
    expect(remote.candidateRevisionDiff).toHaveBeenCalledWith('run-compare', 'candidate-revision-b')

    fireEvent.change(screen.getByLabelText(zh.compareOlder), { target: { value: 'candidate-revision-b' } })
    await waitFor(() => expect(remote.candidateRevisionDiff).toHaveBeenCalledTimes(4))
    expect(await screen.findByRole('region', { name: `${zh.compareOlder}: candidate-revision-b` })).toBeTruthy()
    expect(await screen.findByRole('region', { name: `${zh.compareNewer}: candidate-revision-a` })).toBeTruthy()
  })

  it('requires a second confirmation to promote and routes retry through the active DSH Session', async () => {
    const gate = {
      id: 'gate-web-1', runId: 'run-web-2', reason: 'Review the retained Candidate',
      options: ['retry', 'rework', 'replan', 'abandon', 'promote', 'cancel'], status: 'OPEN', createdAt: new Date().toISOString(),
    }
    let current = {
      run: { id: 'run-web-2', status: 'NEEDS_INTERVENTION', currentGateId: gate.id, candidateId: 'candidate-web-2', request: 'Fix a regression', updatedAt: new Date().toISOString(), acceptanceCriteria: [] },
      plan: undefined, nodes: [], evidence: [{ id: 'evidence-1' }], verifications: [{ id: 'verification-1', status: 'PASS' }], verificationResults: [], signals: [], assumptions: [], uncertainties: [],
      memories: [], knowledge: [], concepts: [], playbooks: [], knowledgeMergeProposals: [], actionIntents: [], gates: [gate],
    } as unknown as AutoDevSnapshot
    let runs: readonly AutoDevSnapshot['run'][] = [current.run]
    const resolveGate = vi.fn(async (request: { action: string }) => {
      current = {
        ...current,
        run: { ...current.run, status: request.action === 'promote' ? 'PROMOTED' : 'EXECUTING' },
        gates: [{ ...gate, status: 'RESOLVED', selected: request.action }],
      } as AutoDevSnapshot
      runs = [current.run]
      return { ok: true as const, value: current }
    })
    const remote = {
      list: vi.fn(async () => ({ ok: true as const, value: runs })),
      snapshot: vi.fn(async () => ({ ok: true as const, value: current })),
      candidateDiff: vi.fn(async () => ({ ok: true as const, value: undefined })),
      resolveGate,
    }
    const props = {
      useTabInfo: () => ({ tab: { id: 'autodev-gate-test-tab' } }),
      sessionId: 'session-web-panel', remote,
      t: (key: AutoDevKey) => zh[key],
    } as unknown as AutoDevPanelProps
    render(<AutoDevPanel {...props} />)
    chooseTab(zh.runDetailsTab)

    await screen.findByRole('button', { name: zh.promote })
    for (const actionLabel of [zh.retry, zh.rework, zh.replan, zh.abandon, zh.cancel, zh.promote]) {
      expect(screen.getByRole('button', { name: actionLabel })).toBeTruthy()
    }
    fireEvent.click(await screen.findByRole('button', { name: zh.promote }))
    expect(await screen.findByText(zh.promotionReview)).toBeTruthy()
    expect(screen.getByText(/candidate-web-2/)).toBeTruthy()
    expect(resolveGate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.confirmPromotion }))
    await waitFor(() => expect(resolveGate).toHaveBeenCalledWith({ runId: 'run-web-2', action: 'promote' }))

    cleanup()
    current = {
      ...current,
      run: { ...current.run, status: 'NEEDS_INTERVENTION', currentGateId: gate.id },
      gates: [gate],
    } as AutoDevSnapshot
    runs = [current.run]
    render(<AutoDevPanel {...props} />)
    chooseTab(zh.runDetailsTab)
    fireEvent.click(await screen.findByRole('button', { name: zh.retry }))
    await waitFor(() => expect(resolveGate).toHaveBeenLastCalledWith({ runId: 'run-web-2', action: 'retry', sessionId: 'session-web-panel' }))
  })

  it('requires trusted PASS Evidence to confirm assumptions and supports uncertainty resolution', async () => {
    const snapshot = {
      run: { id: 'run-semantic-ui', status: 'DRAFT', request: 'Review semantic state', updatedAt: new Date().toISOString(), acceptanceCriteria: [] },
      plan: { id: 'plan-semantic-ui', version: 1, fingerprint: 'plan-fingerprint', nodes: [] },
      nodes: [],
      evidence: [
        { id: 'evidence-trusted', runId: 'run-semantic-ui', planId: 'plan-semantic-ui', type: 'REPOSITORY_BASELINE', status: 'PASS', source: 'runtime', summary: 'Repository baseline captured', createdAt: new Date().toISOString() },
        { id: 'evidence-agent', runId: 'run-semantic-ui', planId: 'plan-semantic-ui', type: 'REVIEW', status: 'PASS', source: 'agent', summary: 'Agent asserted confirmation', createdAt: new Date().toISOString() },
      ],
      verifications: [], verificationResults: [], signals: [],
      assumptions: [{ id: 'assumption-ui-1', runId: 'run-semantic-ui', planId: 'plan-semantic-ui', statement: 'The repository baseline is valid', status: 'PROPOSED', confidence: 0.6, evidenceIds: [], sourceRefs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
      uncertainties: [{ id: 'uncertainty-ui-1', runId: 'run-semantic-ui', planId: 'plan-semantic-ui', subject: 'Expected output format', reason: 'The request does not specify the format', alternatives: ['JSON', 'Markdown'], severity: 'medium', status: 'OPEN', sourceRefs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
      memories: [], knowledge: [], concepts: [], playbooks: [], knowledgeMergeProposals: [], actionIntents: [], gates: [],
    } as unknown as AutoDevSnapshot
    let current = snapshot
    const runs: readonly AutoDevSnapshot['run'][] = [current.run]
    const resolveAssumption = vi.fn(async (request: {
      assumptionId: string
      status: string
      resolution: string
      evidenceIds?: readonly string[]
    }) => {
      current = {
        ...current,
        assumptions: current.assumptions.map(item => item.id === request.assumptionId
          ? { ...item, status: request.status, resolution: request.resolution, evidenceIds: request.evidenceIds ?? [] }
          : item),
      } as AutoDevSnapshot
      return { ok: true as const, value: current }
    })
    const resolveUncertainty = vi.fn(async (request: { uncertaintyId: string; status: string; resolution: string }) => {
      current = {
        ...current,
        uncertainties: current.uncertainties.map(item => item.id === request.uncertaintyId
          ? { ...item, status: request.status, resolution: request.resolution }
          : item),
      } as AutoDevSnapshot
      return { ok: true as const, value: current }
    })
    const remote = {
      list: vi.fn(async () => ({ ok: true as const, value: runs })),
      snapshot: vi.fn(async () => ({ ok: true as const, value: current })),
      candidateDiff: vi.fn(async () => ({ ok: true as const, value: undefined })),
      resolveAssumption,
      resolveUncertainty,
    }
    const props = {
      useTabInfo: () => ({ tab: { id: 'autodev-semantic-test-tab' } }),
      sessionId: 'session-semantic-panel', remote,
      t: (key: AutoDevKey) => zh[key],
    } as unknown as AutoDevPanelProps
    render(<AutoDevPanel {...props} />)
    chooseTab(zh.runDetailsTab)

    const confirmButton = await screen.findByRole('button', { name: zh.confirmAssumption }) as HTMLButtonElement
    expect(confirmButton.disabled).toBe(true)
    expect(screen.queryByLabelText(`${zh.supportingEvidence}: Agent asserted confirmation`)).toBeNull()
    fireEvent.change(screen.getByLabelText(`${zh.assumptionResolution}: The repository baseline is valid`), { target: { value: 'Confirmed from the captured baseline' } })
    expect(confirmButton.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(`${zh.supportingEvidence}: Repository baseline captured`))
    expect(confirmButton.disabled).toBe(false)
    fireEvent.click(confirmButton)
    await waitFor(() => expect(resolveAssumption).toHaveBeenCalledWith({
      runId: 'run-semantic-ui', assumptionId: 'assumption-ui-1', status: 'CONFIRMED',
      resolution: 'Confirmed from the captured baseline', evidenceIds: ['evidence-trusted'],
    }))
    fireEvent.click(screen.getByRole('button', { name: zh.invalidateAssumption }))
    await waitFor(() => expect(resolveAssumption).toHaveBeenLastCalledWith({
      runId: 'run-semantic-ui', assumptionId: 'assumption-ui-1', status: 'INVALIDATED',
      resolution: 'Confirmed from the captured baseline', evidenceIds: ['evidence-trusted'],
    }))
    fireEvent.click(screen.getByRole('button', { name: zh.markAssumptionUnknown }))
    await waitFor(() => expect(resolveAssumption).toHaveBeenLastCalledWith({
      runId: 'run-semantic-ui', assumptionId: 'assumption-ui-1', status: 'UNKNOWN',
      resolution: 'Confirmed from the captured baseline', evidenceIds: ['evidence-trusted'],
    }))

    fireEvent.change(screen.getByLabelText(`${zh.uncertaintyResolution}: Expected output format`), { target: { value: 'Use Markdown as the project default' } })
    fireEvent.click(screen.getByRole('button', { name: zh.resolveUncertainty }))
    await waitFor(() => expect(resolveUncertainty).toHaveBeenCalledWith({
      runId: 'run-semantic-ui', uncertaintyId: 'uncertainty-ui-1', status: 'RESOLVED', resolution: 'Use Markdown as the project default',
    }))
  })

  it('records versioned Concept corrections and accepts or rejects Knowledge merge proposals', async () => {
    const concept = {
      id: 'concept-refund-ui', key: 'refund', name: 'Refund', definition: 'Return money to a customer', target: 'captured payment', effect: 'reverse payment',
      evidenceCriteria: [], status: 'CANDIDATE', confidence: 0.5, version: 1, sourceRefs: [], evidenceIds: [], relatedConceptIds: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    const knowledge = [
      { id: 'knowledge-ui-1', kind: 'rule', statement: 'Refund checks eligibility', content: 'Check the cancellation window.', status: 'CANDIDATE', confidence: 0.7, version: 1, sourceRefs: [], evidenceIds: [], relatedMemoryIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      { id: 'knowledge-ui-2', kind: 'rule', statement: 'Refund checks payment state', content: 'Only captured payments can be reversed.', status: 'CANDIDATE', confidence: 0.65, version: 2, sourceRefs: [], evidenceIds: [], relatedMemoryIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ]
    const proposals = [
      { id: 'merge-ui-1', kind: 'rule', inputIds: ['knowledge-ui-1', 'knowledge-ui-2'], inputVersions: [{ id: 'knowledge-ui-1', version: 1 }, { id: 'knowledge-ui-2', version: 2 }], similarity: 0.82, sharedTerms: ['refund', 'payment'], reason: 'Both records describe refund eligibility.', status: 'PROPOSED', createdAt: new Date().toISOString() },
      { id: 'merge-ui-2', kind: 'rule', inputIds: ['knowledge-ui-1', 'knowledge-ui-2'], inputVersions: [{ id: 'knowledge-ui-1', version: 1 }, { id: 'knowledge-ui-2', version: 2 }], similarity: 0.7, sharedTerms: ['refund'], reason: 'Review whether these statements should remain separate.', status: 'PROPOSED', createdAt: new Date().toISOString() },
    ]
    let current = {
      run: { id: 'run-knowledge-ui', status: 'DRAFT', request: 'Review project knowledge', updatedAt: new Date().toISOString(), acceptanceCriteria: [] },
      plan: undefined, nodes: [], evidence: [], verifications: [], verificationResults: [], signals: [], assumptions: [], uncertainties: [],
      memories: [],
      knowledge,
      concepts: [concept],
      conceptObservations: [],
      playbooks: [],
      knowledgeMergeProposals: proposals,
      actionIntents: [],
      gates: [],
    } as unknown as AutoDevSnapshot
    const runs: readonly AutoDevSnapshot['run'][] = [current.run]
    const correctConcept = vi.fn(async (request: {
      key: string
      name: string
      definition: string
      target: string
      effect: string
      evidenceSummary: string
      resolution: string
    }) => {
      current = { ...current, concepts: current.concepts.map(item => item.key === request.key ? { ...item, ...request, version: item.version + 1, status: 'ESTABLISHED' } : item) } as AutoDevSnapshot
      return { ok: true as const, value: current }
    })
    const proposeKnowledgeMerges = vi.fn(async () => ({ ok: true as const, value: current }))
    const acceptKnowledgeMerge = vi.fn(async (request: { proposalId: string; statement: string; content?: string; resolution: string }) => {
      current = { ...current, knowledgeMergeProposals: current.knowledgeMergeProposals.map(item => item.id === request.proposalId ? { ...item, status: 'ACCEPTED', resolution: request.resolution, outputKnowledgeId: 'knowledge-ui-merged' } : item) } as AutoDevSnapshot
      return { ok: true as const, value: current }
    })
    const rejectKnowledgeMerge = vi.fn(async (request: { proposalId: string; resolution: string }) => {
      current = { ...current, knowledgeMergeProposals: current.knowledgeMergeProposals.map(item => item.id === request.proposalId ? { ...item, status: 'REJECTED', resolution: request.resolution } : item) } as AutoDevSnapshot
      return { ok: true as const, value: current }
    })
    const remote = {
      list: vi.fn(async () => ({ ok: true as const, value: runs })),
      snapshot: vi.fn(async () => ({ ok: true as const, value: current })),
      candidateDiff: vi.fn(async () => ({ ok: true as const, value: undefined })),
      correctConcept, proposeKnowledgeMerges, acceptKnowledgeMerge, rejectKnowledgeMerge,
    }
    const props = {
      useTabInfo: () => ({ tab: { id: 'autodev-knowledge-test-tab' } }),
      sessionId: 'session-knowledge-panel', remote,
      t: (key: AutoDevKey) => zh[key],
    } as unknown as AutoDevPanelProps
    render(<AutoDevPanel {...props} />)
    chooseTab(zh.runDetailsTab)

    fireEvent.click(await screen.findByRole('button', { name: zh.proposeKnowledgeMerges }))
    await waitFor(() => expect(proposeKnowledgeMerges).toHaveBeenCalledWith({ runId: 'run-knowledge-ui' }))
    fireEvent.change(screen.getByLabelText(zh.conceptName), { target: { value: 'Payment refund' } })
    fireEvent.change(screen.getByLabelText(zh.conceptDefinition), { target: { value: 'Reverse an eligible captured payment' } })
    fireEvent.change(screen.getByLabelText(zh.conceptTarget), { target: { value: 'captured payment' } })
    fireEvent.change(screen.getByLabelText(zh.conceptEffect), { target: { value: 'full or partial reversal' } })
    fireEvent.change(screen.getByLabelText(zh.conceptEvidenceSummary), { target: { value: 'Product policy reviewed' } })
    fireEvent.change(screen.getByLabelText(zh.humanCorrectionReason), { target: { value: 'Corrected to match the policy' } })
    fireEvent.click(screen.getByRole('button', { name: zh.saveConceptCorrection }))
    await waitFor(() => expect(correctConcept).toHaveBeenCalledWith({
      runId: 'run-knowledge-ui', key: 'refund', name: 'Payment refund', definition: 'Reverse an eligible captured payment',
      target: 'captured payment', effect: 'full or partial reversal', evidenceSummary: 'Product policy reviewed',
      resolution: 'Corrected to match the policy', evidenceIds: [],
    }))

    fireEvent.change(screen.getByLabelText(`${zh.mergeStatement}: merge-ui-1`), { target: { value: 'Validate refund eligibility before reversal' } })
    fireEvent.change(screen.getByLabelText(`${zh.mergeContent}: merge-ui-1`), { target: { value: 'Check cancellation eligibility and payment capture state.' } })
    fireEvent.change(screen.getByLabelText(`${zh.knowledgeMergeResolution}: merge-ui-1`), { target: { value: 'The statements are complementary and can be combined.' } })
    fireEvent.click(screen.getByRole('button', { name: `${zh.acceptKnowledgeMerge}: merge-ui-1` }))
    await waitFor(() => expect(acceptKnowledgeMerge).toHaveBeenCalledWith({
      runId: 'run-knowledge-ui', proposalId: 'merge-ui-1', statement: 'Validate refund eligibility before reversal',
      content: 'Check cancellation eligibility and payment capture state.', resolution: 'The statements are complementary and can be combined.',
    }))

    fireEvent.change(screen.getByLabelText(`${zh.knowledgeMergeResolution}: merge-ui-2`), { target: { value: 'Keep these as distinct rules because they check separate conditions.' } })
    fireEvent.click(screen.getByRole('button', { name: `${zh.rejectKnowledgeMerge}: merge-ui-2` }))
    await waitFor(() => expect(rejectKnowledgeMerge).toHaveBeenCalledWith({
      runId: 'run-knowledge-ui', proposalId: 'merge-ui-2', resolution: 'Keep these as distinct rules because they check separate conditions.',
    }))
  })

  it('creates, activates, revises, and deprecates Playbooks through scoped Remotes', async () => {
    let current = {
      run: { id: 'run-playbook-ui', status: 'DRAFT', request: 'Implement refund workflow', updatedAt: new Date().toISOString(), acceptanceCriteria: [], scope: { projectKey: 'C:/repo' } },
      plan: undefined, nodes: [], evidence: [], verifications: [], verificationResults: [], signals: [], assumptions: [], uncertainties: [],
      memories: [],
      knowledge: [],
      concepts: [],
      conceptObservations: [],
      playbooks: [],
      playbookFits: [],
      knowledgeMergeProposals: [],
      actionIntents: [],
      gates: [],
    } as unknown as AutoDevSnapshot
    const runs: readonly AutoDevSnapshot['run'][] = [current.run]
    const createPlaybook = vi.fn(async (request: {
      key: string
      name: string
      purpose: string
      targets: readonly string[]
      effects: readonly string[]
      steps: readonly string[]
    }) => {
      current = { ...current, playbooks: [{ ...request, id: 'playbook-ui-1', scope: current.run.scope, status: 'DRAFT', confidence: 0.5, version: 1, conceptKeys: [], requiredEvidence: [], sourceRefs: [], createdFromRunIds: [current.run.id], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] } as AutoDevSnapshot
      return { ok: true as const, value: current }
    })
    const activatePlaybook = vi.fn(async () => {
      current = { ...current, playbooks: current.playbooks.map(item => ({ ...item, status: 'ACTIVE' })) } as AutoDevSnapshot
      return { ok: true as const, value: current }
    })
    const revisePlaybook = vi.fn(async (request: {
      playbookId: string
      name: string
      purpose: string
      targets: readonly string[]
      effects: readonly string[]
      conceptKeys: readonly string[]
      exclusions: readonly string[]
      steps: readonly string[]
      requiredEvidence: readonly string[]
      resolution: string
    }) => {
      const previous = current.playbooks.find(item => item.id === request.playbookId)!
      current = { ...current, playbooks: [
        ...current.playbooks.map(item => item.id === request.playbookId ? { ...item, status: 'DEPRECATED', supersededBy: 'playbook-ui-2' } : item),
        { ...previous, ...request, id: 'playbook-ui-2', version: previous.version + 1, parentId: previous.id, status: 'ACTIVE' },
      ] } as AutoDevSnapshot
      return { ok: true as const, value: current }
    })
    const deprecatePlaybook = vi.fn(async (request: { playbookId: string }) => {
      current = { ...current, playbooks: current.playbooks.map(item => item.id === request.playbookId ? { ...item, status: 'DEPRECATED' } : item) } as AutoDevSnapshot
      return { ok: true as const, value: current }
    })
    const remote = {
      list: vi.fn(async () => ({ ok: true as const, value: runs })),
      snapshot: vi.fn(async () => ({ ok: true as const, value: current })),
      candidateDiff: vi.fn(async () => ({ ok: true as const, value: undefined })),
      createPlaybook, activatePlaybook, revisePlaybook, deprecatePlaybook,
    }
    const props = {
      useTabInfo: () => ({ tab: { id: 'autodev-playbook-test-tab' } }),
      sessionId: 'session-playbook-panel', remote,
      t: (key: AutoDevKey) => zh[key],
    } as unknown as AutoDevPanelProps
    render(<AutoDevPanel {...props} />)
    chooseTab(zh.runDetailsTab)

    await screen.findByLabelText(`${zh.playbookKey}: ${zh.createPlaybookDraft}`)
    fireEvent.click(screen.getByText(zh.createPlaybookDraft, { selector: 'summary' }))
    fireEvent.change(screen.getByLabelText(`${zh.playbookKey}: ${zh.createPlaybookDraft}`), { target: { value: 'safe-refund' } })
    fireEvent.change(screen.getByLabelText(`${zh.playbookName}: ${zh.createPlaybookDraft}`), { target: { value: 'Safe refund' } })
    fireEvent.change(screen.getByLabelText(`${zh.playbookPurpose}: ${zh.createPlaybookDraft}`), { target: { value: 'Process eligible refunds' } })
    fireEvent.change(screen.getByLabelText(`${zh.playbookTargets}: ${zh.createPlaybookDraft}`), { target: { value: 'captured payment\nstore credit' } })
    fireEvent.change(screen.getByLabelText(`${zh.playbookEffects}: ${zh.createPlaybookDraft}`), { target: { value: 'reverse payment' } })
    fireEvent.change(screen.getByLabelText(`${zh.playbookSteps}: ${zh.createPlaybookDraft}`), { target: { value: 'check eligibility\nwrite audit' } })
    fireEvent.click(screen.getByRole('button', { name: zh.createPlaybookDraft }))
    await waitFor(() => expect(createPlaybook).toHaveBeenCalledWith({
      runId: 'run-playbook-ui', key: 'safe-refund', name: 'Safe refund', purpose: 'Process eligible refunds',
      targets: ['captured payment', 'store credit'], effects: ['reverse payment'], conceptKeys: [], exclusions: [], steps: ['check eligibility', 'write audit'], requiredEvidence: [],
    }))

    fireEvent.click(await screen.findByRole('button', { name: zh.activatePlaybook }))
    await waitFor(() => expect(activatePlaybook).toHaveBeenCalledWith({ runId: 'run-playbook-ui', playbookId: 'playbook-ui-1' }))
    fireEvent.click(screen.getByText(zh.revisePlaybook))
    fireEvent.change(screen.getByLabelText(`${zh.playbookCorrectionReason}: safe-refund`), { target: { value: 'Add explicit audit retention' } })
    fireEvent.click(screen.getByRole('button', { name: zh.savePlaybookRevision }))
    await waitFor(() => expect(revisePlaybook).toHaveBeenCalledWith({
      runId: 'run-playbook-ui', playbookId: 'playbook-ui-1', name: 'Safe refund', purpose: 'Process eligible refunds',
      targets: ['captured payment', 'store credit'], effects: ['reverse payment'], conceptKeys: [], exclusions: [],
      steps: ['check eligibility', 'write audit'], requiredEvidence: [], resolution: 'Add explicit audit retention',
    }))
    fireEvent.click(await screen.findByRole('button', { name: zh.deprecatePlaybook }))
    await waitFor(() => expect(deprecatePlaybook).toHaveBeenCalledWith({ runId: 'run-playbook-ui', playbookId: 'playbook-ui-2' }))
  })

  it('requires current Evidence and regression PASS before Knowledge promotion and confirms compaction restore', async () => {
    const now = new Date().toISOString()
    const scope = { projectKey: 'C:/repo', branch: 'main' }
    const run = { id: 'run-knowledge-lifecycle', status: 'DRAFT', request: 'Review project knowledge', updatedAt: now, acceptanceCriteria: [], scope }
    const knowledge = [
      { id: 'knowledge-lifecycle-1', scope, kind: 'rule', statement: 'Refund checks eligibility', content: 'Check the cancellation window.', status: 'CANDIDATE', confidence: 0.7, version: 1, sourceRefs: [], evidenceIds: [], relatedMemoryIds: [], createdAt: now, updatedAt: now },
      { id: 'knowledge-lifecycle-2', scope, kind: 'rule', statement: 'Refund checks eligibility', content: 'Confirm the cancellation window.', status: 'CANDIDATE', confidence: 0.6, version: 1, sourceRefs: [], evidenceIds: [], relatedMemoryIds: [], createdAt: now, updatedAt: now },
    ]
    const evidence = [{ id: 'evidence-knowledge-1', runId: run.id, type: 'TEST', status: 'PASS', source: 'command', summary: 'Knowledge retrieval tests passed', createdAt: now }]
    let current = {
      run, plan: undefined, nodes: [], candidate: undefined, evidence, decisions: [], gates: [], signals: [],
      verificationChecks: [],
      verificationResults: [],
      verifications: [],
      memories: [],
      assumptions: [],
      uncertainties: [],
      concepts: [],
      conceptObservations: [],
      playbooks: [],
      playbookFits: [],
      knowledge,
      knowledgeMergeProposals: [],
      compactions: [],
      regressionCases: [],
      regressionResults: [],
      regressionSuites: [],
      actionIntents: [],
      sideEffects: [],
    } as unknown as AutoDevSnapshot
    const runs: readonly AutoDevSnapshot['run'][] = [current.run]
    const createKnowledgeRegression = vi.fn(async (request: {
      operationId: string
      name: string
      query: string
      expectedStatements: readonly string[]
      forbiddenStatements?: readonly string[]
    }) => {
      current = { ...current, regressionCases: [{
        id: 'regression-knowledge-1', scope, name: request.name, input: request.query,
        expectedStatements: request.expectedStatements,
        ...(request.forbiddenStatements === undefined ? {} : { forbiddenStatements: request.forbiddenStatements }),
        createdAt: new Date().toISOString(),
      }] } as AutoDevSnapshot
      return { ok: true as const, value: current }
    })
    const runKnowledgeRegressionSuite = vi.fn(async () => {
      const testedKnowledgeVersions = current.knowledge.map(item => ({ id: item.id, version: item.version }))
      const createdAt = new Date().toISOString()
      const results = current.regressionCases.map(testCase => ({
        id: `result-${testCase.id}`, caseId: testCase.id, status: 'PASS' as const, matched: testCase.expectedStatements, missing: [], unexpected: [], testedKnowledgeVersions, createdAt,
      }))
      current = { ...current, regressionResults: results, regressionSuites: [{
        id: 'suite-knowledge-1', scope, status: 'PASS', caseIds: current.regressionCases.map(testCase => testCase.id),
        resultIds: results.map(result => result.id), testedKnowledgeVersions, createdAt,
      }] } as AutoDevSnapshot
      return { ok: true as const, value: current }
    })
    const promoteKnowledge = vi.fn(async (request: { knowledgeId: string; evidenceIds: readonly string[] }) => {
      current = { ...current, knowledge: current.knowledge.map(item => item.id === request.knowledgeId
        ? { ...item, status: 'ESTABLISHED', version: item.version + 1, evidenceIds: request.evidenceIds }
        : item) } as AutoDevSnapshot
      return { ok: true as const, value: current }
    })
    const compactKnowledge = vi.fn(async () => {
      const before = current.knowledge
      const first = before[0]!
      const second = before[1]!
      const snapshots = [first, second]
      const resultingVersions = snapshots.map(item => ({ id: item.id, version: item.version + 1 }))
      const report = {
        id: 'compaction-knowledge-1', scope, inputIds: [first.id, second.id], outputIds: [first.id],
        actions: [{ kind: 'merged' as const, inputIds: [first.id, second.id], outputId: first.id, reason: 'Same normalized statement and scope.' }],
        snapshots, resultingVersions, createdAt: new Date().toISOString(),
      }
      current = { ...current, knowledge: before.map((item, index) => ({ ...item, status: index === 0 ? item.status : 'DEPRECATED', version: item.version + 1 })), compactions: [report] } as AutoDevSnapshot
      return { ok: true as const, value: current }
    })
    const restoreKnowledgeCompaction = vi.fn(async () => {
      const report = current.compactions[0]!
      current = {
        ...current,
        knowledge: current.knowledge.map((item) => {
          const previous = report.snapshots.find(snapshot => snapshot.id === item.id)
          return previous === undefined ? item : { ...previous, version: item.version + 1 }
        }),
        compactions: [{ ...report, restoredAt: new Date().toISOString() }],
      } as AutoDevSnapshot
      return { ok: true as const, value: current }
    })
    const remote = {
      list: vi.fn(async () => ({ ok: true as const, value: runs })),
      snapshot: vi.fn(async () => ({ ok: true as const, value: current })),
      candidateDiff: vi.fn(async () => ({ ok: true as const, value: undefined })),
      createKnowledgeRegression, runKnowledgeRegressionSuite, promoteKnowledge, compactKnowledge, restoreKnowledgeCompaction,
    }
    const props = {
      useTabInfo: () => ({ tab: { id: 'autodev-knowledge-lifecycle-tab' } }),
      sessionId: 'session-knowledge-lifecycle', remote,
      t: (key: AutoDevKey) => zh[key],
    } as unknown as AutoDevPanelProps
    render(<AutoDevPanel {...props} />)
    chooseTab(zh.runDetailsTab)

    const promoteButtons = await screen.findAllByRole('button', { name: zh.promoteKnowledgeCandidate }) as HTMLButtonElement[]
    const promoteButton = promoteButtons[0]!
    expect(promoteButton.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(zh.regressionCaseName), { target: { value: 'refund policy retrieval' } })
    fireEvent.change(screen.getByLabelText(zh.regressionQuery), { target: { value: 'How is refund eligibility checked?' } })
    fireEvent.change(screen.getByLabelText(zh.regressionExpected), { target: { value: 'Refund checks eligibility' } })
    fireEvent.change(screen.getByLabelText(zh.regressionForbidden), { target: { value: 'Refunds are always automatic' } })
    fireEvent.click(screen.getByRole('button', { name: zh.createRegressionCase }))
    await waitFor(() => expect(createKnowledgeRegression).toHaveBeenCalledWith(expect.objectContaining({
      runId: run.id, operationId: expect.any(String), name: 'refund policy retrieval', query: 'How is refund eligibility checked?',
      expectedStatements: ['Refund checks eligibility'], forbiddenStatements: ['Refunds are always automatic'],
    })))
    fireEvent.click(await screen.findByRole('button', { name: zh.runKnowledgeRegression }))
    await waitFor(() => expect(runKnowledgeRegressionSuite).toHaveBeenCalledWith(run.id, expect.any(String)))

    fireEvent.click(screen.getAllByLabelText(/evidence-knowledge-1/)[0]!)
    fireEvent.change(screen.getAllByLabelText(zh.promotionRegressionCase)[0]!, { target: { value: 'regression-knowledge-1' } })
    expect(promoteButton.disabled).toBe(true)
    fireEvent.click(screen.getAllByLabelText(zh.confirmKnowledgePromotion)[0]!)
    expect(promoteButton.disabled).toBe(false)
    fireEvent.click(promoteButton)
    await waitFor(() => expect(promoteKnowledge).toHaveBeenCalledWith({
      runId: run.id, knowledgeId: 'knowledge-lifecycle-1', evidenceIds: ['evidence-knowledge-1'], regressionCaseId: 'regression-knowledge-1',
    }))

    fireEvent.click(screen.getByRole('button', { name: zh.compactKnowledge }))
    expect(compactKnowledge).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: zh.confirmCompactKnowledge }))
    await waitFor(() => expect(compactKnowledge).toHaveBeenCalledWith(run.id, expect.any(String)))
    const restoreButton = await screen.findByRole('button', { name: zh.restoreCompaction }) as HTMLButtonElement
    expect(restoreButton.disabled).toBe(false)
    fireEvent.click(restoreButton)
    expect(restoreKnowledgeCompaction).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: zh.confirmRestoreCompaction }))
    await waitFor(() => expect(restoreKnowledgeCompaction).toHaveBeenCalledWith({ runId: run.id, reportId: 'compaction-knowledge-1' }))
    expect(await screen.findByText(new RegExp(`${zh.compactionRestored}`))).toBeTruthy()
  })
})
