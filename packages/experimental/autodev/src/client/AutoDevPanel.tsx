import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ArtifactContent, AutoDevAuditActor, AutoDevAuditEvent, AutoDevCleanupJobView, AutoDevMode, AutoDevRetentionPreview, AutoDevSnapshot, BuildDriverId, CandidateRevisionSummary, HumanGate, Run } from '../contracts.ts'
import { AutoDevBackupRecovery } from './AutoDevBackupRecovery.tsx'
import { AutoDevKnowledgeReview } from './AutoDevKnowledgeReview.tsx'
import { AutoDevKnowledgeLifecycle } from './AutoDevKnowledgeLifecycle.tsx'
import { AutoDevPlaybookReview } from './AutoDevPlaybookReview.tsx'
import { AutoDevSemanticReview } from './AutoDevSemanticReview.tsx'
import type { AutoDevKey } from './locales.ts'
import styles from './AutoDevPanel.module.css'
import { AUTODEV_MODES } from '../mode.ts'

type GateAction = HumanGate['options'][number]

export interface AutoDevPanelInjected {
  readonly remote: ClientRemote['autodev']
}

export type AutoDevPanelProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'autodev'>
  & InjectFace<AutoDevPanelInjected>

function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw new Error(result.error.message)
}

function terminal(status: Run['status']): boolean {
  return status === 'PROMOTED' || status === 'CANCELLED' || status === 'ABANDONED'
}

