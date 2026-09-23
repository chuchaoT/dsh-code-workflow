/** Public, JSON-safe AutoDev contracts. The Host owns the authoritative copies. */

import type { AgentContext, AgentSignalInput, AgentTask } from './protocol.ts'

export const AUTODEV_SCHEMA_VERSION = 1 as const

export type RunStatus =
  | 'DRAFT'
  | 'READY'
  | 'EXECUTING'
  | 'BUILDING'
  | 'TESTING'
  | 'VERIFY'
  | 'PROMOTING'
  | 'PROMOTED'
  | 'PAUSED'
  | 'NEEDS_INTERVENTION'
  | 'FAILED'
  | 'CANCELLED'
  | 'ABANDONED'
  | 'REWORK_REQUESTED'

export type NodeStatus = 'PENDING' | 'READY' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN' | 'BLOCKED'

export type EvidenceStatus = 'PASS' | 'FAIL' | 'WARN' | 'UNKNOWN'

export type EvidenceType =
  | 'REPOSITORY_BASELINE'
  | 'AGENT_OUTPUT'
  | 'DIFF'
  | 'BUILD'
  | 'TEST'
  | 'REVIEW'
  | 'JEV_DECISION'
  | 'DRIFT'
  | 'PROMOTION'
  | 'ENVIRONMENT'
  | 'VERIFICATION'
  | 'SIDE_EFFECT'
  | 'MEMORY'
  | 'CONCEPT'
  | 'PLAYBOOK'
  | 'KNOWLEDGE'

export type DecisionPurpose = 'agent-route' | 'failure-action' | 'quality' | 'completion'

export type JevMode = 'required' | 'advisory' | 'off'

export type RouteKind = 'subagent' | 'command' | 'model'

export interface ProviderInfo {
  readonly name: string
  readonly kind: RouteKind
  readonly available: boolean
  readonly traits: readonly string[]
}

export type FailureAction = 'retry_same' | 'rework' | 'replan' | 'human' | 'stop'

export interface RouteCandidate {
  readonly kind: RouteKind
  readonly provider: string
  readonly model?: string
  readonly enabled?: boolean
  readonly traits?: readonly string[]
}

export interface RoutePolicy {
  readonly candidates: readonly RouteCandidate[]
  readonly requiredTaskTraits?: readonly string[]
  readonly minConfidence?: number
}

export interface ProviderCatalog {
  readonly providers: readonly ProviderInfo[]
  readonly routes: Readonly<Record<string, RoutePolicy>>
}

export interface AutoDevConfig {
  readonly dataRoot?: string
  readonly worktreeRoot?: string
  readonly maxAttempts?: number
  readonly commandTimeoutMs?: number
  readonly buildTimeoutMs?: number
  readonly testTimeoutMs?: number
  readonly qualityMinScore?: number
  readonly jev?: JevConfig
  readonly routes?: Readonly<Record<string, RoutePolicy>>
  readonly maven?: MavenConfig
}

export interface JevConfig {
  readonly mode?: JevMode
  readonly endpoint?: string
  readonly model?: string
  readonly apiKeyEnv?: string
  readonly timeoutMs?: number
  readonly retryCount?: number
  readonly minConfidence?: Partial<Record<DecisionPurpose, number>>
  readonly questionSetVersion?: string
  readonly sendPaths?: boolean
}

export interface MavenConfig {
  readonly buildArgs?: readonly string[]
  readonly testArgs?: readonly string[]
  readonly executable?: string
}

export interface RepositoryBaseline {
  readonly repoPath: string
  readonly repoRoot: string
  readonly baseCommit: string
  readonly clean: boolean
  readonly status: readonly string[]
  readonly capturedAt: string
}

