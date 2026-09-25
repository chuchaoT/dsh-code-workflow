# DeepSeek Harness AutoDev 项目介绍

> 本文介绍 `deepseek-harness` 仓库中的 `@deepseek-ai/dsh-experimental-autodev` 项目：它是什么、如何接入 DSH、内部如何运行、如何扩展 Provider，以及当前已经验证到什么程度。
>
> - 文档版本：2026-09-23
> - 项目包：`@deepseek-ai/dsh-experimental-autodev@0.1.0`
> - 所属仓库：`deepseek-harness`
> - 源码目录：`packages/experimental/autodev`

## 1. 一句话结论

AutoDev 是 DeepSeek Harness（以下简称 DSH）中的一个可安装 Bundle，用于把一次软件工程请求变成可恢复、可审计、可验证、可人工接管的工程执行 Run。

它不是独立的 Agent Framework，也不是只负责编排步骤的 Workflow Engine。它复用 DSH 已有的 Cordis Loader、Subagent Runtime、Subprocess Runtime、Tools、Typert Remote、Web Client 和 Profile 机制，在这些基础设施之上增加软件工程执行领域的状态、证据、隔离工作区和晋级规则。

当前实现已经可以真实挂载到 DSH：

- DSH `plugin` 命令可以把 AutoDev 安装进一个 Profile。
- DSH `dump-config` 可以解析并显示 AutoDev Bundle 的 patch。
- DSH 真实 `runProfile()` 可以启动 AutoDev Host Service，并取得 `AutoDevRuntime`。
- AutoDev 的 Remote、Model Tools、持久化和动态 Provider/Route 注册都在 DSH Host 内生效。
- DSH 仓库中官方 Codex 与 Claude Code Provider 的 Loader E2E 测试均已通过。

“真实接入 DSH”与“真实调用外部 Codex/Claude Code/Jev 服务”是两个不同层次。当前环境已验证前者；后者仍需要目标机器上的外部凭据、原生运行时和网络条件，因此本文会单独标出，不把离线或 Loader 验证冒充成外部服务 E2E。

## 2. 项目解决什么问题

普通 Coding Agent 的典型流程是：接收需求、修改工作区、执行命令、告诉用户“完成”。这在小任务上足够，但在持续的软件工程任务中会遇到几个问题：

1. 需求、计划、执行和最终完成判断容易混在一起。
2. Agent 自己报告“完成”不能代替构建、测试和审查证据。
3. Agent 直接修改用户当前分支时，失败、取消、崩溃和重试都可能污染工作区。
4. 进程重启后，外部 Agent 或命令到底执行到了哪一步，不能被安全地假设为成功或失败。
5. 业务术语、假设、历史经验和一次性上下文容易混为一谈。
6. 新增 CodeBuddy、Ollama 或其他本地工具时，如果核心流程写死 Provider，会导致每次扩展都要改 Runtime。
7. 结果如果没有来源、版本、证据和有效期，就不能安全地沉淀成项目知识。

AutoDev 的核心做法是把“执行”当作一个由 Host 掌权的、持久化的、证据驱动的 Run：

```text
Goal        = 用户想达到的目标
Plan        = 针对一次 Run 的不可变执行计划
Execution   = 在受控 Worktree 中发生的实际动作
Evidence    = Host、命令、Agent、Jev 或人工产生的可追溯事实
Verification= Host 根据证据做出的确定性验收
Promotion   = 用户明确确认后，才把 Candidate 应用回原仓库
```

其中任何一层都不能伪装成另一层：计划不是完成事实，Agent 输出不是验证证据，知识候选不是已确立知识，Jev 建议也不能绕过确定性门禁。

## 3. 项目边界与定位

### 3.1 当前负责的内容

- 创建并持久化软件工程 Run。
- 捕获 Git 仓库的 clean baseline、HEAD 和环境指纹。
- 生成不可变 PlanVersion 及其 `implement → build → test → review` 节点。
- 在独立 Git Worktree 中执行 Coding Agent。
- 通过 DSH 官方 `ctx.subagents` 调用 Codex、Claude Code、spawn 等 Subagent Provider。
- 通过动态 Provider Registry 调用命令行、本地模型或第三方适配器。
- 执行确定性的 Maven build/test Driver。
- 保存 Evidence、Agent Signal、Jev Decision、Artifact、Gate 和 Side Effect Ledger。
- 在语义不确定、外部结果未知、质量不足、验证失败或发生漂移时暂停并等待人工决策。
- 只有在当前 Candidate 通过所有必需验证并且原仓库仍满足 Promotion 前置条件时，才允许 Promotion。
- 通过 Project Memory、Business Concept、Playbook 和 Knowledge Evolution 形成项目级学习闭环。

### 3.2 当前不负责的内容

- 不替换 DSH 的通用 Agent Loop、Session、Goal、Tools 或 Profile Loader。
- 不把 Codex 或 Claude Code 的底层协议重新实现一遍；调用交给 DSH 官方 Provider Bundle。
- 不在 AutoDev 内保存第三方 API Key。
- 不把任何 Agent 的自报 PASS 直接变成 Host 的完成事实。
- v1 不猜测所有语言的构建命令；当前确定性 Driver 是 Maven。
- 不把 CodeBuddy、Ollama 等第三方工具硬编码到核心 Runtime；它们通过 Provider/Route 接口接入。

非 Maven 项目仍然可以使用 AutoDev 的 Run、Worktree、Evidence、Gate、Memory 和 Promotion 基础设施，但需要后续增加 Gradle、npm、pytest 或其他 Build/Test Driver。

