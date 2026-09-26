import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inject, name } from '../src/index.ts'

interface PackageMetadata {
  readonly files?: readonly string[]
}

describe('AutoDev package metadata', () => {
  it('waits for the DSH SubagentRuntime before capturing its provider registry', () => {
    expect(name).toBe('autodev')
    expect(inject).toContain('tools')
    expect(inject).toContain('subagents')
  })

  it('includes hashed root-level router chunks without a broad lib glob', () => {
    const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageMetadata
    expect(metadata.files).toContain('lib/router-*.js')
    expect(metadata.files).not.toContain('lib/*.js')
  })
})
