/** Public, JSON-safe AutoDev contracts. The Host owns the authoritative copies. */

import type { AutoDevAgentContext, AgentSignalInput, AgentTask } from './protocol.ts'

/** Current version tag for durable AutoDev Run records. */
export const AUTODEV_SCHEMA_VERSION = 1 as const

/** Lifecycle states that describe a Run from planning through closure. */
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

/** Execution states for one Plan node attempt. */
export type NodeStatus = 'PENDING' | 'READY' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN' | 'BLOCKED'

/** Bounded live Agent text/activity snapshot shown in the Run UI, not Evidence. */
export interface AgentProgressSnapshot {
  readonly status: 'STREAMING' | 'COMPLETE' | 'PARTIAL'
  readonly text: string
  readonly activity?: 'working' | 'tool-started' | 'tool-completed'
  readonly updatedAt: string
  readonly truncated?: boolean
}

/** Verification outcome recorded for an Evidence item. */
export type EvidenceStatus = 'PASS' | 'FAIL' | 'WARN' | 'UNKNOWN'

/** Evidence categories that can contribute to Run verification. */
export type EvidenceType =
  | 'REPOSITORY_BASELINE'
  | 'PLAN_APPROVAL'
  | 'AGENT_OUTPUT'
  | 'AGENT_CONTEXT'
  | 'DIFF'
  | 'BUILD'
  | 'TEST'
  | 'REVIEW'
  | 'ANALYSIS'
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

/** Bounded decision categories used by the Runtime policy. */
export type DecisionPurpose = 'intent' | 'agent-route' | 'failure-action' | 'quality' | 'completion'

/** Source which produced a validated decision. */
export type DecisionSource = 'jev' | 'local-model' | 'subagent' | 'static' | 'fallback'

/** Policy for handling Jev availability and confidence. */
export type JevMode = 'required' | 'advisory' | 'off'

/** Trusted Host-side initiator label; it never contains a human account claim. */
export type AutoDevAuditActor =
  | { readonly kind: 'dsh-operator'; readonly source: 'dsh-gateway'; readonly connectionPeerId?: string }
  | { readonly kind: 'autodev-runtime'; readonly source: 'runtime-policy' }
  | { readonly kind: 'host-internal'; readonly source: 'direct-host-call' }

/** Path-free append-only record for an authorization or controlled decision. */
export interface AutoDevAuditEvent {
  readonly id: string
  readonly runId: string
  readonly action: 'plan-approved' | 'gate-resolved' | 'action-authorized' | 'action-result' | 'cleanup-prepared' | 'cleanup-confirmed' | 'cleanup-cancelled'
  readonly actor: AutoDevAuditActor
  readonly resourceKind: 'run' | 'gate' | 'action-intent' | 'cleanup-job'
  readonly resourceId: string
  readonly result: 'APPROVED' | 'AUTHORIZED' | 'COMMITTED' | 'FAILED' | 'UNKNOWN' | 'REJECTED' | 'RESOLVED' | 'PREPARED' | 'CONFIRMED' | 'CANCELLED'
  readonly risk?: ActionRisk
  readonly createdAt: string
}

/** Execution mechanism used by a Provider route candidate. */
export type RouteKind = 'subagent' | 'command' | 'model'

/** Current availability and capabilities of a registered Provider. */
export interface ProviderInfo {
  readonly name: string
  readonly kind: RouteKind
  readonly available: boolean
  readonly traits: readonly string[]
}

/** Decision options for recovering from an execution failure. */
export type FailureAction = 'retry_same' | 'rework' | 'replan' | 'human' | 'stop'

/** Engineering intent selected for one AutoDev Run; it is distinct from workflow state. */
export type AutoDevMode = 'EXPLORE' | 'IMPACT' | 'DEV' | 'DEBUG' | 'DATABASE' | 'REFACTOR' | 'TEST' | 'REVIEW' | 'RELEASE'

/** How the Run's engineering intent was selected. */
export type AutoDevModeSource = 'explicit' | 'auto'

/** Repository starting point observed when a Run was created. */
export type RepositoryBaselineKind = 'commit' | 'unborn'

/** Execution location/security contract; MVP supports only Host-managed local Git Worktrees. */
export type ExecutionEnvironmentKind = 'LOCAL_WORKTREE'

/** Frozen execution boundary selected separately from the engineering work mode. */
export interface ExecutionEnvironmentSpec {
  readonly kind: ExecutionEnvironmentKind
}

/** One Provider choice considered by a named route. */
export interface RouteCandidate {
  /** Adapter category used to invoke the Provider. */
  readonly kind: RouteKind
  /** Registered Provider name. */
  readonly provider: string
  /** Optional model identifier passed to the adapter. */
  readonly model?: string
  /** Whether route selection may consider this candidate. */
  readonly enabled?: boolean
  /** Capabilities the candidate declares for task matching. */
  readonly traits?: readonly string[]
}

