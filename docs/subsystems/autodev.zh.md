# AutoDev 工作流

[English](autodev.md) | 中文

AutoDev 是一个可选的 DeepSeek Harness Bundle，用于执行可恢复、可审计的软件工程 Run。它是工作流 Service，不会替代 Agent Runtime：它通过 DSH 已加载的 Provider 路由任务，并由 Host 掌管持久状态、验证和晋级。[包使用指南](../../packages/experimental/autodev/README.zh.md)介绍安装和操作流程。

## 职责与安全边界

- Host `ctx.autodev` Service 管理 Run 状态、Plan、Attempt、Evidence、项目知识和恢复流程。[AutoDev Runtime 源码](../../packages/experimental/autodev/src/runtime.ts)负责协调这些状态转换。
- Provider 在托管 Git Worktree 中执行，而不是直接改动原始 checkout。Codex 和 Claude Code 仍由 Harness 管理 Provider 集成；AutoDev 不重复实现其登录或进程管理。
- 每次实现会收到可选的 v1 Agent 上下文卡片，包括限定作用域的 Memory、Plan 关联的 Business Concept、Playbook、当前 Run 的 Assumption 与 Semantic Uncertainty，以及 Knowledge。Host 对六类卡片合计限制为 6,000 字符，在 Provider 边界再次校验，并保留 `AGENT_CONTEXT` Artifact。
- Provider 输出和 Agent Signal 都只是声明，不等同于验证结果。只有 Host 将 Build/Test Evidence 绑定到当前 Plan、Attempt 和 Candidate 后，才会开放晋级。
- Client 仅调用受限 Remote 方法，不能写入 SQLite Store 或绕过 Gate；晋级始终是由 Host 重新验证的显式操作。

## 领域契约归属

下方公开 Remote 签名由 Host Service 生成。共享 Wire Record 位于 [`src/contracts.ts`](../../packages/experimental/autodev/src/contracts.ts)；Agent 消息和 Signal Envelope 位于 [`src/protocol.ts`](../../packages/experimental/autodev/src/protocol.ts)；Provider 选择逻辑位于 [`src/router.ts`](../../packages/experimental/autodev/src/router.ts)。项目 Memory、Business Concept、Playbook、Assumption、不确定性、Knowledge 和 Compaction 仍由包内独立领域 Service 管理，并由 Host 派生的项目身份限定作用域。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxautodev--autodevruntime"></a>

### `ctx.autodev` — `AutoDevRuntime`

Main Host-owned AutoDev service.