## 4. DSH 真实接入方式

### 4.1 AutoDev 是 DSH Bundle，不是旁路脚本

AutoDev 包通过 `package.json` 声明 DSH Bundle patch：

```json
{
  "name": "@deepseek-ai/dsh-experimental-autodev",
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

`cordis.patch.yml` 的当前核心内容是把 AutoDev 插入 DSH 配置树：

```yaml
- insert:
    - id: autodev
      name: '@deepseek-ai/dsh-experimental-autodev'
```

DSH 启动时会按照以下链路解析和加载：

```text
dsh CLI
  └─ $DSH_HOME/profiles/<profile>/package.json
       └─ dsh.profile.bundles
            └─ @deepseek-ai/dsh-experimental-autodev
                 └─ cordis.patch.yml
                      └─ Cordis Loader
                           └─ AutoDev Bundle apply(ctx, config)
                                ├─ AutoDevRuntime
                                ├─ Model Tools
                                ├─ Typert Remote Service
                                └─ AutoDevStore / Git / Router / Jev
```

### 4.2 Host、Client 和 Remote 的职责

| 层 | 主要职责 | 是否权威 |
|---|---|---|
| DSH Loader / Cordis Host | 解析 Profile、挂载插件、管理生命周期 | 是 |
| `AutoDevRuntime` | Run 状态机、计划、执行、验证、Gate、Promotion | 是 |
| `AutoDevStore` | SQLite WAL、记录、Artifact 索引、事件 | 是 |
| Model Tools | 让模型创建 Run、执行 Run、查看状态、处理 Gate | 否；动作仍由 Host 授权 |
| Typert Remote | 向 Web Client 暴露受限读写接口 | 否；只调用 Host |
| Web Sidebar | 展示 Snapshot、证据、信号、Gate、Diff 和学习状态 | 否 |
| Provider Adapter | 把某个外部 Agent 或命令翻译成统一协议 | 否；不能决定完成 |

Client 不直接访问数据库，不直接修改仓库，不自行推断 Run 状态，也不能绕过 Host 的 Evidence、Side Effect 和 Promotion 检查。

### 4.3 实际接入验证记录

本次在 Windows 本地仓库中使用隔离的临时 `DSH_HOME` 完成了以下验证：

#### A. 通过 DSH Plugin Manager 安装本地 AutoDev Bundle

```powershell
$env:DSH_HOME = "<临时 DSH_HOME>"
pnpm dsh plugin --profile autodev add .\packages\experimental\autodev
```

实际结果：

```text
+ @deepseek-ai/dsh-experimental-autodev link:D:/codex/deepseek-harness/packages/experimental/autodev
Done in ... using pnpm v11.7.0
```

这证明安装走的是 DSH 自己的 Profile 包管理入口，而不是直接 import AutoDev 源码。

#### B. 通过 DSH `dump-config` 解析 Bundle

```powershell
pnpm dsh --profile autodev --dump-config
```

输出中实际出现：

```text
# == @deepseek-ai/dsh-experimental-autodev
- id: autodev
  name: '@deepseek-ai/dsh-experimental-autodev'
```

这证明 Profile manifest、Bundle 声明、patch 文件和 DSH Loader 的解析链路已经连通。

#### C. 在真实 DSH `runProfile()` 中启动 AutoDev

通过 `apps/cli/src/profile-boot.ts` 的真实 `runProfile()` 启动 Profile，并检查：

```text
DSH_RUNTIME_BOOT=PASS AutoDevRuntime routes=... providers=0
```

这证明 AutoDev 已经在 DSH Host 中执行 `apply()`，并且 `ctx.get('autodev')` 返回真实的 `AutoDevRuntime` 实例，而非只存在于配置输出中。

#### D. 在 DSH Host 内动态注册 Provider 和 Route

在同一个真实 Host Context 中调用：

```ts
runtime.registerProvider({
  name: 'dsh-smoke-provider',
  kind: 'command',
  traits: ['code-edit', 'local-workspace'],
  run: async request => ({
    provider: request.provider,
    status: 'completed',
    output: request.request,
  }),
})

runtime.router.registerRoute('dsh-smoke-route', {
  candidates: [{
    kind: 'command',
    provider: 'dsh-smoke-provider',
    traits: ['code-edit', 'local-workspace'],
  }],
  requiredTaskTraits: ['code-edit', 'local-workspace'],
})
```

实际结果：

```text
DSH_AUTODEV_DYNAMIC_ROUTE=PASS
```

这证明未来新增 CodeBuddy、Ollama 或内部 Agent 时，可以通过插件注册，不需要修改 AutoDev Runtime 主流程。

#### E. DSH 官方 Codex / Claude Code Provider Loader E2E

使用仓库正确的 E2E Vitest 配置运行：

```powershell
pnpm exec vitest run --config vitest.e2e.config.ts `
  packages/subagent/subagent-codex/tests/loader-composition.e2e.ts `
  packages/subagent/subagent-claude-code/tests/loader-composition.e2e.ts
