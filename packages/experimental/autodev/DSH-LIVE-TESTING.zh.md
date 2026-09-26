# AutoDev × DSH 真实集成测试记录

> 更新日期：2026-09-26（Asia/Shanghai）
> 目的：把真实 DSH 环境、已验证证据、尚未完成项和验收顺序保存在项目中；后续以本文件为准续做，不依赖对话记忆。

## 1. 验收目标与边界

在用户实际使用的 DSH Profile 中，使用非空的样例 Git 项目，逐项验证 AutoDev 九种工作模式：`EXPLORE`、`IMPACT`、`DEV`、`DEBUG`、`DATABASE`、`REFACTOR`、`TEST`、`REVIEW`、`RELEASE`。验证要覆盖计划生成、人工审批、隔离执行、构建/测试、Evidence、审查和晋级边界，并确认 Agent 路由实际符合预期：Claude Code 负责分析/只读任务，Codex 负责工程实现，CodeBuddy 可作为轻量代码生成提供方。

安全边界：每个写入类 Run 使用可恢复的 Git Worktree；不得直接改动样例项目基线；不得自动批准计划、Gate 或晋级；不得为测试发布、提交或推送代码；真实模型请求尽量每种 Agent 只做必要的最小验证，避免重复调用和额度浪费。

## 2. 环境基线与 Profile 差异

| 项目 | 已观察事实 | 验收意义 |
|---|---|---|
| DSH CLI | `C:\Users\chuchao\bin\dsh.cmd`，版本 `0.1.7-rc.1`；`dsh web --help` 显示实际形式为 `dsh --profile web` | 使用同一个全局 DSH CLI，不是另一个 DSH 源码 fork |
| `web` Profile | 已安装 `dsh-workbuddy-connect@0.6.2`，该插件负责将 WorkBuddy 桌面模型接入 DSH；同时安装 AutoDev、Claude Code、Codex，后三者 Junction 到 `D:\codex\deepseek-harness` 当前源码，版本 `0.1.7-rc.1`。当前 DSH 插件页显示 WorkBuddy 连接器及其 `llm-workbuddy` 组件为运行中，但账号状态为未登录，错误提示缺少 `WORKBUDDY_ELECTRON_BIN` | 插件包已安装/启用，但 WorkBuddy 连接器尚不可用，故当前模型选择器未能提供 Hy3；此前 `workbuddy/hy3` 的 `UNKNOWN_MODEL` 与此状态吻合。尚未设置环境变量或改配置 |
| `autodev-web` Profile | 同样使用 AutoDev、Claude Code、Codex 源码 Junction 和 `0.1.7-rc.1` 包版本，但**未安装 `dsh-workbuddy-connect`**；该 Profile 配置了 `deepseek-official/deepseek-flash`。当前 `3080` 测试页来自此 Profile | Hy3 在此 Profile 缺失是插件清单差异导致的预期结果，不是 AutoDev 移除了 Hy3；此 Profile 不能验证 WorkBuddy/Hy3 路由 |
| 兼容性提醒 | DSH CLI 报告 `@linxin666/dsh-web-all@0.4.2` 要求 DSH `>=0.1.7-rc.2`，当前是 `0.1.7-rc.1`，因此启动时拒绝该插件；UI 将其标为异常 | 与 Hy3 问题分开记录；本轮没有授权版本豁免、升级或卸载该插件 |
| 源码关系 | 没有 fork 第二份 DSH 源码；是同一份 `D:\codex\deepseek-harness` 源码被两个 DSH Profile 引用 | Profile 仍可能有不同模型清单、凭据环境、服务和依赖状态，因此必须区分“源码一致”和“运行环境一致” |

结论：Hy3 未被本次工作删除。用户指出且插件清单已核实：`autodev-web` 没有 `dsh-workbuddy-connect`，所以该 Profile 看不到 Hy3；`web` Profile 有并启用了 `dsh-workbuddy-connect@0.6.2`，但当前实例报告缺少 `WORKBUDDY_ELECTRON_BIN` 且账号未登录，所以也尚未注册 Hy3。后续若要恢复 Hy3，需找到 WorkBuddy Electron 可执行文件并在启动 DSH 的环境中配置该变量后重启；本轮没有修改系统环境或插件配置。端到端验收仍以用户实际执行 `dsh --profile web` 的 Profile 为准。

## 3. 样例仓库与基线

- 项目：`D:\codex\autodev-mode-tests\workflow-project`
- 内容：非空的静态任务看板样例，含 Node 测试与构建脚本。
- 初始 Git 基线：`095d54c`；AutoDev 创建 Run 时确认工作区干净。
- 已有本地验证：`npm test` 通过 4 项；`npm run build` 通过。
- 验收要求：每次写模式都应从同一基线创建独立 Worktree；Run 完成后记录 Candidate diff、测试 Evidence 和源工作区状态。

## 4. 已完成验证及证据

| 范围 | 结果 | 证据/限制 |
|---|---|---|
| 九模式 Runtime 行为（确定性 Provider 测试） | 通过，9/9 | 使用隔离临时 Git 仓库与 fake providers；验证各模式计划语义、写入隔离和适用的构建/测试。这不是九种模式的真实模型 E2E |
| 样例项目自身 | 通过 | `npm test` 4 项、`npm run build` 通过 |
| AutoDev Panel | 通过，9/9 | 修复前发现 `remote.providerSettings()` 缺失时组件 effect 抛 `TypeError`；现已做能力检测、显示明确提示而不再让面板崩溃，并新增 Ollama→Jev 设置保存及凭据不落库测试 |
| 现有 DSH 实例 UI | 部分通过 | 停止我启动的临时 `autodev-web` 后，浏览器回到先前已运行的 DSH；插件页显示 AutoDev、Claude Code、Codex、WorkBuddy Connect 已启用，AutoDev 设置 Remote 和 Run 详情可加载。没有改动此实例的配置 |
| AutoDev 类型检查 / 构建 | 通过 | `pnpm --filter @deepseek-ai/dsh-experimental-autodev typecheck`；`pnpm --filter @deepseek-ai/dsh-experimental-autodev bundle` |
| DSH 工具级集成（`autodev-web`） | 部分通过 | 实际调用 `autodev_create` 创建 EXPLORE Run `e221c99a-7f58-476f-8f57-2e00ea788e16`，Plan `33c62a44-9029-4a76-93e3-cd34c6bc7655` v1，状态 `DRAFT`；`autodev_routes` 返回 Codex、Claude Code、CodeBuddy 可用，spawn/fork 不可用 |
| Run 审批与 Agent 执行 | 未执行，等待人工审批 | 当前现有 DSH 页面可见 Run `e221c99a-7f58-476f-8f57-2e00ea788e16` 的 `批准此版本计划` 按钮；Plan `33c62a44-9029-4a76-93e3-cd34c6bc7655` v1 仍为 DRAFT。尚未审批、未调用 `autodev_run`、未发起真实 Agent 请求；没有改动样例源仓库。不能绕过 DSH 的精确 Plan 人工闸门 |
| Claude Code 真实服务 | 未验收 | `invalid-result` 诊断现已增加安全原因字段；尚未用真实 Claude Code 调用复现并确认根因已解决 |
| 九种模式真实 DSH 全流程 | 未完成 | 目前没有任何一份“九种模式均在用户常用 Profile 完成真实 Agent 工作流”的证据 |

## 5. 面板故障记录

2026-09-25 定向运行 `packages/experimental/autodev/tests/panel.client.spec.tsx` 时，8 个既有用例均因 `settingsRemote.providerSettings is not a function` 在挂载 effect 中抛错而失败。该问题会阻断客户端组件挂载，是面板空白的直接故障点之一。处理内容：检测 Remote 方法是否存在；缺失时在设置区提示 Profile/插件接口不匹配，并让其余 AutoDev 面板继续渲染；新增设置界面用例。修复后的该文件测试结果为 9/9，通过。

打包后刷新 `autodev-web` 页面，AutoDev 设置区和 Run 详情均已正常显示；界面读到 Ollama `qwen3:8b-fast`、Claude Code/Codex 分析路由和 Codex/Claude Code/CodeBuddy 实现候选。没有点击保存，也没有改动 Profile 设置或凭据。此页面不含 `dsh-workbuddy-connect`，因此不显示 Hy3；这不能替代 `web` Profile 的界面验收。

随后关闭我启动的临时 `autodev-web` 服务，`3080` 的先前 DSH 实例仍在，浏览器重新加载后 AutoDev Remote 和 Run 详情正常显示。查看该实例的 WorkBuddy 插件详情只读得到“未登录 / 缺少 `WORKBUDDY_ELECTRON_BIN`”，没有按“已处理，重新检查”，没有设置环境变量，也没有触发 Agent 调用。

注意：面板崩溃已由组件能力检测修复，并在两个运行页面上复核渲染；但 Profile connector 插件集不同，且当前 WorkBuddy 连接器不可用。真实 Agent 与九模式完整流程仍未验收。

## 6. 下一阶段计划与验收标准

### 阶段 0：统一真实运行环境