```ts cordis-catalog
/** List the durable Runs available to the profile's Web dashboard.
 * @returns Runs ordered by most recent update.
 */
@Remote('list') listRuns(): readonly Run[]

/** Create a verified backup in a new operator-selected directory.
 * @param request New destination path outside the live AutoDev data root.
 * @param signal DSH Remote cancellation signal; cancellation is checked before the backup is published.
 * @returns The backup manifest, whose file paths are relative to the backup.
 */
@Remote('createBackup') async remoteCreateBackup( request: { readonly destinationPath: string }, signal: AbortSignal, ): Promise<AutoDevBackupManifest>

/** Restore a verified backup to a new operator-selected data root.
 * @param request Backup directory, new target, and the exact target path typed by the operator for confirmation.
 * @param signal DSH Remote cancellation signal; cancellation is checked before the restored directory is published.
 * @returns The verified backup manifest; the running Store is not switched to the restored root.
 */
@Remote('restoreBackup') async remoteRestoreBackup( request: { readonly backupPath: string readonly targetDataRoot: string readonly confirmedTargetDataRoot: string }, signal: AbortSignal, ): Promise<AutoDevBackupManifest>

/** Return a path-free, read-only preview of Worktrees eligible for retention.
 * @param request Optional minimum terminal age in days; defaults to 30.
 * @param signal DSH Remote cancellation signal.
 * @returns Eligible and protected Worktrees plus an observed-state fingerprint.
 */
@Remote('retentionPreview') remoteRetentionPreview(request: { readonly minAgeDays?: number }, signal: AbortSignal): AutoDevRetentionPreview

/** List path-free retention Cleanup Jobs for recovery and audit review.
 * @returns Recent durable Jobs without filesystem paths or user identity claims.
 */
@Remote('retentionCleanupJobs') remoteRetentionCleanupJobs(): readonly AutoDevCleanupJobView[]

/** Persist an explicit bounded selection without deleting or modifying any Worktree.
 * @param request Idempotency key, exact current preview fingerprint, and selected IDs.
 * @returns A path-free Job and the exact text required for its second confirmation.
 */
@Remote('prepareRetentionCleanup') remotePrepareRetentionCleanup(request: PrepareRetentionCleanupRequest): AutoDevCleanupJobView

/** Execute or resume a confirmed Cleanup Job after rechecking the current Preview and each target.
 * @param request Job id, freshly observed fingerprint, and the UI's typed confirmation phrase.
 * @param signal DSH Remote cancellation signal; an individual Git removal is allowed to settle once claimed.
 * @returns Latest path-free durable Job state.
 */
@Remote('executeRetentionCleanup') async remoteExecuteRetentionCleanup( request: ExecuteRetentionCleanupRequest, signal: AbortSignal, ): Promise<AutoDevCleanupJobView>

/** Cancel a prepared Job before any filesystem operation has been authorized.
 * @param jobId Job to cancel.
 * @returns The latest path-free Job.
 */
@Remote('cancelRetentionCleanup') remoteCancelRetentionCleanup(jobId: string): AutoDevCleanupJobView

/** Read one authoritative Run snapshot.
 * @param runId - The Run to inspect.
 * @returns The current persisted Run state and related records.
 */
@Remote('snapshot') remoteSnapshot(runId: string): AutoDevSnapshot

/** Read the registered Providers and configured routes.
 * @returns A detached Provider and route catalog.
 */
@Remote('providers') remoteProviders(): ProviderCatalog

/** Create a Run and immutable Plan for Web review without starting a Provider.
 * @param request - Local repository, task, acceptance checks, and optional Driver.
 * @param signal - Cancellation of repository inspection.
 * @returns The persisted Run snapshot for review.
 */
@Remote('create') async remoteCreate(request: CreateRunRequest, signal: AbortSignal): Promise<AutoDevSnapshot>

/** Record explicit approval for exactly the Plan shown to the caller.
 * @param request Run and reviewed Plan version identifiers.
 * @returns The ready Run with an auditable approval Evidence item.
 */
@Remote('approvePlan') remoteApprovePlan(request: { readonly runId: string; readonly planId: string }): AutoDevSnapshot

/** Start an approved Plan from an ordinary DSH Session bound to this repository.
 * The Run outlives this short Remote call and can be observed via snapshot.
 * @param request Run and framework-bound Session identities.
 * @param signal Cancellation only for admission, not the background Run.
 * @returns The latest durable snapshot after execution has been admitted.
 */
@Remote('start') async remoteStart(request: { readonly runId: string; readonly sessionId: string }, signal: AbortSignal): Promise<AutoDevSnapshot>

/** Search bounded Memory records within the Run's derived project scope.
 * @param request - The Run, query, and optional result limits.
 * @returns Matching summaries that apply to the Run's scope.
 */
@Remote('memorySearch') remoteMemorySearch(request: { readonly runId: string readonly query: string readonly limit?: number readonly maxChars?: number }): readonly MemorySearchHit[]

/** Read one Memory record after checking its scope against the Run.
 * @param request - The Run and Memory identifiers.
 * @returns The scoped record, or `undefined` when it does not exist.
 */
@Remote('memoryDetail') remoteMemoryDetail(request: { readonly runId: string; readonly memoryId: string }): ProjectMemory | undefined

/** Read the open semantic decisions associated with one Run.
 * @param runId - The Run whose assumptions and uncertainties are requested.
 * @returns The Run's assumptions and currently open uncertainties.
 */
@Remote('semanticState') remoteSemanticState(runId: string): { readonly assumptions: AutoDevSnapshot['assumptions']; readonly uncertainties: AutoDevSnapshot['uncertainties'] }

/** Search Concepts using the Run's request and project scope.
 * @param runId - The Run that supplies the query and scope.
 * @returns Up to eight matching Concepts.
 */
@Remote('concepts') remoteConcepts(runId: string): readonly BusinessConcept[]

/** Read a Concept only when it belongs to the Run's scope.
 * @param request - The Run and Concept identifiers.
 * @returns The scoped Concept, or `undefined` when it does not exist.
 */
@Remote('conceptDetail') remoteConceptDetail(request: { readonly runId: string; readonly conceptId: string }): BusinessConcept | undefined

/** Read observations for a Concept after validating its scope.
 * @param request - The Run and Concept identifiers.
 * @returns Observations for the selected Concept in the Run's scope.
 */
@Remote('conceptHistory') remoteConceptHistory(request: { readonly runId: string; readonly conceptId: string }): AutoDevSnapshot['conceptObservations']

/** Add an Agent or operator observation to a project Concept.
 * @param request - The Run, Concept observation, and optional Evidence references.
 * @returns The updated authoritative Run snapshot.
 */
@Remote('observeConcept') remoteObserveConcept(request: { readonly runId: string readonly key: string readonly name: string readonly definition: string readonly target: string readonly effect: string readonly evidenceSummary: string readonly evidenceIds?: readonly string[] readonly confidence?: number }): AutoDevSnapshot

/** Record an explicit human correction for a project Concept.
 * @param request - The Run, corrected definition, and resolution rationale.
 * @returns The updated authoritative Run snapshot.
 */
@Remote('correctConcept') remoteCorrectConcept(request: { readonly runId: string readonly key: string readonly name: string readonly definition: string readonly target: string readonly effect: string readonly evidenceSummary: string readonly resolution: string readonly evidenceIds?: readonly string[] }): AutoDevSnapshot

/** List relevant Playbooks for the Run's project scope.
 * @param runId - The Run that supplies the scope and request.
 * @returns Up to eight applicable Playbooks.
 */
@Remote('playbooks') remotePlaybooks(runId: string): readonly Playbook[]

/** Read one Playbook after validating its project scope.
 * @param request - The Run and Playbook identifiers.
 * @returns The requested Playbook.
 */
@Remote('playbookDetail') remotePlaybookDetail(request: { readonly runId: string; readonly playbookId: string }): Playbook

/** Create a Run-scoped Draft Playbook for later human activation.
 * @param request - Scoped Playbook content authored from this Run.
 * @returns The updated project snapshot.
 */
@Remote('createPlaybook') remoteCreatePlaybook(request: { readonly runId: string readonly key: string readonly name: string readonly purpose: string readonly targets: readonly string[] readonly effects: readonly string[] readonly conceptKeys?: readonly string[] readonly exclusions?: readonly string[] readonly steps: readonly string[] readonly requiredEvidence?: readonly EvidenceType[] }): AutoDevSnapshot

/** Revise an applicable Playbook as a new immutable version.
 * The operation forces Plan re-review before a non-Draft Run can continue.
 * @param request - Prior version, revised content, and human rationale.
 * @returns The updated project snapshot.
 */
@Remote('revisePlaybook') remoteRevisePlaybook(request: { readonly runId: string readonly playbookId: string readonly name: string readonly purpose: string readonly targets: readonly string[] readonly effects: readonly string[] readonly conceptKeys?: readonly string[] readonly exclusions?: readonly string[] readonly steps: readonly string[] readonly requiredEvidence?: readonly EvidenceType[] readonly resolution: string }): AutoDevSnapshot

/** Activate an applicable Draft Playbook and require Plan re-review.
 * @param request - The Run and Draft Playbook identities.
 * @returns The updated project snapshot.
 */
@Remote('activatePlaybook') remoteActivatePlaybook(request: { readonly runId: string; readonly playbookId: string }): AutoDevSnapshot

/** Deprecate an applicable Playbook while retaining its history.
 * @param request - The Run and Playbook identities.
 * @returns The updated project snapshot.
 */
@Remote('deprecatePlaybook') remoteDeprecatePlaybook(request: { readonly runId: string; readonly playbookId: string }): AutoDevSnapshot

/** List established or candidate Knowledge records in the Run's scope.
 * @param runId - The Run that supplies the scope.
 * @returns Up to twenty Knowledge records.
 */
@Remote('knowledge') remoteKnowledge(runId: string): readonly KnowledgeCandidate[]

/** Search Knowledge with caller-selected, bounded result limits.
 * @param request - The Run, query, and optional result limits.
 * @returns Matching Knowledge summaries and retrieval metadata.
 */
@Remote('knowledgeSearch') remoteKnowledgeSearch(request: { readonly runId: string; readonly query: string; readonly limit?: number; readonly maxChars?: number }): readonly KnowledgeSearchHit[]

/** List the Knowledge regression cases that apply to the Run's scope.
 * @param runId - The Run that supplies the project scope.
 * @returns The current scoped regression cases.
 */
@Remote('knowledgeRegressionCases') remoteKnowledgeRegressionCases(runId: string): readonly KnowledgeRegressionCase[]

/** Create a scoped Knowledge retrieval regression case.
 * @param request - The Run, query, and expected or forbidden statements.
 * @returns The updated authoritative Run snapshot.
 */
@Remote('createKnowledgeRegression') remoteCreateKnowledgeRegression(request: { readonly runId: string readonly operationId?: string readonly name: string readonly query: string readonly expectedStatements: readonly string[] readonly forbiddenStatements?: readonly string[] }): AutoDevSnapshot

/** Run the current regression suite for the Run's Knowledge scope.
 * @param runId - The Run that supplies the project scope.
 * @param operationId - Optional caller identity used to deduplicate Remote retries.
 * @returns The updated snapshot with the persisted suite result.
 */
@Remote('runKnowledgeRegressionSuite') remoteRunKnowledgeRegressionSuite(runId: string, operationId?: string): AutoDevSnapshot

/** Read a Knowledge record only when it applies to the Run's scope.
 * @param request - The Run and Knowledge identifiers.
 * @returns The scoped Knowledge record, or `undefined` when absent.
 */
@Remote('knowledgeDetail') remoteKnowledgeDetail(request: { readonly runId: string; readonly knowledgeId: string }): KnowledgeCandidate | undefined

/** Generate bounded semantic merge proposals for exact-scope Knowledge.
 * @param request Run identifier and optional proposal-generation limits.
 * @returns The authoritative snapshot including persisted review proposals.
 */
@Remote('proposeKnowledgeMerges') remoteProposeKnowledgeMerges(request: { readonly runId: string readonly limit?: number readonly minSimilarity?: number }): AutoDevSnapshot

/** Accept a Knowledge merge as a new Candidate without changing its inputs.
 * @param request Run, proposal, human-authored merged text, and review rationale.
 * @returns The authoritative snapshot including the Candidate and resolved proposal.
 */
@Remote('acceptKnowledgeMerge') remoteAcceptKnowledgeMerge(request: { readonly runId: string readonly proposalId: string readonly statement: string readonly content?: string readonly resolution: string }): AutoDevSnapshot

/** Reject a Knowledge merge while retaining the human rationale.
 * @param request Run, proposal, and reason to keep the inputs separate.
 * @returns The authoritative snapshot with the rejected proposal.
 */
@Remote('rejectKnowledgeMerge') remoteRejectKnowledgeMerge(request: { readonly runId: string readonly proposalId: string readonly resolution: string }): AutoDevSnapshot

/** Resolve or dismiss an uncertainty owned by the Run.
 * @param request - The Run, uncertainty, status, and human resolution.
 * @returns The updated authoritative Run snapshot.
 */
@Remote('resolveUncertainty') remoteResolveUncertainty(request: { readonly runId: string; readonly uncertaintyId: string; readonly status: 'RESOLVED' | 'DISMISSED'; readonly resolution: string }): AutoDevSnapshot

/** Resolve an assumption and open a Gate when invalidation needs replanning.
 * @param request - The Run, assumption, resolution, and optional Evidence ids.
 * @returns The updated authoritative Run snapshot.
 */
@Remote('resolveAssumption') remoteResolveAssumption(request: { readonly runId: string; readonly assumptionId: string; readonly status: 'CONFIRMED' | 'INVALIDATED' | 'UNKNOWN'; readonly resolution: string; readonly evidenceIds?: readonly string[] }): AutoDevSnapshot

/** Compact Knowledge in the Run's exact scope and record the side effect.
 * @param runId - The Run that supplies the Knowledge scope.
 * @param operationId - Optional caller identity used to deduplicate Remote retries.
 * @returns The updated authoritative Run snapshot.
 */
@Remote('compactKnowledge') remoteCompactKnowledge(runId: string, operationId?: string): AutoDevSnapshot

/** Restore a compaction only when its snapshots and versions still match.
 * @param request - The Run and compaction report identifiers.
 * @returns The updated authoritative Run snapshot.
 */
@Remote('restoreKnowledgeCompaction') remoteRestoreKnowledgeCompaction(request: { readonly runId: string; readonly reportId: string }): AutoDevSnapshot

/** Promote a Knowledge candidate after Evidence and regression validation.
 * @param request - The Run, candidate, Evidence ids, and passing case id.
 * @returns The updated authoritative Run snapshot.
 */
@Remote('promoteKnowledge') remotePromoteKnowledge(request: { readonly runId: string readonly knowledgeId: string readonly evidenceIds: readonly string[] readonly regressionCaseId: string }): AutoDevSnapshot

/** Resolve a browser-visible Gate action without accepting arbitrary Agent input.
 * Retry and rework require the DSH Session bound to this repository and use
 * its live parent Agent. Their Run outlives the short Remote admission call.
 * @param request - The Run, selected Gate action, and optional DSH Session identity.
 * @param signal - The Host request cancellation signal for admission.
 * @returns The updated authoritative Run snapshot.
 */
@Remote('resolveGate') async remoteResolveGate(request: { readonly runId: string; readonly action: 'retry' | 'rework' | 'replan' | 'abandon' | 'promote' | 'cancel'; readonly sessionId?: string }, signal: AbortSignal): Promise<AutoDevSnapshot>

/** Promote after the browser has presented the Candidate and Evidence.
 * @param runId - The Run whose verified Candidate is being promoted.
 * @param signal - The Host request cancellation signal.
 * @returns The updated authoritative Run snapshot.
 */
@Remote('promote') async remotePromote(runId: string, signal: AbortSignal): Promise<AutoDevSnapshot>

/** Cancel a Run while retaining its Worktree and artifacts.
 * @param runId - The Run to cancel.
 * @returns The updated authoritative Run snapshot.
 */
@Remote('cancel') async remoteCancel(runId: string): Promise<AutoDevSnapshot>

/** Return a bounded, path-free Candidate Diff view to the Web Client.
 * @param runId - The Run whose Candidate diff is requested.
 * @param signal - The Host request cancellation signal.
 * @returns The bounded diff artifact, or `undefined` when no Candidate exists.
 */
@Remote('candidateDiff') async remoteCandidateDiff(runId: string, signal: AbortSignal): Promise<ArtifactContent | undefined>

/** Return a bounded Diff for a specific Candidate that belongs to the Run.
 * @param runId - The owning Run identifier.
 * @param candidateId - Candidate revision identifier from this Run's history.
 * @param signal - The Host request cancellation signal.
 * @returns The bounded Diff artifact, or `undefined` when the Candidate has no Diff.
 */
@Remote('candidateRevisionDiff') async remoteCandidateRevisionDiff(runId: string, candidateId: string, signal: AbortSignal): Promise<ArtifactContent | undefined>

/** Inspect a clean repository and persist a Run, Plan, and baseline Evidence.
 * @param request - The repository, requested change, acceptance criteria, and optional scope.
 * @param signal - Optional cancellation signal for repository inspection.
 * @returns The new Run's authoritative snapshot.
 */
async create(request: CreateRunRequest, signal?: AbortSignal): Promise<AutoDevSnapshot>

/** Read the current authoritative snapshot for a Run.
 * @param runId - The Run to inspect.
 * @returns The persisted Run state and related records.
 */
snapshot(runId: string): AutoDevSnapshot

/** List Providers visible to the current Host runtime.
 * @returns Registered custom Providers and Harness subagents.
 */
listProviders(): readonly ProviderInfo[]

/** Register a Provider for dynamic route selection.
 * @param provider - The adapter identity, capabilities, and run function.
 * @returns A disposer that unregisters this Provider.
 */
registerProvider(provider: Parameters<ProviderRouter['register']>[0]): () => void

/** Add a candidate backed by a Provider already loaded by Harness, such as an ACP subagent.
 * @param routeName Existing AutoDev route to extend.
 * @param candidate Provider kind, registered name, and route-specific capabilities.
 * @returns A disposer that removes only this candidate.
 */
registerRouteCandidate(routeName: string, candidate: RouteCandidate): () => void

/** Register a custom Provider and append it to an existing route as one reversible operation.
 * If candidate registration fails, the Provider registration is rolled back. The returned
 * disposer removes the candidate and Provider together, which lets an extension Bundle
 * unload without leaving a dangling route entry or an unreachable Provider.
 * @param routeName Existing AutoDev route to extend.
 * @param provider Custom Provider adapter to register.
 * @param candidate Route-specific model, enabled state, or capability declaration.
 * @returns A disposer that unregisters both parts of the extension.
 */
registerRoutedProvider( routeName: string, provider: CustomProvider, candidate: Pick<RouteCandidate, 'enabled' | 'model' | 'traits'> = {}, ): () => void

/** Execute the current Plan in a dedicated Worktree and retain all Evidence.
 * @param runId - The Run to execute or resume.
 * @param parentAgent - Optional Harness Agent context passed to subagent adapters.
 * @param signal - Optional caller cancellation signal.
 * @returns The updated authoritative Run snapshot.
 */
async run(runId: string, parentAgent?: unknown, signal?: AbortSignal): Promise<AutoDevSnapshot>

/** Apply an action that the current Human Gate explicitly permits.
 * @param runId - The Run with the open Gate.
 * @param action - The selected Gate action.
 * @param parentAgent - Optional Harness Agent context used for resumed execution.
 * @param signal - Optional caller cancellation signal.
 * @param actor - Host-derived initiating source; it is never read from request data.
 * @returns The updated authoritative Run snapshot.
 */
async resolveGate( runId: string, action: 'retry' | 'rework' | 'replan' | 'abandon' | 'promote' | 'cancel', parentAgent?: unknown, signal?: AbortSignal, actor: AutoDevAuditActor = { kind: 'autodev-runtime', source: 'runtime-policy' }, ): Promise<AutoDevSnapshot>

/** Revalidate and explicitly apply the verified Candidate to its original checkout.
 * @param runId - The Run whose Candidate is being promoted.
 * @param signal - Optional cancellation signal for promotion checks.
 * @param actor - Host-derived initiating source; it is never read from request data.
 * @returns The updated authoritative Run snapshot.
 */
async promote( runId: string, signal?: AbortSignal, actor: AutoDevAuditActor = { kind: 'autodev-runtime', source: 'runtime-policy' }, ): Promise<AutoDevSnapshot>

/**
 * Abort active Run work while retaining Worktree and evidence; uncertain effects remain non-promotable.
 * @param runId - Exact Run to cancel.
 * @returns The persisted state after the cancellation request.
 */
async cancel(runId: string): Promise<AutoDevSnapshot>

/**
 * Abort active Runs and await settlement before the owning plugin closes SQLite.
 * @returns A promise that resolves after all active Run operations settle.
 */
async dispose(): Promise<void>
```

Types: [ArtifactContent](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [AutoDevAuditActor](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [AutoDevBackupManifest](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [AutoDevCleanupJobView](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [AutoDevRetentionPreview](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [AutoDevSnapshot](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [BusinessConcept](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [CreateRunRequest](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [EvidenceType](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [ExecuteRetentionCleanupRequest](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [KnowledgeCandidate](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [KnowledgeRegressionCase](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [KnowledgeSearchHit](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [MemorySearchHit](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [Playbook](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [PrepareRetentionCleanupRequest](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [ProjectMemory](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [ProviderCatalog](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [ProviderInfo](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [ProviderRouter](../../packages/experimental/autodev/README.zh.md#public-api-contracts) · [Run](../../packages/experimental/autodev/README.zh.md#public-api-contracts)

Source: [`packages/experimental/autodev/src/runtime.ts`](../../packages/experimental/autodev/src/runtime.ts)
<!-- END GENERATED cordis-surface -->