```

实际结果：

```text
Test Files  2 passed (2)
Tests       2 passed (2)
```

这验证了 DSH 官方 Provider Bundle 自身可以通过 Loader 注册到 `ctx.subagents`；AutoDev 通过 `ctx.subagents` 使用这些 Provider，而不是维护另一套 Codex/Claude Code 调用协议。

### 4.4 验证范围的边界

上面的验证已经确认：

- AutoDev 包可被 DSH Profile 安装。
- AutoDev patch 可被 DSH Loader 解析。
- AutoDev Host Runtime 可在真实 DSH Context 中启动。
- AutoDev Remote Service 和动态路由可在 DSH 内工作。
- DSH 官方 Codex / Claude Code Provider Bundle 的 Loader Composition 通过。

下面这些仍然需要目标机器上的真实条件，当前不能宣称已经通过：

- 真实 Codex App Server 启动、登录和一次完整代码修改。
- 真实 Claude Code SDK 启动、登录和一次完整代码修改。
- Jev 真实 HTTP `POST /v1/systemone` 请求与服务端返回。
- 真实 Maven/JUnit 依赖下载及目标项目构建。
- Windows Desktop 打包后安装、升级、卸载和重启后的 E2E。

这些是外部环境门禁，不是 AutoDev Bundle 与 DSH 的加载链路缺失。

## 5. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│ DSH CLI / Desktop / Web                                     │
│  Profile Manager → Cordis Loader → Host Context             │
└──────────────────────────────┬──────────────────────────────┘
                               │ mount Bundle
┌──────────────────────────────▼──────────────────────────────┐
│ AutoDev Bundle                                               │
│                                                              │
│  AutoDevRuntime                                               │
│   ├─ Run / PlanVersion / NodeExecution state machine          │
│   ├─ ProviderRouter + AgentProtocol                           │
│   ├─ DecisionCoordinator + Jev fallback                        │
│   ├─ Evidence / Verification / HumanGate                       │
│   ├─ Git Worktree / Candidate / Promotion                      │
│   ├─ SemanticService                                           │
│   ├─ ProjectMemoryService + BusinessConceptService             │
│   ├─ PlaybookService + KnowledgeService                         │
│   └─ SideEffectService                                         │
│                                                              │
│  AutoDevStore                                                  │
│   ├─ SQLite WAL records                                        │
│   ├─ Content-addressed Artifacts                               │
│   └─ Append-only domain events                                 │
│                                                              │
│  Model Tools + Typert Remote + Client Sidebar                  │
└───────────────┬──────────────────────────┬───────────────────┘
                │                          │
       DSH Subagent Runtime          DSH Subprocess Runtime
       codex / claude / spawn        Maven / CLI / local adapter
```

### 5.1 核心设计原则

1. **Host 掌权**：状态、证据、授权、验证和 Promotion 都由 Host 决定。
2. **Worktree 隔离**：Agent 默认不直接修改用户当前 checkout。
3. **Evidence 优先**：完成状态必须由当前 Plan/Candidate 的证据证明。
4. **未知即未知**：进程崩溃、网络断开、命令超时或副作用无法确认时进入 `UNKNOWN`，不猜成功。
5. **人工纠正优先**：人工确认的 Business Concept、Assumption Resolution 和 Gate Decision 优先级高于 Agent 候选。
6. **渐进式上下文**：Agent 只收到有限 Memory/Playbook 引用，详情通过受限 Tool/Remote 按需读取。
7. **扩展不改核心**：Provider、Route、Build/Test Driver 和知识策略通过接口扩展。
8. **历史与当前分离**：旧 Plan、旧 Candidate、旧 Evidence 不自动证明新版本完成。

## 6. 代码结构

源码位于 `packages/experimental/autodev/src`，主要模块如下：

| 文件 | 职责 |
|---|---|
| `index.ts` | DSH Bundle 入口、`apply(ctx, config)`、公开导出 |
| `runtime.ts` | AutoDev 主运行时、状态机、Remote、Run 执行和 Gate |
| `contracts.ts` | Run、Plan、Evidence、Memory、Concept、Playbook、Knowledge 等 JSON-safe 契约 |
| `store.ts` | SQLite WAL、领域记录、事件、Snapshot 和 Artifact 索引 |
| `router.ts` | Provider Registry、动态 Route、Jev 辅助选择、Command Provider 和 DSH Subagent 适配 |
| `protocol.ts` | `dsh.agent.v1` Agent Protocol、AgentTask、AgentContext、AgentResult、AgentSignal |
| `jev.ts` | Jev HTTP Provider、Static Provider、决策问题、fallback 和答案校验 |
| `verification.ts` | Evidence 到 Verification 的确定性计算 |
| `git.ts` | baseline、Worktree、tree hash、diff、Promotion 和 drift 检查 |
| `command.ts` | DSH Subprocess 封装、超时、输出限制和命令结果映射 |
| `semantics.ts` | Assumption 与 SemanticUncertainty 生命周期 |
| `memory.ts` | 项目隔离 Memory、渐进检索、预算限制和压缩 |
| `concepts.ts` | Business Concept Observation、匹配和人工纠正 |
| `playbook.ts` | Playbook 创建、激活、版本、Fit Check 和废弃 |
| `knowledge.ts` | Knowledge Candidate、证据晋级、使用统计、过期、Compaction 和 Regression |
| `side-effects.ts` | ActionIntent、SideEffectRecord、幂等和 UNKNOWN 处理 |
| `tools.ts` | Model-facing AutoDev Tools 注册 |
| `src/client/*` | Web Sidebar、Remote Client、Snapshot 展示和本地化 |

测试位于 `packages/experimental/autodev/tests`：

- `core.spec.ts`：Run 状态机、Git、Provider、Jev、Evidence、Promotion、重启恢复等核心链路。
- `domain.spec.ts`：Memory、Assumption、Uncertainty、Business Concept、Playbook、Knowledge、Side Effect 和 Runtime Signal 集成。

仓库还包含 DSH 官方 Provider 的实现和 Loader 测试：

- `packages/subagent/subagent-codex`
- `packages/subagent/subagent-claude-code`
- `packages/subagent/subagent-spawn-in-process`