1. 明确用户日常 `dsh web` 实际落到的 Profile（CLI 当前给出的规范形式为 `dsh --profile web`）。
2. 仅在该 Profile 内确认 AutoDev、Claude Code、Codex、CodeBuddy 的插件装载状态和模型选择器状态；不通过另建 Profile 替代验收。
3. WorkBuddy 插件页当前明确要求设置 `WORKBUDDY_ELECTRON_BIN`；先核对实际 WorkBuddy 安装路径，再由用户决定是否修改 DSH 启动环境并重启。未获明确要求前不更改全局/用户环境变量。
4. 刷新 AutoDev 页面，确认设置 Remote 可读、面板完整显示、创建 Run 可见。

验收标准：同一 Profile 能启动；模型选择器列出预期模型；AutoDev Panel 无客户端异常；`providerSettings`/`updateProviderSettings` 两个 Remote 可用；提供配置截图/调用证据与启动日志的脱敏摘要。

### 阶段 1：只读模式真实验收

按 `EXPLORE`、`IMPACT`、`REVIEW` 顺序使用样例项目，逐个检查计划节点、Claude Code 优先路由、人工计划审批、只读执行和工作树未变化。

验收标准：每种模式有独立 Run/Plan/Agent result；满足模式特定产物；原始仓库 `git status` 与基线一致；不能以创建 DRAFT 代替执行通过。

### 阶段 2：工程实现模式真实验收

按 `DEV`、`DEBUG`、`DATABASE`、`REFACTOR`、`TEST` 顺序执行；每个 Run 使用独立 Worktree。从小任务开始，优先一次 Codex 实现验证；只对一项合适任务附加 CodeBuddy 轻量生成对比，避免重复付费调用。

验收标准：每种模式均正确生成 mode-specific Plan；工程 Agent 实际启动；改动只在该 Run Worktree；适用的 build/test Evidence 为 PASS；REVIEW 节点/质量闸门记录存在；失败必须记录为失败，不得只记录“Run 已创建”。

### 阶段 3：发布准备模式

对 `RELEASE` 生成发布准备类计划/报告，不执行 publish、commit 或 push。

验收标准：输出 diff/兼容性/变更说明/发布风险检查；无未授权外部发布动作；若不能安全形成发布结论，则明确指出缺少的 Evidence。

### 阶段 4：Agent 真实适配器专项验收

1. 使用一次最小只读项目分析调用验证 Claude Code，重点确认此前 `invalid-result` 的响应解析路径。
2. 复用阶段 2 的一次真实工程 Run 验证 Codex。
3. 只复用一项低风险小任务验证 CodeBuddy 可作为明确选择的成本较低 Provider；不把它设为静默 fallback。

验收标准：保留脱敏后的 adapter 状态/结束原因、Agent Result、Evidence、Worktree diff；不保存凭据；没有重复模型调用。

## 7. 每次续做必须追加的记录

每个新测试追加：日期时间、Profile 名称、DSH/插件版本、Run ID 与 Plan 版本、Mode、实际路由 Provider、审批状态、执行结果、Evidence/测试结果、原仓库状态、失败根因与下一步。任何 Profile 切换都要显式记录，不能把不同 Profile 的结果合并成一个通过结论。

### 2026-09-25 15:13 UTC：开始真实验收前状态核对

- 本次检查通过用户当前打开的 DSH Web 页面完成；这个页面对应的 Profile 和版本没有在本次快照中重新确认，不把它与 `autodev-web` 或 `web` 的历史检查混为一谈。
- 非空样例项目的 EXPLORE Run `e221c99a-7f58-476f-8f57-2e00ea788e16` / Plan `33c62a44-9029-4a76-93e3-cd34c6bc7655` v1 仍为 DRAFT；`analyze:0` 为 READY，尚未审批，未调用 Agent，也未修改源仓库。
- 页面当前选中的另一条旧记录是空仓库 RELEASE Run `5837f923-5f7f-4611-8ed4-f316d4ebb25e` / Plan `1be85314-2fc9-42f0-917e-d79a9cf854cf` v1，仍为 DRAFT、验证状态 UNKNOWN、无人工决议审计；它只是计划草稿，不算 RELEASE 模式已运行。
- 页面中的其它 DRAFT / NEEDS_INTERVENTION 历史条目也不能仅凭存在于列表就视为执行通过。本次没有批准任何计划，没有发起模型/Agent 请求，也没有改变 DSH 状态。
- 继续条件：先由用户在 DSH 中审阅并批准非空样例项目的 EXPLORE Plan v1；获得批准后才开始这个只读真实调用。该项通过后仍需逐模式生成并批准各自计划，不能由一次批准推导九种模式全部通过。

### 2026-09-25 15:44 UTC：EXPLORE 真实 DSH / Claude Code 执行

- 用户明确授权代为点击并启动该只读测试。DSH Operator 为 Plan `33c62a44-9029-4a76-93e3-cd34c6bc7655` v1 记入 `PLAN_APPROVAL: PASS`；批准审计时间 `15:40:52Z`。随后从当前父 Agent 会话启动 Run。
- Run `e221c99a-7f58-476f-8f57-2e00ea788e16`：Mode `EXPLORE`，仓库 `D:\codex\autodev-mode-tests\workflow-project`，基线 `095d54ca877a507595cf02432b040e278547ca16`，Host `win32/x64`，Node `v22.20.0`。
- 真实 Agent 结果：DSH 显示 `AGENT_OUTPUT: PASS — Provider claude-code completed explore task` 与 `ANALYSIS: PASS`；计划仅有只读 `analyze` 节点，节点状态 `COMPLETED`。`SIDE_EFFECT: PASS`，`JEV_DECISION: PASS — completion`。
- 验证：DSH 显示 `VERIFY`，`all 3 required verification checks passed`（REPOSITORY_BASELINE、ANALYSIS、SIDE_EFFECT）。Evidence IDs：baseline `2868d55c-7918-46ec-9279-3973ec99b3f8`；analysis `94e2e0ac-d864-41bd-a7f3-b864fbcf3cd7`；side effect `bfe6a85a-9a19-42f8-99c6-87bc0de24624`。
- 独立 Git 复核：源仓库 HEAD 仍为 `095d54c` 且 `git status --short` 为空；AutoDev Worktree `C:\Users\chuchao\.dsh\autodev\worktrees\e221c99a-7f58-476f-8f57-2e00ea788e16\attempt-1` 存在，HEAD 同为 `095d54c`，工作树干净。没有 Candidate diff，没有执行晋级或 Git commit。
- DSH 审计中的 `agent-workspace: COMMITTED` 是 AutoDev Worktree 资源动作已提交/完成的状态；它不是 Git commit。UI 当前仍显示 `VERIFY`，不将其误报为 Run 的所有后续状态均已终结。
- 本次 Profile / DSH 版本仍未从页面独立确认；执行 Agent 为 `claude-code`，而非仅凭 Provider 菜单中的 `available` 推断。运行设置显示决策后端为本地 Ollama；该结果不能证明 Jev 云服务可用。
- EXPLORE 的真实只读 Agent 调用及三项验证通过；它只验收 EXPLORE，不代表其它八种模式通过。下一步应在同一真实 DSH Profile 和样例仓库上生成下一模式的专用计划，先核对计划与隔离边界，再按用户对测试的授权通过 DSH 审批闸门运行。

### 2026-09-25 15:48 UTC：IMPACT 真实 DSH 执行

- Run `1ee7f16f-2681-4e55-b742-38a46f346cb9` / Plan `4f757998-3efc-46ea-b87c-c1b714f9aa93` v1；Mode `IMPACT`；基线仍为 `095d54c`；DSH 主机 `win32/x64`、Node `v22.20.0`。
- Plan 是只读 `impact` 节点，要求追踪实际模块/状态/数据流和测试边界、标注不存在或不确定层，不修改文件、不运行命令、不联网。用户已授权进行模式测试，DSH 记录 Plan approval `15:47:24Z`。
- Run 进入 `VERIFY`；Agent 节点 `impact: COMPLETED`；DSH 显示 `AGENT_OUTPUT: PASS`、`ANALYSIS: PASS`、`SIDE_EFFECT: PASS`、`JEV_DECISION: PASS`，且全部 3 项必需验证通过（baseline、analysis、side effect）。实际 Agent 为 **`codex`**，Evidence IDs：baseline `e2a23081-d215-46f8-892d-04bcb174688b`、analysis `425b5daa-f8f7-482c-b3eb-c20cd770f38e`、side effect `352a2575-2288-43af-9b1f-7def9572915f`。
- 源仓库 `git status --short` 为空；Run Worktree `C:\Users\chuchao\.dsh\autodev\worktrees\1ee7f16f-2681-4e55-b742-38a46f346cb9\attempt-1` 的 `git status --short` 为空，HEAD 与基线相同；无 Candidate diff、无晋级。
- **路由偏差待核实：**本次只读 IMPACT 实际走了 Codex；设置 UI 当时为“自动路由”，虽然 `review` Route 的顺序首选 Claude Code。源码显示没有显式 `preferredProvider` 时由决策后端在 eligible candidates 中选择；因此“自动路由 + Ollama 选择 Codex”是可能解释，尚未检查本次持久化 RouteDecision 的具体 reason。模式语义和 DSH Evidence 验证通过，但“分析任务实际使用 Claude Code”的策略目标本次未通过/未证实。后续报告必须分开统计模式执行和 Provider 策略，不可把 DSH 通用验证 PASS 写成全部策略验收通过。

