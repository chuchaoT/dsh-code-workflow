/** Deterministic Evidence -> Verification evaluation. */

import type {
  Evidence,
  EvidenceStatus,
  EvidenceType,
  PlanVersion,
  Run,
  VerificationCheck,
  VerificationResult,
} from './contracts.ts'

export interface VerificationEvaluation {
  readonly status: EvidenceStatus
  readonly results: readonly Omit<VerificationResult, 'id' | 'createdAt'>[]
  readonly summary: string
}

export function defaultVerificationChecks(run: Run, plan: PlanVersion, createdAt: string): readonly VerificationCheck[] {
  return [
    {
      id: `${run.id}:${plan.id}:baseline`, runId: run.id, planId: plan.id, kind: 'baseline',
      evidenceType: 'REPOSITORY_BASELINE', required: true,
      description: 'A clean repository baseline must be captured before execution', createdAt,
    },
    {
      id: `${run.id}:${plan.id}:build`, runId: run.id, planId: plan.id, kind: 'build',
      evidenceType: 'BUILD', required: true,
      description: 'The candidate must pass the deterministic build command', createdAt,
    },
    {
      id: `${run.id}:${plan.id}:test`, runId: run.id, planId: plan.id, kind: 'test',
      evidenceType: 'TEST', required: true,
      description: 'The candidate must pass the deterministic test command', createdAt,
    },
    {
      id: `${run.id}:${plan.id}:review`, runId: run.id, planId: plan.id, kind: 'review',
      evidenceType: 'REVIEW', required: true,
      description: 'Quality/review Evidence must be a PASS before completion', createdAt,
    },
    {
      id: `${run.id}:${plan.id}:side-effect`, runId: run.id, planId: plan.id, kind: 'side-effect',
      evidenceType: 'SIDE_EFFECT', required: true,
      description: 'Every external or workspace side effect must have a known PASS outcome before completion', createdAt,
    },
  ]
}

export function evaluateVerification(
  checks: readonly VerificationCheck[],
  evidence: readonly Evidence[],
  _now: string,
  candidateId?: string,
): VerificationEvaluation {
  const results = checks.map((check) => {
    const matching = evidence
      .filter(item => item.type === check.evidenceType)
      .filter(item => check.kind === 'baseline' || candidateId === undefined || item.candidateId === candidateId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    const latest = matching.at(-1)
    if (latest === undefined) {
      return {
        runId: check.runId,
        checkId: check.id,
        status: 'UNKNOWN' as const,
        evidenceIds: [],
        reason: `no ${check.evidenceType} Evidence was recorded`,
      }
    }
    return {
      runId: check.runId,
      checkId: check.id,
      status: latest.status,
      evidenceIds: matching.map(item => item.id),
      reason: latest.status === 'PASS'
        ? `${check.evidenceType} Evidence ${latest.id} satisfies the check`
        : `${check.evidenceType} Evidence ${latest.id} is ${latest.status}`,
    }
  })
  const requiredResults = results.filter(result => checks.find(check => check.id === result.checkId)?.required === true)
  const status: EvidenceStatus = requiredResults.some(result => result.status === 'FAIL')
    ? 'FAIL'
    : requiredResults.some(result => result.status === 'UNKNOWN')
      ? 'UNKNOWN'
      : requiredResults.some(result => result.status === 'WARN')
        ? 'WARN'
        : 'PASS'
  return {
    status,
    results,
    summary: status === 'PASS'
      ? `all ${requiredResults.length} required verification checks passed`
      : `${requiredResults.filter(result => result.status !== 'PASS').length} required verification check(s) are ${status}`,
  }
}

/** Keep the public type useful to callers that need to build custom checks. */
export type VerificationEvidenceType = EvidenceType