## 7. 一次 AutoDev Run 的完整生命周期

### 7.1 Create：建立不可变基线

调用 `autodev_create` 后，Runtime 会：

1. 解析目标目录并定位 Git 根目录。
2. 检查目标仓库是否干净。
3. 捕获 baseline commit、工作树状态和环境指纹。
4. 创建 Run，初始状态从 `DRAFT` 进入 `READY`。
5. 创建 PlanVersion 和节点执行记录。
6. 保存 `REPOSITORY_BASELINE` 与 `ENVIRONMENT` Evidence。
7. 可选地记录 `goalId`，但 Goal 仍由 DSH GoalService 管理，Run 仍是 AutoDev 的执行聚合。

### 7.2 Execute：在独立 Worktree 中调用 Agent

调用 `autodev_run` 后，Runtime 会：

1. 从 baseline 创建专用 Worktree。
2. 将有限的 `AgentContext` 交给 Provider：Run、Project、Plan、Node、Attempt、Evidence 引用、Memory 引用和 Playbook 引用。
3. 通过 ProviderRouter 选择 Provider。
4. 通过 AgentProtocol 规范化任务、结果和 Signal。
5. 为 Agent Worktree 副作用创建 ActionIntent。
6. 把 Agent 输出记录为不可信的 `AGENT_OUTPUT` Evidence。
7. 将 `SemanticUncertainty`、`AssumptionRaised`、`PlaybookMismatch`、`VerificationFailed` 等 Signal 持久化，并按规则打开 Gate。
8. Agent 正常完成且 Worktree tree hash 可确认时，封存 Candidate。

### 7.3 Build/Test：确定性命令验证

当前 v1 Driver 使用 Maven：

```text
BUILD: mvn -q -DskipTests package
TEST:  mvn -q test
```

实际参数可通过 `maven.buildArgs`、`maven.testArgs` 和 `maven.executable` 配置。

每个命令执行前先写 ActionIntent，结束后记录：

- 命令参数和工作目录。
- 退出码、signal、超时信息。
- stdout/stderr Artifact。
- BUILD/TEST Evidence。
- SIDE_EFFECT Evidence。
- 执行前后 tree hash，用于检测命令漂移。

如果 Build/Test 修改了已封存 Candidate 的 tracked 文件，Runtime 会记录 `DRIFT` 失败并进入 Gate。

### 7.4 Verify：五项必需验证

当前默认 Verification 包含五项 required check：

| Check | 必需证据 | 说明 |
|---|---|---|
| Baseline | `REPOSITORY_BASELINE` | 执行前必须捕获 clean baseline |
| Build | `BUILD` | 当前 Candidate 必须通过构建 |
| Test | `TEST` | 当前 Candidate 必须通过测试 |
| Review | `REVIEW` | 质量/审查结果必须满足策略 |
| Side Effect | `SIDE_EFFECT` | 所有外部/工作区副作用必须有已知 PASS 结算 |

验证时，Build、Test、Review 和 Side Effect Evidence 必须绑定当前 Candidate；旧 Candidate 或旧 Plan 的 PASS 不能证明新 Candidate 完成。

Agent 自己产生的 `EvidenceProduced` 只会成为来源为 `agent` 的不可信事实，不能单独让 Verification 通过。

### 7.5 Promotion：明确确认后回写原仓库

当 Run 进入 `VERIFY` 后，仍不能自动修改用户原仓库。调用 `autodev_promote` 时，Runtime 会再次检查：

- 当前 Run 已有通过的 Verification。
- Candidate patch 仍然可读取。
- 原仓库 HEAD 没有变化。
- 原仓库仍然满足 clean / drift 前置条件。
- Promotion ActionIntent 已授权并且幂等键未发生冲突。

Promotion 成功后 Run 进入 `PROMOTED`，并写入 `PROMOTION` 与 `SIDE_EFFECT` Evidence。Promotion 过程中如果结果未知，Run 进入 `NEEDS_INTERVENTION`，不会自动重复执行。

### 7.6 失败、重启和人工 Gate

以下情况会进入 `NEEDS_INTERVENTION` 或保留明确的失败状态：

- Provider 不可用或没有满足 Route traits。
- 外部 Agent 返回 `unknown`、异常退出或进程消失。
- Agent 发送语义不确定性或要求人工决策。
- Build/Test 失败或命令产生 drift。
- Jev 为 required 但不可用、答案非法或置信度不足。
- Review 质量分数低于 `qualityMinScore`。
- 验证缺少证据或只找到旧 Candidate 证据。
- 达到最大尝试次数。

进程在 Agent、Build、Test 或 Promotion 中断时，正在执行的节点会被恢复为 `UNKNOWN`，不会因为重启而自动重试外部副作用。只有用户显式选择 Retry、Rework、Replan、Promote、Abandon 或 Cancel，状态机才会继续。

## 8. Agent Protocol 与 Provider 路由

### 8.1 统一协议

AutoDev 对外使用 `dsh.agent.v1`：

```text
AgentTask
  ├─ protocolVersion
  ├─ runId / planVersionId / nodeId / attempt
  ├─ kind / instruction / acceptanceCriteria
  └─ workspacePath

AgentContext
  ├─ projectKey / repoRoot / baseCommit
  ├─ planVersionId / nodeId / attempt
  ├─ evidenceIds
  ├─ memoryRefs
  └─ playbookRefs

AgentResult
  ├─ provider / status / output / diagnostic
  └─ artifactIds / signals

AgentSignalEnvelope
  ├─ sequence / taskId / runId / nodeId / provider
  └─ normalized AgentSignal
```

