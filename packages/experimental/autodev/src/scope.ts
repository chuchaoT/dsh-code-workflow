/** Scope matching helpers shared by AutoDev domain services and persistence. */

import type { ScopeRef } from './contracts.ts'

/** A non-project dimension that constrains where knowledge is applicable. */
export type ScopeDimension = 'module' | 'branch' | 'language' | 'projectVersion' | 'schemaVersion' | 'techStackVersion'

const DIMENSIONS: readonly ScopeDimension[] = ['module', 'branch', 'language', 'projectVersion', 'schemaVersion', 'techStackVersion']

/** A project key preserves legacy project-wide lookup; ScopeRef enables precise retrieval. */
export type ScopeQuery = string | ScopeRef

/**
 * Validate and canonicalize a project scope, omitting unspecified dimensions.
 * @param scope Candidate scope to normalize.
 * @returns A trimmed scope with only explicitly supplied dimensions.
 */
export function normalizeScope(scope: ScopeRef): ScopeRef {
  const normalized: { projectKey: string } & Partial<Record<ScopeDimension, string>> = {
    projectKey: requireText(scope.projectKey, 'projectKey'),
  }
  for (const dimension of DIMENSIONS) {
    const value = scope[dimension]
    if (value !== undefined) normalized[dimension] = requireText(value, dimension)
  }
  return normalized
}

/**
 * Return whether a record's scope is safe to use for a requested scope.
 * @param query Requested scope; a project key means project-wide context only.
 * @param candidate Record scope; an omitted scope represents a global record.
 * @returns Whether every constraint on the candidate is explicitly satisfied.
 */
export function scopeApplies(query: ScopeQuery, candidate?: ScopeRef): boolean {
  const requested = toScope(query)
  if (candidate === undefined) return true
  const available = normalizeScope(candidate)
  if (requested.projectKey !== available.projectKey) return false
  return DIMENSIONS.every(dimension => available[dimension] === undefined || requested[dimension] === available[dimension])
}

/**
 * Return true only when both scopes identify the same exact knowledge partition.
 * @param left First scope to compare.
 * @param right Second scope to compare.
 * @returns Whether all project and optional dimensions are equal.
 */
export function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  const a = normalizeScope(left)
  const b = normalizeScope(right)
  return a.projectKey === b.projectKey && DIMENSIONS.every(dimension => a[dimension] === b[dimension])
}

/**
 * Count constrained dimensions so more-specific applicable records can rank first.
 * @param scope Scope to measure; omitted scope is fully broad.
 * @returns Number of constrained non-project dimensions.
 */
export function scopeSpecificity(scope: ScopeRef | undefined): number {
  if (scope === undefined) return 0
  const normalized = normalizeScope(scope)
  return DIMENSIONS.reduce((count, dimension) => count + Number(normalized[dimension] !== undefined), 0)
}

/**
 * Stable partition key for compaction; records from different scopes never merge.
 * @param scope Scope whose stable partition key is requested.
 * @returns A deterministic key covering project and every supported dimension.
 */
export function scopeIdentity(scope: ScopeRef): string {
  const normalized = normalizeScope(scope)
  return JSON.stringify([normalized.projectKey, ...DIMENSIONS.map(dimension => normalized[dimension] ?? null)])
}

function toScope(query: ScopeQuery): ScopeRef {
  return normalizeScope(typeof query === 'string' ? { projectKey: query } : query)
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`)
  return value.trim()
}
