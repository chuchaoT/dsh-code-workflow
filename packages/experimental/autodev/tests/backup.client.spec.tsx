// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutoDevBackupRecovery, type AutoDevBackupRecoveryProps } from '../src/client/AutoDevBackupRecovery.tsx'
import { zh, type AutoDevKey } from '../src/client/locales.ts'

afterEach(cleanup)

const manifest = {
  formatVersion: 1 as const,
  databaseSchemaVersion: 2,
  createdAt: '2026-09-24T00:00:00.000Z',
  included: ['sqlite', 'run-artifacts'] as const,
  excluded: ['git-worktrees'] as const,
  files: [{ path: 'autodev.sqlite', bytes: 512, sha256: 'a'.repeat(64) }],
}

function renderBackup(remote: AutoDevBackupRecoveryProps['remote']): void {
  render(<AutoDevBackupRecovery remote={remote} t={key => zh[key as AutoDevKey] ?? String(key)} />)
}

describe('AutoDev backup and restore controls', () => {
  it('creates a backup and requires the exact new data root before restoring', async () => {
    const remote = {
      createBackup: vi.fn(async () => ({ ok: true as const, value: manifest })),
      restoreBackup: vi.fn(async () => ({ ok: true as const, value: manifest })),
    } satisfies AutoDevBackupRecoveryProps['remote']
    renderBackup(remote)

    fireEvent.change(screen.getByLabelText(zh.backupDestinationPath), { target: { value: 'C:\\dsh\\backups\\backup-1' } })
    fireEvent.click(screen.getByRole('button', { name: zh.createBackup }))
    await waitFor(() => {
      expect(remote.createBackup).toHaveBeenCalledWith({ destinationPath: 'C:\\dsh\\backups\\backup-1' })
    })
    expect(await screen.findByText(new RegExp(zh.backupCreated, 'u'))).toBeTruthy()

    const restoreButton = screen.getByRole('button', { name: zh.restoreBackup }) as HTMLButtonElement
    expect(restoreButton.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(zh.restoreBackupPath), { target: { value: 'C:\\dsh\\backups\\backup-1' } })
    fireEvent.change(screen.getByLabelText(zh.restoreTargetDataRoot), { target: { value: 'C:\\dsh\\autodev-restored' } })
    fireEvent.change(screen.getByLabelText(zh.restoreConfirmation), { target: { value: 'different path' } })
    expect(restoreButton.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(zh.restoreConfirmation), { target: { value: 'C:\\dsh\\autodev-restored' } })
    expect(restoreButton.disabled).toBe(false)
    fireEvent.click(restoreButton)

    await waitFor(() => {
      expect(remote.restoreBackup).toHaveBeenCalledWith({
        backupPath: 'C:\\dsh\\backups\\backup-1',
        targetDataRoot: 'C:\\dsh\\autodev-restored',
        confirmedTargetDataRoot: 'C:\\dsh\\autodev-restored',
      })
    })
    expect(await screen.findByText(new RegExp(zh.backupRestored, 'u'))).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('C:\\dsh\\autodev-restored')
  })

  it('shows a Host rejection without reporting that a backup completed', async () => {
    const remote = {
      createBackup: vi.fn(async () => ({ ok: false as const, error: { message: 'destination already exists' } })),
      restoreBackup: vi.fn(async () => ({ ok: true as const, value: manifest })),
    } satisfies AutoDevBackupRecoveryProps['remote']
    renderBackup(remote)

    fireEvent.change(screen.getByLabelText(zh.backupDestinationPath), { target: { value: 'C:\\dsh\\backups\\existing' } })
    fireEvent.click(screen.getByRole('button', { name: zh.createBackup }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('destination already exists')
    expect(screen.queryByText(new RegExp(zh.backupCreated, 'u'))).toBeNull()
  })
})
