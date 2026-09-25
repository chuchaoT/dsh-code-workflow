import { useEffect, useState, type ReactNode } from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AutoDevSnapshot, EvidenceType, Playbook } from '../contracts.ts'

export interface AutoDevPlaybookReviewProps {
  readonly snapshot: AutoDevSnapshot
  readonly remote: ClientRemote['autodev']
  readonly t: TranslateNS<'autodev'>
  readonly busy: boolean
  readonly onSnapshotAction: (action: () => Promise<RemoteResult<AutoDevSnapshot>>) => Promise<void>
}

interface PlaybookDraft {
  readonly key: string
  readonly name: string
  readonly purpose: string
  readonly targets: string
  readonly effects: string
  readonly conceptKeys: string
  readonly exclusions: string
  readonly steps: string
  readonly requiredEvidence: readonly EvidenceType[]
  readonly resolution: string
}

const evidenceTypes = [
  'REPOSITORY_BASELINE', 'PLAN_APPROVAL', 'AGENT_OUTPUT', 'AGENT_CONTEXT', 'DIFF', 'BUILD', 'TEST', 'REVIEW',
  'JEV_DECISION', 'DRIFT', 'PROMOTION', 'ENVIRONMENT', 'VERIFICATION', 'SIDE_EFFECT', 'MEMORY', 'CONCEPT', 'PLAYBOOK', 'KNOWLEDGE',
] as const satisfies readonly EvidenceType[]

function fromPlaybook(playbook?: Playbook): PlaybookDraft {
  return {
    key: playbook?.key ?? '',
    name: playbook?.name ?? '',
    purpose: playbook?.purpose ?? '',
    targets: playbook?.targets.join('\n') ?? '',
    effects: playbook?.effects.join('\n') ?? '',
    conceptKeys: playbook?.conceptKeys.join('\n') ?? '',
    exclusions: playbook?.exclusions?.join('\n') ?? '',
    steps: playbook?.steps.join('\n') ?? '',
    requiredEvidence: playbook?.requiredEvidence ?? [],
    resolution: '',
  }
}

function lines(value: string): string[] {
  return value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean)
}

function PlaybookFields({ draft, t, disabled, prefix, onChange, includeKey }: {
  readonly draft: PlaybookDraft
  readonly t: TranslateNS<'autodev'>
  readonly disabled: boolean
  readonly prefix: string
  readonly includeKey: boolean
  readonly onChange: (key: keyof PlaybookDraft, value: string | readonly EvidenceType[]) => void
}): ReactNode {
  const label = (value: string): string => `${value}: ${prefix}`
  return <div style={{ display: 'grid', gap: 6 }}>
    {includeKey && <label style={{ display: 'grid', gap: 4 }}>{t('playbookKey')}
      <input aria-label={label(t('playbookKey'))} value={draft.key} onChange={(event) => { onChange('key', event.target.value) }} disabled={disabled} />
    </label>}
    <label style={{ display: 'grid', gap: 4 }}>{t('playbookName')}
      <input aria-label={label(t('playbookName'))} value={draft.name} onChange={(event) => { onChange('name', event.target.value) }} disabled={disabled} />
    </label>
    <label style={{ display: 'grid', gap: 4 }}>{t('playbookPurpose')}
      <textarea aria-label={label(t('playbookPurpose'))} value={draft.purpose} onChange={(event) => { onChange('purpose', event.target.value) }} rows={2} disabled={disabled} />
    </label>
    <label style={{ display: 'grid', gap: 4 }}>{t('playbookTargets')}
      <textarea aria-label={label(t('playbookTargets'))} value={draft.targets} onChange={(event) => { onChange('targets', event.target.value) }} rows={2} disabled={disabled} />
    </label>
    <label style={{ display: 'grid', gap: 4 }}>{t('playbookEffects')}
      <textarea aria-label={label(t('playbookEffects'))} value={draft.effects} onChange={(event) => { onChange('effects', event.target.value) }} rows={2} disabled={disabled} />
    </label>
    <label style={{ display: 'grid', gap: 4 }}>{t('playbookConceptKeys')}
      <textarea aria-label={label(t('playbookConceptKeys'))} value={draft.conceptKeys} onChange={(event) => { onChange('conceptKeys', event.target.value) }} rows={2} disabled={disabled} />
    </label>
    <label style={{ display: 'grid', gap: 4 }}>{t('playbookExclusions')}
      <textarea aria-label={label(t('playbookExclusions'))} value={draft.exclusions} onChange={(event) => { onChange('exclusions', event.target.value) }} rows={2} disabled={disabled} />
    </label>
    <label style={{ display: 'grid', gap: 4 }}>{t('playbookSteps')}
      <textarea aria-label={label(t('playbookSteps'))} value={draft.steps} onChange={(event) => { onChange('steps', event.target.value) }} rows={3} disabled={disabled} />
    </label>
    <label style={{ display: 'grid', gap: 4 }}>{t('requiredEvidence')}
      <select
        aria-label={label(t('requiredEvidence'))}
        multiple
        size={4}
        value={draft.requiredEvidence}
        onChange={(event) => { onChange('requiredEvidence', [...event.currentTarget.selectedOptions].map(option => option.value as EvidenceType)) }}
        disabled={disabled}
      >{evidenceTypes.map(type => <option key={type} value={type}>{type}</option>)}</select>
    </label>
  </div>
}