未知 Signal 不会被丢弃，也不会改变完成状态；它会被规范化为 `UnknownSignal` 并保留原始 JSON payload，便于未来协议扩展和审计。

### 8.2 内置 Route

默认 `ProviderRouter` 提供：

```text
implement:
  codex → claude-code → spawn

review:
  claude-code → codex
```

实际选择会检查：

- Provider 是否已经由 DSH Profile 加载。
- Provider kind 是否匹配。
- Provider traits 是否满足 Route 和 Node 要求。
- Provider 健康检查是否通过。
- Jev 的 Route 建议是否在允许候选集合内。
- Provider 的执行结果是否可确定。

Route 选择失败会产生 RouteDecision 和拒绝原因，不会假装调用了不存在的 Provider。

### 8.3 DSH 官方 Codex / Claude Code Provider

AutoDev 不直接启动 Codex 或 Claude Code。它通过 DSH 的 `ctx.subagents`：

```text
AutoDev ProviderRouter
      └─ DSH SubagentRuntime
           ├─ @deepseek-ai/dsh-subagent-codex
           ├─ @deepseek-ai/dsh-subagent-claude-code
           └─ @deepseek-ai/dsh-subagent-spawn-in-process
```

这些包由 DSH 自己维护真实的官方协议、进程生命周期、权限模式、凭据清理和失败诊断。AutoDev 只负责把软件工程任务映射成统一 Agent Protocol，并消费规范化结果。

## 9. 动态扩展 CodeBuddy、Ollama 和其他 Provider

### 9.1 扩展接口

第三方 DSH Bundle 可以在 AutoDev 加载后取得 `ctx.autodev`，注册一个 Provider 和一个 Route：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { commandProvider } from '@deepseek-ai/dsh-experimental-autodev'

export function apply(ctx: Context): void {
  const autodev = ctx.autodev

  const removeProvider = autodev.registerProvider(commandProvider({
    name: 'ollama',
    executable: 'ollama',
    args: request => [
      'run',
      'qwen2.5-coder',
      request.request,
    ],
    traits: ['code-edit', 'local-workspace'],
    timeoutMs: 10 * 60 * 1000,
    maxOutputBytes: 512 * 1024,
  }))

  const removeRoute = autodev.router.registerRoute('local-agent', {
    requiredTaskTraits: ['code-edit', 'local-workspace'],
    candidates: [{
      kind: 'command',
      provider: 'ollama',
      traits: ['code-edit', 'local-workspace'],
    }],
  })

  ctx.effect(() => () => {
    removeRoute()
    removeProvider()
  })
}
```

CodeBuddy 可以使用同样的方式，只需要把 `executable`、参数构造、可用性检查和输出解析换成 CodeBuddy 的实际 CLI/API 适配器。

### 9.2 适配器必须遵守的边界

Provider 适配器必须：

- 只在 `request.cwd` 的 Worktree 中工作。
- 使用参数数组，不拼接未经处理的 shell 字符串。
- 提供超时、取消和输出上限。
- 映射 `completed`、`error`、`aborted`、`unknown`。
- 不把原始 API Key 写入日志、Artifact 或 Snapshot。
- 不直接修改原始仓库。
- 不自行标记 Verification PASS。
- 在无法确认外部副作用时返回 `unknown`。

### 9.3 为什么采用“动态路由”而不是固定 if/else

动态路由把变化隔离在三个注册表中：

```text
Provider Registry  = “有哪些可用执行后端”
Route Registry     = “哪些任务可以使用哪些后端”
Agent Protocol     = “无论后端是谁，Runtime 如何理解结果”
```

因此新增 CodeBuddy/Ollama 时，不需要把 `if provider === 'ollama'` 分散到 Runtime、Verification、UI 和 Store；只要实现 Provider、注册 Route，Runtime 继续消费统一协议。

## 10. Evidence、Verification 和可审计性

### 10.1 Evidence 类型

当前 Evidence 覆盖：

- `REPOSITORY_BASELINE`
- `ENVIRONMENT`
- `AGENT_OUTPUT`
- `BUILD`
- `TEST`
- `REVIEW`
- `JEV_DECISION`
- `DRIFT`
- `PROMOTION`
- `VERIFICATION`
- `SIDE_EFFECT`
- `MEMORY`
- `CONCEPT`
- `PLAYBOOK`
- `KNOWLEDGE`

每条 Evidence 可以关联：Run、Plan、Node、Candidate、tree hash、Artifact、来源和父 Evidence。

### 10.2 Evidence 的信任层次

```text
Agent 自报结果
      ↓ 仅作为待验证事实
Host 命令/文件/Git/测试结果
      ↓ 形成可重复证据
Verification Policy
      ↓ 只接受当前 Candidate 的必需 PASS
