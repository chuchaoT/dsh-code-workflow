import { useEffect, useState, type ReactNode } from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AutoDevSnapshot, BusinessConcept, KnowledgeMergeProposal } from '../contracts.ts'

export interface AutoDevKnowledgeReviewProps {
  readonly snapshot: AutoDevSnapshot
  readonly remote: ClientRemote['autodev']
  readonly t: TranslateNS<'autodev'>
  readonly busy: boolean
  readonly onSnapshotAction: (action: () => Promise<RemoteResult<AutoDevSnapshot>>) => Promise<void>
}

interface ConceptDraft {
  readonly name: string
  readonly definition: string
  readonly target: string
  readonly effect: string
  readonly evidenceSummary: string
  readonly resolution: string
}

interface MergeDraft {
  readonly statement: string
  readonly content: string
  readonly resolution: string
}

function initialConceptDraft(concept: BusinessConcept): ConceptDraft {
  return {
    name: concept.name,
    definition: concept.definition,
    target: concept.target,
    effect: concept.effect,
    evidenceSummary: '',
    resolution: '',
  }
}

function ConceptCorrectionCard({ concept, t, busy, onCorrect }: {
  readonly concept: BusinessConcept
  readonly t: TranslateNS<'autodev'>
  readonly busy: boolean
  readonly onCorrect: (draft: ConceptDraft) => Promise<void>
}): ReactNode {
  const [draft, setDraft] = useState(() => initialConceptDraft(concept))
  useEffect(() => { setDraft(initialConceptDraft(concept)) }, [concept.id, concept.version])
  const update = (key: keyof ConceptDraft, value: string): void => { setDraft(current => ({ ...current, [key]: value })) }
  const required = [draft.name, draft.definition, draft.target, draft.effect, draft.evidenceSummary, draft.resolution]
    .every(value => value.trim() !== '')

  return <article style={{ marginTop: 6, padding: 10, border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))', borderRadius: 8 }}>
    <p style={{ margin: '2px 0' }}><strong>{concept.name}</strong> · {concept.key} · v{concept.version} · {concept.status}</p>
    <p style={{ margin: '4px 0' }}>{concept.definition}</p>
    <p style={{ margin: '4px 0' }}>{t('conceptTarget')}: {concept.target} · {t('conceptEffect')}: {concept.effect}</p>
    <label style={{ display: 'grid', gap: 4, marginTop: 6 }}>{t('conceptName')}
      <input value={draft.name} onChange={(event) => { update('name', event.target.value) }} disabled={busy} />
    </label>
    <label style={{ display: 'grid', gap: 4, marginTop: 6 }}>{t('conceptDefinition')}
      <textarea value={draft.definition} onChange={(event) => { update('definition', event.target.value) }} rows={2} disabled={busy} />
    </label>
    <label style={{ display: 'grid', gap: 4, marginTop: 6 }}>{t('conceptTarget')}
      <input value={draft.target} onChange={(event) => { update('target', event.target.value) }} disabled={busy} />
    </label>
    <label style={{ display: 'grid', gap: 4, marginTop: 6 }}>{t('conceptEffect')}
      <input value={draft.effect} onChange={(event) => { update('effect', event.target.value) }} disabled={busy} />
    </label>
    <label style={{ display: 'grid', gap: 4, marginTop: 6 }}>{t('conceptEvidenceSummary')}
      <textarea value={draft.evidenceSummary} onChange={(event) => { update('evidenceSummary', event.target.value) }} rows={2} disabled={busy} />
    </label>
    <label style={{ display: 'grid', gap: 4, marginTop: 6 }}>{t('humanCorrectionReason')}
      <textarea value={draft.resolution} onChange={(event) => { update('resolution', event.target.value) }} rows={2} disabled={busy} />
    </label>
    <button type="button" disabled={busy || !required} onClick={() => { void onCorrect(draft) }}>{t('saveConceptCorrection')}</button>
  </article>
}