### 2026-09-25 15:52 UTC：REVIEW 真实执行（需重测）

- Run `f2681016-fd33-4a48-9f64-3e119b9c1fe3` / Plan `6cdca37a-270e-4706-8a28-bd0bc4561ca9` v1；Mode `REVIEW`；Plan 是只读 `review` 节点，已由 DSH Operator 批准并从当前父会话启动。
- 真实 Agent 为 `codex`。`AGENT_OUTPUT: PASS`，但 `REVIEW: WARN`；Run 状态 `NEEDS_INTERVENTION`，人工闸门 `OPEN`，Verify 为 WARN（baseline/side effect PASS，review WARN）。Evidence IDs：baseline `026b8aec-4f0e-4964-b963-f92ac0cca1ef`、review `8ffd3ed4-40e8-4e4d-8bbe-b60c8bf40b71`、side effect `09a6dee8-0042-4cf3-a6f1-decdcda1116e`。
- 已读取该 Run 的原始 `agent-output` artifact（324 bytes）。Agent 返回 JSON `verdict=NEEDS_CHANGES`，唯一 low finding 是本次任务禁止运行命令且未提供文件内容，因而无法检查代码；明确说明未修改文件、未联网。由于本次测试提示本身同时禁止运行命令，这是测试输入限制造成的审查无法完成；不能把它描述成已完成的有效代码审查，也不能将 WARN 覆盖为 PASS。
- 源仓库 status 为空；Review Worktree `C:\Users\chuchao\.dsh\autodev\worktrees\f2681016-fd33-4a48-9f64-3e119b9c1fe3\attempt-1` 存在、HEAD 与 `095d54c` 一致、status 为空。未修改、未晋级。
- 下一次 REVIEW 重测需明确允许只读文件检查和安全的只读命令（如 `rg`、`Get-Content`、`git status/diff`），仍禁止写入/网络/安装；要求输出 `{"verdict":"PASS"|"NEEDS_CHANGES","findings":[...]}`，PASS 必须零 findings。保留本次 NEEDS_INTERVENTION 记录，不要对它点 `重新执行实现` 或做人工放行。

### 2026-09-26 00:08 Asia/Shanghai（2026-09-25 16:08 UTC）：REVIEW 修正版重测取消与隔离异常