/** Selection policy and ordered candidates for one task route. */
export interface RoutePolicy {
  /** Providers eligible for this route, in preference order. */
  readonly candidates: readonly RouteCandidate[]
  /** Explicitly selected Provider. When set, selection fails closed instead of falling back. */
  readonly preferredProvider?: string
  /** Capabilities a task and candidate must both satisfy. */
  readonly requiredTaskTraits?: readonly string[]
  /** Minimum confidence required before Jev can select a candidate. */
  readonly minConfidence?: number
}

/** Detached Provider and route catalog returned to clients. */
export interface ProviderCatalog {
  readonly providers: readonly ProviderInfo[]
  readonly routes: Readonly<Record<string, RoutePolicy>>
}

/** Provider choices persisted for the active DSH Profile; this never contains credentials. */
export interface AutoDevProviderSettings {
  readonly decisionBackend: 'ollama' | 'jev' | 'configured'
  readonly ollamaEndpoint: string
  readonly ollamaModel: string
  readonly analysisProvider: string
  readonly engineeringProvider: string
}

/** Safe settings view returned to the Web client, including credential presence but not its value. */
export interface AutoDevProviderSettingsView extends AutoDevProviderSettings {
  readonly jevApiKeyEnv: string
  readonly jevCredentialConfigured: boolean
  readonly providers: readonly ProviderInfo[]
  readonly analysisProviders: readonly ProviderInfo[]
  readonly engineeringProviders: readonly ProviderInfo[]
  readonly activeRunCount: number
}

/** Bundle settings for storage, execution limits, decisions, and routing. */
export interface AutoDevConfig {
  /** Root directory for the SQLite database and run artifacts. */
  readonly dataRoot?: string
  /** Managed parent directory for Git Worktrees created by AutoDev. */
  readonly worktreeRoot?: string
  /** Maximum number of explicit implementation attempts for one Run. */
  readonly maxAttempts?: number
  /** Maximum duration of one Agent task before AutoDev requests cancellation (default: 5 minutes). */
  readonly agentTimeoutMs?: number
  /** Timeout for shell/CLI command operations. */
  readonly commandTimeoutMs?: number
  /** Timeout applied to Build driver execution. */
  readonly buildTimeoutMs?: number
  /** Timeout applied to Test driver execution. */
  readonly testTimeoutMs?: number
  /** Minimum Jev quality score accepted without an additional Gate. */
  readonly qualityMinScore?: number
  /** Jev endpoint, decision mode, confidence policy, and request limits. */
  readonly jev?: JevConfig
  /** Optional local-first decision chain; unlike `jev.mode`, this can run while Jev is disabled. */
  readonly decisions?: DecisionPipelineConfig
  /** Named Provider selection policies available to Runs. */
  readonly routes?: Readonly<Record<string, RoutePolicy>>
  /** Maven executable and argument overrides. */
  readonly maven?: MavenConfig
  /** Select a project driver explicitly (including for a greenfield Worktree), or auto-detect from root markers. */
  readonly buildDriver?: BuildDriverId | 'auto'
  /** Root-project command overrides for Maven, Gradle, Node, and pytest. */
  readonly drivers?: Partial<Record<BuildDriverId, DriverCommandSettings>>
}

/** Supported deterministic Build/Test driver identifiers. */
export type BuildDriverId = 'maven' | 'gradle' | 'node' | 'pytest'

/** Executable and argv overrides for one Build/Test driver. */
export interface DriverCommandSettings {
  /** Executable name or absolute path. */
  readonly executable?: string
  /** Arguments used for the Build stage. */
  readonly buildArgs?: readonly string[]
  /** Arguments used for the Test stage. */
  readonly testArgs?: readonly string[]
}

/** Jev transport, retry, confidence, and data-sharing settings. */
export interface JevConfig {
  /** Whether Jev is required, advisory, or disabled. */
  readonly mode?: JevMode
  /** HTTP endpoint used for Jev decision requests. */
  readonly endpoint?: string
  /** Jev model name sent with the request. */
  readonly model?: string
  /** Environment variable name that contains the API key. */
  readonly apiKeyEnv?: string
  /** Per-request time limit in milliseconds. */
  readonly timeoutMs?: number
  /** Number of bounded retries after a transient request failure. */
  readonly retryCount?: number
  /** Per-purpose confidence thresholds for accepting Jev answers. */
  readonly minConfidence?: Partial<Record<DecisionPurpose, number>>
  /** Version identifier for the decision question set. */
  readonly questionSetVersion?: string
  /** Whether repository paths may be included in Jev context. */
  readonly sendPaths?: boolean
}

