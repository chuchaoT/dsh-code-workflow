import { useState, type ReactNode } from 'react'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

export interface AutoDevBackupRecoveryProps {
  readonly remote: Pick<ClientRemote['autodev'], 'createBackup' | 'restoreBackup'>
  readonly t: TranslateNS<'autodev'>
}

interface BackupOutcome {
  readonly operation: 'created' | 'restored'
  readonly createdAt: string
  readonly fileCount: number
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw new Error(result.error.message)
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** Host-backed backup controls; restoration always targets a new data root. */
export function AutoDevBackupRecovery({ remote, t }: AutoDevBackupRecoveryProps): ReactNode {
  const [backupDestinationPath, setBackupDestinationPath] = useState('')
  const [restoreBackupPath, setRestoreBackupPath] = useState('')
  const [restoreTargetDataRoot, setRestoreTargetDataRoot] = useState('')
  const [confirmedTargetDataRoot, setConfirmedTargetDataRoot] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [outcome, setOutcome] = useState<BackupOutcome>()

  const createBackup = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setOutcome(undefined)
    try {
      const manifest = unwrap(await remote.createBackup({ destinationPath: backupDestinationPath }))
      setOutcome({ operation: 'created', createdAt: manifest.createdAt, fileCount: manifest.files.length })
    } catch (cause: unknown) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const restoreBackup = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setOutcome(undefined)
    try {
      const manifest = unwrap(await remote.restoreBackup({
        backupPath: restoreBackupPath,
        targetDataRoot: restoreTargetDataRoot,
        confirmedTargetDataRoot,
      }))
      setOutcome({ operation: 'restored', createdAt: manifest.createdAt, fileCount: manifest.files.length })
    } catch (cause: unknown) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return <section
    aria-label={t('backupRecovery')}
    style={{ padding: 8, border: '1px solid #e5e7eb', borderRadius: 6 }}
  >
    <strong>{t('backupRecovery')}</strong>
    <p style={{ margin: '4px 0' }}>{t('backupRecoveryNotice')}</p>
    <label style={{ display: 'grid', gap: 4, marginTop: 6 }}>{t('backupDestinationPath')}
      <input value={backupDestinationPath} onChange={(event) => {
        setBackupDestinationPath(event.currentTarget.value)
        setOutcome(undefined)
      }} disabled={busy} />
    </label>
    <button type="button" disabled={busy || backupDestinationPath.trim() === ''} onClick={() => { void createBackup() }}>
      {busy ? t('backupWorking') : t('createBackup')}
    </button>
    <label style={{ display: 'grid', gap: 4, marginTop: 8 }}>{t('restoreBackupPath')}
      <input value={restoreBackupPath} onChange={(event) => {
        setRestoreBackupPath(event.currentTarget.value)
        setOutcome(undefined)
      }} disabled={busy} />
    </label>
    <label style={{ display: 'grid', gap: 4, marginTop: 6 }}>{t('restoreTargetDataRoot')}
      <input value={restoreTargetDataRoot} onChange={(event) => {
        setRestoreTargetDataRoot(event.currentTarget.value)
        setConfirmedTargetDataRoot('')
        setOutcome(undefined)
      }} disabled={busy} />
    </label>
    <label style={{ display: 'grid', gap: 4, marginTop: 6 }}>{t('restoreConfirmation')}
      <input value={confirmedTargetDataRoot} onChange={(event) => {
        setConfirmedTargetDataRoot(event.currentTarget.value)
      }} disabled={busy} />
    </label>
    <button
      type="button"
      disabled={busy || restoreBackupPath.trim() === '' || restoreTargetDataRoot.trim() === '' || confirmedTargetDataRoot !== restoreTargetDataRoot}
      onClick={() => { void restoreBackup() }}>
      {busy ? t('backupWorking') : t('restoreBackup')}
    </button>
    {error !== undefined && <p role="alert" style={{ color: '#b91c1c', margin: '4px 0' }}>{t('error')}: {error}</p>}
    {outcome !== undefined && <p role="status" style={{ margin: '4px 0', overflowWrap: 'anywhere' }}>
      {outcome.operation === 'created' ? t('backupCreated') : t('backupRestored')}
      {' · '}{t('backupFileCount')}: {outcome.fileCount} · {outcome.createdAt}
      {outcome.operation === 'restored' && <><br />{t('restoredDataRoot')}: {restoreTargetDataRoot}</>}
    </p>}
  </section>
}