- Run `1361d8a3-16b8-49f9-904f-26f5a21b5439` / Plan `3a554863-ddc7-4535-b165-62b2bc75e3bf` v1；Mode `REVIEW`；修正版提示明确允许 `rg`、`Get-Content`、`git status/diff` 等只读检查，禁止写入/构建/测试/联网，并要求结构化 JSON verdict。Plan 已在 DSH 中批准并启动。
- 当前 DSH 页面最终显示 Run `CANCELLED`；Review 节点停留在 `RUNNING`，Verify `UNKNOWN`。没有 Agent 完成结果、review Evidence、side-effect Evidence 或 `JEV_DECISION` 完成证据；因此本次 REVIEW 不能计为通过。Claude Code 进程 PID `33092` 在执行约五分钟后仍活动且进展不足，Operator 通过 DSH 的“取消运行”按钮取消，随后确认该 PID 已退出。
- AutoDev 指定 Worktree `C:\Users\chuchao\.dsh\autodev\worktrees\1361d8a3-16b8-49f9-904f-26f5a21b5439\attempt-1` 仍干净，HEAD 与基线 `095d54c` 相同。
- **隔离异常：**样例源仓库 `D:\codex\autodev-mode-tests\workflow-project` 下同时出现 Claude Code 注册的嵌套 Worktree `D:\codex\autodev-mode-tests\workflow-project\.claude\worktrees\agent-aa3337239f086dd90`，创建时间 `2026-09-25 15:58:20 UTC`。它位于源仓库目录而非本次 AutoDev 指定 Worktree；Git 将其显示为 `?? .claude/worktrees/agent-aa3337239f086dd90/`。`git worktree list --porcelain` 显示其分支 `worktree-agent-aa3337239f086dd90`、HEAD `095d54c`，并留有 `locked claude agent ... (pid 33092)`；PID 已退出。嵌套 Worktree 内文件与基线相同、状态干净，没有观察到代码差异。
- **根因已大幅收敛：**在 Claude 本地项目会话元数据中找到与 Worktree 同时创建的 Agent 记录。`Explore` 子 Agent 的 `spawnedWithWorktree=true`，其 `worktreePath` 正是 `.claude/worktrees/agent-aa3337239f086dd90`，分支为 `worktree-agent-aa3337239f086dd90`；另一个 `general-purpose` Agent（spawnDepth 2）继承了这个 worktree。结合目录命名、Git 锁的 `claude agent` 标记及 [Claude Code 官方 Worktree 文档](https://code.claude.com/docs/en/worktrees)（内部 subagent 可创建独立 Worktree，默认置于 Git 仓库根的 `.claude/worktrees/`），这不是 AutoDev 直接把 `workspaceCwd` 改成源仓库的证据，而是 Claude 在 AutoDev 提供的任务中又启动了自带 Worktree 隔离的内部 Agent。该位置可落在 Git 主仓库目录，因为 AutoDev Worktree 与源仓库共享 Git 元数据。尚未取得该次 SDK 实际 cwd 的独立运行时日志，故不把 cwd 传递标成已实测。
- 源码与安装构建交叉核对：AutoDev Router 把每 Run 的 `request.cwd` 传给 DSH `workspaceCwd`；Claude provider 解析后在 SDK options 中设置 `cwd: spec.cwd`。`web` 与 `autodev-web` 两个 Profile 安装的 AutoDev 和 Claude adapter 均为 `0.1.7-rc.1`；`autodev-web` 内 Claude Agent SDK 为 `0.3.263`。这证明安装包具备传递 cwd 的实现，但当前监听 `3080` 的 DSH 进程命令未显式携带 Profile 参数，不能仅凭包版本断言本次页面精确使用了哪个 Profile。
- Claude 内部 Worktree HEAD 与样例基线相同且内容干净；源仓库代码 HEAD 未变。Claude SDK 会话目录元数据显示 Agent 运行在 Worktree；没有读出完整对话/项目源码 transcript。取消后 DSH 仍将 `agent-workspace` 副作用显示为 `EXECUTING`，Run 虽为 `CANCELLED`，Verify 仍 `UNKNOWN`。这是 AutoDev/DSH 取消与副作用终结状态需专项跟进的观察点，不把它误报成通过。
- 测试记录及源码仓库保留原有未提交修改；未删除、移动、解锁嵌套 Worktree，未执行其它模式测试。样例源仓库代码与 HEAD 未发生变化，但它当前确实带有上述未跟踪的 Worktree 目录。
- 保留 Claude 内部 Worktree、分支及锁，不擅自清理/解锁；在 Agent/Run 取消记录核实前不再触发 Claude-backed Agent。其余模式可在独立 AutoDev Worktree 中用明确选定的 Codex Provider 继续验证，逐 Run 核对工作树基线和副作用；如遇共享源仓库状态变化立即停测。

### 2026-09-26 00:33 Asia/Shanghai（2026-09-25 16:33 UTC）：DEV 空仓库真实执行触发隔离故障，暂停写入型模式测试

- 本次选用专门新建的测试仓库 `D:\codex\autodev-mode-tests\empty-unborn-20260926`，它在 Run 前确认是没有任何提交、没有任何文件的 unborn Git 仓库；没有使用用户的 `D:\codex\test`。后者已有 4 个未跟踪文件，时间早于本轮测试，不应视为干净测试夹具或由本 Run 创建。
- DSH 页面中该仓库的会话已单独建立并绑定。最终批准的计划为 `d38bafb9-ee17-46ad-9070-132f4482debe` v1，Run 为 `8617a5b3-8e3b-4eaa-8c40-e8e09a12d925`；Mode `DEV`，明确选择 Node 驱动，环境 Evidence 为 Node `v22.20.0`。计划列有 `implement`、`build`、`test`，要求只在 AutoDev Run Worktree 创建计数器页面和 Node 内置测试，不 commit、不晋级。
- 页面路由设置当时为分析 `codex`、实现 `codex`；进程检查确认 Codex provider 实际启动。Profile 名称未从该页面/运行审计中独立确认，因此不推断为 `web` 或 `autodev-web`。
- 指定 AutoDev Worktree 为 `C:\Users\chuchao\.dsh\autodev\worktrees\8617a5b3-8e3b-4eaa-8c40-e8e09a12d925\attempt-1`。Run 期间该目录除 Git Worktree `.git` 指针外没有生成计划所需源文件；独立 Git 检查显示它干净、HEAD 为合成 unborn 基线 `90db051b71e836007c8ef19740716be5699b66c1`。
- **真实隔离验收失败：**源仓库 `D:\codex\autodev-mode-tests\empty-unborn-20260926` 在 Run 启动前为空；Run 执行期间却在源仓库根目录产生以下 4 个未跟踪文件，均于 `2026-09-25 16:27:47 UTC` 创建/写入：`app.js`（1128 bytes）、`app.test.js`（628 bytes）、`index.html`（2852 bytes）、`package.json`（213 bytes）。Git 状态将它们列为源仓库未跟踪文件。因文件此前不存在且时间落在本 Run 执行期间，这构成 Agent 在指定 AutoDev Worktree 之外写入的直接证据。没有证据表明这四个文件写入了 DSH 源码仓库。
- Operator 在 `16:29:23 UTC` 通过 DSH 取消运行。UI 当前显示 Run `CANCELLED`，但 `implement` 仍显示 `RUNNING`、`build/test` 为 `PENDING`、Run 验证 `UNKNOWN`、`agent-workspace` 副作用仍为 `EXECUTING`；没有 Build/Test Evidence，也没有 Agent 完成结果。因此不能把本次 DEV 记为通过，取消动作也没有清除错误写入或终结副作用状态。
- 只读源码核对显示当前 AutoDev 源码会把 `context.workspacePath` 传入 Router `request.cwd`，再传给 DSH Subagent `workspaceCwd`；Codex 插件源码声明 `workspaceCwd: true`。这些是静态代码意图，不是该次运行实际 cwd 的运行时证明。尚未取得协议执行时的实际 cwd 记录，也未确定偏离发生在调用参数、Provider/app-server cwd、工具执行位置还是其它环节；**根因待查，不能仅凭静态实现判定哪一层出错。**
- 已停止后续所有会执行/写入文件的模式 Run，避免在隔离边界未修复前扩大影响。现阶段只有历史 `EXPLORE`（Claude Code）与 `IMPACT`（Codex）真实运行记录为通过；REVIEW 修正版曾取消且无完成证据；本 DEV 失败；其它模式未通过真实全流程验收。历史草稿或仅生成计划不算模式通过。
- 安全处置：四个源仓库文件、AutoDev Worktree、既有 Claude 内部 Worktree/锁及 DSH checkout 中所有原有未提交变更全部保留；没有清理、移动、解锁、提交或晋级。需要先修复并通过一项最小隔离回归：在 disposable unborn 仓库运行同等 DEV 任务，证明四个文件只出现在指定 AutoDev Worktree，源仓库 Git 状态保持与运行前完全一致，Build/Test Evidence 均完成，取消/终态与副作用状态一致；之后再继续其它写入型模式。只读模式是否继续也应先保证其执行 cwd 不会造成源仓库副作用。
- 测试中为排除自动路由变量而临时设置的 `analysis=codex`、`engineering=codex` 已在 DSH UI 恢复为“自动路由 / 自动路由”并点击保存；当前 Ollama 决策后端配置未更改。

### 2026-09-26 01:03–01:06 Asia/Shanghai（2026-09-25 17:03–17:06 UTC）：DEV/Codex 隔离回归再次失败

- 使用当前真实 DSH `web` Profile（服务进程为已安装 DSH CLI；AutoDev 与 Codex 插件目录联接到 `D:\codex\deepseek-harness` checkout），Node `v22.20.0`。界面显示 AutoDev、Codex 可用；决策后端为本地 Ollama `qwen3:8b-fast`，实现路由本次显式选 `codex` 以排除自动路由变量。
- 新建并在 DSH 会话中绑定空 unborn 仓库 `D:\codex\autodev-mode-tests\dsh-isolation-regression-74128c895d`。Run `9c8d4260-b9c1-4586-9749-3e1ae9a96902` / Plan `33cae890-93cd-48ee-bda0-3eaa35a36500` v1，Mode `DEV`，Node driver；Run 前仓库无文件、无 HEAD。计划含 `implement`、Node `build`、Node `test`，已在 DSH 页面批准；副作用 intent `e0139050-6f8d-4edc-b4d4-f5e31cd9faf4` 获授权。
- Host/Node 环境和计划批准 Evidence 均为 PASS；Codex 子进程确实启动并返回。最终 Run 为 `NEEDS_INTERVENTION`，implement `FAILED`；Evidence 明确为 `AGENT_OUTPUT: FAIL`、`DRIFT: FAIL`、`SIDE_EFFECT: FAIL`，原因是 Agent 在源仓库发生写入，候选被拒绝。Build/Test 均保持 PENDING，Verify `UNKNOWN`，没有 Candidate Diff、Git commit 或晋级。
- 直接核验文件位置：四个任务文件 `app.js`、`app.test.js`、`index.html`、`package.json` 出现在源仓库 `D:\codex\autodev-mode-tests\dsh-isolation-regression-74128c895d`；本 Run 指定 Worktree `C:\Users\chuchao\.dsh\autodev\worktrees\9c8d4260-b9c1-4586-9749-3e1ae9a96902\attempt-1` 仍干净且为空。DSH 插件 checkout `D:\codex\deepseek-harness` 未出现这四个任务文件。违规写入文件全部保留，未删除或移动；旧测试仓库文件也未处理。
- **兼容性线索（尚非已证实根因）：**当前 checkout 的 `packages/subagent/subagent` 源码含 per-run `workspaceCwd` 支持；运行中的 DSH 全局安装依赖 `@deepseek-ai/dsh-subagent@0.1.7-rc.1` 的 `lib` 仍是旧实现（`resolveChildCwd` 只有 parent cwd 三参数，Host lib 无 `workspaceCwd` 引用），而 profile 中的 Codex/AutoDev 包联接到当前 checkout。Host 的旧 `start()` 仍以对象展开把未知字段传给 Provider，因此该构建差异本身不足以证明它就是本次偏离原因；仍需拿到 Provider 实际解析 cwd 与 Codex 工具实际执行位置的运行时证据。Codex 插件源码向 `thread/start` 发送 Worktree cwd 并校验响应 cwd，但该响应校验未能阻止这次源仓库写入。
- 处理：没有重试 Run；实现路由已恢复为 `自动路由` 并保存，分析路由保持 `自动路由`，Ollama 设置未变。隔离根因解决并有运行时 cwd 证据前，暂停所有会写文件的真实模式测试；不得把本轮计为 DEV 通过。下次验证须使用新的 disposable unborn 仓库，且启动前先确认 Host/Provider 实际 cwd 与 AutoDev Worktree 相同，再允许模型写入；否则仅执行不写入的诊断。

### 2026-09-26 01:50 Asia/Shanghai（2026-09-25 17:50 UTC）：DEV/Codex 空仓库隔离回归取消，状态观察不一致

- 使用用户实际运行的 DSH `web` Profile（已安装 DSH CLI 启动；Profile 内 AutoDev、Codex 插件联接到当前 `D:\codex\deepseek-harness` checkout），Host 运行包为 `@deepseek-ai/dsh-subagent@0.1.7-rc.1`。本轮将该安装包已发布的 Host `lib` 文件更新为当前 checkout 构建，并在更新前把 54 个文件备份到 `C:\Users\chuchao\.dsh\backups\subagent-lib-20260926-013707`；目标包运行时检查确认 `resolveChildCwd` 支持第四个 `requestedCwd` 参数。重启的是用户实际 `dsh web` 进程，不是另起 DSH fork。此前针对 Host/Provider 的 3 个测试文件通过：116 passed、1 skipped。
- 新建并绑定空 unborn 测试仓库 `D:\codex\autodev-mode-tests\host-cwd-regression-20260926-014027`。Run 前基线为 `c6bcec8766fcae283cf77a01d4004d245d211033`、Node `v22.20.0`，源仓库只有 `.git`、无提交。AutoDev Run `dd64d096-8445-4c49-941a-8659f901732b` / Plan `3399693b-d6c1-4518-a350-8e317aa9ea03` v1，Mode `DEV`、Node driver；实现路由显式选择 `codex`。计划于 `17:46:47Z` 获 Operator 批准，副作用 intent `d6f55cdc-fc2f-4b08-97d3-a1728d3065ed` 于 `17:46:55Z` 获授权。Host、环境、计划批准及 Agent context 证据显示 PASS。
- DSH 操作审计中的 `agent-workspace` 指向正确的本次托管 Worktree：`C:\Users\chuchao\.dsh\autodev\worktrees\dd64d096-8445-4c49-941a-8659f901732b\attempt-1`。取消后的独立检查确认该 Worktree 内有 `index.html`、`app.js`、`package.json`、`app.test.js` 四个未跟踪文件；Run 的 Build/Test 节点仍为 PENDING，未运行验证。页面未产生 Agent Signal / `AGENT_OUTPUT` 完成 Evidence，Verify 为 UNKNOWN。
- **源仓库状态观察出现不一致，故隔离不予验收：**Agent 执行期间的一次检查中，`git status` 短暂报告上述四个文件为源仓库未跟踪文件，但同一次目录枚举只看到 `.git`；取消后再次检查，源仓库 `git status` 为空且目录也只有 `.git`。目前没有源仓库中的生成文件可保留或恢复，也没有证据解释这次状态变化。不得据取消后的干净状态推断运行期间隔离正确；在拿到可信的 Provider 实际 cwd、Agent 完成结果和可重复的源仓库前后快照前，判定为隔离失败/未通过，而非 DEV 通过。
- Operator 于 `17:50:37Z` 使用 DSH 的“取消运行”停止本次 Run。Run 状态为 `CANCELLED`；没有 Candidate Diff、Git commit、晋级，也没有 Build/Test 结果。Worktree 中四个生成文件予以保留；没有清理或改写测试仓库。
- 下一步：恢复实现路由为自动路由；只做 Host/Provider 的只读 cwd 传递诊断及现有日志核对，先解释并修复隔离问题。根因未明前不再发起任何写入型模式 Run，不把本次计作 DEV 或 Build/Test 通过；修复后需换全新 disposable unborn 仓库重测，并同时证明实际 Agent cwd、Worktree 文件位置、源仓库前后 Git/文件清单一致，再考虑其它写入模式。

### 2026-09-26 01:56 Asia/Shanghai（2026-09-25 17:56 UTC）：取消 Run 后对 Worktree 产物的补充本地检查

- 为避免再次发起模型调用，对已审阅的 Worktree 文件直接使用 DSH Profile 所用的 Node `v22.20.0` 可执行文件，在本次 Run Worktree 内运行 `node --check app.js` 和 `node --test app.test.js`。语法检查 exit 0；Node 内置测试 3/3 通过（初始值、递增、重置）。此前 Shell 默认 Node `v24.16.0` 下同样通过，但验收记录以 DSH 的 `v22.20.0` 结果为准。
- 这些是取消后人工执行的补充本地检查，不是 DSH `build`/`test` 节点的 Evidence；Run 仍为 `CANCELLED`，两个节点仍 `PENDING`，Agent output 与 side effect 仍为 `UNKNOWN`，不得据此记为 AutoDev DEV 全流程通过。未安装依赖、未提交、未晋级。检查后源仓库仍只有 `.git` 且干净，四个未跟踪文件仍只位于本次托管 Worktree。
- 实现路由已在 DSH UI 中恢复为“自动路由”并点击保存；分析路由与本地 Ollama `qwen3:8b-fast` 保持原设置。

### 2026-09-26 03:34 Asia/Shanghai（2026-09-25 19:34 UTC）：DEV/Codex 限时重试取消，产物仅在隔离 Worktree

- 在用户实际 DSH Web Profile 中启动单次 DEV Run `2361356b-8f00-4645-b8bc-2eb49a9b9765` / Plan `d3dd4ed4-2d65-4b43-9f09-257c2c85ffc5` v1；Node driver，明确选择 Codex。基线 `fc074c4aace2da67bf5733d21999a96fdc635db5` 为无提交空仓库；Node Host Evidence 为 `v22.20.0`。Plan 已审批，Action intent `e397e2a8-d24d-49f5-a829-db5f693f8aef` 获授权。
- Run 于 DSH 审计时间 `19:31:37Z` 进入 EXECUTING，托管工作区为 `C:\Users\chuchao\.dsh\autodev\worktrees\2361356b-8f00-4645-b8bc-2eb49a9b9765\attempt-1`。限时观察期间 Agent 没有返回完成结果或 Agent Signal；`implement` 长时间 RUNNING，Build/Test 保持 PENDING。操作员在 `19:34:37Z` 通过 DSH 取消，不再重试模型调用。
- 刷新 Host 状态后，Run=`CANCELLED`、`implement=UNKNOWN`、`AGENT_OUTPUT=UNKNOWN`、`SIDE_EFFECT=UNKNOWN`、Verify=`UNKNOWN`，Build/Test 仍 PENDING；没有 Candidate Diff、commit 或晋级。不能把该 Run 计作 AutoDev DEV 全流程通过。
- 取消后独立检查发现 Agent 已生成 `index.html`、`app.js`、`package.json`、`app.test.js`，这四个未跟踪文件均位于本次托管 Worktree；Worktree 的 `Get-Location` 与 `git rev-parse --show-toplevel` 输出路径一致。源测试仓库 `D:\codex\autodev-mode-tests\host-cwd-regression-20260926-014027` 的 `git status --short --untracked-files=all` 为空。此结果支持本次快照下文件只落在隔离 Worktree，但没有 Provider 完成回执或其写入前 cwd 报告，故不把 Provider 运行时隔离协议记为完整验收通过。
- 检查生成文件后，Shell 当前 `node` 为 `v24.16.0`；手动 `npm run build` 通过，`npm test` 3/3 通过。这些是取消后本地补充验证，不是 DSH Run 的 Build/Test Evidence，也不是在 DSH 显示的 Node `v22.20.0` 环境中执行。
- 实现 Agent 路由已改回“自动路由”并保存；分析路由继续为自动路由，本地 Ollama `qwen3:8b-fast` 未改。四个隔离 Worktree 产物保留；未清理、安装依赖、commit 或晋级。

### 2026-09-26：Codex 长时间无完成回执的代码侧防护与回归验证

- 回看 Run `2361356b-8f00-4645-b8bc-2eb49a9b9765` 的 Host SQLite 记录：Agent 调用约 3 分钟后由 Operator 取消，之前没有 Agent 完成输出；取消时输出 artifact 为空。不能据此证明 Codex 自然执行最终一定不会返回，也不能把“缺少终态回执”的底层根因说成已经查明。该 Run 的源码仓库干净，已生成文件在该 Run 的托管 Worktree。
- 代码定位确认：AutoDev 原先只把 Run 的取消信号传给 Agent Protocol，没有独立的 Agent 调用时限；`commandTimeoutMs` 只约束 Shell/CLI 命令，并不覆盖官方 Subagent 调用。这使长时间没有完成回执的 Agent 节点可以一直保持 RUNNING，直到外部取消。
- 在 `AutoDevConfig` 增加 `agentTimeoutMs`，默认 5 分钟且必须为正整数；Run 主动取消信号与 Agent 超时信号合并后传给 Provider。超时不视为成功或可安全重试：AutoDev 保留 UNKNOWN 的 Agent/副作用 Evidence 与 Worktree，进入人工处理闸门，停止 Build/Test 和晋级。
- 新增确定性假 Provider 回归测试：设置 25ms Agent 时限，确认 Provider 收到 AbortSignal 后返回；Run 被置于 `NEEDS_INTERVENTION`，implement 节点及副作用为 UNKNOWN，超时原因写入 Evidence，Build/Test 未运行，源仓库保持干净。
- 验证通过：`runtime-modes.spec.ts` 12/12；Codex Subagent 模拟 app-server 测试 58/58；AutoDev `typecheck` 通过；AutoDev `bundle`（`tsc -b && tsdown`）通过。该验证未启动 Codex、Claude Code 或其它计费模型，也不是 DSH Web 中的真实 Agent E2E。
- 这是对“无独立超时导致无限等待”的防护修复，不是 Codex 无完成回执的根因修复。信号取消仍依赖 Provider/Host 遵守取消契约；Codex 当前实现存在 signal→interrupt→子进程 teardown 路径，但补丁后尚未在实际 DSH Profile 重启并重新验收 Codex 完整调用。因此不能把之前失败的 DEV Run 改记为通过，也不能声称线上已生效；DSH 需加载新 bundle 并重启后，才能验证实际运行结果。本次未安装、重启、提交或晋级。

### 2026-09-26 04:59 Asia/Shanghai（2026-09-25 20:59 UTC）：Run `4ccc6736-8491-4e76-a099-c34fb3d1814a` Codex 完成回执链路取证

- 只读核对 DSH AutoDev SQLite（Run、Evidence、Artifact、ActionIntent、事件）与 Codex `logs_2.sqlite`，没有重跑 Agent、没有发起新的模型请求，也没有修改 Provider 配置。Run 为 DEV，Plan `69b50e40-37a5-4a30-9fad-15559a4230c1` v1，显式选中 Codex；授权的 Worktree 为 `C:\Users\chuchao\.dsh\autodev\worktrees\4ccc6736-8491-4e76-a099-c34fb3d1814a\attempt-1`。
- Codex app-server 进程（PID 41296；日志关联 thread `01a0da4d-d8e6-7e81-ae28-3a686df367f9`）成功启动，`thread/start` 于 `20:42:08Z`、`turn/start` 于 `20:42:10Z`。同一进程日志记录了 471 条 `item/agentMessage/delta`、29 个 `item/started`/`item/completed` 以及 14 个命令输出增量；最后一条 app-server 输出事件为 `20:46:57Z` 的 `item/completed`。该进程日志中没有 `turn/completed`，也没有 completed/failed/cancelled 的 turn 终态事件。Codex 日志在 `20:46:53Z` 还记录到一次 `apply_patch` 的 Windows sandbox `failed_to_write_file`（path 未知）；其后仍继续产生事件，因此该警告是待查线索，不足以单独认定为超时根因。
- AutoDev 的 300,000ms Agent timer 于 `20:47:07Z` 到期。SQLite 同秒记录 implement=`UNKNOWN`、ActionIntent=`UNKNOWN`、`AGENT_OUTPUT=UNKNOWN` 与 `SIDE_EFFECT=UNKNOWN`；Agent output Artifact 为 0 字节，节点错误是“Agent timed out … Provider completion was not confirmed”。之后 Build/Test 均未启动，没有 Candidate Diff、提交或晋级。任务文件确实已在上述 Worktree 生成；原始空仓库的状态保持干净。由此可确认 Codex 做过实质工作，但 Host 没有拿到已完成的 Agent 结果。
- **判定：**不是“Codex 已发出完成回执、AutoDev 收到后漏看”。本次 Codex 进程日志显示没有发出 turn 完成终态，AutoDev 只记录了超时后的 UNKNOWN/空输出；现有证据也不支持“完成回执在传输通道中丢失”。更准确地说，Codex 有进度和工具事件，但在 5 分钟限时内未完成/未发出终态，超时取消后 Host 得到的是非完成结果。根因是否为任务耗时、Codex 在最后一次工具事件后停滞，或 sandbox 警告造成额外返工，单凭现存日志无法再区分。
- **可观测性缺口已确认：**`packages/experimental/autodev/src/router.ts` 只在 `await run.result` 后将最终 `output` 返回给 Agent Protocol；Codex app-server 的 delta 不会作为 AutoDev Run 的实时 Evidence/Artifact 显示。`subagent-codex` 在取消时只能快照其已收集的最终/无阶段文本；本次快照为空。因此用户在 AutoDev 页面看不到 Codex 执行中的部分进度，即使 Codex 子进程本地日志中记录了增量事件。这是独立于本次“没有 completed 终态”的 UI/协议可观测性问题。
- 本轮仅完成日志取证和记录，未实现流式进度、未重试 Codex、未验收 Claude Code；Claude 的真实调用结论不能从本次 Codex Run 推导。不得把该 Run 计为 DEV 全流程通过。

### 2026-09-26 05:35 Asia/Shanghai：Codex/Claude 增量输出链路修复与本地构建

- 针对上面的日志结论，修的是“Provider 已产生的安全进度/部分答复到不了 AutoDev 页面”，不是伪造 Codex 终态。DSH 的 `ctx.subagents` 原先只提供 `run.result`；现为该 seam 增加可选 `progress` 能力和 `onProgress` 回调。未声明该能力的 Provider 会在启动前被拒绝；回调异常被隔离，不能使 Agent 运行失败。
- Codex app-server 适配器读取 `item/agentMessage/delta`，仅向 Host 转发 `final_answer` 或 nullable-phase 的助手文本；commentary/reasoning 不转发。它只转发通用 working/tool-started/tool-completed 活动，不暴露工具名、命令、参数或工具输出。取消/超时时，已收到的最终答复增量作为部分输出返回，stopReason 仍是 `aborted`/`error`，不冒充 completed。
- Claude Code SDK 启用 `includePartialMessages`；只接收 root Assistant 的 text delta 与 tool-use block 活动，不透传工具输入/输出，也忽略嵌套 Agent 的文本。终止前收到的部分文本可随取消结果保留。
- AutoDev Agent Protocol 将该事件归一化；Runtime 把当前 Node 的最近 8,000 字符安全限长快照写入 SQLite NodeExecution，按长度/时间节流，不为每个 token 追加审计事件。正常结果覆盖成最终 Agent 文本；取消/超时保留 `PARTIAL`；Host 恢复时把遗留 `STREAMING` 改为 `PARTIAL`。UI 复用 2 秒轮询展示，并始终标注“Agent 输出（尚未验证）”；该字段不是 Evidence，不改变 VERIFY、UNKNOWN、副作用、人工 Gate、Build/Test 或晋级规则。
- 定向回归覆盖：DSH Subagent 能力门控/observer 异常隔离；Codex final delta、commentary/工具敏感信息过滤、取消时部分输出；Claude root delta/工具活动/嵌套文本过滤、取消时部分输出；AutoDev 25ms 超时后 progress 留存且节点/副作用仍 UNKNOWN、Build/Test 未启动；Panel 展示部分输出及未验证状态。没有发起 Codex、Claude、Jev、CodeBuddy 或 Ollama 的真实模型请求。
- 验证结果：覆盖的 6 个目标测试文件合计 188 项检查（187 passed、1 skipped）。初次合并运行中 Panel 只有一条测试因 Testing Library 对“状态 + 活动”组合文案做精确匹配而失败；将断言改成片段匹配后，Panel 文件重跑 10/10 通过，其余 5 个目标文件均通过。目标 TypeScript project-reference `tsc -b` 退出码 0。Subagent seam、Codex、Claude 三个 Host bundle 用精确包名构建成功；AutoDev `bundle`（Host + Client）成功。构建只更新 Profile 通过 Junction 引用的本地插件 `lib`，未改 DSH Web/Host 源码、Profile 配置或用户数据。
- 当前 `autodev-web` Profile 中 AutoDev、Codex 和 Claude Provider 包均为 Junction，目标分别指向本仓库的 `packages/experimental/autodev` 与 `packages/subagent/...`；因此新 bundle 已写到该 Profile 引用的本地包路径。**尚未重启已经运行的 DSH 进程，也未进行一次真实模型 E2E。**现有 Run `4ccc6736-8491-4e76-a099-c34fb3d1814a` 仍没有 `turn/completed`；新补丁能让下一次调用期间的增量可见并在未知终态时保留部分文本，但不能保证远端 Codex 最终会发出 completed，也不改变旧 Run 的状态。后续需重启实际使用的 DSH Profile 后，使用用户批准的单次真实调用确认增量在页面可见；若 Provider 仍不发终态，应依据新进度/状态快照继续查超时/终态原因，不自动重试、晋级或将 UNKNOWN 改成 PASS。

### 2026-09-26 08:03 Asia/Shanghai：`web` Profile 重启及 AutoDev 在线核验

- 重启前检查发现 3080 没有监听进程；现有浏览器仍能显示缓存页面，但记忆状态接口返回 `Failed to fetch`。AutoDev SQLite 共有 24 个历史 Run，状态分布为 CANCELLED=5、DRAFT=10、VERIFY=2、NEEDS_INTERVENTION=7，没有 RUNNING Run；因此重启不会中断活动 Run。服务为何在重启前已停止，当前证据无法确定。
- Profile 与包清单核对：已安装 DSH CLI 的 `dsh web` 对应 `web` Profile；`C:\Users\chuchao\.dsh\profiles\web\package.json` 声明 `@deepseek-ai/dsh-experimental-autodev`、Codex、Claude Code bundles，三个运行包都通过 `link:D:/codex/deepseek-harness/...` 指向本 checkout。故继续使用真实 DSH `web` Profile，无需切换到另一个 Profile 或启动 fork。
- 用户确认继续后，以隐藏后台进程启动 `C:\Users\chuchao\bin\dsh.cmd web --no-open`。新 DSH Node 进程 PID `35704` 成功监听 `0.0.0.0:3080`；复用已打开的内置浏览器重载后，DSH 会话页正常，AutoDev 标签和设置面板可见，页面显示 Ollama `qwen3:8b-fast`、Codex `可用`、Claude Code `可用`，历史 Run 详情仍在，旧 Run `4ccc6736-8491-4e76-a099-c34fb3d1814a` 仍为 UNKNOWN。
- 本次只验收 DSH 服务启动、Profile 包加载与 AutoDev UI 可达性；没有创建任务、调用 Agent/模型或更改提供方配置。此前 187 passed、1 skipped 的流式输出定向测试及构建结果不变。**真实 Codex/Claude 增量是否在新 Run 中可见仍待一次明确授权的模型 E2E；本轮不把它记为通过，也不把旧 UNKNOWN 改写。**

### 2026-09-26 08:20 Asia/Shanghai（2026-09-26 00:20 UTC）：Codex/AutoDev 只读 EXPLORE 真实 E2E

- 在重启后的同一个 DSH `web` Profile、`http://127.0.0.1:3080/` 中，使用测试仓库 `D:\codex\autodev-mode-tests\host-cwd-regression-20260926-014027`。运行前确认仓库只有 `.git`，没有源文件、未提交变更或初始提交。Run `bb0d29bb-8fd3-46aa-8a82-0b8812e8e798`，Plan `90ba07fb-2e3d-4577-97be-ae84531f5f05` v1，Mode `EXPLORE`；DSH 审计显示精确 Plan fingerprint 已由 Operator 批准。
- 执行期间 AutoDev UI 显示 `Agent 输出（尚未验证）` 和 `正在生成` 状态；期间可见的活动状态从工具已返回更新为正在使用工具。Codex 完成后，完整的 5 条只读答复出现在同一输出卡片中。Host 明确记录 `AGENT_OUTPUT: PASS — Provider codex completed explore task`、`ANALYSIS: PASS`、`SIDE_EFFECT: PASS`，因此本次实际路由确认为 Codex，而不是由 UI 的“自动路由”标签推测。
- Host 的 3 项必需验证（`REPOSITORY_BASELINE`、`ANALYSIS`、`SIDE_EFFECT`）全部 PASS；Run 最终停在 `VERIFY`，验证汇总为 `PASS — all 3 required verification checks passed`。UI 的 Agent 答复仍标为“尚未验证”，没有把模型文本本身提升为 Evidence。
- 独立复查显示源测试仓库仍只有 `.git` 且 `git status --short --untracked-files=all` 为空；AutoDev Worktree `C:\Users\chuchao\.dsh\autodev\worktrees\bb0d29bb-8fd3-46aa-8a82-0b8812e8e798\attempt-1` 的 Git 状态为空，HEAD 为合成 unborn 基线 `3dbeb074f2a76eb920d799f65d4b7d30406652da`。没有创建、修改或删除项目文件，没有 Build/Test、Review、Git commit 或晋级。
- **验收结论：**真实 Codex 终结答复已通过 DSH Agent Protocol → AutoDev Host/SQLite → AutoDev UI 可见，并被 Host 如实记录；先前“页面完全看不到执行中输出/结果”的关键链路已有真实 E2E 证据。运行中实际观察到的是未验证输出卡片和活动状态；完整正文在 Provider 完成后可见，本次不声称已逐 token 验证所有中间 delta 的刷新时序。此结论只覆盖该次只读 EXPLORE，不等于 Claude Code E2E、写入隔离、Build/Test 或九种模式全流程已通过。提供方设置页面显示“自动路由”；Run 的 Host Evidence 仍证实本次最终由 Codex 执行。旧 Run `4ccc6736-8491-4e76-a099-c34fb3d1814a` 的 UNKNOWN 状态未改变。

### 2026-09-26 08:52–08:55 Asia/Shanghai（00:52–00:54 UTC）：Claude Code REVIEW 真实 E2E

- 在正在运行的真实 DSH web Profile（AutoDev 面板 http://127.0.0.1:3080/）中，对独立干净测试克隆 D:\codex\autodev-mode-tests\workflow-review-20260926 执行手动指定的 REVIEW。基线 HEAD 为 095d54ca877a507595cf02432b040e278547ca16。Run 118f6864-f88b-486c-aa88-e9fbd69c216f；Plan cf582c00-d344-4eeb-bec8-a3a631abbd93 v1，fingerprint c1fe5c08cc6480e98fac2c07026ea2cd1433ac671c6b590d9682e761fae99e7b，Operator 已通过 DSH UI 显式批准。
- 计划仅包含一个只读 review 节点；任务明确禁止写入、命令、构建、测试、联网、子 Agent 和 Claude 自建 Worktree。运行期间分析/只读 Agent 临时显式选择 claude-code（UI 显示可用）；本地 Ollama 决策后端与实现路由未改。审查结束后分析路由恢复自动路由并点击保存。
- Claude Code 确实启动并完成审查。执行过程中 UI 出现“Agent 输出（尚未验证）/正在生成”，完成后完整 JSON 正文显示在同一 AutoDev 输出卡片中。Host/SQLite 记录 AGENT_OUTPUT: PASS — Provider claude-code completed review task，并保存输出 Artifact；这证明该 Run 的 Provider → Agent Protocol → Host → AutoDev UI 返回通道是通的，没有发生 invalid-result。
- Claude 返回结构化 verdict=NEEDS_CHANGES，列出 6 项带文件和行号的问题：src/app.js:60 持久化失败被忽略；src/app.js:38 storage 为 null 时可能误报保存成功；src/app.js:76 加载数据未校验 task ID 唯一性；src/app.js:98 空筛选与空任务提示混淆；src/app.js:143 存储数据校验未执行标题约束；styles.css:51 筛选文字对比度不足。范围覆盖 README、HTML、CSS、主 JS、测试与 package.json。Agent 明确说明只做静态审查，未运行构建、测试或浏览器交互。
- Host 将 REVIEW Evidence 记录为 WARN（人工复核），Run 最终为 NEEDS_INTERVENTION、验证汇总 WARN，闸门保持打开。这是因为审查 verdict 为 NEEDS_CHANGES，人工复核门禁未通过；不是返回格式/传输失败。该结果不能作为 REVIEW 模式通过计数。Baseline 和只读副作用 Evidence 均 PASS；没有候选 Diff 或晋级。
- 运行后独立检查测试克隆和 AutoDev Worktree C:\Users\chuchao\.dsh\autodev\worktrees\118f6864-f88b-486c-aa88-e9fbd69c216f\attempt-1，两处 git status --short 均为空；确认源仓库与托管 Worktree 没有文件改动。未运行命令、构建、测试或额外 Agent，也未重试本次模型调用。
- 验收结论：Claude Code 的真实 REVIEW 请求、终结 JSON 输出、Host Evidence 记录和页面可见链路通过；只读隔离也通过。REVIEW 质量门禁按设计因 NEEDS_CHANGES 返回 WARN/人工处理，故“Claude Provider E2E 通过”不等于“REVIEW 工作模式验收通过”。这轮仅覆盖一项只读 Claude REVIEW，不代表所有工作模式已通过。

### 2026-09-26 13:11 Asia/Shanghai（05:11 UTC）：CodeBuddy TEST 真实 E2E、质量决策 Evidence 修正与 Profile 重载

- 首次尝试使用 `D:\codex\autodev-mode-tests\workflow-review-20260926` 创建 TEST 任务时，Host 因源仓库已有 `README.md`、`index.html`、`src/app.js`、`styles.css`、`tests/app.test.js` 改动及未跟踪 `WORKLOG.md` 而拒绝不干净基线。所有这些改动均保留，没有 stash、清理或覆盖。随后改用已存在且干净的 `D:\codex\autodev-mode-tests\workflow-modes-20260926`，HEAD `095d54ca877a507595cf02432b040e278547ca16`；运行前 `git status --short` 为空。
- 真实 DSH 入口为 `http://127.0.0.1:3080/`、Profile `autodev-web`；Profile 中 AutoDev 包是 Junction，目标为本 checkout 的 `D:\codex\deepseek-harness\packages\experimental\autodev`，不是另起 DSH fork。Mode `TEST`、Node driver，Plan `c408ee37-1d51-4d32-9d2c-de89b4b14f08` v1，Run `57052c05-5aad-4627-acf3-553ee1e8935e`，显式计划批准已记审计。
- SQLite RouteDecision 和进程命令行证明实际执行顺序为只读分析 `claude-code`，实现 `codebuddy`；CodeBuddy 通过 `--output-format stream-json --include-partial-messages` 启动，UI 实时出现“正在使用工具”并随后显示完整输出。Agent 在托管 Worktree `C:\Users\chuchao\.dsh\autodev\worktrees\57052c05-5aad-4627-acf3-553ee1e8935e\attempt-1` 只修改 `tests/app.test.js`，增加 `storage.getItem()` 抛错时 `loadTasks()` 返回 `[]` 的 `node:test`；Candidate Diff 与本地 Worktree 状态均只显示这一文件。原测试仓库运行后仍干净，没有晋级或写回原仓库。
- DSH Host 在该 Worktree 中执行 `npm run build`（两个 `node --check`）和 `npm test`（`node --test`），均 exit 0；测试日志为 5 passed、0 failed，Build/Test Evidence 分别 PASS。不能把最终 Run 记为全通过：决策后端的 Ollama 评分不符合有限数字契约，DecisionCoordinator 安全降级到静态 fallback；质量决策因此不可信，Human Gate 保持 OPEN，Run 为 `NEEDS_INTERVENTION`。未批准、绕过或晋级该门禁。
- 此次暴露一个可复现的 Evidence 缺陷：`recordJev` 原先把 `degraded` 决策错误标为 `JEV_DECISION: PASS`；质量摘要又把静态 fallback 的默认 `100/100` 展示成了不可信评分。修正为只有 `accepted` 决策记 PASS，`rejected/degraded/paused` 记 WARN；只有质量可信的提供方评分才会显示分数，否则明确标为不可信并要求人工审查。Fail-closed 行为和质量门禁本身保持不变，现有历史 Run Evidence 不回写。
- 新增 Runtime 集成回归覆盖非法 Ollama score → 静态 fallback 的 `JEV_DECISION: WARN`、REVIEW `WARN`、不暴露 fallback `100/100`；与既有低分质量门禁测试合计 2/2 通过。完整 `runtime-modes.spec.ts` 13/13 通过（含九种工作模式的确定性执行路径）；另有 CodeBuddy 流输出定向测试 4/4、子进程实时 stdout/stderr 1/1、CodeBuddy Runtime 参数/超时 1/1 通过；AutoDev TypeScript typecheck 与 Host/Client bundle 成功。整套 AutoDev 测试曾尝试运行但因耗时较长被中止，不能声称完整包级测试全绿。
- 为加载修正后的源码 bundle，在确认 SQLite 没有 READY/EXECUTING/BUILDING/TESTING/PROMOTING Run 后重启同一 `autodev-web` Profile；新 Node 进程 PID `9468` 监听 `127.0.0.1:3080`，浏览器重载后 AutoDev UI、Ollama/Claude Code/CodeBuddy 设置与历史 Run 可见。当前 TEST Run 的历史 REVIEW/WARN 不会因代码修正而追溯改变；新行为由定向 Runtime 回归验证，未再发起第二次模型调用。
- 当前模式验收边界：本次补上 TEST + Claude 分析 / CodeBuddy 实现的真实端到端正向证据（确定性 Build/Test 均通过），但整条 Run 因质量提供方不可信停在人工闸门；之前的 DEV/DEBUG/DATABASE/REVIEW 真实运行仍有隔离、Agent、质量或审查门禁未通过的记录；REFACTOR 当前只有 DRAFT，缺真实执行证据。九模式 Runtime 的确定性测试与九种模式都通过真实 DSH E2E 是两回事，后者尚未完成。
- 没有提交或推送 `D:\codex\deepseek-harness`；其既有脏工作区变更全部保留。AutoDev Run、Evidence、Worktree 和 Candidate 状态按上文保留，未晋级。

### 当前九种工作模式真实 DSH Run 盘点（截至 2026-09-26）

| Mode | 最近可用真实 Run | 当前结论 |
|---|---|---|
| EXPLORE | `bb0d29bb-8fd3-46aa-8a82-0b8812e8e798` | VERIFY；Codex 只读输出和必需 Evidence PASS。 |
| IMPACT | `c44f51b8-4554-4a6d-8afe-3f998e0dcea1` | VERIFY；Claude Code 分析输出和 Evidence PASS。更早自动路由曾走 Codex，Provider 策略需与模式结果分开统计。 |
| DEV | `9c8d4260-b9c1-4586-9749-3e1ae9a96902` | NEEDS_INTERVENTION；有源仓库越界写入证据，不能验收隔离或 DEV 通过。 |
| DEBUG | `6223720e-09a7-4875-b6d2-8fbe1a6fb8d3` | NEEDS_INTERVENTION；Claude 分析、Codex 实现及 Host Build/Test PASS；Ollama 质量决策降级并触发人工审查。 |
| DATABASE | `a9bf90d0-8877-4722-9061-92fc8c4ca0e6` | NEEDS_INTERVENTION；Codex 实现超时、完成状态 UNKNOWN，Build/Test 未运行。 |
| REFACTOR | `2a87b5c9-7418-4509-b904-259471bf7b9d` | 只有 DRAFT 和基线/环境 Evidence，没有批准后真实执行。 |
| TEST | `57052c05-5aad-4627-acf3-553ee1e8935e` | CodeBuddy 真实实现及 Host Build/Test 5/5 PASS；最终因不可信质量决策保持 NEEDS_INTERVENTION。 |
| REVIEW | `118f6864-f88b-486c-aa88-e9fbd69c216f` | Claude Code 真实只读审查已返回 6 项 NEEDS_CHANGES；人工审查闸门未通过，不计模式通过。 |
| RELEASE | `502e150c-9aa0-466e-b9c6-f9efd47ef8b0` | VERIFY；Claude Code 只读发布准备分析及必需 Evidence PASS；没有发布动作。 |

`VERIFY` 仅表示该只读 Run 的 Host 验证通过，不代表所有九种模式都通过；当前明确未验收的写入模式为 DEV、DEBUG、DATABASE、REFACTOR、TEST，REVIEW 则完成了审查但报告了需人工处理的发现。全套 AutoDev 测试也未在本轮跑完。

### 2026-09-26：AutoDev 面板信息架构拆分

- 根据实际使用反馈，把原先纵向堆叠的提供方配置、任务创建、运行记录、备份恢复、Worktree 清理和 Run 全量详情拆成五个工作区标签：`新建任务`、`运行列表`、`运行详情`、`提供方设置`、`备份与维护`，避免 36 条历史记录继续挤在任务表单下方。
- `新建任务`只保留创建表单；`运行列表`单独呈现历史记录。创建任务成功后自动跳到该 Run 的详情，点击任一历史 Run 也会切到详情。没有选中 Run 时详情页显示返回新建任务的空状态。
- `运行详情`完整保留计划、未验证 Agent 输出、Evidence、操作审计、Verification、Signals、Assumption / SemanticUncertainty、Project Memory、Concept、Knowledge / Compaction、Playbook、Side Effect、Candidate Diff、人工 Gate 和晋级确认；只改变导航和页面组织，不改变 Host 端审批、验证、清理及晋级权限。
- 提供方和维护界面仍保持挂载，切换标签不会丢掉已填写的恢复路径、清理预览或知识审阅表单状态；错误消息继续在面板顶部可见。五个标签支持键盘左右方向、Home/End 和 DSH 主题样式，小屏横向滚动。
- 验证：AutoDev `typecheck` 通过；面板和样式定向测试 15/15 通过；AutoDev `bundle` 成功。没有运行耗时较长的全包测试，也没有发起模型调用。
- 真实页面验证：`autodev-web` Profile 内插件目录是 `D:\codex\deepseek-harness\packages\experimental\autodev` 的 Junction；只读检查 SQLite，确认没有 READY/EXECUTING/BUILDING/TESTING/PROMOTING Run 后重启服务。最终服务 PID `45748` 监听 `127.0.0.1:3080`；已打开的 DSH 页面无须重新授权即可加载最终 bundle。Accessibility 树实际显示五个标签且默认只呈现新建任务表单；36 条运行记录仍保留在 AutoDev 数据中，组件回归验证了运行列表独立显示及点选后跳转详情。本轮未修改历史 Run。
- 实施文件：`src/client/AutoDevPanel.tsx`、`src/client/AutoDevPanel.module.css`、`src/client/locales.ts`；回归覆盖：`tests/panel.client.spec.tsx`、`tests/panel-styles.client.spec.ts`。未提交或推送。

### 2026-09-26：运行详情页挤压顶部标签栏修复

- 用户反馈：从运行列表打开详情后，页面上方标签栏像是消失，只剩一条细线。当前 DSH Accessibility 树实际仍包含“新建任务 / 运行列表 / 运行详情 / 提供方设置 / 备份与维护”五个标签，选中历史 Run 后“运行详情”也保持选中，因此不是 React 导航被卸载或 Run 跳转状态错误。
- 根因：面板根节点为固定高度、可滚动的纵向 Flex 容器；标签栏作为普通 Flex 子项默认允许 `flex-shrink: 1`。运行详情内容很长时，纵向空间竞争会把标签栏压缩到近乎 0 高度，符合截图中按钮不可见、只剩边框/滚动线的现象。
- 修复：为 `.tabList` 设置 `flex: 0 0 auto`，禁止标签栏因详情内容变长而收缩；横向滚动能力和五个标签的既有导航行为保留。样式回归测试新增“标签栏不得收缩”断言。
- 验证：面板交互与样式测试 15/15 通过（`panel.client.spec.tsx`、`panel-styles.client.spec.ts`）；AutoDev `typecheck` 通过；Host/Client `bundle` 成功。重启前只读检查 AutoDev SQLite，活动状态 Run 数量为 0；确认 3080 监听进程属于 `autodev-web`，插件 Junction 指向本仓库源码。重启后新 Node PID `12512` 监听 `127.0.0.1:3080`，Accessibility 树再次列出全部五个标签，默认显示新建任务；运行列表点选后切到详情的交互由面板测试覆盖。当前内置浏览器自动化返回控件树但未提供该嵌入页面的截图，因此没有声称完成修复后的像素级截图复验；样式高度由防收缩规则和回归断言验证。

### 2026-09-26：修复 AutoDev 发布文件清单约束

- 根因：AutoDev 原 `files` 包含宽泛的 `lib/*.js`，与仓库要求的精确发布清单不一致；但该通配符也隐式包含 `exports` 公开的 `lib/contracts.js` 和 `lib/router.js`，所以不能仅删除通配符，否则 npm 包会遗漏这两个子路径目标。
- 修复：将 `lib/contracts.js`、`lib/router.js` 加入 `scripts/check-workspace-constraints.ts` 的 AutoDev 精确发布例外清单；AutoDev `package.json.files` 改为显式列出两个文件，并删除 `lib/*.js`。新增约束回归测试，验证当前清单完整且遗漏任一公开子路径文件都会失败。
- 验证：`pnpm constraints` 通过；`scripts/check-workspace-constraints.spec.ts` 38/38 通过；`pnpm run verify-package-meta` 通过；`npm pack --dry-run --json --ignore-scripts` 显示 rc.2 包含 `lib/contracts.js` 与 `lib/router.js`（共 49 个发布条目）。
- Git 状态：原有 313 个已暂存版本 manifest 变更仍保留；本次 AutoDev `files` 元数据、约束规则和测试是未暂存改动。未提交、未推送。