function PlaybookCard({ playbook, snapshot, remote, t, busy, onSnapshotAction }: {
  readonly playbook: Playbook
  readonly snapshot: AutoDevSnapshot
  readonly remote: ClientRemote['autodev']
  readonly t: TranslateNS<'autodev'>
  readonly busy: boolean
  readonly onSnapshotAction: AutoDevPlaybookReviewProps['onSnapshotAction']
}): ReactNode {
  const [draft, setDraft] = useState(() => fromPlaybook(playbook))
  useEffect(() => { setDraft(fromPlaybook(playbook)) }, [playbook.id, playbook.version])
  const change = (key: keyof PlaybookDraft, value: string | readonly EvidenceType[]): void => {
    setDraft(current => ({ ...current, [key]: value }))
  }
  const required = [draft.name, draft.purpose, draft.targets, draft.effects, draft.steps, draft.resolution]
    .every(value => value.trim() !== '')
  const fit = snapshot.playbookFits.filter(item => item.playbookId === playbook.id).at(-1)
  const revise = (): void => {
    if (!required) return
    void onSnapshotAction(() => remote.revisePlaybook({
      runId: snapshot.run.id,
      playbookId: playbook.id,
      name: draft.name.trim(), purpose: draft.purpose.trim(),
      targets: lines(draft.targets), effects: lines(draft.effects),
      conceptKeys: lines(draft.conceptKeys), exclusions: lines(draft.exclusions), steps: lines(draft.steps),
      requiredEvidence: draft.requiredEvidence,
      resolution: draft.resolution.trim(),
    }))
  }

  return <article style={{ marginTop: 6, padding: 8, border: '1px solid #e5e7eb', borderRadius: 6 }}>
    <p style={{ margin: '2px 0' }}><strong>{playbook.name}</strong> · {playbook.key} · v{playbook.version} · {playbook.status}</p>
    <p style={{ margin: '4px 0' }}>{playbook.purpose}</p>
    <p style={{ margin: '4px 0' }}>{t('playbookTargets')}: {playbook.targets.join(', ')} · {t('playbookEffects')}: {playbook.effects.join(', ')}</p>
    <ol style={{ margin: '4px 0', paddingLeft: 20 }}>{playbook.steps.map((step, index) => <li key={`${index}:${step}`}>{step}</li>)}</ol>
    {fit !== undefined && <small>{t('latestPlaybookFit')}: {fit.outcome} · {fit.reasons.join('; ')}</small>}
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
      {playbook.status === 'DRAFT' && <button type="button" disabled={busy} onClick={() => {
        void onSnapshotAction(() => remote.activatePlaybook({ runId: snapshot.run.id, playbookId: playbook.id }))
      }}>{t('activatePlaybook')}</button>}
      {playbook.status === 'ACTIVE' && <button type="button" disabled={busy} onClick={() => {
        void onSnapshotAction(() => remote.deprecatePlaybook({ runId: snapshot.run.id, playbookId: playbook.id }))
      }}>{t('deprecatePlaybook')}</button>}
    </div>
    {playbook.status !== 'DEPRECATED' && <details style={{ marginTop: 6 }}>
      <summary>{t('revisePlaybook')}</summary>
      <PlaybookFields draft={draft} t={t} disabled={busy} prefix={playbook.key} includeKey={false} onChange={change} />
      <label style={{ display: 'grid', gap: 4, marginTop: 6 }}>{t('playbookCorrectionReason')}
        <textarea aria-label={`${t('playbookCorrectionReason')}: ${playbook.key}`} value={draft.resolution} onChange={(event) => { change('resolution', event.target.value) }} rows={2} disabled={busy} />
      </label>
      <button type="button" disabled={busy || !required} onClick={revise}>{t('savePlaybookRevision')}</button>
    </details>}
  </article>
}

export function AutoDevPlaybookReview({ snapshot, remote, t, busy, onSnapshotAction }: AutoDevPlaybookReviewProps): ReactNode {
  const [draft, setDraft] = useState(() => fromPlaybook())
  useEffect(() => { setDraft(fromPlaybook()) }, [snapshot.run.id])
  const change = (key: keyof PlaybookDraft, value: string | readonly EvidenceType[]): void => {
    setDraft(current => ({ ...current, [key]: value }))
  }
  const required = [draft.key, draft.name, draft.purpose, draft.targets, draft.effects, draft.steps]
    .every(value => value.trim() !== '')
  const create = (): void => {
    if (!required) return
    void onSnapshotAction(() => remote.createPlaybook({
      runId: snapshot.run.id,
      key: draft.key.trim(), name: draft.name.trim(), purpose: draft.purpose.trim(),
      targets: lines(draft.targets), effects: lines(draft.effects),
      conceptKeys: lines(draft.conceptKeys), exclusions: lines(draft.exclusions), steps: lines(draft.steps),
      requiredEvidence: draft.requiredEvidence,
    }))
  }

  return <section aria-labelledby="autodev-playbook-review-title" style={{ display: 'grid', gap: 8 }}>
    <h4 id="autodev-playbook-review-title" style={{ margin: '4px 0 0', fontSize: 13 }}>{t('playbookReview')}</h4>
    <p style={{ margin: '2px 0' }}>{t('playbookPlanReviewNotice')}</p>
    <details>
      <summary>{t('createPlaybookDraft')}</summary>
      <PlaybookFields draft={draft} t={t} disabled={busy} prefix={t('createPlaybookDraft')} includeKey onChange={change} />
      <button type="button" disabled={busy || !required} onClick={create}>{t('createPlaybookDraft')}</button>
    </details>
    {snapshot.playbooks.length === 0
      ? <p style={{ margin: '4px 0' }}>{t('noPlaybooks')}</p>
      : snapshot.playbooks.map(playbook => <PlaybookCard
        key={playbook.id}
        playbook={playbook}
        snapshot={snapshot}
        remote={remote}
        t={t}
        busy={busy}
        onSnapshotAction={onSnapshotAction}
      />)}
  </section>
}
