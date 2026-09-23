# DeepSeek Harness AutoDev

AutoDev 是一个可恢复、可审计、默认不直接污染用户工作区的 DeepSeek Harness Bundle。它把一次软件工程请求拆成不可变 Plan，在 Git Worktree 中调用 Harness 已加载的 Coding Agent Provider，执行确定性的构建/测试，再由用户明确确认后 Promotion 回原仓库。

## 当前交付范围

- Host Bundle：Cordis Service、SQLite 持久化、事件记录、Artifact 内容寻址、Git Worktree、Maven 构建/测试、Human Gate、Promotion。
- Agent 路由：默认接入 Harness 官方 `codex`、`claude-code`、`spawn` Provider；Provider 通过注册表动态发现，不把调用写死在 AutoDev 主流程。
- Agent Protocol：ProviderRouter 的 Codex、Claude Code、命令行和未来本地适配器统一映射为 `AgentTask`、`AgentContext`、`AgentResult` 和 `AgentSignal`；未知 Signal 会被安全保留为 `UnknownSignal`，不会直接成为完成事实。
- 领域学习闭环：`ProjectMemoryService` 提供项目隔离、摘要检索、详情读取和压缩；`BusinessConceptService` 记录 Observation、Target/Effect/Evidence 语义和人类纠正；`PlaybookService` 提供版本化套路与 Fit Check；`KnowledgeService` 管理 Candidate、证据晋级、使用统计、过期、Compaction 和 Regression。
- SideEffect Boundary：Agent Worktree、Build/Test 命令、Knowledge Promotion、Git Promotion 都先写入 `ActionIntent`，经过 Precondition/Authorization/Idempotency 后执行并记录 `SideEffectRecord`；UNKNOWN 结果不会自动重试。
- Jev：支持 `required`、`advisory`、`off` 三种模式；Jev 不可用时，`required` 会暂停并打开 Gate，`advisory` 会记录降级证据并使用确定性回退。
- Web Client：通过 Typert Remote 暴露运行列表、完整快照、Provider/Route 目录、有限的 Gate 操作和受限 Candidate Diff；右侧 Sidebar 可通过 `/autodev` 打开。
- Model Tools：基础运行工具之外，还提供 `autodev_memory_search/detail`、`autodev_semantic_state`、`autodev_resolve_assumption/uncertainty`、`autodev_concepts/concept_detail`、`autodev_playbooks/playbook_detail`、`autodev_knowledge/knowledge_detail`、`autodev_knowledge_compact/promote`。摘要与详情分离，避免把全量历史注入 Agent。

v1 的确定性 Driver 是 Maven；非 Maven 项目仍可以使用路由、Worktree、持久化与 Gate 基础设施，但应在后续 Driver 中补充 Gradle/npm 等构建策略，而不是在当前实现中猜测构建命令。

## 架构边界

```text
Harness Loader
    └── autodev Bundle
          ├── AutoDevRuntime (Cordis/Typert Host Service)
          │     ├── AutoDevStore (node:sqlite + WAL)
          │     ├── GitManager (baseline/worktree/tree/diff/promotion)
          │     ├── ProviderRouter (动态 Provider/Route 注册表)
          │     ├── AgentProtocol (规范化任务、结果与 Signal)
          │     ├── DecisionCoordinator (Jev + fallback policy)
          │     ├── SemanticService (Assumption / Uncertainty)
          │     ├── ProjectMemoryService + BusinessConceptService
          │     ├── PlaybookService (version + fit)
          │     ├── KnowledgeService (promotion + compaction + regression)
          │     ├── SideEffectService (intent ledger + idempotency)
          │     └── Maven Driver (build/test + drift evidence)
          ├── Model-facing tools
          └── Client Bundle
                └── Typert Remote + Web Sidebar panel
```

Host 是唯一权威状态源。Client 只读取快照并提交有限动作，不能自行推断 Run 状态，也不能绕过 Host 直接写数据库或仓库。Verification 只接受绑定当前 Plan/Candidate 的 Evidence；Agent 自报的 PASS、Playbook 匹配和 Knowledge Candidate 都不会直接改变完成状态。

