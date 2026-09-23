import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ArtifactContent, AutoDevSnapshot, Run } from '../contracts.ts'

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

function statusColor(status: Run['status']): string {
  if (status === 'VERIFY' || status === 'PROMOTED') return '#2e8b57'
  if (status === 'NEEDS_INTERVENTION' || status === 'FAILED') return '#c2410c'
  if (status === 'CANCELLED' || status === 'ABANDONED') return '#6b7280'
  return '#2563eb'
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

export function AutoDevPanel({ useTabInfo, remote, t }: AutoDevPanelProps): ReactNode {
  const { tab } = useTabInfo()
  const [runs, setRuns] = useState<readonly Run[]>([])
  const [selected, setSelected] = useState<AutoDevSnapshot | undefined>()
  const [diff, setDiff] = useState<ArtifactContent | undefined>()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

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
  }, [remote, selected?.run.id])

  useEffect(() => { void refresh() }, [refresh])

  const perform = async (action: 'promote' | 'cancel' | 'abandon'): Promise<void> => {
    if (selected === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      const next = action === 'promote'
        ? unwrap(await remote.promote(selected.run.id))
        : action === 'cancel'
          ? unwrap(await remote.cancel(selected.run.id))
          : unwrap(await remote.resolveGate({ runId: selected.run.id, action }))
      setSelected(next)
      await refresh(next.run.id)
    } catch (cause: unknown) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return <section data-autodev-panel style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, height: '100%', overflow: 'auto', fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 15 }}>{t('title')}</h2>
        <small style={{ color: '#6b7280' }}>{t('description')}</small>
      </div>
      <button type="button" onClick={() => { void refresh() }} disabled={loading || busy}>{t('refresh')}</button>
    </header>
    {error !== undefined && <p role="alert" style={{ color: '#b91c1c', margin: 0 }}>{t('error')}: {error}</p>}
    {loading && runs.length === 0 && <p>{t('loading')}</p>}
    {!loading && runs.length === 0 && <p>{t('empty')}</p>}
    {runs.length > 0 && <div style={{ display: 'grid', gap: 6 }}>
      {runs.map(run => <button
        key={run.id}
        type="button"
        onClick={() => { void refresh(run.id) }}
        style={{ textAlign: 'left', padding: 8, border: run.id === selected?.run.id ? '1px solid #2563eb' : '1px solid #d1d5db', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
      >
        <strong style={{ color: statusColor(run.status) }}>{run.status}</strong>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{run.request}</div>
        <small style={{ color: '#6b7280' }}>{formatTime(run.updatedAt)}</small>
      </button>)}
    </div>}
    {selected !== undefined && <article style={{ borderTop: '1px solid #e5e7eb', paddingTop: 10 }}>
      <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>{t('details')}</h3>
      <p style={{ margin: '4px 0' }}><strong>{t('request')}:</strong> {selected.run.request}</p>
      <p style={{ margin: '4px 0' }}><strong>{selected.run.status}</strong> · {selected.run.id}</p>
      {selected.plan !== undefined && <div><strong>{t('plan')}</strong> v{selected.plan.version}
        <ul style={{ marginTop: 4, paddingLeft: 18 }}>{selected.plan.nodes.map((node) => {
          const executions = selected.nodes.filter(item => item.planId === selected.plan?.id && item.nodeId === node.id)
          const latest = executions.at(-1)
          return <li key={node.id}>{node.id}: {latest?.status ?? 'PENDING'} — {node.description}</li>
        })}</ul>
      </div>}
      <div><strong>{t('evidence')}</strong>
        <ul style={{ marginTop: 4, paddingLeft: 18 }}>
          {selected.evidence.slice(-8).map(item => (
            <li key={item.id}>{item.type}: {item.status} — {item.summary}</li>
          ))}
        </ul>
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
      <div><strong>{t('semantic')}</strong>
        <p style={{ margin: '4px 0' }}>{t('assumptions')}: {selected.assumptions.length} · {t('uncertainties')}: {selected.uncertainties.filter(item => item.status === 'OPEN').length} {t('open')}</p>
        {selected.uncertainties.filter(item => item.status === 'OPEN').slice(-3).map(item => <p key={item.id} style={{ margin: '4px 0', color: '#92400e' }}>{item.subject}: {item.reason}</p>)}
      </div>
      <div><strong>{t('memory')}</strong>
        <p style={{ margin: '4px 0' }}>{selected.memories.length} {t('memoryItems')} · {selected.knowledge.length} {t('knowledgeItems')} · {selected.concepts.length} {t('conceptItems')} · {selected.playbooks.length} {t('playbookItems')}</p>
        {selected.memories.slice(-3).map(item => <p key={item.id} style={{ margin: '4px 0' }}>{item.status}: {item.title}</p>)}
      </div>
      <div><strong>{t('sideEffects')}</strong>
        {selected.actionIntents.length === 0
          ? <p style={{ margin: '4px 0' }}>{t('noSideEffects')}</p>
          : <ul style={{ marginTop: 4, paddingLeft: 18 }}>
            {selected.actionIntents.slice(-6).map(item => (
              <li key={item.id}>{item.kind}: {item.status} — {item.target}</li>
            ))}
          </ul>}
      </div>
      <div><strong>{t('diff')}</strong>
        {diff === undefined
          ? <p style={{ margin: '4px 0' }}>{t('noDiff')}</p>
          : <>
            <pre style={{ margin: '4px 0', padding: 8, maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 11, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 4 }}>{diff.content}</pre>
            {diff.truncated && <small style={{ color: '#92400e' }}>{t('diffTruncated')}</small>}
          </>}
      </div>
      {selected.gates.length > 0 && <div><strong>{t('gate')}</strong>
        {selected.gates.slice(-1).map(gate => <div key={gate.id} style={{ marginTop: 4 }}>
          <p style={{ margin: '4px 0' }}>{gate.status}: {gate.reason}</p>
          {gate.status === 'OPEN' && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {gate.options.includes('promote') && <button type="button" disabled={busy} onClick={() => { void perform('promote') }}>{t('promote')}</button>}
            {gate.options.includes('abandon') && <button type="button" disabled={busy} onClick={() => { void perform('abandon') }}>{t('abandon')}</button>}
            {gate.options.includes('cancel') && <button type="button" disabled={busy} onClick={() => { void perform('cancel') }}>{t('cancel')}</button>}
          </div>}
        </div>)}
      </div>}
      {selected.gates.length === 0 && <small style={{ color: '#6b7280' }}>{t('noGate')}</small>}
      {!terminal(selected.run.status) && selected.run.status !== 'VERIFY' && <p><button type="button" disabled={busy} onClick={() => { void perform('cancel') }}>{t('cancel')}</button></p>}
      {selected.run.status === 'VERIFY' && <p><button type="button" disabled={busy} onClick={() => { void perform('promote') }}>{t('promote')}</button></p>}
    </article>}
    <span hidden>{tab.id}</span>
  </section>
}