export interface Run {
  readonly schemaVersion: typeof AUTODEV_SCHEMA_VERSION
  readonly id: string
  readonly repoPath: string
  readonly request: string
  readonly acceptanceCriteria: readonly string[]
  readonly status: RunStatus
  readonly baseCommit: string
  readonly repoRoot: string
  /** Stable project scope; defaults to the normalized repository root. */
  readonly projectKey?: string
  /** Optional link to Harness GoalService; Run remains the execution aggregate. */
  readonly goalId?: string
  readonly worktreePath?: string | undefined
  readonly activePlanId?: string | undefined
  readonly candidateId?: string | undefined
  readonly lastError?: string | undefined
  readonly currentGateId?: string | undefined
  readonly attempt: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly assumptionIds?: readonly string[]
  readonly conceptIds?: readonly string[]
  readonly playbookIds?: readonly string[]
}

export interface PlanNode {
  readonly id: string
  readonly kind: 'implement' | 'build' | 'test' | 'review'
  readonly description: string
  readonly dependencies: readonly string[]
  readonly expectedOutputs: readonly string[]
  readonly routeName?: string
}

export interface PlanVersion {
  readonly schemaVersion: typeof AUTODEV_SCHEMA_VERSION
  readonly id: string
  readonly runId: string
  readonly version: number
  readonly parentId?: string
  readonly status: 'ACTIVE' | 'SUPERSEDED' | 'CANCELLED'
  readonly fingerprint: string
  readonly nodes: readonly PlanNode[]
  readonly createdAt: string
  readonly assumptionIds?: readonly string[]
  readonly conceptIds?: readonly string[]
  readonly playbookIds?: readonly string[]
}

export interface NodeExecution {
  readonly id: string
  readonly runId: string
  readonly planId: string
  readonly nodeId: string
  readonly attempt: number
  readonly status: NodeStatus
  readonly provider?: string
  readonly inputTree?: string
  readonly outputTree?: string
  readonly startedAt?: string
  readonly endedAt?: string
  readonly error?: string
}

export interface CandidateRevision {
  readonly id: string
  readonly runId: string
  readonly planId: string
  readonly worktreePath: string
  readonly baseCommit: string
  readonly gitTreeHash: string
  readonly diffArtifactId?: string
  readonly createdAt: string
}

export interface EnvironmentFingerprint {
  readonly platform: string
  readonly arch: string
  readonly node: string
  readonly git?: string
  readonly java?: string
  readonly maven?: string
  readonly buildArgs?: readonly string[]
  readonly testArgs?: readonly string[]
  readonly harness?: string
  readonly capturedAt: string
}

export interface Evidence {
  readonly id: string
  readonly runId: string
  readonly candidateId?: string | undefined
  readonly gitTreeHash?: string
  readonly type: EvidenceType
  readonly status: EvidenceStatus
  readonly summary: string
  readonly artifactId?: string
  readonly environment?: EnvironmentFingerprint
  readonly planId?: string
  readonly nodeId?: string
  readonly source?: 'runtime' | 'command' | 'agent' | 'human' | 'jev' | 'system'
  readonly parentEvidenceIds?: readonly string[]
  readonly createdAt: string
}

export type MemoryKind = 'fact' | 'rule' | 'experience' | 'hypothesis'
export type KnowledgeStatus = 'OBSERVED' | 'CANDIDATE' | 'ESTABLISHED' | 'DEPRECATED'

export interface ScopeRef {
  readonly projectKey: string
  readonly module?: string
  readonly branch?: string
  readonly language?: string
  readonly projectVersion?: string
  readonly schemaVersion?: string
  readonly techStackVersion?: string
}

export interface ProvenanceRef {
  readonly sourceType: 'run' | 'evidence' | 'signal' | 'human' | 'playbook' | 'concept' | 'system'
  readonly sourceId: string
  readonly runId?: string
  readonly evidenceIds?: readonly string[]
  readonly note?: string
}

