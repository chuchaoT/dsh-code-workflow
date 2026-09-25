---
description: "Adds resumable, auditable software-engineering runs to DSH profiles for users who need isolated agent work, evidence-backed checks, human promotion, or extensible provider routing."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-autodev

English | [中文](README.zh.md)

## Summary

AutoDev adds a resumable software-engineering workflow to a DeepSeek Harness profile. It runs Coding Agents in Git Worktrees, selects an explicit engineering mode, checks changes with repository-specific Build/Test drivers when available, and requires explicit approval before promotion to the original checkout. It supports a genuinely empty Git repository with no initial commit or configured author identity. It reuses Harness-loaded Codex and Claude Code providers and accepts additional providers through registration contracts. The Host owns durable state; the sidebar is a bounded client, not an authority for execution or promotion.

## Table of Contents

- [Use this package](#use-this-package)
- [Work modes and execution environment](#work-modes-and-execution-environment)
- [Understand the implementation](#understand-the-implementation)
- [Public API Contracts](#public-api-contracts)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Choose AutoDev when a DSH task needs an isolated coding attempt, verifiable build and test evidence, reviewable knowledge, or an explicit promotion boundary. It is not a replacement for the DSH Agent runtime, a source-control host, or a model provider.

### Install into a profile

From the `deepseek-harness` repository root, build the package and add this Bundle to a scratch profile. Set `DSH_HOME` to a temporary location so the check does not change your normal DSH installation.

```powershell
$env:DSH_HOME = "C:\path\to\temporary-dsh-home"
pnpm dsh plugin --profile autodev add .\packages\experimental\autodev
pnpm dsh --profile autodev --dump-config
pnpm dsh plugin --profile autodev remove @deepseek-ai/dsh-experimental-autodev
```

The package declares `dsh.bundle.patch`; profile reconciliation activates its layer. `--dump-config` lets you check the composed profile. Restart a running DSH process after changing its profile; a profile edit does not hot-load a Bundle.

### What you get

The Bundle adds one Host-owned workflow and a client view to a DSH profile:

- Git baseline checks, fresh Worktrees for attempts, bounded diffs, drift detection, and guarded promotion.
- A normalized Agent Protocol and dynamic ProviderRouter; the built-in `codex`, `claude-code`, and `spawn` routes use Harness-loaded Providers.
- Root-level Maven, Gradle, npm/pnpm/yarn/bun, and pytest Build/Test driver selection, frozen into each Plan.
- Nine explicit/auto-detected work modes, separated from workflow lifecycle states; read-only modes do not require a build driver or code Candidate.
- Project-scoped Memory, Business Concepts, Assumptions, Semantic Uncertainty, versioned Playbooks, and evidence-backed Knowledge evolution.
- Model tools for runs, Gates, retrieval, correction, regression checks, and compaction; a Web sidebar shows run snapshots and bounded Candidate diffs, with side-by-side comparison of two revisions from the same Run and their verification evidence.
- Optional Jev/local decision-provider chain with `required`, `advisory`, and `off` modes; deterministic fallback decisions cannot create a Review PASS or override failed Build/Test Evidence.

The Host derives the project key from the inspected Git repository. Optional module, branch, language, project-version, schema-version, and tech-stack-version fields narrow knowledge scope; callers cannot use them to redirect a Run to another project.

### Decision-provider extension

The existing `DecisionProvider` contract can be extended without replacing the route router or Jev HTTP adapter. A separate DSH Bundle may register a local model or another Jev-compatible service, give it an explicit priority, and dispose it on unload:

```ts
import type { DecisionProvider } from '@deepseek-ai/dsh-experimental-autodev'

declare const ctx: { autodev: { registerDecisionProvider(id: string, provider: DecisionProvider, priority?: number): () => void } }
declare const localModelAdapter: DecisionProvider

const removeLocalModel = ctx.autodev.registerDecisionProvider('local-qwen', localModelAdapter, 20)
// Call removeLocalModel() when the contributing Bundle unloads.
```

Higher priorities are tried first. Invalid, low-confidence (when configured), or unavailable providers fall through to the next; `required` fails if none succeeds, while `advisory` uses the explicitly untrusted static fallback. A provider must identify an actual model-backed decision as `source: 'jev'`; rule/static adapters must not claim that source. Quality Review PASS additionally requires a valid score above policy and an explicit `needs_review: false`. Code-run quality decisions include up to 24,000 bytes of Candidate Diff, which may contain proprietary source; confirm the configured remote Jev backend's data-handling boundary before enabling it. Path sharing remains separately controlled by `sendPaths`. Provider probability is not assumed calibrated unless a confidence threshold is configured. This seam does not bundle a Qwen model or connect DSH's Ollama endpoint automatically.

### Add a Provider or route

Codex and Claude Code execution stays in the official Harness Provider packages; AutoDev does not duplicate their login or subprocess lifecycle. A separate Bundle can use Runtime's `registerRoutedProvider(routeName, provider, candidate?)` to register a custom Provider and route candidate as one reversible operation: candidate-registration failure rolls back the Provider, and its disposer removes both. For an ACP or other Subagent already loaded by Harness, use `registerRouteCandidate(routeName, candidate)`. The lower-level `registerProvider()`, `router.registerCandidate()`, and `registerRoute()` remain available when an integration needs finer control. The default Plan uses `implement`; a separate named route runs only when referenced by a Plan or configuration.

A hand-written `CustomProvider` must set `workspaceCwd: true` only if every workspace operation in `run()` honors that invocation's `request.cwd`; otherwise it is unavailable to AutoDev routes and direct invocation fails closed. Its declared traits must also cover every trait claimed by the route candidate (`unknown` is not a wildcard for custom adapters). `commandProvider()` supplies the cwd guarantee and `worktree-cwd` trait automatically.

For a CLI integration, `commandProvider()` supplies a bounded argv-based adapter (no shell interpolation) that delegates to the Harness subprocess boundary:

```ts
import { commandProvider } from '@deepseek-ai/dsh-experimental-autodev/router'
import type { RouteCandidate } from '@deepseek-ai/dsh-experimental-autodev/contracts'

declare function checkMyAgentInstallation(): boolean | Promise<boolean>
declare const ctx: { autodev: {
  registerRoutedProvider(
    routeName: string,
    provider: ReturnType<typeof commandProvider>,
    candidate?: Pick<RouteCandidate, 'enabled' | 'model' | 'traits'>,
  ): () => void
} }

const provider = commandProvider({
  name: 'my-agent',
  executable: 'my-agent',
  args: request => ['run', request.request], // Replace with the CLI's documented argument contract.
  traits: ['code-edit', 'local-workspace'],
  isAvailable: checkMyAgentInstallation,
  timeoutMs: 10 * 60_000,
  maxOutputBytes: 2 * 1024 * 1024,
})
const disposeProvider = ctx.autodev.registerRoutedProvider('implement', provider, {
  traits: ['code-edit', 'local-workspace', 'worktree-cwd'],
})
// Call disposeProvider() when this extension Bundle unloads.
```

### CodeBuddy through the existing ACP provider

[CodeBuddy Code documents an ACP mode](https://www.codebuddy.ai/docs/cli/acp) (`codebuddy --acp`), so DSH can compose it through `@deepseek-ai/dsh-subagent-acp` instead of adding a second subprocess/login implementation:

DSH scrubs credential-shaped variables from the ambient child-process environment. If CodeBuddy authenticates with an API key, explicitly forward it through ACP `env` using `!!js process.env...`; keep the value in the host's secret environment, not in the profile file. CodeBuddy documents `CODEBUDDY_API_KEY`; for `CODEBUDDY_INTERNET_ENVIRONMENT`, use `internal` for the China edition, `ioa` for iOA, and leave it unset for the international edition ([official IAM guidance](https://www.codebuddy.ai/docs/cli/iam)).

```yaml
- name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: codebuddy-acp
    command: codebuddy
    args: ['--acp']
    permission: reject # safe default: ACP permission requests are auto-rejected
    env:
      CODEBUDDY_API_KEY: !!js process.env.CODEBUDDY_API_KEY
      # For China edition only; use "ioa" for iOA and omit for international:
      # CODEBUDDY_INTERNET_ENVIRONMENT: internal
```

To make it eligible for AutoDev's default `implement` route, a companion Bundle can append the loaded subagent dynamically:

```ts
declare const ctx: { autodev: {
  registerRouteCandidate(route: string, candidate: {
    kind: 'subagent'; provider: string; traits: readonly string[]
  }): () => void
} }

const removeCodeBuddy = ctx.autodev.registerRouteCandidate('implement', {
  kind: 'subagent',
  provider: 'codebuddy-acp',
  traits: ['code-edit', 'local-workspace', 'worktree-cwd'],
})
// Call removeCodeBuddy() when the companion Bundle unloads.
```

The ACP provider now forwards AutoDev's per-run Worktree cwd, overriding its static `cwd` and the parent session cwd. `permission: reject` will deny CodeBuddy actions that request ACP permission. Changing it to `allow` auto-answers those permission prompts; do so only after reviewing [CodeBuddy's permission system](https://www.codebuddy.ai/docs/cli/permissions) and using the managed Worktree. A working directory is not an OS sandbox, and this repository has not yet completed a real CodeBuddy/authenticated AutoDev end-to-end run.

### Ollama and FreeLLMAPI are model routes, not code-agent adapters

Use DSH's existing `@deepseek-ai/dsh-llm-pi-ai` provider directory for OpenAI-compatible model endpoints. For local [Ollama](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx), use the model ID reported by `ollama list` and a small, honest context fallback; adjust it to the server's configured context size:

```yaml
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      ollama-local:
        displayName: Ollama Local
        apiKeyEnv: DSH_OLLAMA_API_KEY # store a non-empty placeholder credential such as "ollama" in DSH
        api: openai-completions
        baseURL: http://127.0.0.1:11434/v1
        defaultContextWindow: 32768
        defaultMaxTokens: 8192
        models:
          - id: qwen3:8b # replace with an installed model ID
            name: Qwen3 8B
```

For a self-hosted [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) gateway, configure its actual listening address and choose an ID returned by its `/v1/models` endpoint:

```yaml
      freellmapi:
        displayName: FreeLLMAPI
        apiKeyEnv: DSH_FREELLMAPI_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:<configured-port>/v1
        models:
          - id: <model-id-from-v1-models>
```

The OpenAI-compatible client requires a credential value even when the local Ollama server ignores it, so keep the placeholder in DSH's credential mechanism rather than a checked-in profile. Ollama and FreeLLMAPI supply model inference; they do not provide a coding Agent's workspace tools, execution lifecycle, or AutoDev Evidence. Run an Ollama-backed Agent through a DSH Agent composition (for example, a `spawn` child inheriting a Session configured for `ollama-local`), while CodeBuddy remains an ACP Agent candidate. The route seam is extensible, but live endpoint and Agent end-to-end verification remain release checks.

<a id="work-modes-and-execution-environment"></a>
### Work modes and execution environment

Work mode answers “what engineering strategy should this Run use?” Workflow state answers “where is the Run in its lifecycle?” Execution environment answers “where does the work happen?” They are separate contracts.

| Work mode | Intent | Default plan shape |
| --- | --- | --- |
| `EXPLORE` | Understand repository structure and behavior | Read-only Agent analysis |
| `IMPACT` | Trace dependencies and change impact | Read-only Agent analysis |
| `DEV` | Implement a normal requirement | Implement → optional Build → optional Test → Jev quality review |
| `DEBUG` | Find root cause, fix, and regress | Implement/fix → optional Build/Test → quality review |
| `DATABASE` | Make schema/migration changes safely | Implement → optional Build/Test → quality review |
| `REFACTOR` | Refactor while preserving behavior | Implement → optional Build/Test → quality review |
| `TEST` | Add or improve tests and run regressions | Implement tests → optional Build/Test → quality review |
| `REVIEW` | Report concrete findings without editing | Structured read-only review |
| `RELEASE` | Assess release readiness without editing | Read-only release analysis |

The sidebar offers `AUTO` plus each explicit mode. Explicit selection always wins; auto classification is deterministic and defaults ambiguous requests to `DEV`. Newly created Runs persist the resolved mode and whether it was explicit or inferred. Older Runs without that field are interpreted as `DEV`. Workflow statuses such as `EXECUTING`, `BUILDING`, `TESTING`, and `VERIFY` remain lifecycle states, not modes.

The only execution environment implemented today is `LOCAL_WORKTREE`: a Host-managed Git Worktree. Docker, remote sandboxes, and Agent Substrate are future adapters, not current selectable options. A Worktree isolates edits from the original checkout, but is not an operating-system sandbox. Read-only modes require a route declaring `read-only` and fail/gate if Git observes changes in the Worktree; that does not contain arbitrary side effects outside the Worktree.

#### Starting from an empty Git repository

AutoDev accepts a repository whose current branch is unborn only when the working tree is genuinely empty (including no ignored files). It creates a private synthetic baseline commit object in the repository object database so Git Worktree and patch operations can work. The synthetic commit is not installed as a branch/HEAD commit, does not change global/local Git author configuration, and does not modify the user's index. Build/Test stages are omitted when no supported root driver exists, and the Environment Evidence visibly warns about that gap. A successful model-backed review is still required before `VERIFY`; promotion applies the candidate patch as ordinary untracked files and leaves the branch unborn. If you want a committed baseline, create it yourself before starting instead.

`EXPLORE`, `IMPACT`, `REVIEW`, and `RELEASE` run a single read-only Agent task, do not create a code Candidate, and do not require Build/Test drivers. Review output must be strict JSON with `verdict` and `findings`; invalid output stays `WARN` and opens a Human Gate. Their Worktrees remain isolated and auditable.

### Run and promote safely

The normal flow keeps unverified edits out of the original checkout:

1. Create a DRAFT Run from a clean committed repository or a genuinely empty unborn repository; AutoDev records a baseline, resolved mode, execution environment, and immutable Plan.
2. Review the Plan and acceptance criteria in the sidebar, then explicitly approve that exact Plan version. `autodev_run` refuses an unapproved Plan; Replan requires fresh approval.
3. Run the attempt from a live DSH Agent session in a managed Worktree, then collect Build, Test, verification, and side-effect Evidence. The sidebar does not yet start official subagent providers because they require a parent Agent.
4. Review any Human Gate, stale baseline, failed check, unresolved uncertainty, or unknown external outcome; AutoDev does not automatically retry an unknown side effect.
5. Promote only after the Host rechecks the current Plan, Candidate tree, and original repository baseline and the user explicitly approves the Gate.

Explicit cancellation and interrupted provider work remain auditable. The Host marks incomplete effects as unknown or pauses the Run when it cannot establish a safe result; it does not treat a Provider's completion claim as verification.

### State and files

By default, SQLite state and content-addressed run artifacts live below `$DSH_HOME/autodev`; `dataRoot` and `worktreeRoot` can be configured for the Bundle. The Host persists Runs, Plans, Evidence, Gate decisions, Provider decisions, and domain records. Artifact references are exposed without returning host filesystem paths through the Remote.

### Backup and restore

The package exports explicit backup and restore helpers. A backup contains a transactionally consistent SQLite snapshot and every referenced Run artifact, with a SHA-256 manifest. It excludes Git Worktrees and original repositories. Restore requires a new, nonexistent data root and rebases artifact paths; it preserves audit records, but does not promise that a Run can resume or promote without its original repository and Worktree. Active Run recovery still follows the Host's normal restart gates.

The AutoDev Sidebar also exposes both operations through the Host Remote. The operator enters the backup destination, backup source, and restore target paths; the Host rejects existing destinations, Artifact paths outside the managed root, and attempts to replace the current data directory. Before restore, the operator must type the exact new data root again, which the Host verifies. The Remote returns only the verified relative-path manifest and does not switch the running Store. To use restored data, stop the Profile and configure a later launch with the new `dataRoot`.

The SQLite Store applies ordered, transactional schema migrations at startup. Existing v1 databases are upgraded in place to v2 without dropping Run or event records; the migration history stores SQL checksums and is checked on every open. Concurrent Host startups recheck the schema under a write transaction, and a failed migration rolls back without advancing the version. Backups record the Store schema version and restore only a supported version.

```ts
import { AutoDevStore, createAutoDevBackup, restoreAutoDevBackup } from '@deepseek-ai/dsh-experimental-autodev'

declare const dataRoot: string
declare const backupPath: string
declare const restoredDataRoot: string

const store = new AutoDevStore(dataRoot)
try {
  await createAutoDevBackup(store, backupPath)
} finally {
  store.close()
}

await restoreAutoDevBackup(backupPath, restoredDataRoot)
```

The backup destination must be new and outside the live data root. Restore never overwrites an existing destination.

### Retention cleanup

The AutoDev Sidebar previews managed Worktrees without returning local paths. Only Worktrees linked to terminal Runs and older than the selected minimum age are eligible; active operations, open Gates, unsettled side effects, unsafe paths, and shared paths are protected. The preview fingerprint is stable while its relevant Run, Candidate, Gate, ActionIntent, and filesystem identity remain unchanged.

Cleanup is an explicit two-step operation: select at most 10 Worktrees, persist a path-free Cleanup Job, then review it and type the Job-bound confirmation phrase. The Host rechecks Run eligibility and Git ownership/status before each removal. It only runs non-forced `git worktree remove`; it never falls back to recursive filesystem deletion. If a Worktree is dirty, unregistered, outside the managed root, or otherwise ambiguous, the Job stops that item and records a path-free failure code. Jobs survive Host restarts and can reconcile a Worktree removed just before a crash. Run, Event, Evidence, Artifact, and repository history are not deleted; the empty per-Run parent directory may remain.

AutoDev reads the call-bound Context injected by Gateway and never accepts an actor from Client arguments. DSH operator calls are labeled `dsh-operator`; Host-internal calls and automated actions are labeled separately. Peer ID is only a connection reference, not a person or account. Plan approvals, Gate decisions, ActionIntent authorization/results, and Cleanup Job preparation/confirmation/cancellation are persisted in the existing SQLite append-only event stream; the Sidebar displays the latest 100 Run audit events and the Cleanup Job event history. Current DSH provides a local-operator trust model, not named accounts or multi-user RBAC. Personal approver attribution requires a trusted principal minted by Gateway's authentication layer and unavailable to Client input.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Bundle patch in [`cordis.patch.yml`](./cordis.patch.yml) inserts the Host and Client rows into a DSH profile. The Host owns state transitions and persistence; Typert Remote snapshots cross the process boundary; the Client can read those snapshots and submit only bounded actions.

The main ownership boundaries are:

- [`src/runtime.ts`](./src/runtime.ts) coordinates Runs, Gates, retries, Evidence, and promotion preconditions.
- [`src/store.ts`](./src/store.ts), [`src/git.ts`](./src/git.ts), and [`src/side-effects.ts`](./src/side-effects.ts) own durable records, Worktrees, and side-effect intent/result tracking.
- [`src/protocol.ts`](./src/protocol.ts), [`src/router.ts`](./src/router.ts), and [`src/verification.ts`](./src/verification.ts) normalize Provider messages, select routes, and validate completion Evidence.
- Domain services own scoped Memory, Concepts, Playbooks, Assumptions, Uncertainty, Knowledge regression, and compaction; the Client renders Host snapshots.

`cordis.patch.yml` describes profile composition. The package manifest identifies the Bundle patch and Client injection dependencies; it does not grant the Client direct write access to SQLite or the Git checkout.

</details>

-----

<a id="public-api-contracts"></a>
## Public API Contracts

The `ctx.autodev` Host service exchanges serializable records across the Remote boundary. The package exports its shared wire and domain contracts from [`src/contracts.ts`](./src/contracts.ts); provider selection is implemented by [`src/router.ts`](./src/router.ts). These declarations are the source of truth for generated service signatures.

| Contract area | Public types | Source |
| --- | --- | --- |
| Runs and snapshots | `Run`, `AutoDevSnapshot`, `CreateRunRequest`, `ArtifactContent` | [`src/contracts.ts`](./src/contracts.ts) |
| Provider routing | `ProviderInfo`, `ProviderCatalog`, `ProviderRouter` | [`src/contracts.ts`](./src/contracts.ts), [`src/router.ts`](./src/router.ts) |
| Agent Protocol | `AutoDevAgentContext`, `AgentTask`, `AgentSignalEnvelope`, `AgentResult` | [`src/protocol.ts`](./src/protocol.ts) |
| Project Memory | `ProjectMemory`, `MemorySearchHit` | [`src/contracts.ts`](./src/contracts.ts) |
| Business Concepts and Playbooks | `BusinessConcept`, `Playbook` | [`src/contracts.ts`](./src/contracts.ts) |
| Knowledge and regression | `KnowledgeCandidate`, `KnowledgeSearchHit`, `KnowledgeRegressionCase` | [`src/contracts.ts`](./src/contracts.ts) |

These types are part of the package API, but the Host remains authoritative: Clients submit bounded intents and receive snapshots rather than writing these records directly.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Codex Provider Bundle](../../subagent/subagent-codex/README.md) explains the official Harness-owned Codex integration.
- [Claude Code Provider Bundle](../../subagent/subagent-claude-code/README.md) explains the official Harness-owned Claude Code integration.
- [Base Bundle](../../bundle/base/README.md) explains a DSH profile layer and its composition contract.
- [AutoDev Java fixture](../../../examples/autodev-java/README.md) is a small Maven project for Build/Test integration checks.

<a id="model-experience"></a>
## Model Experience

### AutoDev tools

#### What the model sees

When this Bundle is loaded, the DSH Agent receives AutoDev tools such as `autodev_create`, `autodev_run`, `autodev_status`, and `autodev_resolve_gate`; profile-loaded tool rows are omitted from the static tool catalog.

#### Token effect

Each exposed tool definition contributes schema and description text to requests that include it; arguments and returned summaries add data-dependent content, while detail tools keep large records out of routine responses.

#### KV Cache effect

The tool set remains stable for an unchanged profile and tool composition. Adding or removing this Bundle changes that request surface; the selected Provider controls actual cache behavior.

### Agent context cards

#### What the model sees

An implementation task can include scope-matched Memory, versioned Business Concept, Playbook, Run-local Assumption, Semantic Uncertainty, and Knowledge cards. Each card retains identifiers and relevant status/version, source, and Evidence references. Only Plan-linked Concepts are included; Assumptions and Uncertainties are limited to the current Run. Candidate, proposed, unknown, and open states remain explicitly labeled rather than being promoted to facts. The same optional `dsh.agent.v1` context fields reach custom Providers and the official Harness Subagent prompt, and the captured `AutoDevAgentContext` records the content sent to the Provider.

#### Token effect

AutoDev caps all six card groups together at 6,000 characters per attempt and the Agent Protocol validates the limit at the Provider boundary; current scope, Plan references, record status, search results, and record content determine how much of that budget is used. The new context fields are optional, so existing `dsh.agent.v1` adapters that do not read them remain compatible.

#### KV Cache effect

Project records and retrieval results can change these supplemental cards between attempts. AutoDev does not promise provider cache hits or a fixed cache lifetime.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Real Codex, Claude Code, and Jev end-to-end checks require credentials and a target DSH profile; offline tests do not certify those external paths.
- Build-driver detection and command construction have offline coverage, but each supported driver still needs a real-project success and failure check before release claims are complete.
- On Windows, Maven and Gradle run through their standard Wrapper JARs using direct `java.exe` argv; AutoDev never executes `.cmd`/`.bat` wrappers. A wrapper JAR is required unless a directly executable custom binary is configured. The shell-free launch path has a Java-backed wrapper smoke test, but this does not certify a real Maven or Gradle project build.
- The sidebar can create, review, and approve Plans; start or rework a Run through a DSH Session whose working directory matches the repository; invoke every currently allowed Human Gate action; resolve semantic uncertainties; confirm, invalidate, or mark assumptions unknown; version human Business Concept corrections; review Knowledge merge proposals; manage Knowledge regression cases and suites; promote a Candidate only with trusted PASS Evidence and fresh passing regressions; inspect compaction reports and restore only while recorded versions remain unchanged; and create, revise, activate, or deprecate versioned Playbooks. It can also compare two Candidate revisions from the same Run side by side, including each revision's Diff, Plan/Attempt/tree metadata, Verification, and Candidate Evidence. Knowledge promotion and compaction require explicit confirmation, while the Host remains authoritative for scope, freshness, and state changes. Plan re-review is required after semantic or Playbook changes, and Host rejects those changes during active execution. Assumption confirmation requires selecting current-Run trusted PASS Evidence, with Host-side validation remaining authoritative. Run Promotion has a second confirmation with Candidate, verification, and Evidence summary. Authenticated DSH Web and real official Codex/Claude Code execution are still unverified; browser E2E and approval-actor identity remain release gates.
- Knowledge mutation tools use the DSH tool-call ID as an idempotency key: replaying the same committed call returns the current snapshot without writing twice, while a new explicit call can create a new regression case, suite result, or compaction report. The UI similarly assigns a unique operation ID per confirmed action; retrying a failed operation requires a new ID.
- CodeBuddy and Ollama require separately installed adapters. The generic registration contract does not imply first-party support.
- Promotion is intentionally explicit. A changed baseline, changed Candidate, missing Evidence, or unresolved Gate blocks writes to the original checkout.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
