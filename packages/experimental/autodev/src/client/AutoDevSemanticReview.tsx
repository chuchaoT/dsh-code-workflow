import { useEffect, useState, type ReactNode } from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AutoDevSnapshot, Evidence } from '../contracts.ts'

export interface AutoDevSemanticReviewProps {
  readonly snapshot: AutoDevSnapshot
  readonly remote: ClientRemote['autodev']
  readonly t: TranslateNS<'autodev'>
  readonly busy: boolean
  readonly onSnapshotAction: (action: () => Promise<RemoteResult<AutoDevSnapshot>>) => Promise<void>
}

function confirmableEvidence(snapshot: AutoDevSnapshot, planId?: string): readonly Evidence[] {
  const now = new Date().toISOString()
  return snapshot.evidence.filter(evidence => evidence.runId === snapshot.run.id
    && evidence.status === 'PASS'
    && evidence.source !== 'agent'
    && (evidence.expiresAt === undefined || evidence.expiresAt > now)
    && (planId === undefined || evidence.planId === undefined || evidence.planId === planId))
}

export function AutoDevSemanticReview({ snapshot, remote, t, busy, onSnapshotAction }: AutoDevSemanticReviewProps): ReactNode {
  const [assumptionResolutions, setAssumptionResolutions] = useState<Readonly<Record<string, string>>>({})
  const [assumptionEvidence, setAssumptionEvidence] = useState<Readonly<Record<string, readonly string[]>>>({})
  const [uncertaintyResolutions, setUncertaintyResolutions] = useState<Readonly<Record<string, string>>>({})

  useEffect(() => {
    setAssumptionResolutions({})
    setAssumptionEvidence({})
    setUncertaintyResolutions({})
  }, [snapshot.run.id])

  const resolveAssumption = (assumptionId: string, status: 'CONFIRMED' | 'INVALIDATED' | 'UNKNOWN'): void => {
    const assumption = snapshot.assumptions.find(item => item.id === assumptionId)
    if (assumption === undefined) return
    const resolution = assumptionResolutions[assumptionId]?.trim() ?? ''
    const eligibleIds = new Set(confirmableEvidence(snapshot, assumption.planId).map(item => item.id))
    const evidenceIds = [...new Set(assumptionEvidence[assumptionId]
      ?? (assumption.evidenceIds ?? []).filter(id => eligibleIds.has(id)))].filter(id => eligibleIds.has(id))
    if (resolution === '' || (status === 'CONFIRMED' && evidenceIds.length === 0)) return
    void onSnapshotAction(() => remote.resolveAssumption({
      runId: snapshot.run.id,
      assumptionId,
      status,
      resolution,
      ...(evidenceIds.length === 0 ? {} : { evidenceIds }),
    }))
  }

  const resolveUncertainty = (uncertaintyId: string, status: 'RESOLVED' | 'DISMISSED'): void => {
    const resolution = uncertaintyResolutions[uncertaintyId]?.trim() ?? ''
    if (resolution === '') return
    void onSnapshotAction(() => remote.resolveUncertainty({
      runId: snapshot.run.id,
      uncertaintyId,
      status,
      resolution,
    }))
  }

  return <section aria-labelledby="autodev-semantic-review-title" style={{ display: 'grid', gap: 8 }}>
    <h4 id="autodev-semantic-review-title" style={{ margin: '4px 0 0', fontSize: 13 }}>{t('semanticReview')}</h4>
    <div><strong>{t('assumptions')}</strong>
      {snapshot.assumptions.length === 0
        ? <p style={{ margin: '4px 0' }}>{t('noAssumptions')}</p>
        : snapshot.assumptions.map((assumption) => {
          const evidence = confirmableEvidence(snapshot, assumption.planId)
          const checkedEvidence = assumptionEvidence[assumption.id]
            ?? (assumption.evidenceIds ?? []).filter(id => evidence.some(item => item.id === id))
          const resolution = assumptionResolutions[assumption.id] ?? ''
          return <div key={assumption.id} style={{ marginTop: 6, padding: 10, border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))', borderRadius: 8 }}>
            <p style={{ margin: '2px 0' }}><strong>{assumption.status}</strong> · {assumption.statement}</p>
            {assumption.rationale !== undefined && <small>{assumption.rationale}</small>}
            {assumption.resolution !== undefined && <p style={{ margin: '4px 0' }}>{t('resolution')}: {assumption.resolution}</p>}
            <label style={{ display: 'grid', gap: 4, marginTop: 6 }}>{t('resolution')}
              <textarea
                aria-label={`${t('assumptionResolution')}: ${assumption.statement}`}
                value={resolution}
                onChange={(event) => { setAssumptionResolutions(current => ({ ...current, [assumption.id]: event.target.value })) }}
                rows={2}
                disabled={busy}
              />
            </label>
            <fieldset style={{ margin: '6px 0', padding: 6 }}>
              <legend>{t('supportingEvidence')}</legend>
              {evidence.length === 0
                ? <small>{t('noConfirmableEvidence')}</small>
                : evidence.map((item) => {
                  const checked = checkedEvidence.includes(item.id)
                  return <label key={item.id} style={{ display: 'block', margin: '3px 0' }}>
                    <input
                      type="checkbox"
                      aria-label={`${t('supportingEvidence')}: ${item.summary}`}
                      checked={checked}
                      disabled={busy}
                      onChange={() => {
                        setAssumptionEvidence((current) => {
                          const selected = current[assumption.id]
                            ?? (assumption.evidenceIds ?? []).filter(id => evidence.some(candidate => candidate.id === id))
                          return { ...current, [assumption.id]: checked
                            ? selected.filter(id => id !== item.id)
                            : [...selected, item.id] }
                        })
                      }}
                    />{' '}{item.type}: {item.status} — {item.summary}
                  </label>
                })}
            </fieldset>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" disabled={busy || resolution.trim() === '' || checkedEvidence.length === 0} onClick={() => { resolveAssumption(assumption.id, 'CONFIRMED') }}>{t('confirmAssumption')}</button>
              <button type="button" disabled={busy || resolution.trim() === '' || assumption.status === 'INVALIDATED'} onClick={() => { resolveAssumption(assumption.id, 'INVALIDATED') }}>{t('invalidateAssumption')}</button>
              <button type="button" disabled={busy || resolution.trim() === '' || assumption.status === 'UNKNOWN'} onClick={() => { resolveAssumption(assumption.id, 'UNKNOWN') }}>{t('markAssumptionUnknown')}</button>
            </div>
          </div>
        })}
    </div>
    <div><strong>{t('uncertainties')}</strong>
      {snapshot.uncertainties.length === 0
        ? <p style={{ margin: '4px 0' }}>{t('noUncertainties')}</p>
        : snapshot.uncertainties.map((uncertainty) => {
          const resolution = uncertaintyResolutions[uncertainty.id] ?? ''
          return <div key={uncertainty.id} style={{ marginTop: 6, padding: 10, border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))', borderRadius: 8 }}>
            <p style={{ margin: '2px 0' }}><strong>{uncertainty.status}</strong> · {uncertainty.subject} ({uncertainty.severity})</p>
            <p style={{ margin: '4px 0' }}>{uncertainty.reason}</p>
            {uncertainty.alternatives.length > 0 && <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{uncertainty.alternatives.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>}
            {uncertainty.status === 'OPEN'
              ? <>
                <label style={{ display: 'grid', gap: 4 }}>{t('resolution')}
                  <textarea
                    aria-label={`${t('uncertaintyResolution')}: ${uncertainty.subject}`}
                    value={resolution}
                    onChange={(event) => { setUncertaintyResolutions(current => ({ ...current, [uncertainty.id]: event.target.value })) }}
                    rows={2}
                    disabled={busy}
                  />
                </label>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button type="button" disabled={busy || resolution.trim() === ''} onClick={() => { resolveUncertainty(uncertainty.id, 'RESOLVED') }}>{t('resolveUncertainty')}</button>
                  <button type="button" disabled={busy || resolution.trim() === ''} onClick={() => { resolveUncertainty(uncertainty.id, 'DISMISSED') }}>{t('dismissUncertainty')}</button>
                </div>
              </>
              : uncertainty.resolution !== undefined && <p style={{ margin: '4px 0' }}>{t('resolution')}: {uncertainty.resolution}</p>}
          </div>
        })}
    </div>
  </section>
}
