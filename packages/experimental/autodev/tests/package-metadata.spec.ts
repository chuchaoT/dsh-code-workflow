import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface PackageMetadata {
  readonly files?: readonly string[]
}

describe('AutoDev package metadata', () => {
  it('includes root-level emitted JavaScript chunks in the published package', () => {
    const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageMetadata
    expect(metadata.files).toContain('lib/*.js')
  })
})