/** Local-first decision chain, configured independently from remote Jev availability. */
export interface DecisionPipelineConfig {
  /** Required fails closed to a Human Gate; advisory permits only explicitly untrusted static fallback. */
  readonly mode?: JevMode
  /** Optional local Ollama provider. Presence enables it unless `enabled` is false. */
  readonly ollama?: {
    readonly enabled?: boolean
    /** Ollama `/api/chat` endpoint; defaults to the local service. */
    readonly endpoint?: string
    /** Installed Ollama model id. Defaults to `qwen3:8b-fast`. */
    readonly model?: string
    readonly timeoutMs?: number
  }
  /** Optional second-opinion DSH Subagent providers, tried in listed order. */
  readonly escalationSubagents?: readonly string[]
  /** Include the remote Jev HTTP adapter after local and Subagent providers. Defaults to false. */
  readonly useJev?: boolean
  /** Confidence thresholds shared by the ordered providers; model confidence is self-reported. */
  readonly minConfidence?: Partial<Record<DecisionPurpose, number>>
}

/** Maven-specific executable and argument overrides. */
export interface MavenConfig {
  /** Arguments used for the Maven Build stage. */
  readonly buildArgs?: readonly string[]
  /** Arguments used for the Maven Test stage. */
  readonly testArgs?: readonly string[]
  /** Maven executable name or absolute path. */
  readonly executable?: string
}

/** Git repository state captured when a Run is created. */
export interface RepositoryBaseline {
  readonly repoPath: string
  readonly repoRoot: string
  readonly baseCommit: string
  /** `unborn` means the baseline is a private synthetic commit; the original branch remains unborn. */
  readonly kind?: RepositoryBaselineKind
  readonly clean: boolean
  readonly status: readonly string[]
  readonly capturedAt: string
}

/** Durable aggregate for one software-engineering request. */
export interface Run {
  readonly schemaVersion: typeof AUTODEV_SCHEMA_VERSION
  readonly id: string
  readonly repoPath: string
  readonly request: string
  readonly acceptanceCriteria: readonly string[]
  readonly status: RunStatus
  readonly baseCommit: string
  /** Missing on legacy Runs, which are interpreted as DEV over a committed baseline. */
  readonly mode?: AutoDevMode
  readonly modeSource?: AutoDevModeSource
  /** Missing on legacy Runs; they execute in the Host-managed local Worktree. */
  readonly executionEnvironment?: ExecutionEnvironmentSpec
  /** Missing on legacy Runs, which are interpreted as ordinary committed repositories. */
  readonly baselineKind?: RepositoryBaselineKind
  readonly repoRoot: string
  /** Stable project scope; defaults to the normalized repository root. */
  readonly projectKey?: string
  /** Optional module/branch/language/version scope supplied when the Run is created. */
  readonly scope?: ScopeRef
  /** Optional link to Harness GoalService; Run remains the execution aggregate. */
  readonly goalId?: string
  readonly worktreePath?: string | undefined
  readonly activePlanId?: string | undefined
  /** Exact immutable Plan approved for execution; older Runs without it require review. */
  readonly approvedPlanId?: string
  readonly approvedPlanFingerprint?: string
  readonly planApprovedAt?: string
  /** Actor category for the latest explicit Plan approval; absent on legacy Runs. */
  readonly approvedBy?: AutoDevAuditActor
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

/** One ordered task node in an immutable Plan version. */
export interface PlanNode {
  readonly id: string
  readonly kind: 'implement' | 'build' | 'test' | 'review' | 'analyze' | 'impact' | 'release'
  readonly description: string
  readonly dependencies: readonly string[]
  readonly expectedOutputs: readonly string[]
  readonly routeName?: string
}

/** Immutable execution plan and its current lifecycle status. */
export interface PlanVersion {
  readonly schemaVersion: typeof AUTODEV_SCHEMA_VERSION
  readonly id: string
  readonly runId: string
  readonly version: number
  readonly parentId?: string
  readonly status: 'ACTIVE' | 'SUPERSEDED' | 'CANCELLED'
  readonly fingerprint: string
  /** Missing on legacy Plans; the owning Run's mode is authoritative. */
  readonly mode?: AutoDevMode
  readonly nodes: readonly PlanNode[]
  /** Deterministic build/test driver selected from the inspected project root. */
  readonly buildDriverId?: BuildDriverId
  readonly createdAt: string
  readonly assumptionIds?: readonly string[]
  readonly conceptIds?: readonly string[]
  readonly playbookIds?: readonly string[]
}

/** Recorded state for one Plan node and attempt. */
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
  /** Provider output for live observability only; never a verification result. */
  readonly agentProgress?: AgentProgressSnapshot
}

