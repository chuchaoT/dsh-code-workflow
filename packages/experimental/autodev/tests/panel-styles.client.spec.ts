import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/AutoDevPanel.module.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^{}]*)}`).exec(css)
  if (match === null) throw new Error(`AutoDevPanel.module.css has no \`${selector}\` rule`)
  return match[1] ?? ''
}

describe('AutoDevPanel DSH styling', () => {
  it('uses DSH theme tokens and the platform content font axis', () => {
    const root = rule('.root')
    expect(root).toContain('var(--dsw-alias-label-primary')
    expect(root).toContain('var(--dsw-alias-bg-base')
    expect(root).toContain('var(--dsw-font-family')
    expect(root).toContain('var(--dsh-content-font-size')
  })

  it('keeps the task form responsive and gives keyboard focus a visible theme outline', () => {
    expect(rule('.formGrid')).toContain('grid-template-columns: minmax(0, 1.7fr) minmax(180px, 0.7fr)')
    expect(css).toContain('@media (max-width: 760px)')
    expect(rule('.root button:focus-visible')).toContain('var(--dsw-alias-state-business-primary')
    expect(css).toContain(".root input:not([type='checkbox']):not([type='radio']):focus")
    expect(css).toContain('box-shadow: 0 0 0 3px')
  })

  it('visually distinguishes destructive cleanup confirmation from standard actions', () => {
    expect(rule('.dangerButton')).toContain('var(--dsw-alias-state-error-primary')
    expect(rule('.root [data-autodev-cleanup-confirmation]')).toContain('var(--dsw-alias-state-error-secondary')
  })
})
