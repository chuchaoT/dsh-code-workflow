---
description: "为需要隔离 Agent 执行、证据验证、人工晋级或可扩展 Provider 路由的用户，在 DSH Profile 中加入可恢复、可审计的软件工程流程。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-autodev

[English](README.md) | 中文

## 概述

AutoDev 为 DeepSeek Harness Profile 增加可恢复的软件工程流程。它在 Git Worktree 中运行 Coding Agent，支持显式工程模式，并在可用时使用项目对应的 Build/Test Driver 检查变更；晋级到原始工作区前必须显式批准。它也支持没有首个提交、没有 Git 作者身份配置的真正空仓库。AutoDev 复用 Harness 已加载的 Codex 和 Claude Code Provider，也允许通过注册契约添加其他 Provider。Host 持有权威持久状态；Sidebar 是受限客户端，不负责裁决执行或晋级。

## 目录

- [使用此包](#use-this-package)
- [工作模式与执行环境](#work-modes-and-execution-environment)
- [了解实现](#understand-the-implementation)
- [公开 API 契约](#public-api-contracts)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

当 DSH 任务需要隔离的编码尝试、可验证的构建和测试证据、可审阅的项目知识或显式晋级边界时，适合选择 AutoDev。它不是 DSH Agent Runtime、代码托管服务或模型 Provider 的替代品。

### 安装到 Profile

在 `deepseek-harness` 仓库根目录构建此包，并将 Bundle 添加到临时 Profile。将 `DSH_HOME` 指向临时目录，避免验证过程修改常用的 DSH 安装。

```powershell
$env:DSH_HOME = "C:\path\to\temporary-dsh-home"
pnpm dsh plugin --profile autodev add .\packages\experimental\autodev
pnpm dsh --profile autodev --dump-config
pnpm dsh plugin --profile autodev remove @deepseek-ai/dsh-experimental-autodev
```

此包声明了 `dsh.bundle.patch`；Profile reconcile 会激活对应层。使用 `--dump-config` 检查组合后的 Profile。修改 Profile 后需要重启正在运行的 DSH 进程；配置变更不会热加载 Bundle。

### 你将获得什么

此 Bundle 为 DSH Profile 增加一套由 Host 管理的工作流和客户端视图：

- Git baseline 检查、每次尝试使用全新 Worktree、有界 Diff、漂移检测和受保护的晋级。
- 规范化 Agent Protocol 和动态 ProviderRouter；内置的 `codex`、`claude-code`、`spawn` 路由使用 Harness 已加载的 Provider。
- 识别根目录 Maven、Gradle、npm/pnpm/yarn/bun、pytest 项目并选择 Build/Test Driver，再将选择固化到 Plan。
- 支持九种显式或自动识别的工作模式，并与 Run 生命周期状态分离；只读模式不要求构建驱动或代码 Candidate。
- 按项目隔离的 Memory、Business Concept、Assumption、Semantic Uncertainty、版本化 Playbook 和基于证据的知识演化。
- 用于 Run、Gate、检索、纠正、回归检查和压缩的模型工具；Web Sidebar 展示 Run 快照和受限 Candidate Diff，并可并排比较同一 Run 的两个版本及其验证证据。
- 可扩展的 Jev/本地决策 Provider 链，支持 `required`、`advisory`、`off` 模式；静态降级决策不能伪造 Review PASS，也不能覆盖失败的 Build/Test Evidence。

Host 从经过检查的 Git 仓库派生项目 key。可选的 module、branch、language、project-version、schema-version、tech-stack-version 字段可缩小知识作用域；调用方不能通过这些字段将 Run 指向其他项目。

### 扩展决策 Provider

既有 `DecisionProvider` 契约可以扩展为本地模型或其他 Jev 兼容服务，无需替换路由器或 Jev HTTP 适配器。独立 DSH Bundle 可注册决策后端、指定优先级，并在卸载时撤销：

```ts
import type { DecisionProvider } from '@deepseek-ai/dsh-experimental-autodev'

declare const ctx: { autodev: { registerDecisionProvider(id: string, provider: DecisionProvider, priority?: number): () => void } }
declare const localModelAdapter: DecisionProvider

const removeLocalModel = ctx.autodev.registerDecisionProvider('local-qwen', localModelAdapter, 20)
// Bundle 卸载时调用 removeLocalModel()
```

优先级较高的 Provider 先运行；不可用、答案无效或低置信度（仅在配置阈值时）会继续尝试后续 Provider。`required` 模式在全部失败时中止，`advisory` 模式使用明确标记为不可信的静态兜底。只有真实模型决策才应返回 `source: 'jev'`；规则或静态适配器不能冒用。质量审查只有在分数达标且明确返回 `needs_review: false` 时才能生成 Review PASS。代码类 Run 的质量决策会附带最多 24,000 字节的 Candidate Diff；这可能包含私有源码，启用远程 Jev 前应确认数据处理边界。路径是否发送仍由 `sendPaths` 单独控制。除非显式配置置信度阈值，否则不会假设模型概率已经校准。该扩展点不会自动打包 Qwen 模型，也不会自动接通 DSH 的 Ollama Endpoint。

### 添加 Provider 或路由

Codex 和 Claude Code 的执行仍由 Harness 官方 Provider 包负责；AutoDev 不会重复实现其登录或子进程生命周期。独立 Bundle 可用 Runtime 的 `registerRoutedProvider(routeName, provider, candidate?)` 将自定义 Provider 和路由候选作为一个可撤销操作注册：候选添加失败时 Provider 注册会回滚，disposer 会同时移除候选和 Provider。对于已经由 Harness 加载的 ACP 等 Subagent，使用 `registerRouteCandidate(routeName, candidate)` 即可。底层 `registerProvider()`、`router.registerCandidate()` 和 `registerRoute()` 仍可用于需要更细粒度控制的集成；当前默认 Plan 使用 `implement`，独立命名路由只有被 Plan 或配置引用后才会执行。

手写的 `CustomProvider` 只有在 `run()` 的所有工作区操作都遵守本次调用的 `request.cwd` 时才能设置 `workspaceCwd: true`；否则 AutoDev 不会将它视为可用路由，直接调用也会 fail closed。Provider 声明的 traits 必须覆盖路由候选项声称的每项能力（`unknown` 对自定义适配器不是通配符）。`commandProvider()` 会自动提供 cwd 保证和 `worktree-cwd` trait。

接入 CLI 时，可用 `commandProvider()` 创建受限的 argv 适配器（不拼接 shell 命令），并通过 Harness 子进程边界执行：

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

### 通过现有 ACP Provider 接入 CodeBuddy

[CodeBuddy Code 文档提供 ACP 模式](https://www.codebuddy.ai/docs/cli/acp)（`codebuddy --acp`），因此 DSH 可以通过现有的 `@deepseek-ai/dsh-subagent-acp` 组合，而无需再实现一套子进程和登录生命周期：

DSH 会从子进程继承环境中清除凭据类变量。如果 CodeBuddy 使用 API Key 认证，必须通过 ACP 的 `env` 显式转发，并用 `!!js process.env...` 从宿主环境读取；不要把密钥写入 Profile 文件。CodeBuddy 官方文档使用 `CODEBUDDY_API_KEY`；`CODEBUDDY_INTERNET_ENVIRONMENT` 中国版设为 `internal`、iOA 版设为 `ioa`，国际版则省略（[官方身份与访问管理说明](https://www.codebuddy.ai/docs/cli/iam)）。

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

若要让它参与 AutoDev 默认的 `implement` 路由，可由配套 Bundle 动态追加已加载的 subagent：

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

ACP Provider 会将 AutoDev 每次运行指定的 Worktree cwd 传给子进程，优先级高于静态 `cwd` 和父 Session cwd。`permission: reject` 会拒绝 CodeBuddy 通过 ACP 请求授权的操作；改为 `allow` 后会自动应答这些权限请求，只有审查过 [CodeBuddy 权限系统](https://www.codebuddy.ai/docs/cli/permissions)、并确认使用托管 Worktree 后才应启用。工作目录本身不是操作系统沙箱；本仓库尚未完成真实 CodeBuddy、认证和 AutoDev 全链路测试。

### Ollama 与 FreeLLMAPI 是模型路由，不是代码 Agent 适配器

OpenAI 兼容的模型端点可以复用 DSH 已有的 `@deepseek-ai/dsh-llm-pi-ai`。[Ollama](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx) 示例使用 `ollama list` 返回的模型 ID，并设置保守的上下文容量回退；请按服务端实际配置调整：

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

自托管 [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) Gateway 则填写它实际监听的地址，并从 `/v1/models` 选择可用模型 ID：

```yaml
      freellmapi:
        displayName: FreeLLMAPI
        apiKeyEnv: DSH_FREELLMAPI_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:<configured-port>/v1
        models:
          - id: <model-id-from-v1-models>
```

OpenAI 兼容客户端即使连接到忽略认证的本地 Ollama 服务，也要求传入一个 credential 值；应将占位凭据放入 DSH 凭据机制，不要写进被提交的 Profile。Ollama 和 FreeLLMAPI 提供的是模型推理，不会提供编码 Agent 所需的工作区工具、执行生命周期或 AutoDev Evidence。应通过 DSH Agent 组合运行 Ollama 模型（例如父 Session 使用 `ollama-local`，再由继承配置的 `spawn` 子 Agent 执行）；CodeBuddy 则是 ACP Agent 路由候选项。路由扩展点已存在，但真实服务端点和 Agent 全链路仍属于发布验收项。

<a id="work-modes-and-execution-environment"></a>
### 工作模式与执行环境

工作模式回答“本次 Run 采用什么工程策略”；工作流状态回答“Run 当前处于生命周期哪一步”；执行环境回答“工作实际发生在哪里”。三者是不同层次。

| 工作模式 | 目的 | 默认计划结构 |
| --- | --- | --- |
| `EXPLORE` | 了解仓库结构与行为 | 只读 Agent 分析 |
| `IMPACT` | 追踪依赖关系和变更影响 | 只读 Agent 分析 |
| `DEV` | 实现常规需求 | 实现 → 可选 Build → 可选 Test → Jev 质量审查 |
| `DEBUG` | 定位根因、修复并回归 | 修复 → 可选 Build/Test → 质量审查 |
| `DATABASE` | 安全处理 Schema/Migration | 实现 → 可选 Build/Test → 质量审查 |
| `REFACTOR` | 保持行为兼容地重构 | 实现 → 可选 Build/Test → 质量审查 |
| `TEST` | 补充测试并运行回归 | 编写测试 → 可选 Build/Test → 质量审查 |
| `REVIEW` | 不修改文件，报告具体问题 | 结构化只读审查 |
| `RELEASE` | 不修改文件，评估发布准备度 | 只读发布分析 |

Sidebar 提供 `AUTO` 和所有显式模式。显式选择始终优先；自动分类是确定性的，无法判断时默认为 `DEV`。新 Run 会持久化解析后的模式及其来源（显式或自动）。没有这些字段的旧 Run 按 `DEV` 解释。`EXECUTING`、`BUILDING`、`TESTING`、`VERIFY` 等仍然是生命周期状态，不是模式。

目前唯一支持的执行环境是 `LOCAL_WORKTREE`（由 Host 管理的 Git Worktree）；Docker、远程沙箱和 Agent Substrate 尚未实现。Worktree 可以隔离变更与原始工作区，但不是操作系统沙箱。只读模式要求路由声明 `read-only`，并在 Git 观察到 Worktree 变更时失败或进入闸门；这不能限制 Worktree 之外的任意副作用。

#### 从空 Git 仓库开始

仅当当前分支尚无提交且工作区真正为空（包含没有 ignored 文件）时，AutoDev 才接受 unborn 仓库。它会在仓库对象库中创建一个私有合成基线提交对象，以便 Git Worktree 和补丁操作；该对象不会设置为分支/HEAD 提交，不会修改全局或本地 Git 作者配置，也不会改动用户索引。没有受支持根目录驱动时会省略 Build/Test 阶段，并在 Environment Evidence 中明确警告。进入 `VERIFY` 之前仍要求模型支持的审查通过；晋级时仅将 Candidate 补丁写成普通未跟踪文件，原分支仍然没有提交。如果你希望以提交作为基线，请先自行创建首个提交。

`EXPLORE`、`IMPACT`、`REVIEW` 和 `RELEASE` 各执行一个只读 Agent 任务，不创建代码 Candidate，也不要求 Build/Test Driver。Review 输出必须是包含 `verdict` 和 `findings` 的严格 JSON；格式无效时保持 `WARN` 并打开 Human Gate。Worktree 和执行审计仍会保留。

### 安全地运行与晋级

常规流程会阻止未经验证的改动进入原始工作区：

1. 从干净的已提交仓库或真正空的 unborn 仓库创建 DRAFT Run；AutoDev 记录 baseline、解析后的工作模式、执行环境和不可变 Plan。
2. 在侧栏审阅 Plan 与验收标准，再显式批准该版本 Plan。未批准时 `autodev_run` 会拒绝启动；Replan 后须重新批准。
3. 从有活动父 Agent 的 DSH 会话中运行本次尝试，在托管 Worktree 中收集 Build、Test、Verification 和副作用 Evidence。侧栏目前不能直接启动需要父 Agent 的官方 Subagent Provider。
4. 审阅 Human Gate、过期 baseline、失败检查、未解决的不确定性或未知外部结果；AutoDev 不会自动重试结果未知的副作用。
5. 只有 Host 重新检查当前 Plan、Candidate tree 和原仓库 baseline，且用户显式批准 Gate 后，才会执行晋级。

显式取消和被中断的 Provider 工作仍可审计。如果 Host 无法确认安全结果，会将未完成的副作用标记为 UNKNOWN，或暂停 Run；不会把 Provider 的完成声明当作验证结论。

### 状态和文件

默认情况下，SQLite 状态和内容寻址的 Run Artifact 保存在 `$DSH_HOME/autodev` 下；Bundle 也可配置 `dataRoot` 和 `worktreeRoot`。Host 持久化 Run、Plan、Evidence、Gate 决策、Provider 决策和领域记录。Remote 返回 Artifact 引用时不会暴露宿主机文件系统路径。

### 备份与恢复

包提供显式备份和恢复函数。备份包含事务一致的 SQLite 快照和所有被引用的 Run Artifact，并附带 SHA-256 清单；不包含 Git Worktree 和原始仓库。恢复必须使用一个尚不存在的新数据根目录，并会重映射 Artifact 路径。它保留审计记录，但如果原始仓库和 Worktree 不在，不能保证 Run 可续跑或晋级。活动 Run 仍遵循 Host 的常规重启恢复闸门。

AutoDev Sidebar 也通过 Host Remote 提供这两项操作。操作者输入备份目标、备份来源和恢复目标路径；Host 拒绝已存在的目标、越出安全路径范围的 Artifact，以及覆盖当前数据目录。恢复前必须再次输入完全相同的新数据根目录，Host 会验证该确认；Remote 只返回校验后的相对路径清单，不会切换正在运行的 Store。若要使用恢复的数据，请先停止 Profile，并在后续启动时将 `dataRoot` 配置为新目录。

SQLite Store 会在启动时按顺序执行事务化 schema 迁移。现有 v1 数据库会原地升级到 v2，不丢弃 Run 或事件记录；迁移历史保存 SQL 校验和，并在每次打开时核对。多个 Host 并发启动时会在写事务中重新检查 schema；迁移失败则回滚且不推进版本。备份会记录 Store schema 版本，恢复只接受当前支持的版本。

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

备份目标必须是未创建的新目录，且位于当前数据根目录之外。恢复不会覆盖已存在的目录。

### Worktree 保留清理

AutoDev Sidebar 可预览托管 Worktree，但不会向 Client 返回本机路径。只有关联 Run 已进入终态且超过所选最短保留期限，Worktree 才会进入候选；活动操作、打开的 Gate、未决副作用、不安全路径和被多个 Run 共用的路径都会受保护。只要相关 Run、Candidate、Gate、ActionIntent 和文件系统身份未变化，预览指纹就保持稳定。

清理必须经过明确的两步操作：最多选择 10 个 Worktree，先持久化一个不含路径的 Cleanup Job，再复核 Job 并输入与该 Job 绑定的确认短语。Host 会在每个 Worktree 删除前重新检查 Run 资格和 Git 所属关系/状态；只执行非强制的 `git worktree remove`，绝不回退到递归文件删除。若 Worktree 有改动、未登记、位于托管根之外或状态不明确，该项会停止并留下无路径错误码。Job 可跨 Host 重启保留，并能协调“Git 已删除但结果尚未写回”的中断。Run、Event、Evidence、Artifact 和原仓库历史都不会删除；每个 Run 的空父目录可能保留。

AutoDev 从 Gateway 注入的调用期 Context 读取 actor，不接受 Client 传入 actor。DSH operator 调用记为 `dsh-operator`，Host 内部直调与自动化执行分别记为内部/Runtime 主体；Peer ID 只作连接引用，不是自然人账号。Plan 批准、Gate 决议、ActionIntent 授权/结果以及清理 Job 准备/确认/取消写入既有 SQLite append-only 事件流，Sidebar 展示最近 100 条 Run 审计和清理作业事件。当前 DSH 只有本机 operator 信任模型，没有账号级用户身份或多用户 RBAC；需要个人审批归属时，必须先由 Gateway 提供认证层生成且不可由 Client 伪造的 principal。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节，点击展开</summary>

Bundle 补丁 [`cordis.patch.yml`](./cordis.patch.yml) 会将 Host 和 Client 行插入 DSH Profile。Host 管理状态转换和持久化；Typert Remote 快照跨越进程边界；Client 只能读取快照并提交受限操作。

主要职责边界如下：

- [`src/runtime.ts`](./src/runtime.ts) 协调 Run、Gate、重试、Evidence 和晋级前置条件。
- [`src/store.ts`](./src/store.ts)、[`src/git.ts`](./src/git.ts) 和 [`src/side-effects.ts`](./src/side-effects.ts) 分别管理持久记录、Worktree 和副作用意图/结果。
- [`src/protocol.ts`](./src/protocol.ts)、[`src/router.ts`](./src/router.ts) 和 [`src/verification.ts`](./src/verification.ts) 负责规范化 Provider 消息、选择路由和校验完成所需 Evidence。
- 领域服务管理带作用域的 Memory、Concept、Playbook、Assumption、Uncertainty、Knowledge 回归和压缩；Client 展示 Host 快照。

`cordis.patch.yml` 描述 Profile 组合方式。包清单声明 Bundle 补丁和 Client 注入依赖；它不会赋予 Client 直接写入 SQLite 或 Git 工作区的权限。

</details>

-----

<a id="public-api-contracts"></a>
## 公开 API 契约

`ctx.autodev` Host Service 会通过 Remote 边界交换可序列化记录。包共享的 Wire 和领域契约由 [`src/contracts.ts`](./src/contracts.ts) 导出；Provider 选择逻辑由 [`src/router.ts`](./src/router.ts) 实现。这些声明是生成 Service 签名时的事实来源。

| 契约领域 | 公开类型 | 来源 |
| --- | --- | --- |
| Run 与快照 | `Run`、`AutoDevSnapshot`、`CreateRunRequest`、`ArtifactContent` | [`src/contracts.ts`](./src/contracts.ts) |
| Provider 路由 | `ProviderInfo`、`ProviderCatalog`、`ProviderRouter` | [`src/contracts.ts`](./src/contracts.ts)、[`src/router.ts`](./src/router.ts) |
| Agent Protocol | `AutoDevAgentContext`、`AgentTask`、`AgentSignalEnvelope`、`AgentResult` | [`src/protocol.ts`](./src/protocol.ts) |
| 项目 Memory | `ProjectMemory`、`MemorySearchHit` | [`src/contracts.ts`](./src/contracts.ts) |
| Business Concept 与 Playbook | `BusinessConcept`、`Playbook` | [`src/contracts.ts`](./src/contracts.ts) |
| Knowledge 与回归 | `KnowledgeCandidate`、`KnowledgeSearchHit`、`KnowledgeRegressionCase` | [`src/contracts.ts`](./src/contracts.ts) |

这些类型属于包的 API，但 Host 仍是唯一权威：Client 提交受限意图并接收快照，不会直接写入这些记录。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Codex Provider Bundle](../../subagent/subagent-codex/README.zh.md)介绍 Harness 官方维护的 Codex 集成。
- [Claude Code Provider Bundle](../../subagent/subagent-claude-code/README.zh.md)介绍 Harness 官方维护的 Claude Code 集成。
- [Base Bundle](../../bundle/base/README.zh.md)介绍 DSH Profile 层及其组合契约。
- [AutoDev Java Fixture](../../../examples/autodev-java/README.zh.md)提供用于 Build/Test 集成检查的小型 Maven 项目。

<a id="model-experience"></a>
## 模型体验

### AutoDev 工具

#### 模型可见内容

加载此 Bundle 后，DSH Agent 会收到 AutoDev 工具，例如 `autodev_create`、`autodev_run`、`autodev_status` 和 `autodev_resolve_gate`；静态工具目录不包含按 Profile 动态加载的工具行。

#### Token 开销

每个暴露的工具定义都会为包含它的请求增加 Schema 和描述文本；参数和返回摘要会增加数据相关内容，而详情工具可避免在常规响应中传输大记录。

#### KV Cache 效果

Profile 和工具组合不变时，工具集合保持稳定。添加或移除此 Bundle 会改变请求表面；实际缓存行为由所选 Provider 决定。

### Agent 上下文卡片

#### 模型可见内容

实现任务可以包含按作用域匹配的 Memory、带版本的 Business Concept、Playbook、当前 Run 的 Assumption、Semantic Uncertainty 和 Knowledge 卡片。每张卡保留标识符以及相关状态/版本、来源与 Evidence 引用；Concept 仅来自当前 Plan，Assumption 和 Uncertainty 仅来自当前 Run。Candidate、PROPOSED、UNKNOWN、OPEN 等状态会明确标注，不会被提升成事实。相同的可选 `dsh.agent.v1` 上下文既会传给自定义 Provider，也会写入 Harness 官方 Subagent Prompt；捕获的 `AutoDevAgentContext` 会记录实际发送的内容。

#### Token 开销

AutoDev 将六类卡片合计限制为每次尝试 6,000 个字符，并由 Agent Protocol 在 Provider 边界再次校验；实际占用量由当前作用域、Plan 引用、记录状态、检索结果和内容决定。新增上下文字段均为可选，因此不读取它们的既有 `dsh.agent.v1` Provider 仍可兼容运行。

#### KV Cache 效果

项目记录和检索结果可能使不同尝试的补充卡片发生变化。AutoDev 不承诺 Provider 命中缓存或缓存的固定保留时间。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 真实 Codex、Claude Code 和 Jev 端到端检查需要凭据和目标 DSH Profile；离线测试不能验收这些外部路径。
- Build Driver 检测和命令构造已有离线覆盖，但在完整发布声明前，每种受支持的 Driver 仍需在真实项目中验证成功与失败路径。
- Windows 上的 Maven 和 Gradle 通过标准 Wrapper JAR 与直接 `java.exe` argv 启动；AutoDev 不执行 `.cmd`/`.bat` 包装脚本。除非配置了可直接执行的自定义二进制，否则必须提供 Wrapper JAR。Shell-free 启动路径已有基于真实 Java 的 Wrapper 主类烟测，但这不等于真实 Maven/Gradle 工程构建验收。
- Sidebar 可以创建、审阅并批准 Plan；通过工作目录与仓库一致的 DSH Session 启动或返工 Run；执行当前开放 Human Gate 允许的全部动作；解决语义不确定性；确认、判定失效或标记未知假设；保存带版本历史的 Business Concept 人工纠正；审阅 Knowledge 合并提案；管理 Knowledge 回归用例与套件；仅在可信 PASS Evidence 和新鲜回归通过时晋级 Candidate；查看压缩报告，并且只在记录版本未变化时恢复；还可以创建、修订、激活或弃用带版本历史的 Playbook。它也可并排比较同一 Run 中的两个 Candidate 版本，查看各自 Diff、Plan/Attempt/tree 元数据、验证状态和 Candidate Evidence。Knowledge 晋级和压缩需显式确认，作用域、新鲜度和状态变更仍由 Host 权威校验。语义或 Playbook 变更会要求重新审阅 Plan，执行中的 Run 会拒绝此类变更。确认假设必须选择属于当前 Run 的可信 PASS Evidence，Host 仍执行最终校验。Run Promotion 会二次确认，并展示 Candidate、验证和 Evidence 摘要。认证后的 DSH Web 与真实官方 Codex/Claude Code 执行仍未验收；浏览器 E2E、审批人身份记录仍是发布门禁。
- Knowledge 写入工具以 DSH 工具调用 ID 作为幂等键：重放同一个已提交调用只返回当前快照，不会重复写入；新的显式调用则可新建回归用例、套件结果或压缩报告。UI 也会为每次确认后的操作生成唯一 ID；失败操作如需重试，必须使用新 ID。
- CodeBuddy 和 Ollama 需要单独安装适配器。通用注册契约不代表一方正式支持。
- 晋级需要显式批准。baseline、Candidate 发生变化，Evidence 缺失或 Gate 未解决时，系统会阻止写入原始工作区。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文，点击展开</summary>

None.

</details>
