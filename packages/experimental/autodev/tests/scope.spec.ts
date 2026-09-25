import { describe, expect, it } from 'vitest'
import type { ScopeRef } from '../src/contracts.ts'
import { normalizeScope, sameScope, scopeApplies, scopeIdentity, scopeSpecificity } from '../src/scope.ts'

describe('AutoDev ScopeRef matching', () => {
  it('normalizes all supported dimensions and rejects empty values', () => {
    const normalized = normalizeScope({
      projectKey: ' project-a ', module: ' web ', branch: ' main ', language: ' TypeScript ',
      projectVersion: ' 2 ', schemaVersion: ' 4 ', techStackVersion: ' node-22 ',
    })
    expect(normalized).toEqual({
      projectKey: 'project-a', module: 'web', branch: 'main', language: 'TypeScript',
      projectVersion: '2', schemaVersion: '4', techStackVersion: 'node-22',
    })
    expect(normalizeScope({ projectKey: 'project-a' })).toEqual({ projectKey: 'project-a' })
    expect(() => normalizeScope({ projectKey: ' ' })).toThrow(/projectKey/)
    expect(() => normalizeScope({ projectKey: 'project-a', module: ' ' })).toThrow(/module/)
  })

  it('allows broad records and exact scopes but rejects project or dimension mismatches', () => {
    const web: ScopeRef = { projectKey: 'project-a', module: 'web', branch: 'main' }
    expect(scopeApplies('project-a', undefined)).toBe(true)
    expect(() => scopeApplies(' ', undefined)).toThrow(/projectKey/)
    expect(scopeApplies('project-a', { projectKey: 'project-a' })).toBe(true)
    expect(scopeApplies('project-a', web)).toBe(false)
    expect(scopeApplies({ projectKey: 'project-a', module: 'web', branch: 'main' }, web)).toBe(true)
    expect(scopeApplies({ projectKey: 'project-a', module: 'web', branch: 'dev' }, web)).toBe(false)
    expect(scopeApplies({ projectKey: 'project-a', module: 'api', branch: 'main' }, web)).toBe(false)
    expect(scopeApplies({ projectKey: 'project-b', module: 'web', branch: 'main' }, web)).toBe(false)
    expect(() => scopeApplies(' ', web)).toThrow(/projectKey/)
  })

  it.each([
    ['module', 'web'],
    ['branch', 'main'],
    ['language', 'typescript'],
    ['projectVersion', '2'],
    ['schemaVersion', '4'],
    ['techStackVersion', 'node-22'],
  ] as const)('requires an exact %s match for a specifically scoped record', (dimension, value) => {
    const recordScope: ScopeRef = { projectKey: 'project-a', [dimension]: value }
    const matchingScope: ScopeRef = { projectKey: 'project-a', [dimension]: value }
    const mismatchedScope: ScopeRef = { projectKey: 'project-a', [dimension]: `${value}-other` }

    expect(scopeApplies(matchingScope, recordScope)).toBe(true)
    expect(scopeApplies({ projectKey: 'project-a' }, recordScope)).toBe(false)
    expect(scopeApplies(mismatchedScope, recordScope)).toBe(false)
    expect(sameScope(recordScope, matchingScope)).toBe(true)
    expect(sameScope(recordScope, mismatchedScope)).toBe(false)
    expect(scopeIdentity(recordScope)).not.toBe(scopeIdentity(mismatchedScope))
  })

  it('compares exact partitions, ranks specificity and creates stable identity keys', () => {
    const broad: ScopeRef = { projectKey: 'project-a' }
    const sameWeb: ScopeRef = { projectKey: 'project-a', module: 'web' }
    expect(sameScope(broad, { projectKey: ' project-a ' })).toBe(true)
    expect(sameScope(broad, sameWeb)).toBe(false)
    expect(scopeSpecificity(undefined)).toBe(0)
    expect(scopeSpecificity(broad)).toBe(0)
    expect(scopeSpecificity({ ...sameWeb, branch: 'main', projectVersion: '2' })).toBe(3)
    expect(scopeIdentity({ ...sameWeb, branch: 'main' })).toBe(scopeIdentity({ projectKey: 'project-a', branch: 'main', module: 'web' }))
    expect(scopeIdentity(broad)).not.toBe(scopeIdentity(sameWeb))
  })
})