export interface ProjectMemory {
  readonly id: string
  readonly scope: ScopeRef
  readonly kind: MemoryKind
  readonly title: string
  readonly content: string
  readonly tags: readonly string[]
  readonly status: KnowledgeStatus
  readonly confidence: number
  readonly provenance: readonly ProvenanceRef[]
  readonly evidenceIds: readonly string[]
  readonly version: number
  readonly supersedesId?: string
  readonly expiresAt?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface MemorySearchHit {
  readonly memory: ProjectMemory
  readonly score: number
  readonly reason: string
}

export type AssumptionStatus = 'PROPOSED' | 'CONFIRMED' | 'INVALIDATED' | 'UNKNOWN'

export interface Assumption {
  readonly id: string
  readonly scope: ScopeRef
  readonly runId?: string
  readonly planId?: string
  readonly statement: string
  readonly rationale?: string
  readonly status: AssumptionStatus
  readonly confidence: number
  readonly provenance: readonly ProvenanceRef[]
  readonly evidenceIds: readonly string[]
  readonly resolution?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export type SemanticUncertaintyStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED'

export interface SemanticUncertainty {
  readonly id: string
  readonly scope: ScopeRef
  readonly runId: string
  readonly subject: string
  readonly reason: string
  readonly alternatives: readonly string[]
  readonly severity: 'low' | 'medium' | 'high'
  readonly status: SemanticUncertaintyStatus
  readonly provenance: readonly ProvenanceRef[]
  readonly resolution?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export type ConceptStatus = 'CANDIDATE' | 'ESTABLISHED' | 'DEPRECATED'

export interface BusinessConcept {
  readonly id: string
  readonly scope: ScopeRef
  readonly key: string
  readonly name: string
  readonly definition: string
  readonly target: string
  readonly effect: string
  readonly evidenceCriteria: readonly string[]
  readonly status: ConceptStatus
  readonly confidence: number
  readonly version: number
  readonly provenance: readonly ProvenanceRef[]
  readonly evidenceIds: readonly string[]
  readonly relatedConceptIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ConceptObservation {
  readonly id: string
  readonly scope: ScopeRef
  readonly conceptId?: string
  readonly key: string
  readonly target: string
  readonly effect: string
  readonly evidenceSummary: string
  readonly evidenceIds: readonly string[]
  readonly provenance: readonly ProvenanceRef[]
  readonly confidence: number
  readonly createdAt: string
}

export type PlaybookStatus = 'DRAFT' | 'ACTIVE' | 'DEPRECATED'
export type PlaybookFitOutcome = 'MATCH' | 'PARTIAL' | 'MISMATCH'

export interface Playbook {
  readonly id: string
  readonly scope?: ScopeRef
  readonly key: string
  readonly name: string
  readonly purpose: string
  readonly targets: readonly string[]
  readonly effects: readonly string[]
  readonly conceptKeys: readonly string[]
  readonly exclusions?: readonly string[]
  readonly steps: readonly string[]
  readonly requiredEvidence: readonly EvidenceType[]
  readonly status: PlaybookStatus
  readonly confidence: number
  readonly version: number
  readonly provenance: readonly ProvenanceRef[]
  readonly supportingEvidenceIds?: readonly string[]
  readonly parentId?: string
  readonly supersededBy?: string
  readonly createdFromRunIds?: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PlaybookFit {
  readonly id: string
  readonly runId?: string
  readonly playbookId: string
  readonly playbookVersion: number
  readonly outcome: PlaybookFitOutcome
  readonly matched: readonly string[]
  readonly missing: readonly string[]
  readonly reasons: readonly string[]
  readonly createdAt: string
}

export type KnowledgeKind = 'fact' | 'rule' | 'experience' | 'hypothesis'

export interface KnowledgeCandidate {
  readonly id: string
  readonly scope: ScopeRef
  readonly kind: KnowledgeKind
  readonly statement: string
  readonly content: string
  readonly status: KnowledgeStatus
  readonly confidence: number
  readonly version: number
  readonly provenance: readonly ProvenanceRef[]
  readonly evidenceIds: readonly string[]
  readonly relatedMemoryIds: readonly string[]
  readonly usageCount?: number
  readonly successCount?: number
  readonly failureCount?: number
  readonly lastUsedAt?: string
  readonly lastValidatedAt?: string
  readonly expiresAt?: string
  readonly supersededBy?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface KnowledgeCompactionReport {
  readonly id: string
  readonly scope: ScopeRef
  readonly inputIds: readonly string[]
  readonly outputIds: readonly string[]
  readonly actions: readonly { readonly kind: 'deduplicated' | 'merged' | 'deprecated' | 'archived'; readonly inputIds: readonly string[]; readonly outputId?: string }[]
  readonly createdAt: string
}

export interface KnowledgeRegressionCase {
  readonly id: string
  readonly scope: ScopeRef
  readonly name: string
  readonly input: string
  readonly expectedStatements: readonly string[]
  readonly createdAt: string
}

export interface KnowledgeRegressionResult {
  readonly id: string
  readonly caseId: string
  readonly status: 'PASS' | 'FAIL' | 'UNKNOWN'
  readonly matched: readonly string[]
  readonly missing: readonly string[]
  readonly unexpected: readonly string[]
  readonly createdAt: string
}

export type ActionIntentKind = 'agent-workspace' | 'command' | 'git-promotion' | 'memory-write' | 'knowledge-promotion'
export type ActionRisk = 'low' | 'medium' | 'high' | 'destructive'
export type ActionIntentStatus = 'PLANNED' | 'AUTHORIZED' | 'EXECUTING' | 'COMMITTED' | 'FAILED' | 'UNKNOWN' | 'COMPENSATED' | 'REJECTED'

export interface ActionIntent {
  readonly id: string
  readonly runId: string
  readonly nodeId?: string
  readonly kind: ActionIntentKind
  readonly target: string
  readonly risk: ActionRisk
  readonly idempotencyKey: string
  readonly preconditions: readonly string[]
  readonly authorization?: string
  readonly status: ActionIntentStatus
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SideEffectRecord {
  readonly id: string
  readonly runId: string
  readonly intentId: string
  readonly status: ActionIntentStatus
  readonly summary: string
  readonly beforeFingerprint?: string
  readonly afterFingerprint?: string
  readonly evidenceIds: readonly string[]
  readonly createdAt: string
}

export type VerificationCheckKind = 'baseline' | 'build' | 'test' | 'review' | 'side-effect'

/** A deterministic acceptance condition owned by the Runtime, not by an Agent. */
export interface VerificationCheck {
  readonly id: string
  readonly runId: string
  readonly planId: string
  readonly kind: VerificationCheckKind
  readonly evidenceType: EvidenceType
  readonly required: boolean
  readonly description: string
  readonly createdAt: string
}

/** The result of evaluating one check against the latest available Evidence. */
export interface VerificationResult {
  readonly id: string
  readonly runId: string
  readonly checkId: string
  readonly status: EvidenceStatus
  readonly evidenceIds: readonly string[]
  readonly reason: string
  readonly createdAt: string
}

/** Aggregate verification is the only Runtime-owned input to completion. */
export interface VerificationReport {
  readonly id: string
  readonly runId: string
  readonly candidateId?: string
  readonly status: EvidenceStatus
  readonly requiredCheckIds: readonly string[]
  readonly resultIds: readonly string[]
  readonly summary: string
  readonly createdAt: string
}

export interface RouteDecision {
  readonly id: string
  readonly runId?: string
  readonly nodeId?: string
  readonly policyVersion: string
  readonly purpose: DecisionPurpose
  readonly candidates: readonly RouteCandidate[]
  readonly eligible: readonly RouteCandidate[]
  readonly selected?: RouteCandidate
  readonly confidence?: number
  readonly reason: string
  readonly rejections: readonly { provider: string; reason: string }[]
  readonly createdAt: string
}

export interface JevDecision {
  readonly id: string
  readonly runId?: string
  readonly purpose: DecisionPurpose
  readonly stateHash: string
  readonly questionSetVersion: string
  readonly source: 'jev' | 'static' | 'fallback'
  readonly modelVersion: string
  readonly answer: readonly DecisionAnswer[]
  readonly probability?: number
  readonly confidence?: number
  readonly policyOutcome: 'accepted' | 'rejected' | 'degraded' | 'paused'
  readonly reason: string
  readonly createdAt: string
}

export interface HumanGate {
  readonly id: string
  readonly runId: string
  readonly reason: string
  readonly options: readonly ('retry' | 'rework' | 'replan' | 'abandon' | 'promote' | 'cancel')[]
  readonly status: 'OPEN' | 'RESOLVED'
  readonly selected?: string
  readonly createdAt: string
  readonly resolvedAt?: string
}

export interface ArtifactRef {
  readonly id: string
  readonly runId: string
  readonly kind: string
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly createdAt: string
}

/** A bounded, path-free view of an artifact that is safe to send to Web Client. */
export interface ArtifactContent {
  readonly id: string
  readonly runId: string
  readonly kind: string
  readonly sha256: string
  readonly bytes: number
  readonly content: string
  readonly truncated: boolean
}

export interface AutoDevSnapshot {
  readonly run: Run
  readonly plan?: PlanVersion
  readonly nodes: readonly NodeExecution[]
  readonly candidate?: CandidateRevision
  readonly evidence: readonly Evidence[]
  readonly decisions: readonly (RouteDecision | JevDecision)[]
  readonly gates: readonly HumanGate[]
  readonly signals: readonly import('./protocol.ts').AgentSignalEnvelope[]
  readonly verificationChecks: readonly VerificationCheck[]
  readonly verificationResults: readonly VerificationResult[]
  readonly verifications: readonly VerificationReport[]
  readonly memories: readonly ProjectMemory[]
  readonly assumptions: readonly Assumption[]
  readonly uncertainties: readonly SemanticUncertainty[]
  readonly concepts: readonly BusinessConcept[]
  readonly playbooks: readonly Playbook[]
  readonly playbookFits: readonly PlaybookFit[]
  readonly knowledge: readonly KnowledgeCandidate[]
  readonly compactions: readonly KnowledgeCompactionReport[]
  readonly regressionResults: readonly KnowledgeRegressionResult[]
  readonly actionIntents: readonly ActionIntent[]
  readonly sideEffects: readonly SideEffectRecord[]
}

export interface CreateRunRequest {
  readonly repoPath: string
  readonly request: string
  readonly acceptanceCriteria?: readonly string[]
  readonly goalId?: string
}

export interface ProviderRunRequest {
  readonly provider: string
  readonly model?: string
  readonly request: string
  readonly acceptanceCriteria: readonly string[]
  readonly cwd: string
  readonly signal: AbortSignal
  readonly parentAgent?: unknown
  readonly task?: AgentTask
  readonly context?: AgentContext
  readonly emitSignal?: (signal: AgentSignalInput) => void
}

export interface ProviderRunResult {
  readonly provider: string
  readonly status: 'completed' | 'error' | 'aborted'
  readonly output: string
  readonly diagnostic?: string
  readonly signals?: readonly AgentSignalInput[]
}

export interface DecisionRequest {
  readonly purpose: DecisionPurpose
  readonly state: unknown
  readonly questions: readonly JevQuestion[]
  readonly signal: AbortSignal
}

export interface JevQuestion {
  readonly id: string
  readonly type: 'choice' | 'score' | 'noul'
  readonly text: string
  readonly choices?: readonly string[]
  readonly min?: number
  readonly max?: number
}

export interface DecisionAnswer {
  readonly questionId: string
  readonly kind: 'choice' | 'score' | 'noul'
  readonly value?: string | number | boolean | null
  readonly probability?: number
}

export interface DecisionResult {
  readonly source: 'jev' | 'static' | 'fallback'
  readonly modelVersion: string
  readonly answers: readonly DecisionAnswer[]
  readonly raw?: unknown
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
}