Run = VERIFY / PROMOTING
```

Jev 可以帮助选择 Provider、建议失败动作、评分质量或判断完成倾向，但 Jev 的结论也必须受到确定性规则约束。例如 Jev 建议 `ready_for_verify`，但 Test Evidence 缺失时，Runtime 仍然不能完成。

### 10.3 当前 Candidate 绑定

这是实现中非常重要的安全规则：

- 新一次 Rework 会产生新的 Candidate。
- 新 Plan 产生新的 PlanVersion。
- Build/Test/Review/Side Effect 证据绑定 Candidate。
- Verification 查询时会过滤旧 Candidate 证据。
- 旧 Candidate 通过不等于新 Candidate 通过。

这避免了“第一次实现通过测试，第二次实现修改后却复用了旧测试证据”的错误。

## 11. Project Memory、Business Concept、Playbook 和 Knowledge

### 11.1 Project Memory

`ProjectMemoryService` 提供项目级的、可追溯的经验记忆：

- 按 `projectKey` 隔离项目。
- 支持 `fact`、`rule`、`experience`、`hypothesis`。
- 每条 Memory 保存 scope、来源、Evidence、置信度、版本和有效期。
- 搜索返回摘要和引用，不把所有历史内容一次性塞入 Agent Context。
- 需要详情时通过 `memory_detail` 按需读取。
- 支持过期和压缩，保留历史关系。

### 11.2 Assumption 与 SemanticUncertainty

Assumption 是显式假设，SemanticUncertainty 是尚未解决的语义不确定性。

例如：

```text
“退款”是否意味着全额原路退回？
“删除用户”是否同时删除审计记录？
“完成”是否包含部署到生产环境？
```

Agent 可以提出假设和不确定性，但不能偷偷选择一种业务含义继续完成。高影响的不确定性会在 Build/Test 前打开 Gate；用户或其他授权方通过 Remote/Tool 解决后，Run 才能继续。

### 11.3 Business Concept

Business Concept 是项目中的业务语义身份，而不是代码实现猜测。它记录：

- 稳定 key 和名称。
- 定义。
- Target：作用对象。
- Effect：业务效果。
- Observation 的来源和 Evidence。
- Candidate / Established / Deprecated 状态。

Agent 只能提出 Candidate。`correctConcept` 代表显式人类纠正，会记录最高优先级的人类来源引用，并建立修正后的 Concept 版本。

### 11.4 Playbook

Playbook 是可复用的工程套路或领域执行模板：

- 每个 Playbook 有 scope、key、purpose、steps、requiredEvidence 和适用 Concept。
- `fit` 只给出 `MATCH`、`PARTIAL` 或 `MISMATCH`，默认是建议，不会替代 Runtime 决策。
- Playbook 支持版本化修改。
- 新版本建立后，旧版本被标记为 `DEPRECATED`，保留历史关系。

### 11.5 Knowledge Evolution

Knowledge 的生命周期为：

```text
OBSERVED → CANDIDATE → ESTABLISHED → DEPRECATED
```

只有具备 Evidence，并且可选地通过 Regression Case 的 Knowledge 才能晋级。系统还记录：

- 使用次数。
- 成功/失败次数。
- 最近使用和最近验证时间。
- 过期时间。
- superseded 关系。
- Compaction 合并动作。
- Regression 结果。

因此一次成功 Run 不会自动把所有推断永久写成真理；它先成为 Candidate，经过证据和回归验证后再变成项目知识。

## 12. Side Effect Boundary

AutoDev 对有副作用的动作采用两阶段记录：

```text
ActionIntent
  → Preconditions / Authorization / Idempotency
  → start
  → commit / fail / unknown
  → SideEffectRecord + Evidence
```

当前主要纳入边界的动作包括：

- Agent Worktree 文件修改。
- Maven Build/Test 命令。
- Knowledge Promotion。
- Git Promotion。

每个动作可以使用幂等键，避免重试时重复执行。以下结算不会自动重试：

- `UNKNOWN`
- 已经 `COMMITTED`

这条规则尤其适用于外部 Agent、网络请求、支付/部署类扩展和 Git Promotion：不确定时先让人确认，而不是为了“自动完成”重复产生副作用。

## 13. 持久化和目录布局

默认数据根目录为 DSH Home 下的 AutoDev 子目录，实际可通过 `dataRoot` 和 `worktreeRoot` 配置。

```text
$DSH_HOME/
└─ autodev/
   ├─ autodev.sqlite       # Run、Plan、Evidence、Gate、Signal、Knowledge 等
   ├─ artifacts/            # 内容寻址的 stdout、stderr、diff、诊断
   └─ worktrees/
      ├─ <run-id>/          # 首次执行的 Worktree
      ├─ <run-id>-attempt-2/
      └─ ...
