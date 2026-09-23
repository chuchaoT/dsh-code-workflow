# DeepSeek Harness AutoDev

AutoDev is a resumable, auditable DeepSeek Harness Bundle for software-engineering runs. It creates an immutable plan, executes the implementation inside a Git Worktree through the Coding Agent Providers already loaded by Harness, runs deterministic Maven build/test stages, and requires an explicit promotion before touching the original checkout.

The Host owns all authoritative state. The Web Client consumes Typert Remote snapshots and can perform only bounded gate actions. The implementation is intentionally provider-neutral: official `codex`, `claude-code`, and `spawn` adapters are defaults, while CodeBuddy, Ollama, or another local/remote adapter can register dynamically through `ProviderRouter.register()` and `registerRoute()`.

## Delivered surfaces

- Cordis/Typert Host service with SQLite/WAL persistence and event history.
- Git baseline checks, isolated Worktrees, tree hashes, bounded diffs, drift checks, and guarded promotion.
- Provider/route registry with Jev-assisted selection and deterministic fallback.
- Agent Protocol with normalized AgentTask/Context/Result and structured Signals; unknown signals remain non-authoritative.
- Project-scoped Memory, Business Concepts, versioned advisory Playbooks, Assumptions/Semantic Uncertainty, and evidence-backed Knowledge evolution/compaction/regression.
- ActionIntent/SideEffect ledger for Agent workspaces, commands, knowledge promotion, and Git promotion; unknown outcomes are never automatically retried.
- Jev modes: `required`, `advisory`, and `off`.
- Maven build/test driver with bounded output and timeouts.
- Human Gates for failures, missing providers, Jev outages, uncertainty, and attempt limits.
- Jev quality scoring after deterministic Build/Test checks; low scores or `needs_review` can only add a Human Gate, never override a failed build or test.
- Model tools: `autodev_create`, `autodev_run`, `autodev_status`, `autodev_routes`, `autodev_promote`, `autodev_resolve_gate`, `autodev_cancel`, plus bounded memory/semantic/concept/playbook/knowledge detail and maintenance tools.
- Web sidebar opened with `/autodev`, backed by generated Typert Remote artifacts and a bounded path-free Candidate Diff view.

The first deterministic driver is Maven. Adding Gradle/npm drivers should be done as separate driver implementations rather than guessing commands in the runtime.

## Build

From the `deepseek-harness` root:

```powershell
pnpm install --frozen-lockfile
pnpm exec tsc -b tsconfig.host.json
pnpm exec tsc -b tsconfig.client.json
pnpm exec tsdown --env.DSH_BUILD_FACE host
pnpm exec tsdown --env.DSH_BUILD_FACE client
pnpm --filter @deepseek-ai/dsh-experimental-autodev test
```

The package manifest publishes the Host, Remote, Client, type, patch, README, and license artifacts explicitly. Install the official Harness subagent packages as well when the built-in `codex` or `claude-code` routes are needed.

See [README.zh.md](./README.zh.md) for configuration, a complete dynamic-provider example, installation, and the security/promotion contract.

The repository also contains a runnable Java 17 + Maven + JUnit fixture at `examples/autodev-java`. `RELEASE-VERIFICATION.zh.md` records the build, package, profile-composition, and offline contract checks, plus the external credential gates that still require a target machine.
