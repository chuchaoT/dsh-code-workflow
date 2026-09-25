/** Deterministic Evidence -> Verification evaluation. */

import type {
  CandidateRevision,
  Evidence,
  EvidenceStatus,
  EvidenceType,
  PlanVersion,
  Run,
  VerificationCheck,
  VerificationResult,
} from './contracts.ts'

/** Aggregated result produced from persisted Evidence and Runtime checks. */
export interface VerificationEvaluation {
  readonly status: EvidenceStatus
  readonly results: readonly Omit<VerificationResult, 'id' | 'createdAt'>[]
  readonly summary: string
}

/**
 * Create the required completion checks for one active Plan.
 *
 * @param run - Run that owns the verification checks.
 * @param plan - Active immutable Plan version.
 * @param createdAt - Timestamp shared by the generated checks.
 * @returns Mode-specific required checks, with original checks retained for legacy Plans.
 */
export function defaultVerificationChecks(run: Run, plan: PlanVersion, createdAt: string): readonly VerificationCheck[] {
  const buildNodeId = plan.nodes.find(node => node.kind === 'build')?.id
  const testNodeId = plan.nodes.find(node => node.kind === 'test')?.id
  const legacyPlan = plan.mode === undefined && run.mode === undefined
  const checks: VerificationCheck[] = [
    {
      id: `${run.id}:${plan.id}:baseline`, runId: run.id, planId: plan.id, kind: 'baseline',
      evidenceType: 'REPOSITORY_BASELINE', required: true,
      description: 'A clean repository baseline must be captured before execution', createdAt,
    },
  ]
  if (buildNodeId !== undefined || legacyPlan) checks.push({
    id: `${run.id}:${plan.id}:build`, runId: run.id, planId: plan.id, kind: 'build',
    ...(buildNodeId === undefined ? {} : { nodeId: buildNodeId }),
    evidenceType: 'BUILD', required: true,
    description: 'The candidate must pass the deterministic build command', createdAt,
  })
  if (testNodeId !== undefined || legacyPlan) checks.push({
    id: `${run.id}:${plan.id}:test`, runId: run.id, planId: plan.id, kind: 'test',
    ...(testNodeId === undefined ? {} : { nodeId: testNodeId }),
    evidenceType: 'TEST', required: true,
    description: 'The candidate must pass the deterministic test command', createdAt,
  })
  if (plan.mode === 'EXPLORE' || plan.mode === 'IMPACT' || plan.mode === 'RELEASE') {
    checks.push({
      id: `${run.id}:${plan.id}:analysis`, runId: run.id, planId: plan.id,
      ...(plan.nodes[0] === undefined ? {} : { nodeId: plan.nodes[0].id }), kind: 'analysis', evidenceType: 'ANALYSIS', required: true,
      description: 'The requested read-only analysis must be captured by the Agent Protocol', createdAt,
    })
  } else {
    const reviewNodeId = plan.nodes.find(node => node.kind === 'review')?.id
    checks.push({
      id: `${run.id}:${plan.id}:review`, runId: run.id, planId: plan.id,
      ...(reviewNodeId === undefined ? {} : { nodeId: reviewNodeId }), kind: 'review',
      evidenceType: 'REVIEW', required: true,
      description: 'A structured review or trusted Jev quality review must pass', createdAt,
    })
  }
  checks.push(
    {
      id: `${run.id}:${plan.id}:side-effect`, runId: run.id, planId: plan.id, kind: 'side-effect',
      evidenceType: 'SIDE_EFFECT', required: true,
      description: 'Every external or workspace side effect must have a known PASS outcome before completion', createdAt,
    },
  )
  return checks
}

/**
 * Evaluate checks using only Evidence from the check's Run and Plan.
 *
 * Build, Test and Review Evidence must match the active Candidate's Git tree hash. Other non-baseline Evidence must
 * belong to that Candidate. Baseline Evidence is Run-scoped and may omit a Plan id because Runtime captures it before
 * executing the Plan.
 *
 * @param checks - Runtime-owned acceptance checks.
 * @param evidence - Persisted Evidence available to the Run.
 * @param candidate - Candidate whose output is being verified, if one exists.
 * @returns Check results and an aggregate status; unmatched required checks remain UNKNOWN.
 */
export function evaluateVerification(
  checks: readonly VerificationCheck[],
  evidence: readonly Evidence[],
  candidate?: Pick<CandidateRevision, 'id' | 'runId' | 'planId' | 'gitTreeHash' | 'attempt'>,
): VerificationEvaluation {
  const results = checks.map((check) => {
    const matching = evidence
      .filter(item => item.runId === check.runId && item.type === check.evidenceType)
      .filter((item) => {
        if (check.kind === 'baseline') return item.planId === undefined || item.planId === check.planId
        if (item.planId !== check.planId) return false
        if (candidate === undefined) {
          return item.candidateId === undefined && (item.attempt === undefined || item.attempt > 0)
        }
        if (candidate.runId !== check.runId || candidate.planId !== check.planId) return false
        if (item.candidateId !== candidate.id || item.planId !== check.planId) return false
        if (candidate.attempt !== undefined && item.attempt !== candidate.attempt) return false
        if (check.nodeId !== undefined && item.nodeId !== check.nodeId) return false
        if (check.kind === 'build' || check.kind === 'test' || check.kind === 'review') {
          return item.gitTreeHash === candidate.gitTreeHash
        }
        return true
      })
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