/** Sealed Worktree result eligible for review and promotion. */
export interface CandidateRevision {
  readonly id: string
  readonly runId: string
  readonly planId: string
  readonly worktreePath: string
  readonly baseCommit: string
  readonly gitTreeHash: string
  /** Attempt that produced this candidate; absent only on legacy records. */
  readonly attempt?: number
  readonly diffArtifactId?: string
  readonly createdAt: string
}

/** Path-free Candidate metadata that can be included in a browser snapshot. */
export interface CandidateRevisionSummary {
  readonly id: string
  readonly runId: string
  readonly planId: string
  readonly baseCommit: string
  readonly gitTreeHash: string
  readonly attempt?: number
  readonly diffAvailable: boolean
  readonly createdAt: string
}

/** Host and project facts captured for reproducible execution checks. */
export interface EnvironmentFingerprint {
  readonly platform: string
  readonly arch: string
  readonly node: string
  readonly buildDriverId?: BuildDriverId
  readonly git?: string
  readonly java?: string
  readonly maven?: string
  readonly buildArgs?: readonly string[]
  readonly testArgs?: readonly string[]
  readonly harness?: string
  readonly capturedAt: string
}

/** Durable result or observation used to justify a Run decision. */
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
  /** Execution attempt that produced this Evidence, when applicable. */
  readonly attempt?: number
  readonly source?: 'runtime' | 'command' | 'agent' | 'human' | 'jev' | 'local-model' | 'subagent' | 'system'
  /** Host-derived actor for an explicit approval; never supplied by a Client. */
  readonly actor?: AutoDevAuditActor
  readonly parentEvidenceIds?: readonly string[]
  /** Optional expiry for evidence whose validation is time-bound. */
  readonly expiresAt?: string
  readonly createdAt: string
}

/** Semantic category assigned to a project Memory item. */
export type MemoryKind = 'fact' | 'rule' | 'experience' | 'hypothesis'
/** Lifecycle state shared by project Memory and Knowledge records. */
export type KnowledgeStatus = 'OBSERVED' | 'CANDIDATE' | 'ESTABLISHED' | 'DEPRECATED'

/** Project identity plus optional dimensions that isolate knowledge. */
export interface ScopeRef {
  readonly projectKey: string
  readonly module?: string
  readonly branch?: string
  readonly language?: string
  readonly projectVersion?: string
  readonly schemaVersion?: string
  readonly techStackVersion?: string
}

/** Typed reference to a source event or domain record. */
export interface SourceReference {
  readonly sourceType: 'run' | 'evidence' | 'signal' | 'human' | 'playbook' | 'concept' | 'system'
  readonly sourceId: string
  readonly runId?: string
  readonly evidenceIds?: readonly string[]
  readonly note?: string
}