```

SQLite 使用 WAL；Store 同时写入领域记录和事件，便于恢复、审计和后续 Projection。Worktree 默认保留，以便人工查看失败尝试的现场；清理应是明确的运维动作，不由失败路径偷偷删除。

## 14. Model Tools、Remote 和 Web UI

### 14.1 Model Tools

核心工具包括：

- `autodev_create`
- `autodev_run`
- `autodev_status`
- `autodev_list`
- `autodev_routes`
- `autodev_promote`
- `autodev_resolve_gate`
- `autodev_cancel`

领域工具包括：

- `autodev_memory_search`
- `autodev_memory_detail`
- `autodev_semantic_state`
- `autodev_resolve_assumption`
- `autodev_resolve_uncertainty`
- `autodev_concepts`
- `autodev_concept_detail`
- `autodev_observe_concept`
- `autodev_correct_concept`
- `autodev_playbooks`
- `autodev_playbook_detail`
- `autodev_knowledge`
- `autodev_knowledge_detail`
- `autodev_knowledge_compact`
- `autodev_knowledge_promote`

所有查询都尽量采用“摘要 → 详情”的渐进方式，并对 limit、字符数、Artifact 大小和作用域做限制。

### 14.2 Typert Remote

Host Remote 提供：

- Run 列表和完整 Snapshot。
- Provider/Route 目录。
- Candidate Diff、Artifact 和 Evidence 查询。
- Memory、Concept、Playbook、Knowledge 查询。
- Assumption/Uncertainty 解决。
- Gate、Cancel、Rework、Replan、Promotion 等受限动作。

Remote 的返回值来自 Host Snapshot；Client 不保存第二份权威状态。

### 14.3 Web Sidebar

客户端通过 `/autodev` Sidebar 展示：

- Run 状态和当前 Plan。
- Node attempts、Provider、Route Decision。
- Build/Test/Review/Jev/Side Effect Evidence。
- Agent Signals。
- Human Gates。
- Candidate Diff。
- Memory、Concept、Playbook、Knowledge 和 Compaction 摘要。

Diff Remote 只返回受限内容，并且不把 Worktree 的绝对路径直接暴露给浏览器。

## 15. 最小配置示例

AutoDev 的配置通过 DSH Profile patch 传给 `apply(ctx, config)`。下面是说明性配置，实际部署时应按目标 Profile 调整路径和 Provider：

```yaml
- id: autodev
  name: '@deepseek-ai/dsh-experimental-autodev'
  config:
    dataRoot: 'C:/Users/me/.dsh/autodev'
    worktreeRoot: 'C:/Users/me/.dsh/autodev/worktrees'
    maxAttempts: 2
    commandTimeoutMs: 60000
    buildTimeoutMs: 600000
    testTimeoutMs: 600000
    qualityMinScore: 70
    maven:
      executable: mvn
      buildArgs: ['-q', '-DskipTests', package]
      testArgs: ['-q', test]
    jev:
      mode: advisory
      endpoint: 'https://api.typesafe.ai/v1/systemone'
      model: jev
      apiKeyEnv: TYPESAFE_API_KEY
      timeoutMs: 15000
      retryCount: 1
      sendPaths: false
    routes:
      implement:
        requiredTaskTraits: [code-edit, local-workspace]
        minConfidence: 0.55
        candidates:
          - kind: subagent
            provider: codex
            traits: [code-edit, local-workspace]
          - kind: subagent
            provider: claude-code
            traits: [code-edit, local-workspace]
          - kind: command
            provider: ollama
            traits: [code-edit, local-workspace]
```

Jev 模式：

| 模式 | 行为 |
|---|---|
| `off` | 不请求 Jev，使用确定性策略 |
| `advisory` | Jev 可用时参与决策；不可用时记录 fallback，不阻断确定性流程 |
| `required` | Jev 不可用、答案非法或置信度不足时打开 Gate |

密钥只应来自 DSH 凭据机制或环境变量引用，不应写入 Profile patch、日志、Artifact 或前端 Bundle。

## 16. 从源码安装和运行

### 16.1 构建

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @deepseek-ai/dsh-experimental-autodev typecheck
pnpm --filter @deepseek-ai/dsh-experimental-autodev bundle
pnpm run build:lib
```

### 16.2 安装到隔离 DSH Profile

```powershell
$env:DSH_HOME = 'C:\Users\me\.dsh-autodev-dev'
pnpm dsh plugin --profile autodev add .\packages\experimental\autodev
pnpm dsh --profile autodev --dump-config
```

需要官方 Provider 时：

```powershell
pnpm dsh plugin --profile autodev add @deepseek-ai/dsh-subagent-codex
pnpm dsh plugin --profile autodev add @deepseek-ai/dsh-subagent-claude-code
```

新增、移除或更新 Bundle 后必须重启 Profile。只更新 manifest 不会把新 JavaScript 模块热加载进当前进程。

### 16.3 运行 DSH Profile

```powershell
pnpm dsh --profile autodev
```

AutoDev 是 Web/Host 组合中的服务和工具，实际使用时通常从 DSH Web/Desktop 会话调用 `autodev_create` 和 `autodev_run`。如果当前 Profile 没有真实 Codex/Claude Code Provider，Route 会给出“Provider 未加载”的拒绝证据，而不会静默回退成假执行。

## 17. Java 示例工程

仓库根目录的 `examples/autodev-java` 是最小 Java 17 + Maven + JUnit 示例，用于验证：

- Git baseline。
- Worktree 隔离。
- Maven Build/Test。
- Candidate Diff。
- Evidence。
- 显式 Promotion。

示例使用方式：

```powershell
cd examples\autodev-java
mvn -q test
git init
git add .
git commit -m baseline
```

然后在 DSH 会话中调用：

```text
autodev_create
repo_path: <examples/autodev-java 的绝对路径>
request: 为 Calculator 增加 multiply(int left, int right)，并补充一个 JUnit 测试
acceptance_criteria: multiply(4, 3) == 12
```

接着调用 `autodev_run`，检查 Build/Test Evidence、Candidate Diff 和 Human Gate，最后只有在确认后调用 `autodev_promote`。

## 18. 测试和验收状态

### 18.1 AutoDev 包级验证

| 验证项 | 结果 |
|---|---|
| AutoDev TypeScript typecheck | 通过 |
| AutoDev Vitest | 22/22 通过 |
| Host bundle | 通过 |
| Client bundle | 通过 |
| `pnpm run build:lib` | 通过 |
| 公开导出 smoke test | 通过 |
| `git diff --check` | 通过 |
| npm tarball 内容审计 | 通过 |

22 项测试覆盖：

- SQLite、事件、Artifact 和 Snapshot。
- Agent Protocol、Signal 顺序、未知 Signal。
- Jev 成功、fallback、required Gate、质量分数和非法答案。
- 动态 Provider、Route 和命令 Provider。
- Git baseline、Worktree、tree hash、Diff 和 Promotion。
- Maven/JUnit fake Driver。
- 重启恢复、最大尝试次数和 UNKNOWN 禁止自动重试。
- Evidence Verification 和当前 Candidate 绑定。
- Project Memory、Assumption、SemanticUncertainty。
- Business Concept 人工纠正。
- Playbook Fit 和版本。
- Knowledge Promotion、Compaction、Regression 和使用统计。
- Side Effect 幂等和 UNKNOWN 处理。

