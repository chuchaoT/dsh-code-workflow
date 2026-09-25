import { useEffect, useState, type ReactNode } from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  AutoDevSnapshot,
  KnowledgeCandidate,
  KnowledgeCompactionReport,
  KnowledgeRegressionCase,
  KnowledgeRegressionResult,
  KnowledgeRegressionSuite,
  ScopeRef,
} from '../contracts.ts'

export interface AutoDevKnowledgeLifecycleProps {
  readonly snapshot: AutoDevSnapshot
  readonly remote: ClientRemote['autodev']
  readonly t: TranslateNS<'autodev'>
  readonly busy: boolean
  readonly onSnapshotAction: (action: () => Promise<RemoteResult<AutoDevSnapshot>>) => Promise<void>
}

interface PromotionDraft {
  readonly evidenceIds: readonly string[]
  readonly regressionCaseId: string
  readonly confirmed: boolean
}

interface RegressionDraft {
  readonly name: string
  readonly query: string
  readonly expected: string
  readonly forbidden: string
}

const SCOPE_FIELDS = ['projectKey', 'module', 'branch', 'language', 'projectVersion', 'schemaVersion', 'techStackVersion'] as const

function runScope(snapshot: AutoDevSnapshot): ScopeRef {
  return snapshot.run.scope ?? { projectKey: snapshot.run.projectKey ?? snapshot.run.repoRoot }
}

function scopeKey(scope: ScopeRef): string {
  return SCOPE_FIELDS.map(field => `${field}=${scope[field] ?? ''}`).join('\u0000')
}

function newKnowledgeOperationId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  if (cryptoApi?.getRandomValues !== undefined) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return `knowledge-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function versionsMatch(
  tested: readonly { readonly id: string; readonly version: number }[] | undefined,
  current: readonly KnowledgeCandidate[],
): boolean {
  if (tested === undefined) return false
  const keys = (items: readonly { readonly id: string; readonly version: number }[]) => items
    .map(item => `${item.id}:${item.version}`)
    .sort()
  return JSON.stringify(keys(tested)) === JSON.stringify(keys(current))
}

function latestResult(results: readonly KnowledgeRegressionResult[], caseId: string): KnowledgeRegressionResult | undefined {
  return results.filter(result => result.caseId === caseId).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
}

function latestSuite(suites: readonly KnowledgeRegressionSuite[], scope: ScopeRef): KnowledgeRegressionSuite | undefined {
  return suites
    .filter(suite => scopeKey(suite.scope) === scopeKey(scope))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
}

function suiteIsCurrent(
  suite: KnowledgeRegressionSuite | undefined,
  scope: ScopeRef,
  cases: readonly KnowledgeRegressionCase[],
  knowledge: readonly KnowledgeCandidate[],
): boolean {
  return suite !== undefined
    && suite.status === 'PASS'
    && scopeKey(suite.scope) === scopeKey(scope)
    && sameIds(suite.caseIds, cases.map(testCase => testCase.id))
    && versionsMatch(suite.testedKnowledgeVersions, knowledge)
}

function caseIsCurrentPass(
  testCase: KnowledgeRegressionCase,
  results: readonly KnowledgeRegressionResult[],
  knowledge: readonly KnowledgeCandidate[],
): boolean {
  const result = latestResult(results, testCase.id)
  return result?.status === 'PASS' && versionsMatch(result.testedKnowledgeVersions, knowledge)
}

function exactScopeRecords(snapshot: AutoDevSnapshot): KnowledgeCandidate[] {
  const scope = runScope(snapshot)
  return (snapshot.knowledge ?? []).filter(item => item.scope !== undefined && scopeKey(item.scope) === scopeKey(scope))
}

function canRestoreCompaction(report: KnowledgeCompactionReport, knowledge: readonly KnowledgeCandidate[], scope: ScopeRef): boolean {
  if (report.restoredAt !== undefined || report.snapshots.length === 0 || scopeKey(report.scope) !== scopeKey(scope)) return false
  const current = new Map(knowledge.map(item => [item.id, item.version]))
  return report.resultingVersions.every(item => current.get(item.id) === item.version)
}

function duplicateGroupCount(items: readonly KnowledgeCandidate[]): number {
  const counts = new Map<string, number>()
  for (const item of items) {
    if (item.status === 'DEPRECATED') continue
    const key = `${item.kind}:${item.statement.trim().toLowerCase().replace(/\s+/g, ' ')}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.values()].filter(count => count > 1).length
}

function splitLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean))]
}

function isEligibleEvidence(snapshot: AutoDevSnapshot, now: number): AutoDevSnapshot['evidence'][number][] {
  return (snapshot.evidence ?? []).filter(evidence => evidence.status === 'PASS'
    && evidence.source !== 'agent'
    && (evidence.expiresAt === undefined || Date.parse(evidence.expiresAt) > now))
}

export function AutoDevKnowledgeLifecycle({ snapshot, remote, t, busy, onSnapshotAction }: AutoDevKnowledgeLifecycleProps): ReactNode {
  const [promotionDrafts, setPromotionDrafts] = useState<Readonly<Record<string, PromotionDraft>>>({})
  const [regressionDraft, setRegressionDraft] = useState<RegressionDraft>({ name: '', query: '', expected: '', forbidden: '' })
  const [compactArmed, setCompactArmed] = useState(false)
  const [restoreArmedId, setRestoreArmedId] = useState<string>()
  const scope = runScope(snapshot)
  const knowledge = snapshot.knowledge ?? []
  const cases = snapshot.regressionCases ?? []
  const results = snapshot.regressionResults ?? []
  const suites = snapshot.regressionSuites ?? []
  const reports = snapshot.compactions ?? []
  const eligibleEvidence = isEligibleEvidence(snapshot, Date.now())
  const currentSuite = latestSuite(suites, scope)
  const currentSuitePass = suiteIsCurrent(currentSuite, scope, cases, knowledge)
  const promotableKnowledge = knowledge.filter(item => item.scope !== undefined && (item.status === 'CANDIDATE' || item.status === 'OBSERVED'))
  const exactRecords = exactScopeRecords(snapshot)

  useEffect(() => {
    setPromotionDrafts({})
    setRegressionDraft({ name: '', query: '', expected: '', forbidden: '' })
    setCompactArmed(false)
    setRestoreArmedId(undefined)
  }, [snapshot.run.id])

  const draftFor = (id: string): PromotionDraft => promotionDrafts[id] ?? { evidenceIds: [], regressionCaseId: '', confirmed: false }
  const updatePromotion = (id: string, next: Partial<PromotionDraft>): void => {
    setPromotionDrafts(current => ({
      ...current,
      [id]: { ...(current[id] ?? { evidenceIds: [], regressionCaseId: '', confirmed: false }), ...next },
    }))
  }

  const createRegression = (): void => {
    const expectedStatements = splitLines(regressionDraft.expected)
    const forbiddenStatements = splitLines(regressionDraft.forbidden)
    if (regressionDraft.name.trim() === '' || regressionDraft.query.trim() === '' || expectedStatements.length + forbiddenStatements.length === 0) return
    const operationId = newKnowledgeOperationId()
    void onSnapshotAction(() => remote.createKnowledgeRegression({
      runId: snapshot.run.id,
      operationId,
      name: regressionDraft.name.trim(),
      query: regressionDraft.query.trim(),
      expectedStatements,
      ...(forbiddenStatements.length === 0 ? {} : { forbiddenStatements }),
    })).then(() => setRegressionDraft({ name: '', query: '', expected: '', forbidden: '' }))
  }

  const promote = (candidate: KnowledgeCandidate): void => {
    const draft = draftFor(candidate.id)
    if (!draft.confirmed || draft.regressionCaseId === '') return
    void onSnapshotAction(() => remote.promoteKnowledge({
      runId: snapshot.run.id,
      knowledgeId: candidate.id,
      evidenceIds: draft.evidenceIds,
      regressionCaseId: draft.regressionCaseId,
    })).then(() => updatePromotion(candidate.id, { confirmed: false }))
  }

  const startCompaction = (): void => {
    if (!compactArmed) {
      setCompactArmed(true)
      return
    }
    const operationId = newKnowledgeOperationId()
    void onSnapshotAction(() => remote.compactKnowledge(snapshot.run.id, operationId)).then(() => setCompactArmed(false))
  }

  const runRegressionSuite = (): void => {
    const operationId = newKnowledgeOperationId()
    void onSnapshotAction(() => remote.runKnowledgeRegressionSuite(snapshot.run.id, operationId))
  }

  const restoreCompaction = (report: KnowledgeCompactionReport): void => {
    if (!canRestoreCompaction(report, knowledge, scope)) {
      setRestoreArmedId(undefined)
      return
    }
    if (restoreArmedId !== report.id) {
      setRestoreArmedId(report.id)
      return
    }
    void onSnapshotAction(() => remote.restoreKnowledgeCompaction({ runId: snapshot.run.id, reportId: report.id }))
      .then(() => setRestoreArmedId(undefined))
  }

  const regressionReady = regressionDraft.name.trim() !== ''
    && regressionDraft.query.trim() !== ''
    && (splitLines(regressionDraft.expected).length + splitLines(regressionDraft.forbidden).length > 0)

  return <section aria-labelledby="autodev-knowledge-lifecycle-title" style={{ display: 'grid', gap: 8 }}>
    <h4 id="autodev-knowledge-lifecycle-title" style={{ margin: '4px 0 0', fontSize: 13 }}>{t('knowledgeLifecycle')}</h4>
    <p style={{ margin: '2px 0', color: '#6b7280' }}>{t('knowledgeLifecycleNotice')}</p>

    <section aria-labelledby="autodev-knowledge-regression-title" style={{ display: 'grid', gap: 6 }}>
      <h5 id="autodev-knowledge-regression-title" style={{ margin: '4px 0 0' }}>{t('knowledgeRegression')}</h5>
      <label style={{ display: 'grid', gap: 4 }}>{t('regressionCaseName')}
        <input
          value={regressionDraft.name}
          onChange={(event) => {
            setRegressionDraft(current => ({ ...current, name: event.target.value }))
          }}
          disabled={busy}
        />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>{t('regressionQuery')}
        <textarea
          value={regressionDraft.query}
          onChange={(event) => {
            setRegressionDraft(current => ({ ...current, query: event.target.value }))
          }}
          rows={2}
          disabled={busy}
        />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>{t('regressionExpected')}
        <textarea
          value={regressionDraft.expected}
          onChange={(event) => {
            setRegressionDraft(current => ({ ...current, expected: event.target.value }))
          }}
          rows={2}
          disabled={busy}
        />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>{t('regressionForbidden')}
        <textarea
          value={regressionDraft.forbidden}
          onChange={(event) => {
            setRegressionDraft(current => ({ ...current, forbidden: event.target.value }))
          }}
          rows={2}
          disabled={busy}
        />
      </label>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" disabled={busy || !regressionReady} onClick={createRegression}>{t('createRegressionCase')}</button>
        <button type="button" disabled={busy || cases.length === 0} onClick={runRegressionSuite}>{t('runKnowledgeRegression')}</button>
      </div>
      {cases.length === 0
        ? <p style={{ margin: '2px 0' }}>{t('noRegressionCases')}</p>
        : <ul style={{ margin: '2px 0', paddingLeft: 18 }}>{cases.map((testCase) => {
          const result = latestResult(results, testCase.id)
          const freshPass = caseIsCurrentPass(testCase, results, knowledge)
          return <li key={testCase.id}>{testCase.name}: {result?.status ?? 'UNKNOWN'}{result !== undefined && !freshPass ? ` · ${t('regressionStale')}` : ''} — {testCase.input}</li>
        })}</ul>}
      {currentSuite !== undefined && <p style={{ margin: '2px 0' }}>
        {t('latestRegressionSuite')}: {currentSuite.status}{currentSuitePass ? '' : ` · ${t('regressionStale')}`}
      </p>}
    </section>

    <section aria-labelledby="autodev-knowledge-promotion-title" style={{ display: 'grid', gap: 6 }}>
      <h5 id="autodev-knowledge-promotion-title" style={{ margin: '4px 0 0' }}>{t('knowledgePromotion')}</h5>
      {promotableKnowledge.length === 0
        ? <p style={{ margin: '2px 0' }}>{t('noPromotableKnowledge')}</p>
        : promotableKnowledge.map((candidate) => {
          const draft = draftFor(candidate.id)
          const scopeMatches = scopeKey(candidate.scope) === scopeKey(scope)
          const candidateCases = cases.filter(testCase => scopeKey(testCase.scope) === scopeKey(candidate.scope))
          const eligibleCases = candidateCases.filter(testCase => caseIsCurrentPass(testCase, results, knowledge) && currentSuitePass)
          const selectedCase = eligibleCases.find(testCase => testCase.id === draft.regressionCaseId)
          const hasEvidence = draft.evidenceIds.length > 0 || candidate.evidenceIds.length > 0
          const expired = candidate.expiresAt !== undefined && Date.parse(candidate.expiresAt) <= Date.now()
          const canPromote = scopeMatches && !expired && hasEvidence && selectedCase !== undefined && currentSuitePass
          return <article key={candidate.id} style={{ padding: 8, border: '1px solid #e5e7eb', borderRadius: 6 }}>
            <p style={{ margin: '2px 0' }}><strong>{candidate.statement}</strong></p>
            <p style={{ margin: '2px 0', color: '#6b7280' }}>{candidate.id} · {candidate.status} · v{candidate.version} · {t('knowledgeEvidenceAttached')}: {candidate.evidenceIds.join(', ') || '—'}</p>
            {!scopeMatches && <p style={{ margin: '2px 0', color: '#92400e' }}>{t('promotionScopeMismatch')}</p>}
            {expired && <p style={{ margin: '2px 0', color: '#92400e' }}>{t('knowledgeExpired')}</p>}
            <fieldset style={{ margin: '6px 0', padding: 6 }} disabled={busy || !scopeMatches || expired}>
              <legend>{t('promotionEvidence')}</legend>
              {eligibleEvidence.length === 0
                ? <p style={{ margin: '2px 0' }}>{t('noKnowledgeEvidence')}</p>
                : eligibleEvidence.map(evidence => <label key={evidence.id} style={{ display: 'flex', gap: 6, alignItems: 'baseline', margin: '4px 0' }}>
                  <input
                    type="checkbox"
                    checked={draft.evidenceIds.includes(evidence.id)}
                    onChange={event => updatePromotion(candidate.id, {
                      evidenceIds: event.currentTarget.checked
                        ? [...new Set([...draft.evidenceIds, evidence.id])]
                        : draft.evidenceIds.filter(id => id !== evidence.id),
                      confirmed: false,
                    })}
                  />
                  <span>{evidence.id} · {evidence.type} — {evidence.summary}</span>
                </label>)}
            </fieldset>
            <label style={{ display: 'grid', gap: 4 }}>{t('promotionRegressionCase')}
              <select
                value={draft.regressionCaseId}
                onChange={event => updatePromotion(candidate.id, {
                  regressionCaseId: event.target.value,
                  confirmed: false,
                })}
                disabled={busy || !scopeMatches || !currentSuitePass}
              >
                <option value="">{t('selectRegressionCase')}</option>
                {candidateCases.map((testCase) => {
                  const ready = caseIsCurrentPass(testCase, results, knowledge) && currentSuitePass
                  const latest = latestResult(results, testCase.id)
                  return <option key={testCase.id} value={testCase.id} disabled={!ready}>
                    {testCase.name} · {latest?.status ?? 'UNKNOWN'}{ready ? '' : ` · ${t('regressionStale')}`}
                  </option>
                })}
              </select>
            </label>
            {!currentSuitePass && <p style={{ margin: '2px 0', color: '#92400e' }}>{t('promotionNeedsFreshSuite')}</p>}
            <label style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginTop: 6 }}>
              <input type="checkbox" checked={draft.confirmed} onChange={event => updatePromotion(candidate.id, { confirmed: event.currentTarget.checked })} disabled={busy || !canPromote} />
              <span>{t('confirmKnowledgePromotion')}</span>
            </label>
            <button type="button" disabled={busy || !canPromote || !draft.confirmed} onClick={() => { promote(candidate) }}>{t('promoteKnowledgeCandidate')}</button>
          </article>
        })}
    </section>

    <section aria-labelledby="autodev-knowledge-compaction-title" style={{ display: 'grid', gap: 6 }}>
      <h5 id="autodev-knowledge-compaction-title" style={{ margin: '4px 0 0' }}>{t('knowledgeCompaction')}</h5>
      <p style={{ margin: '2px 0' }}>{t('compactionPreview')}: {duplicateGroupCount(exactRecords)} · {t('knowledgeDuplicateGroups')}</p>
      <p style={{ margin: '2px 0', color: '#6b7280' }}>{t('compactionNotice')}</p>
      {compactArmed && <p role="status" style={{ margin: '2px 0', color: '#92400e' }}>{t('confirmCompactionNotice')}</p>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" disabled={busy} onClick={startCompaction}>{compactArmed ? t('confirmCompactKnowledge') : t('compactKnowledge')}</button>
        {compactArmed && <button type="button" disabled={busy} onClick={() => { setCompactArmed(false) }}>{t('cancelKnowledgeAction')}</button>}
      </div>
      {reports.length === 0
        ? <p style={{ margin: '2px 0' }}>{t('noCompactionReports')}</p>
        : reports.map((report) => {
          const restorable = canRestoreCompaction(report, knowledge, scope)
          const armed = restoreArmedId === report.id
          const status = report.restoredAt !== undefined
            ? t('compactionRestored')
            : report.snapshots.length === 0
              ? t('compactionNoChanges')
              : restorable ? t('compactionRestorable') : t('compactionStale')
          return <article key={report.id} style={{ padding: 8, border: '1px solid #e5e7eb', borderRadius: 6 }}>
            <p style={{ margin: '2px 0' }}><strong>{report.id}</strong> · {status}</p>
            <p style={{ margin: '2px 0' }}>{t('compactionCounts')}: {report.inputIds.length} → {report.outputIds.length} · {report.actions.length} {t('compactionActions')}</p>
            <details>
              <summary>{t('compactionReportDetails')}</summary>
              <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{report.actions.map((action, index) => <li key={`${report.id}:${index}`}>
                {action.kind}: {action.inputIds.join(', ')}{action.outputId === undefined ? '' : ` → ${action.outputId}`} — {action.reason}
              </li>)}</ul>
            </details>
            {armed && <p role="status" style={{ margin: '2px 0', color: '#92400e' }}>{t('confirmRestoreNotice')}</p>}
            <button type="button" disabled={busy || !restorable} onClick={() => { restoreCompaction(report) }}>
              {armed ? t('confirmRestoreCompaction') : t('restoreCompaction')}
            </button>
            {armed && <button type="button" disabled={busy} onClick={() => { setRestoreArmedId(undefined) }}>{t('cancelKnowledgeAction')}</button>}
          </article>
        })}
    </section>
  </section>
}