/** Durable project-scoped summary intended for progressive retrieval. */
export interface ProjectMemory {
  readonly id: string
  readonly scope: ScopeRef
  readonly kind: MemoryKind
  readonly title: string
  readonly content: string
  readonly tags: readonly string[]
  readonly status: KnowledgeStatus
  readonly confidence: number
  readonly sourceRefs: readonly SourceReference[]
  readonly evidenceIds: readonly string[]
  readonly version: number
  readonly supersedesId?: string
  readonly expiresAt?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** A ranked Memory summary and the reason it matched a query. */
export interface MemorySearchHit {
  readonly memory: ProjectMemory
  readonly score: number
  readonly reason: string
}

/** Resolution state for a proposed product or engineering assumption. */
export type AssumptionStatus = 'PROPOSED' | 'CONFIRMED' | 'INVALIDATED' | 'UNKNOWN'

/** Explicit assumption tied to a project scope and optional Run. */
export interface Assumption {
  readonly id: string
  readonly scope: ScopeRef
  readonly runId?: string
  readonly planId?: string
  readonly statement: string
  readonly rationale?: string
  readonly status: AssumptionStatus
  readonly confidence: number
  readonly sourceRefs: readonly SourceReference[]
  readonly evidenceIds: readonly string[]
  readonly resolution?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Resolution state for an ambiguous domain or implementation meaning. */
export type SemanticUncertaintyStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED'

/** Persisted ambiguity with its alternatives, severity, and resolution. */
export interface SemanticUncertainty {
  readonly id: string
  readonly scope: ScopeRef
  readonly runId: string
  readonly planId?: string
  readonly subject: string
  readonly reason: string
  readonly alternatives: readonly string[]
  readonly severity: 'low' | 'medium' | 'high'
  readonly status: SemanticUncertaintyStatus
  readonly sourceRefs: readonly SourceReference[]
  readonly resolution?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Confidence state for a Business Concept definition. */
export type ConceptStatus = 'CANDIDATE' | 'ESTABLISHED' | 'DEPRECATED'

/** Versioned domain concept with explicit Target and Effect semantics. */
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
  readonly sourceRefs: readonly SourceReference[]
  readonly evidenceIds: readonly string[]
  readonly relatedConceptIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** Historical observation or correction associated with a Concept. */
export interface ConceptObservation {
  readonly id: string
  readonly scope: ScopeRef
  readonly runId?: string
  readonly planId?: string
  readonly conceptId?: string
  readonly name?: string
  readonly definition?: string
  readonly key: string
  readonly target: string
  readonly effect: string
  readonly relationship?: 'SUPPORTING' | 'AMBIGUOUS' | 'HUMAN_CORRECTION'
  /** Monotonic version within one scoped concept key. */
  readonly version?: number
  readonly evidenceSummary: string
  readonly evidenceIds: readonly string[]
  readonly sourceRefs: readonly SourceReference[]
  readonly confidence: number
  readonly createdAt: string
}

/** Lifecycle state for an advisory Playbook. */
export type PlaybookStatus = 'DRAFT' | 'ACTIVE' | 'DEPRECATED'
/** Semantic fit result for applying a Playbook to a Run. */
export type PlaybookFitOutcome = 'MATCH' | 'PARTIAL' | 'MISMATCH'

/** Versioned, advisory steps and constraints for a recurring task. */
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
  readonly sourceRefs: readonly SourceReference[]
  readonly supportingEvidenceIds?: readonly string[]
  readonly parentId?: string
  readonly supersededBy?: string
  readonly createdFromRunIds?: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** Recorded result of checking a Playbook against a Run. */
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

/** Semantic kind of a durable Knowledge statement. */
export type KnowledgeKind = 'fact' | 'rule' | 'experience' | 'hypothesis'

/** Evidence-backed Knowledge candidate or established project record. */
export interface KnowledgeCandidate {
  readonly id: string
  readonly scope: ScopeRef
  readonly kind: KnowledgeKind
  readonly statement: string
  readonly content: string
  readonly status: KnowledgeStatus
  readonly confidence: number
  readonly version: number
  readonly sourceRefs: readonly SourceReference[]
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

/** Human-reviewable proposal to combine semantically similar Knowledge.
 * Proposals snapshot exact input versions and never mutate those inputs.
 */
export interface KnowledgeMergeProposal {
  readonly id: string
  readonly scope: ScopeRef
  readonly kind: KnowledgeKind
  readonly inputIds: readonly string[]
  readonly inputVersions: readonly { readonly id: string; readonly version: number }[]
  readonly similarity: number
  readonly sharedTerms: readonly string[]
  readonly reason: string
  readonly status: 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'STALE'
  readonly outputKnowledgeId?: string
  readonly resolution?: string
  readonly createdAt: string
  readonly resolvedAt?: string
}

/** Retrieval temperature derived from use and validation history. */
export type KnowledgeTemperature = 'hot' | 'warm' | 'cold'

/** Ranked Knowledge summary with scope, confidence, and retrieval reason. */
export interface KnowledgeSearchHit {
  readonly knowledge: KnowledgeCandidate
  readonly temperature: KnowledgeTemperature
  readonly score: number
  readonly reason: string
}

/** Auditable report and snapshots produced by Knowledge compaction. */
export interface KnowledgeCompactionReport {
  readonly id: string
  readonly scope: ScopeRef
  readonly inputIds: readonly string[]
  readonly outputIds: readonly string[]
  readonly actions: readonly {
    readonly kind: 'retained' | 'deduplicated' | 'merged' | 'deprecated' | 'archived'
    readonly inputIds: readonly string[]
    readonly outputId?: string
    readonly reason: string
  }[]
  /** Pre-compaction records changed by this report; used for guarded restoration. */
  readonly snapshots: readonly KnowledgeCandidate[]
  /** Versions written by compaction; restore is refused if any changed afterwards. */
  readonly resultingVersions: readonly { readonly id: string; readonly version: number }[]
  readonly restoredAt?: string
  readonly createdAt: string
}

/** Query-based retrieval expectation used for Knowledge regression. */
export interface KnowledgeRegressionCase {
  readonly id: string
  readonly scope: ScopeRef
  readonly name: string
  readonly input: string
  readonly expectedStatements: readonly string[]
  /** Statements that must not be retrieved for this scoped query. */
  readonly forbiddenStatements?: readonly string[]
  readonly createdAt: string
}

/** Result of executing one Knowledge regression case. */
export interface KnowledgeRegressionResult {
  readonly id: string
  readonly caseId: string
  readonly status: 'PASS' | 'FAIL' | 'UNKNOWN'
  readonly matched: readonly string[]
  readonly missing: readonly string[]
  readonly unexpected: readonly string[]
  /** Knowledge ids and versions present when this regression was evaluated. */
  readonly testedKnowledgeVersions?: readonly { readonly id: string; readonly version: number }[]
  readonly createdAt: string
}

/** Aggregate result for the complete current regression-case set. */
export interface KnowledgeRegressionSuite {
  readonly id: string
  readonly scope: ScopeRef
  readonly status: 'PASS' | 'FAIL' | 'UNKNOWN'
  readonly caseIds: readonly string[]
  readonly resultIds: readonly string[]
  /** Knowledge ids and versions present when the scoped suite was evaluated. */
  readonly testedKnowledgeVersions: readonly { readonly id: string; readonly version: number }[]
  readonly createdAt: string
}

/** Category of external effect that must pass the intent ledger. */
export type ActionIntentKind = 'agent-workspace' | 'command' | 'git-promotion' | 'memory-write' | 'knowledge-promotion'
/** Risk level used to authorize an ActionIntent. */
export type ActionRisk = 'low' | 'medium' | 'high' | 'destructive'
/** Lifecycle state of a planned or completed external effect. */
export type ActionIntentStatus = 'PLANNED' | 'AUTHORIZED' | 'EXECUTING' | 'COMMITTED' | 'FAILED' | 'UNKNOWN' | 'COMPENSATED' | 'REJECTED'

/** Preconditions and idempotency state for one planned side effect. */
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
  /** Host-derived actor that authorized the intent; absent on legacy records. */
  readonly authorizedBy?: AutoDevAuditActor
  readonly status: ActionIntentStatus
  readonly createdAt: string
  readonly updatedAt: string
}

/** Observed result of an authorized external effect. */
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

/** Deterministic verification check category for a Run Candidate. */
export type VerificationCheckKind = 'baseline' | 'build' | 'test' | 'review' | 'analysis' | 'side-effect'

/** A deterministic acceptance condition owned by the Runtime, not by an Agent. */
export interface VerificationCheck {
  readonly id: string
  readonly runId: string
  readonly planId: string
  readonly nodeId?: string
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

/** Persisted Provider selection and rejected-candidate reasons. */
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
  readonly decisionSource?: DecisionSource
  readonly decisionProviderId?: string
  readonly reason: string
  readonly rejections: readonly { provider: string; reason: string }[]
  readonly createdAt: string
}

/** Persisted Jev answer, confidence, and decision policy result. */
export interface JevDecision {
  readonly id: string
  readonly runId?: string
  readonly purpose: DecisionPurpose
  readonly stateHash: string
  readonly questionSetVersion: string
  readonly source: DecisionSource
  /** Optional stable provider identifier for Jev/local-model extension adapters. */
  readonly providerId?: string
  /** Host-registered decision purposes for which this provider is trusted. */
  readonly trustedFor?: readonly DecisionPurpose[]
  readonly modelVersion: string
  readonly answer: readonly DecisionAnswer[]
  readonly probability?: number
  readonly confidence?: number
  readonly policyOutcome: 'accepted' | 'rejected' | 'degraded' | 'paused'
  readonly reason: string
  readonly createdAt: string
}

/** Human-visible decision boundary for a blocked or uncertain Run. */
export interface HumanGate {
  readonly id: string
  readonly runId: string
  readonly reason: string
  readonly options: readonly ('retry' | 'rework' | 'replan' | 'abandon' | 'promote' | 'cancel')[]
  readonly status: 'OPEN' | 'RESOLVED'
  readonly selected?: string
  readonly createdAt: string
  readonly resolvedAt?: string
  /** Host-derived actor for a resolved Gate; absent on legacy Gates. */
  readonly resolvedBy?: AutoDevAuditActor
}

/** Content-addressed reference to a persisted AutoDev Artifact. */
export interface ArtifactRef {
  readonly id: string
  readonly runId: string
  readonly kind: string
  readonly path: string
  readonly sha256: string
  readonly bytes: number
  readonly createdAt: string
}

/** A hashed database or Run-artifact file included in an AutoDev backup. */
export interface AutoDevBackupFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

/** Manifest for a self-contained SQLite and Run-artifact snapshot. */
export interface AutoDevBackupManifest {
  readonly formatVersion: 1
  readonly databaseSchemaVersion: number
  readonly createdAt: string
  readonly included: readonly ['sqlite', 'run-artifacts']
  readonly excluded: readonly ['git-worktrees']
  readonly files: readonly AutoDevBackupFile[]
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

/** Reasons a managed Worktree must be excluded from cleanup eligibility. */
export type RetentionBlockReason =
  | 'active-runtime-operation'
  | 'run-not-terminal'
  | 'open-gate'
  | 'unsettled-side-effect'
  | 'invalid-run-timestamp'
  | 'retention-period-not-elapsed'
  | 'future-run-timestamp'
  | 'worktree-outside-managed-root'
  | 'worktree-is-symlink'
  | 'worktree-is-not-directory'
  | 'worktree-unavailable'
  | 'worktree-path-shared'

/** Path-free identifier for one managed Worktree considered by a preview. */
export interface RetentionWorktreeItem {
  readonly retentionId: string
  readonly runId: string
  readonly attempt: number
  readonly ageDays: number
}

/** Worktree protected from cleanup, with stable reasons for operator review. */
export interface RetentionBlockedWorktree extends RetentionWorktreeItem {
  readonly reasons: readonly RetentionBlockReason[]
}

/** Durable lifecycle state for one bounded Worktree cleanup operation. */
export type RetentionCleanupJobStatus = 'AWAITING_CONFIRMATION' | 'EXECUTING' | 'COMPLETED' | 'NEEDS_ATTENTION' | 'CANCELLED'

/** Lifecycle state for one Worktree in a cleanup operation. */
export type RetentionCleanupItemStatus = 'PENDING' | 'EXECUTING' | 'REMOVED' | 'FAILED' | 'BLOCKED' | 'UNKNOWN'

/** Stable, path-free failure category stored for operator review. */
export type RetentionCleanupFailureCode =
  | 'preview-stale'
  | 'run-state-changed'
  | 'target-not-eligible'
  | 'path-unsafe'
  | 'git-registration-mismatch'
  | 'worktree-dirty'
  | 'git-remove-failed'
  | 'interrupted'
  | 'lease-busy'

/** One selected Worktree and its durable cleanup progress. */
export interface RetentionCleanupJobItem {
  readonly retentionId: string
  readonly runId: string
  readonly attempt: number
  readonly status: RetentionCleanupItemStatus
  readonly failureCode?: RetentionCleanupFailureCode
  /** Runtime owning the live SQLite cleanup lease; never an operator identity. */
  readonly leaseOwner?: string
  readonly leaseExpiresAt?: string
}

/** Append-only, path-free maintenance event retained in a Cleanup Job. */
export interface RetentionCleanupJobEvent {
  readonly at: string
  readonly type: 'prepared' | 'confirmed' | 'item-started' | 'item-removed' | 'item-failed' | 'cancelled'
  readonly retentionId?: string
  /** DSH invocation.peer.id connection identifier; not a user identity or authorization input. */
  readonly sourcePeerId?: string
  /** Host-derived actor category; `sourcePeerId` remains only a DSH connection identifier. */
  readonly actor?: AutoDevAuditActor
  readonly failureCode?: RetentionCleanupFailureCode
}

/** Internal durable Cleanup Job record; it deliberately contains no filesystem path. */
export interface RetentionCleanupJobRecord {
  readonly id: string
  readonly status: RetentionCleanupJobStatus
  readonly minAgeDays: number
  readonly snapshotFingerprint: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly items: readonly RetentionCleanupJobItem[]
  readonly events: readonly RetentionCleanupJobEvent[]
  /** DSH invocation.peer.id connection identifier; not an account principal. */
  readonly requestedFromPeerId?: string
  readonly requestedBy?: AutoDevAuditActor
  /** DSH invocation.peer.id connection identifier; not an account principal. */
  readonly confirmedFromPeerId?: string
  readonly confirmedBy?: AutoDevAuditActor
  readonly confirmedAt?: string
  readonly cancelledBy?: AutoDevAuditActor
}

/** DSH request to persist a bounded Cleanup Job from one current preview. */
export interface PrepareRetentionCleanupRequest {
  readonly requestId: string
  readonly minAgeDays: number
  readonly snapshotFingerprint: string
  readonly retentionIds: readonly string[]
}

/** DSH request to execute or resume a previously prepared Cleanup Job. */
export interface ExecuteRetentionCleanupRequest {
  readonly jobId: string
  readonly snapshotFingerprint: string
  readonly confirmationPhrase: string
}

/** Path-free Cleanup Job representation returned to DSH Clients. */
export interface AutoDevCleanupJobView {
  readonly id: string
  readonly status: RetentionCleanupJobStatus
  readonly minAgeDays: number
  readonly snapshotFingerprint: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly confirmationPhrase: string
  readonly items: readonly Omit<RetentionCleanupJobItem, 'leaseOwner' | 'leaseExpiresAt'>[]
  readonly requestedBy?: AutoDevAuditActor
  readonly confirmedBy?: AutoDevAuditActor
  readonly cancelledBy?: AutoDevAuditActor
  readonly events?: readonly RetentionCleanupJobEvent[]
}

/** Read-only, path-free snapshot of Worktrees eligible or protected by policy. */
export interface AutoDevRetentionPreview {
  readonly generatedAt: string
  readonly minAgeDays: number
  readonly snapshotFingerprint: string
  readonly eligibleWorktrees: readonly RetentionWorktreeItem[]
  readonly blockedWorktrees: readonly RetentionBlockedWorktree[]
}

/** Complete Host-owned view of a Run and its related records. */
export interface AutoDevSnapshot {
  readonly run: Run
  readonly plan?: PlanVersion
  readonly nodes: readonly NodeExecution[]
  readonly candidate?: CandidateRevision
  /** Older sealed Candidates for comparison; absent on snapshots from older Hosts. */
  readonly candidateHistory?: readonly CandidateRevisionSummary[]
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
  readonly conceptObservations: readonly ConceptObservation[]
  readonly playbooks: readonly Playbook[]
  readonly playbookFits: readonly PlaybookFit[]
  readonly knowledge: readonly KnowledgeCandidate[]
  readonly knowledgeMergeProposals: readonly KnowledgeMergeProposal[]
  readonly compactions: readonly KnowledgeCompactionReport[]
  readonly regressionCases: readonly KnowledgeRegressionCase[]
  readonly regressionResults: readonly KnowledgeRegressionResult[]
  readonly regressionSuites: readonly KnowledgeRegressionSuite[]
  readonly actionIntents: readonly ActionIntent[]
  readonly sideEffects: readonly SideEffectRecord[]
  /** Most recent append-only authorization/decision entries for this Run. */
  readonly auditEvents?: readonly AutoDevAuditEvent[]
}

/** Inputs accepted when creating a new Run and immutable Plan. */
export interface CreateRunRequest {
  readonly repoPath: string
  readonly request: string
  readonly acceptanceCriteria?: readonly string[]
  readonly goalId?: string
  /** Explicit engineering mode; `AUTO` or omission enables deterministic intent classification. */
  readonly mode?: AutoDevMode | 'AUTO'
  /** Currently `LOCAL_WORKTREE` only; omitted requests use that safe default. */
  readonly executionEnvironment?: ExecutionEnvironmentSpec
  /** Optional explicit driver for a repository containing multiple project markers. */
  readonly buildDriver?: BuildDriverId
  /** Additional scope dimensions; projectKey is always bound to the inspected repository. */
  readonly scope?: Omit<ScopeRef, 'projectKey'>
}

/** Provider adapter request for one Agent Protocol execution. */
export interface ProviderRunRequest {
  readonly provider: string
  readonly model?: string
  readonly request: string
  readonly acceptanceCriteria: readonly string[]
  readonly cwd: string
  readonly signal: AbortSignal
  readonly parentAgent?: unknown
  readonly task?: AgentTask
  readonly context?: AutoDevAgentContext
  readonly emitSignal?: (signal: AgentSignalInput) => void
  readonly onProgress?: (event: import('./protocol.ts').AgentProgressUpdate) => void
}

/** Normalized completion or failure returned by a Provider adapter. */
export interface ProviderRunResult {
  readonly provider: string
  readonly status: 'completed' | 'error' | 'aborted'
  readonly output: string
  readonly diagnostic?: string
  readonly signals?: readonly AgentSignalInput[]
}

/** Inputs sent to Jev to select or evaluate one policy decision. */
export interface DecisionRequest {
  readonly purpose: DecisionPurpose
  readonly state: unknown
  readonly questions: readonly JevQuestion[]
  readonly signal: AbortSignal
  /** Ephemeral caller context for DSH Subagent escalation; never sent in the decision state. */
  readonly parentAgent?: unknown
}

/** One bounded question and its accepted answer choices. */
export interface JevQuestion {
  readonly id: string
  readonly type: 'choice' | 'score' | 'noul'
  readonly text: string
  readonly choices?: readonly string[]
  readonly min?: number
  readonly max?: number
}

/** Selected Jev answer and confidence for a decision question. */
export interface DecisionAnswer {
  readonly questionId: string
  readonly kind: 'choice' | 'score' | 'noul'
  readonly value?: string | number | boolean | null
  readonly probability?: number
}

/** Normalized Jev decision result consumed by Host policy. */
export interface DecisionResult {
  readonly source: DecisionSource
  /** Optional provider identity; older providers may omit it. */
  readonly providerId?: string
  /** Host-owned trust metadata; provider output cannot grant itself trust. */
  readonly trustedFor?: readonly DecisionPurpose[]
  readonly modelVersion: string
  readonly answers: readonly DecisionAnswer[]
  readonly raw?: unknown
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
}