### 18.2 DSH 集成验证

| 验证项 | 结果 |
|---|---|
| `dsh plugin --profile autodev add <local package>` | 通过 |
| `dsh --profile autodev --dump-config` 看到 AutoDev row | 通过 |
| 真实 `runProfile()` 拿到 `AutoDevRuntime` | 通过 |
| DSH Host 内动态注册 Provider/Route | 通过 |
| 官方 Codex Provider Loader Composition | 通过 |
| 官方 Claude Code Provider Loader Composition | 通过 |
| 真实 Codex/Claude Code 外部代码修改 | 待目标机凭据 |
| Jev 真实 HTTP E2E | 待目标机凭据 |

测试时出现的 Node SQLite ExperimentalWarning、Windows 非当前平台 native package warning 和环境中的 SOCKS proxy warning 不影响上述成功结果；它们是运行环境提示，不是 AutoDev Loader 或 Runtime 失败。

## 19. 已知限制与后续实现顺序

### P0：目标机外部环境验收

- 配置 Codex/Claude Code 身份和原生运行时。
- 配置 Jev API Key，完成 required/advisory 真实请求。
- 在锁定 Harness commit 上执行真实 Java/Maven Run。
- 验证真实外部 Agent 的修改、取消、超时和 UNKNOWN 结算。

### P1：构建 Driver 扩展

- Gradle。
- npm/pnpm。
- pytest。
- 可插拔的 Build/Test/Review Driver 契约。

### P2：知识质量和检索

- 更严格的项目版本和模块作用域匹配。
- 更精细的 Knowledge 过期策略。
- Regression Suite 的批量执行和趋势。
- Embedding/全文检索适配器，但仍保持摘要/详情分离。

### P3：安全和运维

- 细化 ActionIntent 的权限策略。
- Promotion 前的用户身份和审计签名。
- Worktree 保留/清理策略。
- 长任务的资源预算、并发和租约。

### P4：产品体验

- Web 中的 Plan 审阅和逐节点执行视图。
- Concept/Assumption/Knowledge 的人工管理页面。
- Gate 解决历史、Diff 对比和失败尝试导航。
- Provider 健康状态和凭据诊断。

这些后续工作不需要推翻当前架构；它们应继续沿用 Host-owned State、Evidence、Agent Protocol、Remote Snapshot 和动态 Registry。

## 20. 新开发者阅读顺序

建议按照以下顺序理解项目：

1. 阅读本文的第 4、5、7、8 节，理解 DSH 接入链路、架构和生命周期。
2. 阅读 `packages/experimental/autodev/src/contracts.ts`，掌握公共数据模型。
3. 阅读 `packages/experimental/autodev/src/runtime.ts`，理解状态机和 Host 边界。
4. 阅读 `router.ts` 与 `protocol.ts`，理解 Provider 扩展和统一任务协议。
5. 阅读 `verification.ts`、`git.ts`、`side-effects.ts`，理解不能绕过的安全门禁。
6. 阅读 `memory.ts`、`concepts.ts`、`playbook.ts`、`knowledge.ts`，理解项目学习闭环。
7. 阅读 `tools.ts` 和 `src/client`，理解模型与 UI 的可观察接口。
8. 运行 `tests/core.spec.ts` 与 `tests/domain.spec.ts`，再执行 DSH Profile 安装和 `dump-config`。
9. 最后阅读 DSH 官方 Provider 的 README 和 Loader E2E，配置真实 Codex/Claude Code。

## 21. 项目文件索引

- AutoDev 源码：`packages/experimental/autodev/src`
- AutoDev 测试：`packages/experimental/autodev/tests`
- DSH Bundle patch：`packages/experimental/autodev/cordis.patch.yml`
- AutoDev 中文 README：`packages/experimental/autodev/README.zh.md`
- 发布验证记录：`packages/experimental/autodev/RELEASE-VERIFICATION.zh.md`
- Java 示例：`examples/autodev-java`
- DSH CLI：`apps/cli`
- DSH Profile / Bundle Loader：`packages/boot/app-boot`、`packages/boot/plugin-manager`
- DSH Subagent Runtime：`packages/subagent/subagent`
- Codex Provider：`packages/subagent/subagent-codex`
- Claude Code Provider：`packages/subagent/subagent-claude-code`
- Agent Protocol 相关 DSH 包：`packages/typert`、`packages/core`、`packages/subagent`

## 22. 最终判断

从工程集成角度，AutoDev 已经是真正的 DSH 插件：它通过 DSH 的 Profile Bundle 机制安装，通过 Cordis Loader 挂载，在 DSH Host Context 中创建 Runtime、Tools 和 Remote，并可以使用 DSH 的官方 Subagent Provider 或后续动态注册的第三方 Provider。

从外部产品调用角度，当前还不能把“已能加载官方 Provider 包”写成“已完成真实 Codex/Claude Code 业务 E2E”。真实业务 E2E 需要目标机器上的登录态、凭据、网络、原生进程和目标仓库。这个区别已经在代码、测试和发布说明中明确保留。

因此当前项目状态应表述为：

> DSH 集成链路已真实接通，AutoDev 本地实现和离线验收已完成；外部 Provider/Jev 的真实调用属于下一步目标机发布门禁。