function formatTime(value: string): string {
  return value.replace('T', ' ').replace(/\.\d{3}Z$/u, 'Z')
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function candidateOptionLabel(candidate: CandidateRevisionSummary): string {
  return `${candidate.attempt === undefined ? '—' : `#${candidate.attempt}`} · ${candidate.id.slice(0, 8)}`
}

function auditActorLabel(actor: AutoDevAuditActor | undefined, t: AutoDevPanelProps['t']): string {
  if (actor?.kind === 'dsh-operator') return t('auditOperator')
  if (actor?.kind === 'autodev-runtime') return t('auditRuntime')
  if (actor?.kind === 'host-internal') return t('auditInternal')
  return t('auditUnknown')
}

function auditActionLabel(action: AutoDevAuditEvent['action'], t: AutoDevPanelProps['t']): string {
  const labels: Record<AutoDevAuditEvent['action'], string> = {
    'plan-approved': t('auditPlanApproved'),
    'gate-resolved': t('auditGateResolved'),
    'action-authorized': t('auditActionAuthorized'),
    'action-result': t('auditActionResult'),
    'cleanup-prepared': t('auditCleanupPrepared'),
    'cleanup-confirmed': t('auditCleanupConfirmed'),
    'cleanup-cancelled': t('auditCleanupCancelled'),
  }
  return labels[action]
}

function cleanupEventLabel(type: NonNullable<AutoDevCleanupJobView['events']>[number]['type'], t: AutoDevPanelProps['t']): string {
  const labels: Record<typeof type, string> = {
    prepared: t('cleanupEventPrepared'),
    confirmed: t('cleanupEventConfirmed'),
    'item-started': t('cleanupEventItemStarted'),
    'item-removed': t('cleanupEventItemRemoved'),
    'item-failed': t('cleanupEventItemFailed'),
    cancelled: t('cleanupEventCancelled'),
  }
  return labels[type]
}

function cleanupRequestId(): string {
  const randomId = globalThis.crypto?.randomUUID?.()
  return randomId ?? `cleanup-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function AutoDevPanel({ sessionId, useTabInfo, remote, t }: AutoDevPanelProps): ReactNode {
  const { tab } = useTabInfo()
  const [runs, setRuns] = useState<readonly Run[]>([])
  const [selected, setSelected] = useState<AutoDevSnapshot | undefined>()
  const [diff, setDiff] = useState<ArtifactContent | undefined>()
  const [compareLeftId, setCompareLeftId] = useState<string | undefined>()
  const [compareRightId, setCompareRightId] = useState<string | undefined>()
  const [comparisonDiffs, setComparisonDiffs] = useState<{
    readonly leftId: string
    readonly left: ArtifactContent | undefined
    readonly rightId: string
    readonly right: ArtifactContent | undefined
  } | undefined>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [repoPath, setRepoPath] = useState('')
  const [request, setRequest] = useState('')
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('')
  const [mode, setMode] = useState<AutoDevMode | 'AUTO'>('AUTO')
  const [buildDriver, setBuildDriver] = useState<BuildDriverId | 'auto'>('auto')
  const [inFlightRunId, setInFlightRunId] = useState<string | undefined>()
  const [promotionRequested, setPromotionRequested] = useState(false)
  const [retentionPreview, setRetentionPreview] = useState<AutoDevRetentionPreview | undefined>()
  const [retentionMinAgeDays, setRetentionMinAgeDays] = useState(30)
  const [retentionBusy, setRetentionBusy] = useState(false)
  const [retentionSelectedIds, setRetentionSelectedIds] = useState<readonly string[]>([])
  const [retentionCleanupJobs, setRetentionCleanupJobs] = useState<readonly AutoDevCleanupJobView[]>([])
  const [activeCleanupJobId, setActiveCleanupJobId] = useState<string | undefined>()
  const [cleanupConfirmationText, setCleanupConfirmationText] = useState('')
  const candidateHistory = selected?.candidateHistory ?? []
  const auditEvents = selected?.auditEvents ?? []
  const candidateHistoryKey = candidateHistory.map(candidate => candidate.id).join('\u0000')

  useEffect(() => {
    if (selected === undefined || candidateHistory.length < 2) return
    const ids = new Set(candidateHistory.map(candidate => candidate.id))
    const defaultRight = selected.run.candidateId !== undefined && ids.has(selected.run.candidateId)
      ? selected.run.candidateId
      : candidateHistory.at(-1)?.id
    const defaultLeft = [...candidateHistory].reverse().find(candidate => candidate.id !== defaultRight)?.id
    if (defaultLeft !== undefined && (compareLeftId === undefined || !ids.has(compareLeftId))) setCompareLeftId(defaultLeft)
    if (defaultRight !== undefined && (compareRightId === undefined || !ids.has(compareRightId))) setCompareRightId(defaultRight)
  }, [selected?.run.id, selected?.run.candidateId, candidateHistoryKey, compareLeftId, compareRightId])

  useEffect(() => {
    let active = true
    if (selected === undefined || candidateHistory.length < 2 || compareLeftId === undefined || compareRightId === undefined
      || !candidateHistory.some(candidate => candidate.id === compareLeftId)
      || !candidateHistory.some(candidate => candidate.id === compareRightId)) {
      setComparisonDiffs(undefined)
      return () => { active = false }
    }
    setComparisonDiffs(undefined)
    void Promise.all([
      remote.candidateRevisionDiff(selected.run.id, compareLeftId),
      remote.candidateRevisionDiff(selected.run.id, compareRightId),
    ]).then(([leftResult, rightResult]) => {
      if (!active) return
      setComparisonDiffs({
        leftId: compareLeftId,
        left: unwrap(leftResult),
        rightId: compareRightId,
        right: unwrap(rightResult),
      })
    }).catch((cause: unknown) => {
      if (active) setError(errorText(cause))
    })
    return () => { active = false }
  }, [remote, selected?.run.id, candidateHistoryKey, compareLeftId, compareRightId])

  const refresh = useCallback(async (runId?: string): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      const nextRuns = unwrap(await remote.list())
      setRuns(nextRuns)
      const nextId = runId ?? selected?.run.id ?? nextRuns[0]?.id
      if (nextId !== undefined) {
        const nextSnapshot = unwrap(await remote.snapshot(nextId))
        setSelected(nextSnapshot)
        if (inFlightRunId === nextId && !['READY', 'EXECUTING', 'BUILDING', 'TESTING', 'PROMOTING'].includes(nextSnapshot.run.status)) {
          setInFlightRunId(undefined)
        }
        setDiff(unwrap(await remote.candidateDiff(nextId)))
      } else {
        setSelected(undefined)
        setDiff(undefined)
      }
    } catch (cause: unknown) {
      setError(errorText(cause))
    } finally {
      setLoading(false)
    }
  }, [remote, selected?.run.id, inFlightRunId])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (inFlightRunId === undefined) return
    const timer = setInterval(() => { void refresh(inFlightRunId) }, 2_000)
    return () => { clearInterval(timer) }
  }, [inFlightRunId, refresh])
  useEffect(() => { setPromotionRequested(false) }, [selected?.run.id, selected?.run.candidateId, selected?.run.currentGateId])

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const next = unwrap(await remote.create({
        repoPath: repoPath.trim(),
        request: request.trim(),
        mode,
        acceptanceCriteria: acceptanceCriteria.split(/\r?\n/u).map(item => item.trim()).filter(Boolean),
        ...(buildDriver === 'auto' ? {} : { buildDriver }),
      }))
      setSelected(next)
      setRequest('')
      setAcceptanceCriteria('')
      await refresh(next.run.id)
    } catch (cause: unknown) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const approvePlan = async (): Promise<void> => {
    if (selected?.plan === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const next = unwrap(await remote.approvePlan({ runId: selected.run.id, planId: selected.plan.id }))
      setSelected(next)
      await refresh(next.run.id)
    } catch (cause: unknown) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const startRun = async (): Promise<void> => {
    if (selected === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const next = unwrap(await remote.start({ runId: selected.run.id, sessionId }))
      setInFlightRunId(next.run.id)
      setSelected(next)
      await refresh(next.run.id)
    } catch (cause: unknown) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const performSnapshotAction = async (action: () => Promise<RemoteResult<AutoDevSnapshot>>): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const next = unwrap(await action())
      setSelected(next)
      await refresh(next.run.id)
    } catch (cause: unknown) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const perform = async (action: GateAction): Promise<void> => {
    if (selected === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const latestGate = selected.gates.at(-1)
      const gateAllowsAction = latestGate?.status === 'OPEN' && latestGate.options.includes(action)
      let next: AutoDevSnapshot
      if (gateAllowsAction) {
        next = unwrap(await remote.resolveGate({
          runId: selected.run.id,
          action,
          ...(action === 'retry' || action === 'rework' ? { sessionId } : {}),
        }))
      } else if (action === 'promote' && selected.run.status === 'VERIFY') {
        next = unwrap(await remote.promote(selected.run.id))
      } else if (action === 'cancel' && (latestGate?.status !== 'OPEN' || !latestGate.options.includes('cancel'))) {
        next = unwrap(await remote.cancel(selected.run.id))
      } else {
        throw new Error(t('gateActionUnavailable'))
      }
      if (action === 'retry' || action === 'rework') setInFlightRunId(next.run.id)
      setPromotionRequested(false)
      setSelected(next)
      await refresh(next.run.id)
    } catch (cause: unknown) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const latestGate = selected?.gates.at(-1)
  const promotionAllowed = selected?.run.status === 'VERIFY'
    || (latestGate?.status === 'OPEN' && latestGate.options.includes('promote'))
  const activeCleanupJob = retentionCleanupJobs.find(job => job.id === activeCleanupJobId)
  const requestPromotion = (): void => { setPromotionRequested(true) }
  const confirmPromotion = (): void => { void perform('promote') }
  const previewRetention = async (): Promise<void> => {
    setRetentionBusy(true)
    setError(undefined)
    try {
      const preview = unwrap(await remote.retentionPreview({ minAgeDays: retentionMinAgeDays }))
      setRetentionPreview(preview)
      setRetentionSelectedIds([])
      setActiveCleanupJobId(undefined)
      setCleanupConfirmationText('')
      setRetentionCleanupJobs(unwrap(await remote.retentionCleanupJobs()))
    } catch (cause: unknown) {
      setError(errorText(cause))
    } finally {
      setRetentionBusy(false)
    }
  }

  const prepareRetentionCleanup = async (): Promise<void> => {
    if (retentionPreview === undefined || retentionSelectedIds.length === 0) return
    setRetentionBusy(true)
    setError(undefined)
    try {
      const job = unwrap(await remote.prepareRetentionCleanup({
        requestId: cleanupRequestId(),
        minAgeDays: retentionPreview.minAgeDays,
        snapshotFingerprint: retentionPreview.snapshotFingerprint,
        retentionIds: retentionSelectedIds,
      }))
      setActiveCleanupJobId(job.id)
      setCleanupConfirmationText('')
      setRetentionCleanupJobs(unwrap(await remote.retentionCleanupJobs()))
    } catch (cause: unknown) {
      setError(errorText(cause))
    } finally {
      setRetentionBusy(false)
    }
  }

  const executeRetentionCleanup = async (job: AutoDevCleanupJobView): Promise<void> => {
    setRetentionBusy(true)
    setError(undefined)
    try {
      const freshPreview = unwrap(await remote.retentionPreview({ minAgeDays: job.minAgeDays }))
      setRetentionPreview(freshPreview)
      const updated = unwrap(await remote.executeRetentionCleanup({
        jobId: job.id,
        snapshotFingerprint: freshPreview.snapshotFingerprint,
        confirmationPhrase: cleanupConfirmationText,
      }))
      setCleanupConfirmationText('')
      setRetentionCleanupJobs(unwrap(await remote.retentionCleanupJobs()))
      if (updated.status === 'COMPLETED' || updated.status === 'CANCELLED') setActiveCleanupJobId(undefined)
    } catch (cause: unknown) {
      setError(errorText(cause))
      try {
        setRetentionCleanupJobs(unwrap(await remote.retentionCleanupJobs()))
      } catch {
        // Preserve the last durable Job list when the recovery query also fails.
      }
    } finally {
      setRetentionBusy(false)
    }
  }

  const cancelRetentionCleanup = async (jobId: string): Promise<void> => {
    setRetentionBusy(true)
    setError(undefined)
    try {
      unwrap(await remote.cancelRetentionCleanup(jobId))
      setRetentionCleanupJobs(unwrap(await remote.retentionCleanupJobs()))
      if (activeCleanupJobId === jobId) setActiveCleanupJobId(undefined)
    } catch (cause: unknown) {
      setError(errorText(cause))
    } finally {
      setRetentionBusy(false)
    }
  }

  return <section data-autodev-panel className={styles.root}>
    <header className={styles.header}>
      <div className={styles.heading}>
        <h2 className={styles.title}>{t('title')}</h2>
        <p className={styles.subtitle}>{t('description')}</p>
      </div>
      <button className={styles.refreshButton} type="button" onClick={() => { void refresh() }} disabled={loading || busy}>{t('refresh')}</button>
    </header>
    <form className={`${styles.card} ${styles.createCard}`} onSubmit={(event) => { event.preventDefault(); void create() }}>
      <div className={styles.cardHeading}>
        <h3 className={styles.cardTitle}>{t('create')}</h3>
      </div>
      <div className={styles.formGrid}>
        <label className={styles.field}>{t('repoPath')}<input required value={repoPath} onChange={(event) => { setRepoPath(event.target.value) }} disabled={busy} /></label>
        <label className={styles.field}>{t('mode')}<select value={mode} onChange={(event) => { setMode(event.target.value as AutoDevMode | 'AUTO') }} disabled={busy}>
          <option value="AUTO">{t('modeAuto')}</option>
          {AUTODEV_MODES.map(item => <option key={item} value={item}>{t(`mode${item}` as AutoDevKey)}</option>)}
        </select></label>
        <label className={styles.field}>{t('buildDriver')}<select value={buildDriver} onChange={(event) => { setBuildDriver(event.target.value as BuildDriverId | 'auto') }} disabled={busy}>
          <option value="auto">{t('autoDriver')}</option>
          <option value="maven">Maven</option><option value="gradle">Gradle</option><option value="node">Node</option><option value="pytest">pytest</option>
        </select></label>
        <label className={`${styles.field} ${styles.fullField}`}>{t('requestInput')}<textarea required value={request} onChange={(event) => { setRequest(event.target.value) }} rows={4} disabled={busy} /></label>
        <label className={`${styles.field} ${styles.fullField}`}>{t('acceptanceCriteria')}<textarea value={acceptanceCriteria} onChange={(event) => { setAcceptanceCriteria(event.target.value) }} rows={3} disabled={busy} /></label>
      </div>
      <button className={styles.primaryButton} type="submit" disabled={busy || repoPath.trim() === '' || request.trim() === ''}>{busy ? t('creating') : t('create')}</button>
    </form>
    <AutoDevBackupRecovery remote={remote} t={t} />
    {error !== undefined && <p className={styles.alert} role="alert">{t('error')}: {error}</p>}
    {loading && runs.length === 0 && <p className={styles.emptyState}>{t('loading')}</p>}
    {!loading && runs.length === 0 && <p className={styles.emptyState}>{t('empty')}</p>}
    {runs.length > 0 && <div className={styles.runList}>
      {runs.map(run => <button
        key={run.id}
        className={styles.runItem}
        type="button"
        onClick={() => { void refresh(run.id) }}
        aria-pressed={run.id === selected?.run.id}
        data-selected={run.id === selected?.run.id}
      >
        <span className={styles.statusBadge} data-status={run.status}>{run.status}</span>
        <span className={styles.runRequest}>{run.request}</span>
        <span className={styles.runTime}>{formatTime(run.updatedAt)}</span>
      </button>)}
    </div>}
    <section data-autodev-section="retention" aria-label={t('retentionReview')}>
      <strong>{t('retentionReview')}</strong>
      <p className={styles.retentionNotice}>{t('retentionNotice')}</p>
      <label className={styles.field}>{t('minAgeDays')} <input type="number" min={0} max={3650} step={1} value={retentionMinAgeDays}
        onChange={(event) => {
          setRetentionMinAgeDays(Number(event.currentTarget.value))
          setRetentionPreview(undefined)
          setRetentionSelectedIds([])
          setActiveCleanupJobId(undefined)
        }} /></label>
      <button type="button" disabled={retentionBusy || !Number.isSafeInteger(retentionMinAgeDays) || retentionMinAgeDays < 0 || retentionMinAgeDays > 3650}
        onClick={() => { void previewRetention() }}>{retentionBusy ? t('loadingRetention') : t('previewRetention')}</button>
      {retentionPreview !== undefined && <div aria-live="polite">
        <p style={{ margin: '4px 0' }}>{t('retentionEligible')}: {retentionPreview.eligibleWorktrees.length} · {t('retentionBlocked')}: {retentionPreview.blockedWorktrees.length}</p>
        {retentionPreview.eligibleWorktrees.length === 0
          ? <small>{t('retentionEmpty')}</small>
          : <ul aria-label={t('retentionEligible')} style={{ marginTop: 4, paddingLeft: 18 }}>
            {retentionPreview.eligibleWorktrees.map(item => <li key={item.retentionId}>
              <label><input type="checkbox" aria-label={`${t('selectRetentionWorktree')}: ${item.runId} #${item.attempt}`}
                checked={retentionSelectedIds.includes(item.retentionId)} disabled={retentionBusy}
                onChange={() => { setRetentionSelectedIds(current => current.includes(item.retentionId)
                  ? current.filter(id => id !== item.retentionId)
                  : [...current, item.retentionId]) }} />
              {item.runId} · #{item.attempt} · {item.ageDays}d
              </label>
            </li>)}
          </ul>}
        {retentionPreview.blockedWorktrees.length > 0 && <ul aria-label={t('retentionBlocked')} style={{ marginTop: 4, paddingLeft: 18 }}>
          {retentionPreview.blockedWorktrees.map(item => <li key={item.retentionId}>{item.runId} · #{item.attempt}: {item.reasons.join(', ')}</li>)}
        </ul>}
        <p style={{ margin: '4px 0' }}>{t('selectedRetentionCount')}: {retentionSelectedIds.length}/10</p>
        <button type="button" disabled={retentionBusy || retentionSelectedIds.length === 0 || retentionSelectedIds.length > 10}
          onClick={() => { void prepareRetentionCleanup() }}>{retentionBusy ? t('preparingRetentionCleanup') : t('prepareRetentionCleanup')}</button>
      </div>}
      <p style={{ margin: '4px 0' }}><small>{t('retentionCleanupPathNotice')}</small></p>
      <div aria-label={t('retentionCleanupJobs')}>
        <strong>{t('retentionCleanupJobs')}</strong>
        {retentionCleanupJobs.length === 0
          ? <p style={{ margin: '4px 0' }}>{t('retentionCleanupNoJobs')}</p>
          : retentionCleanupJobs.map(job => <div key={job.id} data-cleanup-job={job.id} style={{ borderTop: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))', marginTop: 6, paddingTop: 6 }}>
            <small>{job.status} · {job.id} · {t('retentionCleanupProgress')} {job.items.filter(item => item.status === 'REMOVED').length}/{job.items.length}</small>
            {job.requestedBy !== undefined && <small style={{ display: 'block' }}>{t('auditActor')}: {auditActorLabel(job.requestedBy, t)}</small>}
            {(job.events ?? []).length > 0 && <ul aria-label={t('auditTitle')} style={{ margin: '4px 0', paddingLeft: 18 }}>
              {(job.events ?? []).slice(-8).map((event, index) => <li key={`${event.at}:${event.type}:${index}`}>
                {cleanupEventLabel(event.type, t)} · {auditActorLabel(event.actor, t)} · {formatTime(event.at)}
              </li>)}
            </ul>}
            <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
              {job.items.map(item => <li key={item.retentionId}>{item.runId} · #{item.attempt} · {item.status}{item.failureCode === undefined ? '' : ` (${item.failureCode})`}</li>)}
            </ul>
            {(job.status === 'AWAITING_CONFIRMATION' || job.status === 'NEEDS_ATTENTION' || job.status === 'EXECUTING') && <button type="button" disabled={retentionBusy}
              onClick={() => { setActiveCleanupJobId(job.id); setCleanupConfirmationText('') }}>{t('resumeRetentionCleanup')}</button>}
            {job.status === 'AWAITING_CONFIRMATION' && <button type="button" disabled={retentionBusy}
              onClick={() => { void cancelRetentionCleanup(job.id) }}>{t('cancelRetentionCleanup')}</button>}
          </div>)}
      </div>
      {activeCleanupJob !== undefined && activeCleanupJob.status !== 'COMPLETED' && activeCleanupJob.status !== 'CANCELLED' && <div data-autodev-cleanup-confirmation>
        <p style={{ margin: '4px 0' }}>{t('retentionConfirmationPrompt')} <code>{activeCleanupJob.confirmationPhrase}</code></p>
        <label>{t('retentionConfirmationInput')} <input value={cleanupConfirmationText} disabled={retentionBusy}
          onChange={(event) => { setCleanupConfirmationText(event.currentTarget.value) }} /></label>
        <button className={styles.dangerButton} type="button" disabled={retentionBusy || cleanupConfirmationText !== activeCleanupJob.confirmationPhrase}
          onClick={() => { void executeRetentionCleanup(activeCleanupJob) }}>{retentionBusy ? t('executingRetentionCleanup') : t('executeRetentionCleanup')}</button>
      </div>}
    </section>
    {selected !== undefined && <article className={styles.detailCard}>
      <h3>{t('details')}</h3>
      <p style={{ margin: '4px 0' }}><strong>{t('mode')}:</strong> {t(`mode${selected.run.mode ?? 'DEV'}` as AutoDevKey)} · {t(selected.run.modeSource === 'explicit' ? 'modeSelectionExplicit' : selected.run.modeSource === 'auto' ? 'modeSelectionAuto' : 'modeSelectionLegacy')}</p>
      <p style={{ margin: '4px 0' }}><strong>{t('request')}:</strong> {selected.run.request}</p>
      <p style={{ margin: '4px 0' }}><strong>{selected.run.status}</strong> · {selected.run.id}</p>
      {selected.run.status === 'DRAFT' && <p style={{ margin: '4px 0', color: 'var(--dsw-alias-state-warn-label, #a76513)' }}>{t('reviewBeforeRun')}</p>}
      {selected.run.status === 'READY' && <p style={{ margin: '4px 0', color: 'var(--dsw-alias-state-success-primary, #198754)' }}>{t('planApproved')}</p>}
      {inFlightRunId === selected.run.id && <p style={{ margin: '4px 0', color: 'var(--dsw-alias-state-business-primary, #4176e6)' }}>{t('startingRun')}</p>}
      {selected.plan !== undefined && <div><strong>{t('plan')}</strong> v{selected.plan.version}
        <p style={{ margin: '4px 0', overflowWrap: 'anywhere' }}>ID: {selected.plan.id} · {selected.plan.fingerprint} · {selected.plan.buildDriverId}</p>
        {selected.run.acceptanceCriteria.length > 0 && <ul style={{ marginTop: 4, paddingLeft: 18 }}>{selected.run.acceptanceCriteria.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>}
        <ul style={{ marginTop: 4, paddingLeft: 18 }}>{selected.plan.nodes.map((node) => {
          const executions = selected.nodes.filter(item => item.planId === selected.plan?.id && item.nodeId === node.id)
          const latest = executions.at(-1)
          return <li key={node.id}>{node.id}: {latest?.status ?? 'PENDING'} — {node.description}</li>
        })}</ul>
        {selected.run.status === 'DRAFT' && <button type="button" disabled={busy} onClick={() => { void approvePlan() }}>{t('approvePlan')}</button>}
        {selected.run.status === 'READY' && <button type="button" disabled={busy || inFlightRunId === selected.run.id} onClick={() => { void startRun() }}>{t('startRun')}</button>}
      </div>}
      <div><strong>{t('evidence')}</strong>
        <ul style={{ marginTop: 4, paddingLeft: 18 }}>
          {selected.evidence.slice(-8).map(item => (
            <li key={item.id}>{item.type}: {item.status} — {item.summary}</li>
          ))}
        </ul>
      </div>
      <div aria-label={t('auditTitle')}><strong>{t('auditTitle')}</strong>
        {auditEvents.length === 0
          ? <p style={{ margin: '4px 0' }}>{t('auditEmpty')}</p>
          : <ul style={{ marginTop: 4, paddingLeft: 18 }}>
            {auditEvents.map(event => <li key={event.id}>
              {formatTime(event.createdAt)} · {auditActionLabel(event.action, t)} ·{' '}
              {auditActorLabel(event.actor, t)} · {event.result} · {event.resourceKind}:{' '}
              {event.resourceId}
            </li>)}
          </ul>}
      </div>
      <div><strong>{t('verification')}</strong>
        {selected.verifications.at(-1) === undefined
          ? <p style={{ margin: '4px 0' }}>UNKNOWN</p>
          : <p style={{ margin: '4px 0' }}>{selected.verifications.at(-1)?.status} — {selected.verifications.at(-1)?.summary}</p>}
        {selected.verificationResults.length > 0 && (
          <ul style={{ marginTop: 4, paddingLeft: 18 }}>
            {selected.verificationResults.slice(-4).map(item => (
              <li key={item.id}>{item.status}: {item.reason}</li>
            ))}
          </ul>
        )}
      </div>
      <div><strong>{t('signals')}</strong>
        {selected.signals.length === 0
          ? <p style={{ margin: '4px 0' }}>{t('noSignals')}</p>
          : <ul style={{ marginTop: 4, paddingLeft: 18 }}>
            {selected.signals.slice(-8).map(item => (
              <li key={item.id}>{item.provider}: {item.signal.type}</li>
            ))}
          </ul>}
      </div>
      <AutoDevSemanticReview snapshot={selected} remote={remote} t={t} busy={busy} onSnapshotAction={performSnapshotAction} />
      <div><strong>{t('memory')}</strong>
        <p style={{ margin: '4px 0' }}>{selected.memories.length} {t('memoryItems')} · {selected.knowledge.length} {t('knowledgeItems')} · {selected.concepts.length} {t('conceptItems')} · {selected.playbooks.length} {t('playbookItems')}</p>
        {selected.memories.slice(-3).map(item => <p key={item.id} style={{ margin: '4px 0' }}>{item.status}: {item.title}</p>)}
      </div>
      <AutoDevKnowledgeReview snapshot={selected} remote={remote} t={t} busy={busy} onSnapshotAction={performSnapshotAction} />
      <AutoDevKnowledgeLifecycle snapshot={selected} remote={remote} t={t} busy={busy} onSnapshotAction={performSnapshotAction} />
      <AutoDevPlaybookReview snapshot={selected} remote={remote} t={t} busy={busy} onSnapshotAction={performSnapshotAction} />
      <div><strong>{t('sideEffects')}</strong>
        {selected.actionIntents.length === 0
          ? <p style={{ margin: '4px 0' }}>{t('noSideEffects')}</p>
          : <ul style={{ marginTop: 4, paddingLeft: 18 }}>
            {selected.actionIntents.slice(-6).map(item => (
              <li key={item.id}>{item.kind}: {item.status} — {item.target}</li>
            ))}
          </ul>}
      </div>
      <div><strong>{candidateHistory.length > 1 ? t('candidateComparison') : t('diff')}</strong>
        {candidateHistory.length > 1
          ? <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 8, marginTop: 6 }}>
              <label>{t('compareOlder')}
                <select aria-label={t('compareOlder')} value={compareLeftId ?? ''} onChange={(event) => {
                  const id = event.currentTarget.value
                  if (id === compareRightId) setCompareRightId(compareLeftId)
                  setCompareLeftId(id)
                }}>
                  {candidateHistory.map(candidate => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidateOptionLabel(candidate)}
                    </option>
                  ))}
                </select>
              </label>
              <label>{t('compareNewer')}
                <select aria-label={t('compareNewer')} value={compareRightId ?? ''} onChange={(event) => {
                  const id = event.currentTarget.value
                  if (id === compareLeftId) setCompareLeftId(compareRightId)
                  setCompareRightId(id)
                }}>
                  {candidateHistory.map(candidate => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidateOptionLabel(candidate)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {compareLeftId !== undefined &&
              compareRightId !== undefined &&
              candidateHistory.find(item => item.id === compareLeftId)?.baseCommit !==
                candidateHistory.find(item => item.id === compareRightId)?.baseCommit
              && <p style={{ color: 'var(--dsw-alias-state-warn-label, #a76513)' }}>{t('differentCandidateBase')}</p>}
            {comparisonDiffs === undefined || comparisonDiffs.leftId !== compareLeftId || comparisonDiffs.rightId !== compareRightId
              ? <p style={{ margin: '4px 0' }}>{t('loadingCandidateDiffs')}</p>
              : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 8, marginTop: 8 }}>
                {([
                  { id: compareLeftId, content: comparisonDiffs.left, label: t('compareOlder') },
                  { id: compareRightId, content: comparisonDiffs.right, label: t('compareNewer') },
                ] as const).map((side) => {
                  const candidate = candidateHistory.find(item => item.id === side.id)
                  if (candidate === undefined) return null
                  const verification = selected.verifications.filter(item => item.candidateId === candidate.id).at(-1)
                  const evidence = selected.evidence.filter(item => item.candidateId === candidate.id)
                  return <section key={`${side.label}:${candidate.id}`} aria-label={`${side.label}: ${candidate.id}`} style={{ minWidth: 0, padding: 8, border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))', borderRadius: 8 }}>
                    <strong>{side.label}</strong>
                    <p style={{ margin: '4px 0', overflowWrap: 'anywhere' }}>{t('candidateId')}: {candidate.id}</p>
                    <p style={{ margin: '4px 0', overflowWrap: 'anywhere' }}>{t('attempt')}: {candidate.attempt ?? '—'} · {t('plan')}: {candidate.planId}</p>
                    <p style={{ margin: '4px 0', overflowWrap: 'anywhere' }}>{t('baseCommit')}: {candidate.baseCommit}</p>
                    <p style={{ margin: '4px 0', overflowWrap: 'anywhere' }}>{t('candidateTree')}: {candidate.gitTreeHash}</p>
                    <p style={{ margin: '4px 0' }}>{t('verification')}: {verification?.status ?? 'UNKNOWN'} · {t('evidence')}: {evidence.length}</p>
                    {side.content === undefined
                      ? <p style={{ margin: '4px 0' }}>{candidate.diffAvailable ? t('loadingCandidateDiffs') : t('noDiff')}</p>
                      : <>
                        <pre style={{ margin: '4px 0', padding: 8, maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 'var(--dsh-content-font-size-secondary, 13px)', background: 'var(--dsw-alias-bg-module-platform, #f6f7f8)', border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))', borderRadius: 8 }}>{side.content.content}</pre>
                        {side.content.truncated && <small style={{ color: 'var(--dsw-alias-state-warn-label, #a76513)' }}>{t('diffTruncated')}</small>}
                      </>}
                  </section>
                })}
              </div>}
          </>
          : diff === undefined
            ? <p style={{ margin: '4px 0' }}>{t('noDiff')}</p>
            : <>
              <pre style={{ margin: '4px 0', padding: 8, maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 'var(--dsh-content-font-size-secondary, 13px)', background: 'var(--dsw-alias-bg-module-platform, #f6f7f8)', border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))', borderRadius: 8 }}>{diff.content}</pre>
              {diff.truncated && <small style={{ color: 'var(--dsw-alias-state-warn-label, #a76513)' }}>{t('diffTruncated')}</small>}
            </>}
      </div>
      {selected.gates.length > 0 && <div><strong>{t('gate')}</strong>
        {selected.gates.slice(-1).map(gate => <div key={gate.id} style={{ marginTop: 4 }}>
          <p style={{ margin: '4px 0' }}>{gate.status}: {gate.reason}</p>
          {gate.status === 'OPEN' && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['retry', 'rework', 'replan', 'abandon', 'cancel'] as const).filter(action => gate.options.includes(action)).map(action => (
              <button key={action} type="button" disabled={busy} onClick={() => { void perform(action) }}>{t(action)}</button>
            ))}
          </div>}
        </div>)}
      </div>}
      {promotionAllowed && promotionRequested && <div role="group" aria-label={t('promotionReview')} style={{ padding: 12, border: '1px solid var(--dsw-alias-state-warn-secondary, #f7ad31)', borderRadius: 8, background: 'var(--dsw-alias-state-warn-tertiary, #fef5e7)' }}>
        <strong>{t('promotionReview')}</strong>
        <p style={{ margin: '4px 0' }}>{t('candidateId')}: {selected.run.candidateId ?? t('unknownCandidate')} · {t('verification')}: {selected.verifications.at(-1)?.status ?? 'UNKNOWN'} · {t('evidence')}: {selected.evidence.length}</p>
        <button type="button" disabled={busy} onClick={confirmPromotion}>{t('confirmPromotion')}</button>
        <button type="button" disabled={busy} onClick={() => { setPromotionRequested(false) }}>{t('keepCandidate')}</button>
      </div>}
      {selected.gates.length === 0 && <small style={{ color: 'var(--dsw-alias-label-tertiary, #707784)' }}>{t('noGate')}</small>}
      {!terminal(selected.run.status) && selected.run.status !== 'VERIFY'
        && !(latestGate?.status === 'OPEN' && latestGate.options.includes('cancel'))
        && <p><button type="button" disabled={busy} onClick={() => { void perform('cancel') }}>{t('cancel')}</button></p>}
      {promotionAllowed && !promotionRequested && <p><button type="button" disabled={busy} onClick={requestPromotion}>{t('promote')}</button></p>}
    </article>}
    <span hidden>{tab.id}</span>
  </section>
}