## 在 Harness 源码树内构建

在 `deepseek-harness` 根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm exec tsc -b tsconfig.host.json
pnpm exec tsc -b tsconfig.client.json
pnpm exec tsdown --env.DSH_BUILD_FACE host
pnpm exec tsdown --env.DSH_BUILD_FACE client
pnpm --filter @deepseek-ai/dsh-experimental-autodev test
```

发布文件由 `package.json.files` 明确列出，包含入口、Hash chunk、source map、Remote/Host 声明、类型、patch、README 和许可证；至少包括：

- `lib/index.js`、`lib/types/**/*.js`、`lib/types/**/*.d.ts`
- `lib/typert.host.js`、`lib/typert.host.d.ts`
- `lib/typert.remote-client.js`、`lib/typert.remote-client.d.ts`
- `lib/client.js`
- `lib/*.js`、`lib/*.map`（包含拆分后的路由 chunk）
- `cordis.patch.yml`、本 README 和 `LICENSE`

## 安装为 DSH Bundle

在源码树中，Bundle 的 Patch 文件是 `cordis.patch.yml`。使用临时 profile 验证安装：

```powershell
$env:DSH_HOME = "C:\path\to\temporary-dsh-home"
pnpm dsh plugin --profile autodev add .\packages\experimental\autodev
pnpm dsh --profile autodev --dump-config
```

正常使用时，确保官方插件已经加载：

- `@deepseek-ai/dsh-subagent-codex`
- `@deepseek-ai/dsh-subagent-claude-code`

AutoDev 会通过 Harness 的 Subagent Runtime 发现它们；没有加载的 Provider 会出现在路由拒绝证据中，不会被伪装成可用。

升级或移除 Provider/AutoDev Bundle 后重启对应 Profile；Loader 的配置文件更新不等于当前进程已经加载新 Provider。

## 最小配置

配置键由 Bundle 传入 `apply(ctx, config)`：

```json
{
  "dataRoot": "C:/Users/me/.dsh/autodev",
  "worktreeRoot": "C:/Users/me/.dsh/autodev/worktrees",
  "maxAttempts": 2,
  "commandTimeoutMs": 60000,
  "buildTimeoutMs": 600000,
  "testTimeoutMs": 600000,
  "qualityMinScore": 70,
  "jev": {
    "mode": "advisory",
    "endpoint": "https://api.typesafe.ai/v1/systemone",
    "model": "jev",
    "apiKeyEnv": "TYPESAFE_API_KEY",
    "timeoutMs": 15000,
    "retryCount": 1,
    "sendPaths": false
  },
  "maven": {
    "executable": "mvn",
    "buildArgs": ["-q", "-DskipTests", "package"],
    "testArgs": ["-q", "test"]
  },
  "routes": {
    "implement": {
      "requiredTaskTraits": ["code-edit", "local-workspace"],
      "minConfidence": 0.55,
      "candidates": [
        { "kind": "subagent", "provider": "codex", "traits": ["code-edit", "local-workspace"] },
        { "kind": "subagent", "provider": "claude-code", "traits": ["code-edit", "local-workspace"] },
        { "kind": "command", "provider": "ollama", "traits": ["code-edit", "local-workspace"] }
      ]
    }
  }
}
```

`DSH_HOME/autodev/autodev.sqlite` 保存 Run、Plan、NodeExecution、Evidence、RouteDecision、JevDecision、HumanGate、Agent Signal 和事件；大文本与补丁放在同一数据根下的内容寻址 Artifact 目录。

## 动态添加 CodeBuddy / Ollama / 其他 Provider

AutoDev 的对外调用不是一个固定的 `if/else`。第三方 Bundle 可以在加载后注册 Provider，并把它加入一个新 Route：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { ProviderRunRequest, ProviderRunResult } from '@deepseek-ai/dsh-experimental-autodev'

export function apply(ctx: Context): void {
  const autodev = ctx.get('autodev') as {
    registerProvider(provider: {
      name: string
      kind: 'command' | 'model' | 'subagent'
      traits: readonly string[]
      isAvailable?: () => boolean | Promise<boolean>
      run(request: ProviderRunRequest): Promise<ProviderRunResult>
    }): () => void
    router: {
      registerRoute(name: string, policy: {
        candidates: readonly { kind: 'command' | 'model' | 'subagent'; provider: string; model?: string; traits?: readonly string[] }[]
        requiredTaskTraits?: readonly string[]
        minConfidence?: number
      }): () => void
    }
  }

  const removeProvider = autodev.registerProvider({
    name: 'ollama',
    kind: 'command',
    traits: ['code-edit', 'local-workspace'],
    isAvailable: async () => true,
    async run(request) {
      // 这里调用本地 Ollama/CodeBuddy 适配器；必须只在 request.cwd 中工作。
      return {
        provider: 'ollama',
        status: 'completed',
        output: `adapter completed: ${request.request}`,
      }
    },
  })

  const removeRoute = autodev.router.registerRoute('local-agent', {
    requiredTaskTraits: ['code-edit', 'local-workspace'],
    candidates: [{ kind: 'command', provider: 'ollama', traits: ['code-edit', 'local-workspace'] }],
  })

  ctx.effect(() => () => {
    removeRoute()
    removeProvider()
  })
}
```

真实适配器应负责：命令白名单、超时、输出上限、工作目录限制、退出码映射和可重复的 `ProviderRunResult`。不要让适配器直接修改原始仓库；AutoDev 只把 `request.cwd` 的 Worktree 交给 Provider。

## 一次运行的安全边界

1. `autodev_create` 要求目标仓库干净，并记录不可变 baseline commit、环境指纹和 Plan。
2. `autodev_run` 在独立 Worktree 执行实现、Maven build、Maven test 和完成判定；每个真实副作用先建立 ActionIntent。
3. 每个阶段写入 Evidence；检测到 baseline drift、构建/测试失败、质量分数低于 `qualityMinScore`、需要人工复核、Jev required 不可用或达到尝试上限时，Run 进入 Human Gate，Worktree 保留。
4. `autodev_promote` 重新检查原仓库仍然干净且 HEAD 未变化，然后只应用已验证 Candidate patch。
5. 取消或放弃不会删除证据；清理 Worktree 应由后续明确的运维命令完成。

进程在 Agent、Build、Test 或 Promotion 中断并重启时，正在运行的节点会变成 `UNKNOWN`，Run 进入 Human Gate；系统不会因为重启而自动重试外部 Agent。每次显式 Rework/Retry 会从 baseline 创建新的 `attempt-N` Worktree，保留旧 Worktree 供审查。

## 测试与验收

`tests/core.spec.ts` 与 `tests/domain.spec.ts` 覆盖：

- SQLite 持久化、事件和 Artifact 内容寻址；
- Agent Protocol 适配、Signal 顺序封装、未知 Signal 降级和 Snapshot 持久化；
- Jev HTTP 成功、advisory fallback、required Gate、质量评分和非法 `noul` 答案门禁；
- 异步健康检查和动态 Ollama 路由；
- 真实 Git bare baseline / Worktree / tree hash / diff / promotion；
- fake Maven build/test 和完整 `create → run → VERIFY → promote` 闭环。
- Project Memory 跨项目隔离与预算检索、Assumption/Uncertainty 生命周期、Business Concept 人工纠正、Playbook Fit/版本、Knowledge 证据晋级/Compaction/Regression/使用统计、SideEffect 幂等与 UNKNOWN 禁止自动重试、Runtime SemanticUncertainty Gate。

Java 示例位于仓库根目录的 `examples/autodev-java`；发布前校验记录位于 `RELEASE-VERIFICATION.zh.md`。没有外部凭据时，测试使用离线 Jev fallback、Harness Subagent fake 和 fake Maven executor；这不能替代真实 Codex、Claude Code 或 Jev E2E。

在交付前还应检查 `lib/typert.remote-client.*`、`lib/client.js` 已生成，并用临时 DSH profile 执行 `--dump-config`，确保 Loader 能看到 `autodev` Bundle。