export function AutoDevKnowledgeReview({ snapshot, remote, t, busy, onSnapshotAction }: AutoDevKnowledgeReviewProps): ReactNode {
  const [mergeDrafts, setMergeDrafts] = useState<Readonly<Record<string, MergeDraft>>>({})
  useEffect(() => { setMergeDrafts({}) }, [snapshot.run.id])

  const draftFor = (proposalId: string): MergeDraft => mergeDrafts[proposalId] ?? { statement: '', content: '', resolution: '' }
  const updateMerge = (proposalId: string, key: keyof MergeDraft, value: string): void => {
    setMergeDrafts(current => ({
      ...current,
      [proposalId]: { ...(current[proposalId] ?? { statement: '', content: '', resolution: '' }), [key]: value },
    }))
  }
  const acceptMerge = (proposal: KnowledgeMergeProposal): void => {
    const draft = draftFor(proposal.id)
    if (draft.statement.trim() === '' || draft.resolution.trim() === '') return
    void onSnapshotAction(() => remote.acceptKnowledgeMerge({
      runId: snapshot.run.id,
      proposalId: proposal.id,
      statement: draft.statement.trim(),
      ...(draft.content.trim() === '' ? {} : { content: draft.content.trim() }),
      resolution: draft.resolution.trim(),
    }))
  }
  const rejectMerge = (proposal: KnowledgeMergeProposal): void => {
    const resolution = draftFor(proposal.id).resolution.trim()
    if (resolution === '') return
    void onSnapshotAction(() => remote.rejectKnowledgeMerge({ runId: snapshot.run.id, proposalId: proposal.id, resolution }))
  }

  return <>
    <section aria-labelledby="autodev-concept-review-title" style={{ display: 'grid', gap: 8 }}>
      <h4 id="autodev-concept-review-title" style={{ margin: '4px 0 0', fontSize: 13 }}>{t('businessConcepts')}</h4>
      {snapshot.concepts.length === 0
        ? <p style={{ margin: '4px 0' }}>{t('noConcepts')}</p>
        : snapshot.concepts.map(concept => <ConceptCorrectionCard
          key={concept.id}
          concept={concept}
          t={t}
          busy={busy}
          onCorrect={draft => onSnapshotAction(() => remote.correctConcept({
            runId: snapshot.run.id,
            key: concept.key,
            name: draft.name.trim(),
            definition: draft.definition.trim(),
            target: draft.target.trim(),
            effect: draft.effect.trim(),
            evidenceSummary: draft.evidenceSummary.trim(),
            resolution: draft.resolution.trim(),
            evidenceIds: concept.evidenceIds,
          }))}
        />)}
    </section>

    <section aria-labelledby="autodev-knowledge-merge-title" style={{ display: 'grid', gap: 8 }}>
      <h4 id="autodev-knowledge-merge-title" style={{ margin: '4px 0 0', fontSize: 13 }}>{t('knowledgeMergeReview')}</h4>
      <button type="button" disabled={busy} onClick={() => {
        void onSnapshotAction(() => remote.proposeKnowledgeMerges({ runId: snapshot.run.id }))
      }}>{t('proposeKnowledgeMerges')}</button>
      {snapshot.knowledgeMergeProposals.length === 0
        ? <p style={{ margin: '4px 0' }}>{t('noKnowledgeMerges')}</p>
        : snapshot.knowledgeMergeProposals.map((proposal) => {
          const draft = draftFor(proposal.id)
          return <article key={proposal.id} style={{ marginTop: 6, padding: 10, border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.12))', borderRadius: 8 }}>
            <p style={{ margin: '2px 0' }}><strong>{proposal.status}</strong> · {proposal.kind} · {Math.round(proposal.similarity * 100)}%</p>
            <p style={{ margin: '4px 0' }}>{proposal.reason}</p>
            <p style={{ margin: '4px 0' }}>{t('sharedTerms')}: {proposal.sharedTerms.join(', ') || '—'}</p>
            <ul style={{ margin: '4px 0', paddingLeft: 18 }}>{proposal.inputVersions.map((input) => {
              const knowledge = snapshot.knowledge.find(item => item.id === input.id)
              const changed = knowledge === undefined || knowledge.version !== input.version
              return <li key={input.id}>{input.id} · v{input.version}{changed ? ` · ${t('inputVersionChanged')}` : ''}{knowledge === undefined ? '' : ` — ${knowledge.statement}`}</li>
            })}</ul>
            {proposal.status === 'PROPOSED'
              ? <>
                <label style={{ display: 'grid', gap: 4, marginTop: 6 }}>{t('mergeStatement')}
                  <input aria-label={`${t('mergeStatement')}: ${proposal.id}`} value={draft.statement} onChange={(event) => { updateMerge(proposal.id, 'statement', event.target.value) }} disabled={busy} />
                </label>
                <label style={{ display: 'grid', gap: 4, marginTop: 6 }}>{t('mergeContent')}
                  <textarea aria-label={`${t('mergeContent')}: ${proposal.id}`} value={draft.content} onChange={(event) => { updateMerge(proposal.id, 'content', event.target.value) }} rows={3} disabled={busy} />
                </label>
                <label style={{ display: 'grid', gap: 4, marginTop: 6 }}>{t('knowledgeMergeResolution')}
                  <textarea aria-label={`${t('knowledgeMergeResolution')}: ${proposal.id}`} value={draft.resolution} onChange={(event) => { updateMerge(proposal.id, 'resolution', event.target.value) }} rows={2} disabled={busy} />
                </label>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button type="button" aria-label={`${t('acceptKnowledgeMerge')}: ${proposal.id}`} disabled={busy || draft.statement.trim() === '' || draft.resolution.trim() === ''} onClick={() => { acceptMerge(proposal) }}>{t('acceptKnowledgeMerge')}</button>
                  <button type="button" aria-label={`${t('rejectKnowledgeMerge')}: ${proposal.id}`} disabled={busy || draft.resolution.trim() === ''} onClick={() => { rejectMerge(proposal) }}>{t('rejectKnowledgeMerge')}</button>
                </div>
              </>
              : proposal.resolution !== undefined && <p style={{ margin: '4px 0' }}>{t('knowledgeMergeResolution')}: {proposal.resolution}</p>}
            {proposal.outputKnowledgeId !== undefined && <p style={{ margin: '4px 0' }}>{t('outputKnowledge')}: {proposal.outputKnowledgeId}</p>}
          </article>
        })}
    </section>
  </>
}
