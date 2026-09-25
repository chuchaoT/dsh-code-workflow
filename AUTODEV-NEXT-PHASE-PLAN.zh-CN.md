---
description: 对照 AutoDev 当前源码、离线测试与 DSH 架构讨论，规划从可安装候选版到可交付完整版本的分阶段实施与验收。
status: in-progress
as-of: 2026-09-25
---

# DSH AutoDev 完整交付实施计划

## Summary

AutoDev 的目标是作为 DeepSeek Harness（DSH）的可安装 Bundle，让 DSH 掌管工程任务的计划、隔离执行、证据验证、人工决策和项目知识，而不是另起一套 Agent Framework。本文同时记录可证明的实现状态、仍存缺口、架构边界、阶段依赖、测试与验收条件。阶段结论按“通过、失败、阻塞、未运行”记录；离线测试、配置解析和 Bundle 加载都不代表真实 Codex、Claude Code、Jev 或完整 Web 流程已经验收。

## 目录

- [目标、范围与完成定义](#目标范围与完成定义)
- [事实基线与 S1–S4 差距](#事实基线与-s1s4-差距)
- [目标架构与不变边界](#目标架构与不变边界)
- [阶段依赖和工作量](#阶段依赖和工作量)
- [R0：基线审计和契约冻结](#r0基线审计和契约冻结)
- [R1：目标环境真实端到端基线](#r1目标环境真实端到端基线)
- [R2：Agent Protocol 与执行证据闭环](#r2agent-protocol-与执行证据闭环)
- [R3：项目语义、记忆与 Playbook 闭环](#r3项目语义记忆与-playbook-闭环)
- [R4：知识演化、回归与压缩](#r4知识演化回归与压缩)
- [R5：构建驱动与动态 Provider 扩展](#r5构建驱动与动态-provider-扩展)
- [R6：完整 DSH 界面和人工操作](#r6完整-dsh-界面和人工操作)
- [R7：安全运维、兼容性与发布](#r7安全运维兼容性与发布)
- [跨阶段验收矩阵与风险](#跨阶段验收矩阵与风险)
- [参考资料](#参考资料)
- [Dev Note](#dev-note)

## 目标、范围与完成定义

交付对象是可在 DSH `web` Profile 中安装、启动、卸载和升级的 AutoDev Bundle，包含 TypeScript Host、React/TSX Client、受限 Remote、模型工具、测试、示例与运维文档。DSH 的官方 Subagent 插件负责 Codex 和 Claude Code 的原生调用；AutoDev 不复制它们的登录、进程管理或权限系统。Jev 是有 `required`、`advisory`、`off` 策略的决策服务，不是完成判定的权威。

“完整版本”在本计划中意味着：用户可从 DSH Web 创建任务、审阅 Plan、启动或接管执行、查看当前 Candidate 的证据和 Diff，并显式决定是否 Promotion；真实 Codex 和 Claude Code 至少各完成一次隔离工程修改；Jev 真实请求及故障策略验收；已声明支持的构建驱动跑通真实工程；关键领域知识可追溯、可纠错、可回归；安装、重启、升级、失败恢复和卸载有记录。缺少凭据的外部项目只能记作阻塞，不能用 Mock 替代签收。

本版要求验证动态注册的第三方 Provider 契约和至少一个非官方 Provider 集成样例；优先复用 DSH 已有协议/模型接入层，而非为厂商名称重复造轮子。CodeBuddy 可由 ACP Provider 组合；Ollama 与 FreeLLMAPI 属于模型后端路由，不是代码执行 Agent。无论接口复用还是专用实现，真实端点/凭据集成仍需单独验收，不能把配置或模拟测试写成已支持。首个完整发行的构建目标为 Maven、Gradle、npm/pnpm 和 pytest；若某驱动在发布前未满足真实工程验收，发行说明必须明确将其列为不支持，不能仅凭接口占位宣称支持。

实施前提是锁定 DSH 基线提交与目标机版本，准备隔离的测试仓库及相应 Provider/Jev 凭据。所有有破坏性的 E2E 只在专用测试仓库或 Worktree 中执行，不以 DSH 源码仓库或用户真实业务仓库做未授权试验。

## 事实基线与 S1–S4 差距

启动本计划时的审计快照为 AutoDev 2 个测试文件、22 项通过；随后执行阶段中新增了回归与 Driver 测试，最新结果记录在“当前执行状态”。仓库既有[发布验证记录](packages/experimental/autodev/RELEASE-VERIFICATION.zh.md)中的 Profile/打包测试需以对应日期和当前源码分别判断，不能直接当作本轮签收。原始 S1–S4 设计与阶段验收叙述已从用户之前分享的[JeV 模型介绍对话](https://chatgpt.com/share/6ab2785a-b74c-83ea-86d0-bf55fcbd2188)找回；它描述的是 Java 17/Maven 的独立 Runtime 演进，不是当前 DSH 插件源代码。对话中称 S1 为 `0.1.0-runtime-kernel`、S2 为 `0.2.0-recovery-runtime`（累计 42 项）、S3 为 `0.3.0-human-gate`（累计 73 项）、S4 为 `0.4.0-engineering-runtime`（累计 89 项）。这些版本和测试数字目前只有对话文本作为依据，旧仓库、PR/提交及所引用的 S1–S4 报告文件尚未定位，不能视为已独立复跑或正式验收。

| 能力 | 当前可定位的实现或证据 | 判断 | 下一步缺口与归属 |
|---|---|---|---|
| DSH 接入与隔离执行 | [Bundle 元数据](packages/experimental/autodev/package.json)、[Host](packages/experimental/autodev/src/runtime.ts)、[Git 管理](packages/experimental/autodev/src/git.ts)、[模型工具](packages/experimental/autodev/src/tools.ts)；R7.1 已在隔离 Profile 中验证真实 DSH Web 重启、Remote 备份/恢复；R6 已验证浏览器到 Worktree/Promotion 闭环 | Windows 本机交付路径已验证，完整发布仍未验收 | 其他 OS/Node 的安装矩阵、真实官方 Provider/Jev 工程闭环及跨平台；R1、R7 |
| Agent Protocol | [协议](packages/experimental/autodev/src/protocol.ts)定义 Task/Context/Result/Signal 和适配器；契约回归覆盖版本、Signal 校验/顺序、取消、UNKNOWN 和恢复门禁 | 本地协议与状态闭环已覆盖，真实 Agent/目标平台仍待验 | 官方 Provider/Jev 的真实调用及 R2-M14 Linux/macOS 崩溃恢复结果；R1、R2 |
| Evidence / Verification | [验证器](packages/experimental/autodev/src/verification.ts)和 Runtime 将证据绑定至当前 Run/Plan/Attempt/Candidate/Worktree；测试覆盖来源可信度、证据失效、旧 PASS 不复用、漂移和 Promotion 前重验 | 本机隔离执行闭环已覆盖，跨平台/真实 Provider 仍待验 | Linux/macOS 崩溃恢复及官方 Provider 的真实产物来源验收；R1、R2 |
| Project Memory | [记忆服务](packages/experimental/autodev/src/memory.ts)与 Context Artifact 支持作用域检索、渐进式摘要/详情、来源追溯和预算；领域测试覆盖模块/分支/项目版本隔离及越界详情拒绝 | 本地作用域与上下文边界已覆盖 | 真实项目长期数据分布、跨平台/多用户授权边界；R4、R7 |
| Business Concept | [语义服务](packages/experimental/autodev/src/concepts.ts)及 UI 支持 Observation/Candidate、Target/Effect/Evidence 匹配、歧义保留、人工纠正和版本历史；领域与 Runtime 测试覆盖模块/项目版本隔离，R6-M3 覆盖浏览器纠正后 Plan/Context 更新 | 本地生命周期与界面闭环已覆盖 | 更广泛真实项目数据及签名 principal/RBAC 上游能力；R7 |
| Playbook | [服务](packages/experimental/autodev/src/playbook.ts)具备不可变版本、`MATCH/PARTIAL/MISMATCH`、Fit 与影响 Plan 的 Replan；领域测试覆盖跨版本适用性，R6-M4 覆盖真实 DSH Web 中人工纠正至新 Plan/Context | 本地版本与人工闭环已覆盖 | 官方 Provider 上下文端到端及真实多用户授权边界；R1、R7 |
| Assumption / SemanticUncertainty | [语义状态](packages/experimental/autodev/src/semantics.ts)与 Runtime 支持 Evidence 关联/冲突失效、UNKNOWN/AMBIGUOUS 等显式状态、人工 Gate 与 Plan 版本化重审；领域和浏览器用例覆盖关键生命周期 | 本地状态机与人工闭环已覆盖 | 官方 Provider 真实证据和跨平台恢复；R1、R2 |
| Knowledge Evolution / Compaction | [知识服务](packages/experimental/autodev/src/knowledge.ts)已有候选晋级、查询回归/批量套件、合并提案、版本保护、事务恢复和有界检索；领域测试覆盖跨项目版本与 Playbook vN/vN+1 回归，100 轮/2,602 条合成增长循环；R6-M4 覆盖浏览器审阅闭环 | 本地演化与合成增长门禁已覆盖 | 真实生产数据分布、多日 soak 及 Linux/macOS 运行结果；R7 |
| Jev 与动态路由 | [Jev 决策](packages/experimental/autodev/src/jev.ts)、[ProviderRouter](packages/experimental/autodev/src/router.ts)已有配置路由、动态注册和离线策略测试 | 基础具备，外部待验 | 真实 Jev HTTP/重试、官方 Provider 身份与健康检查、第三方契约样例；R1、R5 |
| Build/Test Driver | [Driver 实现](packages/experimental/autodev/src/drivers.ts)按根标记探测 Maven/Gradle/Node/pytest，Plan 冻结选择并以 argv 执行；四类 Driver 均覆盖子进程成功/失败/取消/超时/输出上限，Maven/Gradle 使用真实 Wrapper 工程验收 | Windows 本机 Driver 闭环已覆盖 | 当前发布版本的安装矩阵、其他 OS 兼容性及真实 AutoDev Agent 全链路；R1、R7 |
| DSH Web UI | [侧栏面板](packages/experimental/autodev/src/client/AutoDevPanel.tsx)支持 Run/Plan、Evidence/Diff、Gate、语义、Concept、Knowledge、Playbook；R6-M1/M2/M3/M4 已用真实 DSH Web composition 完成确定性 Provider 浏览器闭环，R7.1 另验证隔离 Profile 重启和 Remote 备份/恢复 | 确定性浏览器与 Profile 恢复路径已覆盖 | 官方 Codex/Claude/Jev 任务、OS 级进程/网络断线重连，以及上游签名 principal/RBAC；R1、R2、R7 |
| 安全与运维 | [Side Effect Ledger](packages/experimental/autodev/src/side-effects.ts)、SQLite Store、迁移、备份/恢复、Retention Preview/Cleanup、审计与重启恢复均有实现及本机测试 | Windows 本机主要运维闭环已覆盖 | 当前 RC 发布 tarball 升级/卸载矩阵、跨平台恢复、自然人 principal/RBAC 上游集成；R7 |

上表的“已具备基础”仅指代码和本轮离线测试可定位；“部分具备”不是已满足完整用户旅程。以下把历史对话里的 S1–S4 契约摘要与当前代码逐项对照；“历史声称”与“当前源码/测试已证明”分开标注。没有原始仓库及报告的历史验收仍属于不可独立复现的二手证据。

| 历史阶段与对话中声称的契约 | 当前 DSH AutoDev 对应实现/测试 | 差距判断与处理决策 |
|---|---|---|
| S1 Runtime Kernel：Event Store 为工作流事实来源；`workflow_stream.current_version` 是 OCC 权威；`commandId + payloadHash` 幂等；一个 Command 的多条 Domain Event 同批原子提交；Replay 不触发副作用；SQLite WAL/`BEGIN IMMEDIATE` | [AutoDevStore](packages/experimental/autodev/src/store.ts) 以 `autodev_records` JSON 行作为当前读取状态，并向 `autodev_events` 追加审计/变更事件；`events()` 读取事件但没有由事件重建状态的 Replay。关键 Plan/Gate/ActionIntent 写路径采用事务，Run 创建与 Replan 有故障注入回归；Plan ID 定义字段不可原位覆盖。可定位的历史测试在 [core.spec.ts](packages/experimental/autodev/tests/core.spec.ts) 与 [domain.spec.ts](packages/experimental/autodev/tests/domain.spec.ts) | **架构不同，保留并加固**：DSH 继续使用 typed Record Store + append-only history，不为了复刻旧 Java 设计改成全量 Event Sourcing；R0-M1 已补 Run/Plan/Node/基线 Evidence 的原子初始化、Replan 原子切换和 Plan ID 不可覆盖保护。不可把 Events 描述为唯一事实来源。当前没有通用 OCC stream version 或全局 Command payload-hash 幂等契约；若未来需要跨 Host 的通用 Command API，应另行设计，不把 ActionIntent 幂等冒充通用 Command 幂等。 |
| S2 Recovery Runtime：持久 Activity/ToolExecution 生命周期、Lease/leaseToken fencing 与 heartbeat；Reconciler 区分仍运行、已停止和未知结果；副作用不确定时不盲目重试 | 当前用 [ActionIntent/SideEffect](packages/experimental/autodev/src/contracts.ts) 记录副作用状态；Runtime 启动时扫描执行中的 Run 并将未结算节点/intent 收敛到 UNKNOWN、打开人工 Gate。[Host 崩溃恢复测试](packages/experimental/autodev/tests/core.spec.ts) 已覆盖 Provider/Build/Test/Git Promotion 的真实进程终止窗口 | **行为目标兼容、执行模型有意简化**：保留 UNKNOWN、人工接管和不自动重试；当前是单机 Host + SQLite，不声称拥有旧方案的多工作者 Lease fencing/heartbeat。若转向多 Host 执行，必须先补 Lease/owner token 和过期接管设计及跨进程测试。真实第三方服务的部分成功语义仍由 R1/R7 验收。 |
| S3 Human Gate：Gate 与 Run 分离；OPEN/ANSWERED/EXPIRED/CANCELLED；提醒/升级是事件而不是 Gate 状态；Gate 打开与 Run 挂起、回答与精确恢复状态原子化 | 当前 [HumanGate](packages/experimental/autodev/src/contracts.ts) 独立记录 OPEN/RESOLVED、选项与主体；Runtime 有显式 Gate 动作校验和重启恢复；R0-M1 已将 Gate 打开与 Run 挂起、Replan/非 Promotion 决议写入同一事务；R2-M13 又将 `promote` 决议与 PROMOTING claim 原子提交并覆盖 SIGKILL 恢复 | **模型相容，关键决议窗口已封闭**：保留独立 Gate 与显式动作，不照搬未使用的 Remind/Escalate 状态。Gate 创建、Replan、决议与 Promotion claim 均以短事务提交；外部 I/O 仍在事务外，进程中断时由 UNKNOWN/人工 Gate 接管，不自动重试。Linux/macOS 的进程恢复执行结果仍归 R2-M14。 |
| S4 Engineering Runtime：PlanVersion 与 NodeExecution 分离；Plan 有 fingerprint/DAG；代码只能改 Worktree；Candidate 快照与 Evidence 按 Revision 绑定；仅人工确认后进入原仓库 | 当前 [PlanVersion/NodeExecution/CandidateRevision/Evidence](packages/experimental/autodev/src/contracts.ts)、[Runtime](packages/experimental/autodev/src/runtime.ts) 与 [Git Manager](packages/experimental/autodev/src/git.ts) 已落实版本化计划、Attempt 节点、独立 Worktree、Candidate tree hash 和证据绑定；R0-M1 加入 Plan ID 定义不可覆盖、旧版 SUPERSEDED 与 Replan 原子切换 | **高度兼容，存储不变量已补强**：保留现有数据模型和 Git Worktree 流程。定义内容与生命周期状态分开，Plan ID 的 fingerprint/nodes 等字段不能改写；Replan 原子写入新 Plan/Nodes、退役旧版并切换 Run 指针。未重写 Scheduler 或 Git 层。 |

### R0 架构决策与状态契约

1. **不迁移成全量 Event Sourcing。** 当前 `autodev_records` 是可变的权威持久化行，`autodev_events` 是顺序追加的审计/变化历史；快照直接组合 Records。继续使用这种符合 DSH Bundle 的 SQLite Store。关键业务批次由 Store/Runtime 在同一短 SQLite 事务提交记录和相关事件；不能宣称现有历史流可独立 Replay。
2. **Plan 身份与生命周期分开。** 一个 Plan ID 的 fingerprint、nodes、driver、parent、scope 引用等内容在首次写入后不可被覆盖；生命周期状态变化走专用受校验写入。每个 Run 只有 `activePlanId` 指向的单一活动 Plan。Replan 原子写入新 Plan、将旧版退役、切换 Run 指针并建立对应 NodeExecution。
3. **初始化 Run 是原子业务批次。** Git/环境探测等 I/O 先在事务外完成；之后 Run、初始 Plan、Nodes、基线与环境 Evidence、activePlan 指针在一个同步事务内写入。任何写入失败必须全回滚，Runtime 不留下可见的半初始化 Run。
4. **UNKNOWN 是不确定终态，不等于失败。** Agent Signal 只是输入；Host 采集的 Git/命令/回归事实才可用于相应 Verification。可能已发生外部效果但没有确定回执时，保留 ActionIntent 和证据为 UNKNOWN，人工 Gate 前不重试；仅在可验证的精确对账或显式安全幂等规则下继续。
5. **兼容性先于重构。** 以上加固不新增数据库 schema，不改变既有 Remote 参数，不改 SQLite WAL、DSH Host/Client 边界。若后续需要 Schema/Remote 变更，先给出迁移、旧数据行为与回滚测试，再实施。

| 故障/威胁 | 当前保护 | 缺口与阶段化验收 |
|---|---|---|
| Agent 伪报完成、构造恶意或过期 Signal | 协议校验、Host 侧 Evidence/Verification、UNKNOWN 和 Gate 测试 | R1 真实 Provider；R2 版本/乱序/去重与长任务恢复契约 |
| Run/Plan 初始化或 Replan 在写入中失败 | SQLite 事务原语和部分关键操作的事务封装 | R0-M1 为初始化/Replan 添加原子批次和故障注入测试，确保无半初始化与双活动 Plan |
| 同 ID Plan 被覆盖、旧 PASS 被新 Candidate/Plan 重用 | 指纹、Candidate/Attempt 绑定与 Verification 检查已有实现 | R0-M1 增加 Plan ID 内容不可变与唯一活动 Plan 回归；R2 继续覆盖 Evidence 新鲜度 |
| Side Effect 已产生、Host 在结果记账前退出 | ActionIntent、UNKNOWN 恢复、人工 Gate；Windows 文件/HTTP/Git SIGKILL 用例 | R1/R7 真实 Provider 与第三方服务端点；其他 OS 和部分成功/超时语义仍未验收 |
| 数据库升级/备份恢复遗漏或旧版本损坏 | schema 迁移、SQLite/Artifact 备份、Hash 校验 | R7 补升级链、失败恢复与多 OS Profile 矩阵；Git Worktree 不包含在数据库备份中 |
| 主体身份或跨项目知识越权 | 调用期 Actor、精确 Scope、路径受限 Snapshot 与审计 | R1/R6/R7 真实用户流程、权限与自然人身份能力边界；不能把本机 Operator 等同个人账号/RBAC |

## 目标架构与不变边界

沿用 DSH 的 Cordis/Bundles 组合和现有 `@deepseek-ai/dsh-experimental-autodev` 包，主要实现语言为 TypeScript，界面为 React/TSX，Host 持久化采用现有 SQLite 与 Artifact Store。Host 是 Run、不可变 Plan 版本、节点尝试、Evidence、Verification、Human Gate、Side Effect 和知识状态的唯一权威；Client 和模型工具都经受限 API 读写，不持有数据库或原仓库写权限。

工作流固定为：需求与项目上下文 → Business Concept/Memory 检索 → Playbook Fit 与假设 → 人审 Plan → Worktree 中由路由选定的 Agent 执行 → 封存 Candidate → 确定性 Build/Test/Review 与 Side Effect 取证 → Verification → Human Gate/显式 Promotion → Experience/Candidate Knowledge → 验证、回归、版本化及压缩。Plan 只描述本次意图，不等同于 Runtime 事实；Agent Signal 是待核实输入，不能直接写出 PASS 或完成态。

Provider 层保留“Route Policy → 能力/可用性筛选 → Jev 辅助选择 → DSH Subagent 或外部适配器 → 统一 Agent Protocol”结构。官方 Codex、Claude Code 仍使用 DSH 的插件；第三方通过可注册 Provider/Route 和受限 argv、cwd、超时、取消、输出上限的适配器接入。Jev 的低置信、非法、超时和不可用结果必须落为可见的静态回退或 Gate，绝不绕过确定性验证。

Evidence 的最小可信关联应覆盖 `runId`、`planVersionId`、`nodeId/attempt`（适用时）、`candidateId`、Git tree/内容摘要、来源、状态、时间和可追溯 Artifact。Promotion 再次读取当前 Candidate 与 Verification，检查原仓库基线未漂移，并要求可审计的用户决策。UNKNOWN 是正式结果，不能自动重试可能已经产生外部副作用的操作。

知识系统保留 Memory（事实/规则/经验/假设）、Concept（业务语义）、Playbook（建议性套路）、Execution History（原始记录）的分工。默认只给 Agent 有预算的卡片；详情按需读取。人工纠正优先于推测；新知识先 Candidate，再核验来源、作用域和回归，最后 Promote 到新版本。Compaction 只减少活跃知识的重复和检索负担，不删除审计历史，也不把一次成功自动变成正式规则。

## 阶段依赖和工作量

实施按验收门禁推进，不按代码提交数算完成。R0 冻结事实和契约后，R1 尽早暴露真实环境缺陷；R2 加固执行内核；R3 先形成可信语义闭环，R4 再做知识演化；R5 可在 R2 后与 R3/R4 部分并行；R6 在 Remote/权限契约稳定后推进；R7 收束所有交付证据。遇到 R1 凭据阻塞时可继续不依赖外部服务的 R2–R6，但完整版本的发布门禁仍保持未通过。

| 阶段 | 主要依赖 | 单人粗估 | 可交付产物 |
|---|---|---:|---|
| R0 基线与契约 | 当前源码、原 S1–S4 材料 | 2–4 工日 | 可追溯差距表、ADR/契约、测试矩阵 |
| R1 真实环境基线 | R0、凭据与隔离仓库 | 4–8 工日 | Codex/Claude/Jev/Maven 首轮 E2E 记录与缺陷单 |
| R2 协议和证据 | R0，参考 R1 缺陷 | 8–12 工日 | 版本化协议、可信证据门禁、恢复测试 |
| R3 语义与记忆 | R2 | 10–15 工日 | 作用域检索、Concept/Playbook/Assumption 闭环 |
| R4 知识演化 | R3 | 8–12 工日 | Promotion/Regression/Compaction 可审计流程 |
| R5 Driver/Provider | R2，可与 R3–R4 部分并行 | 10–16 工日 | 多驱动、动态 Provider 契约与样例 |
| R6 完整界面 | R2、R3 的 Remote/权限契约 | 10–16 工日 | Web 全流程、管理视图、浏览器 E2E |
| R7 交付 | R1–R6 | 6–10 工日 | 运维策略、兼容矩阵、发布包和签收记录 |

粗估合计 58–93 工日，未包含等待外部账号、网络和上游插件修复的时间；两人并行时关键路径仍是 R0→R2→R3→R4→R7。R0 之后按真实缺陷重估，不能把此表当成日期承诺。

## R0：基线审计和契约冻结

目标是先完成设计判断，不能为了匹配讨论稿而重写合理的现有模块。现阶段已将分享对话中的 S1–S4 历史契约映射到现有服务、公开契约、测试和未验证条件；旧 Java 仓库、PR/提交及其报告仍未找到，需保留为证据缺口。本文已绘制 Host/Client/Remote/Provider/Jev/Driver/知识域责任边界，并冻结 Agent Protocol、Evidence 关联、Scope、状态机和迁移策略。对“保留、加固、新增、延期”均给出依据，不把历史测试声称升级为当前验收。

交付物：本文件中的 S1–S4 映射表、架构决策、核心数据与状态契约、威胁/失败清单、分阶段验收计划及版本矩阵草案。旧数据库与 Remote 如需改变，只能先写兼容/迁移设计并提供回滚方案。

R0-M1（已实施，不新增 Schema 或 Remote）：

1. 先完成 Git/环境等异步探测，再在一个可回滚的同步 SQLite 事务中写入初始 Run、Plan、NodeExecution、基线/环境 Evidence 和活动 Plan 指针。
2. Replan 在一个事务中写入新 Plan 与节点、将旧 Plan 标为 SUPERSEDED、切换 Run.activePlanId；中途失败必须完整回滚。
3. Plan 首次持久化后，ID 对应的定义字段不可被覆盖；生命周期状态通过专用校验操作改变。每个 Run 的活动 Plan 唯一。
4. Gate 创建与 Run 进入 NEEDS_INTERVENTION 原子提交。Gate 的决定写入与外部操作分开处理；外部副作用继续遵守 ActionIntent/UNKNOWN，不在外部调用期间持有数据库事务。

测试与验收：创建/重规划事务中途故障注入、Plan ID 改写拒绝、唯一活动 Plan、Gate 决议回滚已有回归；Node 24.16.0 与 Node 22.20.0 AutoDev 全套各 149 项通过、2 项可选 Maven/Gradle 集成跳过；AutoDev typecheck 与 Host/Client Bundle 通过。此前一轮完整 `doc-sync` 为 42/42；后续文档变更后的最新状态见当前执行记录，不把旧结果冒称为当前全量通过。失败时无半初始化 Run/双活动 Plan/孤立节点，Plan 定义不可原位改写，Replan Gate/Run 状态同时回滚。文档区分当前可复跑证据、历史对话声称及仍缺失的原始仓库材料。精确 Node 22.19.0 + Maven/Gradle 147/147 是 R0-M1 之前的历史记录，不冒称由本轮复验。真实 Provider/Jev 和用户身份仍归 R1/R6/R7，不以 Mock 代签。R0 基线审计、架构方案、R0-M1 实施和验收完成；旧 Java 源仓库/提交/报告不可定位这一证据局限继续保留，不影响当前 DSH 方案结论。

## R1：目标环境真实端到端基线

目标是在锁定的 DSH 版本与全新或可恢复 Profile 上验证“确实接入 DSH”，尽早发现账号、系统进程、网络、端口、插件加载与工程构建问题。先记录 `dsh web` 启动、认证后的 Web 侧栏和模型工具可见性；再在独立 Git 测试仓库分别使用官方 Codex 与 Claude Code 实现可断言的小修改。Jev 分别测试 `required`、`advisory`、`off`、HTTP 故障、非法答案与低置信；真实 Maven/JUnit 完成 Build/Test。测试失败时保留日志、Run ID、Worktree、Candidate 和缺陷，而不伪造成功。

测试与验收：每个 Provider 至少有一条真实修改与一条中止/超时或失败路径；验证原仓库在 Promotion 前不变、Diff 可读、Evidence 指向当前 Candidate、显式 Promotion 后才有改动；断开 Provider/Jev 时状态为 Gate/UNKNOWN/受控回退。留存脱敏环境矩阵、命令、退出码、关键日志和可重复样例。没有真实凭据时此阶段保持“阻塞”，不将离线单测计入通过。

Codex 的下一次真实验收使用单条 AutoDev 集成用例，覆盖真实 Provider 调用到显式 Promotion；不要再启动低层独立 smoke 或全量 E2E 套件。仅在决定再次执行外部请求后使用：

```powershell
$env:DSH_AUTODEV_CODEX_E2E = '1'
pnpm exec vitest run --config vitest.e2e.config.ts packages/experimental/autodev/tests/codex-chatgpt.e2e.ts --retry=0 --maxWorkers=1 --no-file-parallelism
```

该用例会在隔离临时 Git 项目中创建并验证补丁，设置 45 秒主动取消与 65 秒测试上限；Promotion 仅改动该临时仓库。2026-09-25 首次运行真实 AutoDev Codex Provider 用例：`codex` 命令存在，但 Responses sampling 请求超时并发生适配器内部第 1/5 次重试；45 秒主动取消触发，测试 1/1 失败，未到 Build/Test、Candidate Verification 或 Promotion。没有复用/修改正式仓库。随后发现本机 HTTP_PROXY/HTTPS_PROXY 为 `http` 协议、ALL_PROXY 为 `socks5`，且 DSH CLI 警告不支持该 SOCKS 方案并会直连。基于这项新线索，按正确 `vitest.e2e.config.ts` 配置只复验一次：仅在测试子进程临时移除 ALL_PROXY、保留 HTTP(S) 代理；Responses sampling 仍超时，内部第 1/5 次重试后于 45 秒主动取消，测试 1/1 失败、总时长 47.85 秒，未进入 Build/Test、Candidate Verification 或 Promotion；临时环境变量已恢复，没有写入正式仓库。该线索不足以证明代理是根因，后续不再重复外部请求，直至出现有效认证或服务端连通性变化。当前只读环境盘点未发现 Claude CLI 或 Jev 命令，也未发现专用 Codex/Claude/Jev 凭据变量；`DEEPSEEK_API_KEY` 的存在不代表 Codex/Claude/Jev 已认证。R1 仍未验收。

## R2：Agent Protocol 与执行证据闭环

目标是让任一 Agent 都只能提出动作与信号，不能自行宣布完成。加固协议版本协商、Signal 结构校验/限长/顺序/去重、适配器能力和取消语义；Runtime 明确处理失败、长任务中断、UNKNOWN、重启后的人工接管。区分 Agent 自述、命令输出、Host 捕获的 Git 事实和人工确认的可信等级。

验证器对每个 Candidate 的当前 Plan、树摘要、构建/测试/审查/副作用证据做一致性检查；重新实施或重跑后旧 PASS 自动失效。对 Promotion 加二次基线检查和幂等/冲突处理，确保仅当前经过验证的补丁进入原仓库。现有 [verification.ts](packages/experimental/autodev/src/verification.ts)、[runtime.ts](packages/experimental/autodev/src/runtime.ts) 和 [protocol.ts](packages/experimental/autodev/src/protocol.ts) 是改进起点，不应平行创建第二套验证器。

测试与验收：协议契约测试覆盖旧版本、未知/恶意 Signal、重复序号、取消与 Provider UNKNOWN；状态机/进程重启测试覆盖每个可中断节点；构造“旧 Candidate PASS、新 Candidate 失败”“Git tree 漂移”“缺一项证据”“Agent 假称完成”“Promotion 重放”反例，全部必须拒绝完成或打开可解释 Gate。正向路径需能从单个 Run 追溯 Plan、Attempt、Candidate、Evidence、Verification、ActionIntent 与 Promotion。

### R2-M13 Promotion Gate 原子领取（已实施并验收，2026-09-24）

**问题与决策：** 当前 Gate `promote` 决议先把 Gate 写成 RESOLVED，随后 Runtime 才把 Run 领取为 PROMOTING；若 Host 恰在两步之间退出，持久状态会变成 Run 仍指向已解决 Gate，既没有活动 Promotion，也没有可回答的 OPEN Gate。将“校验当前 OPEN Gate → 记录 resolved/promote → 清除 currentGateId 并把 Run 原子迁移到 PROMOTING”合并为一个 SQLite 短事务；事务提交后才执行现有 Promotion 验证和外部 Git 操作。Promotion 流程必须接受且只接受这个已领取的 Gate 状态；任何进程在事务提交后、外部效果前退出时，启动恢复将 PROMOTING 收敛为 UNKNOWN/新人工 Gate，不静默应用或盲目重试。

**边界：** 不新增 Schema/Remote，不在事务里执行 Git/Agent/网络 I/O；直接 `promote()` 不能绕过显式 Gate 或 VERIFY 检查。若 Gate 决议事务回滚，原 Gate 必须仍为 OPEN 且 Run 状态不变。竞争中的另一个 Gate 动作不得覆盖已赢得的决议。

**测试与验收：** 1) 故障注入 Run claim 写入，断言 Gate/Run/Event 全部回滚；2) 验证 Git tree 首次异步调用前，Gate 已 RESOLVED(promote)、Run 已 PROMOTING 且 currentGateId 已清除；3) 模拟 Host 在 claim 持久化后、任何 ActionIntent/外部效果前退出，重启后出现可操作 Gate、没有悬空 resolved Gate，且没有自动 Git 操作；4) 并发提交互斥 Gate 动作，仅一个决议成功；5) 保留 R2-M12 的“Patch 已应用后崩溃→UNKNOWN→显式 Gate 对账且不二次应用”回归。验收以 AutoDev 全套、typecheck、Bundle 和 `doc-sync` 通过为准。

**实现与验收结果：** `resolveGate('promote')` 在同一 SQLite 事务中验证 OPEN Gate 和可晋级 Candidate 的 Run/Plan/Worktree/基线/Attempt 关系，再提交 Gate RESOLVED(promote)、Run PROMOTING 和 `currentGateId` 清除；事务之外才进入 Git/外部 Promotion 流程。claim 写入故障时 Gate、Run、Event 一并回滚。恢复测试保留数据库关闭/重开场景，并新增独立 Host 进程级故障注入：子进程确认 claim 已持久化、Run 为 PROMOTING、Gate 已决议且尚无 ActionIntent 后被 SIGKILL；新 Runtime 恢复出可操作 Gate，ActionIntent/已提交副作用均为空，原仓库 tree hash 不变。该用例已移除 Windows-only skip；本机 Windows 定向测试 1/1 通过；2026-09-25 又在 Node 22.20.0 和精确最低版本 Node 22.19.0 下分别定向复验同一 Host 崩溃场景，均 1/1 通过（core.spec.ts 其余 66 项按名称过滤跳过）。`ci-master.yml` 的定向 POSIX job 现使用 Ubuntu/macOS 矩阵，可由 master push 或 `autodev-recovery` 手动触发，只运行五个 Host SIGKILL 场景；对应 workflow 契约测试本轮定向通过 1/1。两个 POSIX runner 尚无本次变更的实际执行结果，不计为跨平台验收通过。竞争 Gate 决议仅一个成功；既有直接 `promote()` 多进程竞态也通过，输家不执行副作用。M13 定向组 4/4、直接 Promotion 跨进程竞态 1/1、AutoDev typecheck 通过。双 Node 最近全套 152 passed / 2 个可选 Maven/Gradle 集成跳过的结果来自新增进程级回归之前，本次按仓库要求未重跑全包；AutoDev Bundle 在本次测试专用变更前通过。未新增 Schema 或 Remote。

### R2-M14：跨平台 Host 崩溃恢复

将 Provider、Build、Test、Promotion 四个 R2-M10/M11/M12 故障场景与 M13 pre-intent 场景纳入非 Windows 测试。POSIX Host 收到 SIGKILL 后，测试显式终止其已记录的测试目标进程，避免孤儿进程影响后续恢复断言。

验收要求 Linux、Windows、macOS 均实际运行五个 SIGKILL 场景，并验证 UNKNOWN/人工 Gate、请求不重复、Promotion 不二次应用、测试子进程退出。当前 Windows 定向组 5/5；`ci-master.yml` 已提供 Ubuntu/macOS 定向矩阵，可由 master push 或选择 `autodev-recovery` 手动触发，单个平台 15 分钟超时，只安装依赖并运行五个 Host SIGKILL 场景，不跑全仓套件。本轮 `ci-master-platforms.spec.ts` 对该 workflow 契约定向测试 1/1 通过；Linux/macOS runner 的实际结果仍待取得，因此 R2-M14 仍未验收。本机确认虽有 `wsl.exe`，但 `wsl.exe --status` 返回 `Wsl/CallMsi/Install/REGDB_E_CLASSNOTREG`，无可用本地 Linux runtime；未触发远端 CI。

## R3：项目语义、记忆与 Playbook 闭环

目标是让 Agent 获得当前项目的可追溯经验，而不将相似词当成相同业务动作。Project Memory 的检索要考虑 project/module/branch/projectVersion/schemaVersion/techStackVersion，提供有上限的卡片、详情、section 与读取原因；版本不匹配时降权或阻断高风险规则。保存模型可见上下文的来源和预算，使同一次决策可复现。

Business Concept 使用 Target/Effect/Evidence 区分语义，允许 Observation→Candidate→Established；人类纠正是独立高权重来源，仍保留来源与时间，不无条件覆盖其他项目。Playbook 以版本化建议进入 Plan 形成前的 Fit Check，`MISMATCH` 或关键排除条件触发重新检索/暂停/Replan，而不是照单执行。Assumption 和 SemanticUncertainty 明确关联 Plan、Evidence 和人工结论；证据冲突会使假设失效，`UNKNOWN`、`AMBIGUOUS`、`NEW_PATTERN` 是允许的结果。

测试与验收：两项目同名 Concept 不串用，版本/模块不符的知识不作为高置信依据；“作废、退费、退款”案例区分 Target/Effect；人工纠正后后续检索可见且历史决策不被改写；Playbook Mismatch 和假设失效后不继续执行受影响节点；上下文卡片、按需详情和单次 token/字符预算有上限。端到端演示一次从用户纠正到新 Plan 版本和 Human Gate 解决的闭环。

## R4：知识演化、回归与压缩

目标是把“历史越来越多”与“活跃知识受控增长”同时成立。Experience 先转为 Candidate Knowledge；Promotion 必须校验所有 Evidence 的存在、项目/版本归属、状态和可信来源，要求适用的 Regression Suite PASS 与明确授权。Playbook 新版本保留 parent、来源执行、证据和 superseded 链；失败、过期或项目升级时降权/弃用，但不抹除审计历史。

在现有精确去重基础上增加可解释的聚类/合并候选、hot/warm/cold 检索层和手动确认门槛。Compaction 报告必须说明输入、输出、保留/淘汰原因及可逆恢复路径；不让模型直接通过一句“总结”覆盖正式规则。批量知识回归需包含正例、负例、跨版本和 Playbook vN/vN+1 对比。

测试与验收：伪造 Evidence ID、其他项目 Evidence、FAIL/过期 Evidence 和缺失回归均不能 Promote；失败案例不会仅因重复而升格；合并前后来源和旧版本可查询；批量回归任何关键负例失败时发布被阻断；检索预算在历史数据增长时保持上限。输出至少一份可审计的知识版本差异和 Compaction 报告。

## R5：构建驱动与动态 Provider 扩展

目标是把目前写在 Runtime 中的 Maven 逻辑收敛到 `Build/Test/Review Driver` 契约，Driver 负责探测、命令 argv、超时、输出 Artifact、环境摘要和失败归类，Runtime 仍统一保存 Evidence 并作验证。先保留 Maven 行为等价，再按样例工程实现 Gradle、npm/pnpm、pytest；驱动只运行在授权的 Worktree，不拼接 Shell 字符串，不自动安装未知依赖或执行无法说明的外部副作用。

Provider 侧沿用现有注册和路由，不重造 Codex/Claude 适配器；增加健康检查、能力声明、降级原因和生命周期测试。第三方 CLI 命令 Provider 继续作为扩展示例。CodeBuddy 优先通过 DSH `subagent-acp` 调用其官方 ACP 模式，并动态追加至 `implement` Route；Ollama/FreeLLMAPI 通过 DSH `llm-pi-ai` 配置模型 Route，再由一个 DSH Agent composition 使用，不伪装成能自主编辑代码的 AutoDev Agent。若适配器无法证明每次调用实际运行在 AutoDev Worktree，Route 必须 fail closed；若增加专用连接器，必须以真实环境验收。

### 参考项目与架构边界校准

| 参考 | 可借鉴处 | 对 DSH 的决定 |
|---|---|---|
| [Apache Maka](https://github.com/apache/maka) | Runtime Event 是事实记录；Session、UI、Context 与恢复状态应是可重建投影；压缩 Prompt Context 不应删改长期事实 | DSH AutoDev 已有追加式 `autodev_events` 与可变 `autodev_records` 投影，Run、Plan、Evidence、Gate、Memory、Concept、Playbook、Knowledge、Compaction 等均有持久化。保留此设计，不迁移 Maka 的 Runtime 或重写 Store。仍需持续检查事件覆盖、版本演进、投影重建与恢复审计；Compaction 仅整理知识/上下文，不清除源事实。 |
| [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) | OpenAI-compatible 聚合端点、模型统一入口、故障回退与用量治理；适合作为可替换的上游模型服务 | DSH `@deepseek-ai/dsh-llm-pi-ai` 已可配置任意命名的 OpenAI-compatible endpoint、模型目录、凭据引用、重试与运行时配置更新。FreeLLMAPI 可选地作为上游模型 Gateway，不在 AutoDev 内再造密钥库、模型目录或免费额度切换器；上游项目自述为个人实验，不作为生产可用性保证。 |
| [CodeBuddy ACP](https://www.codebuddy.ai/docs/cli/acp) | 现成 ACP Agent 接入模式 | 复用 DSH `@deepseek-ai/dsh-subagent-acp`，用 `codebuddy --acp` 注册命名 subagent，再将其追加至动态 `implement` Route；默认 `permission: reject`。`allow` 会自动应答权限请求，不等价于沙箱，需明确部署者启用并验证 CodeBuddy 自身权限边界。 |
| [Ollama OpenAI compatibility](https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx) | 本地模型服务可提供 OpenAI-compatible API | 复用 `llm-pi-ai` 的 `openai-completions` + `baseURL` + 手工模型目录；Ollama 是模型服务，不是带有文件工具/执行生命周期的代码 Agent，不能直接注册成 AutoDev `subagent`。模型端点要求的占位 key 由 DSH credential ref 承载，不写入配置文件。 |

此次校准还发现并修正一个真实隔离缺口：以前提示词包含 Worktree 路径，但 `SubagentStartRequest` 没有逐次 cwd 字段，Harness 子代理会从父 Session 或静态 Provider 配置解析目录，可能不在候选 Worktree 中执行。现增加可选 `workspaceCwd` 和 `workspaceCwd` capability；Codex、Claude Code、ACP、DSH SDK 及进程内 Provider 接受并校验它，AutoDev 只选取声明支持该 capability 的 Provider，不支持时在调用前拒绝。此字段仅保证工作目录选择，不构成 OS 沙箱。本轮已用 Ollama 的真实本机端点验证 `llm-pi-ai → DSH LLM service` 流式请求，并让 DSH AgentLoop 将一轮回复提交到 Session；这仍不是 AutoDev Agent/Worktree E2E。CodeBuddy ACP、真实 Agent 权限边界和 CodeBuddy 操作授权仍未验收。

2026-09-25 补齐 CodeBuddy ACP 配置的密钥传递说明：DSH 子进程边界按 `KEY|PASSWORD|SECRET|TOKEN` 清理继承凭据，故宿主环境中的 `CODEBUDDY_API_KEY` 不会隐式传给 CodeBuddy；双语 README 示例现通过 ACP `env` 显式映射宿主环境变量，并列明 CodeBuddy 区域配置。CodeBuddy 官方 ACP/IAM 文档确认 `codebuddy --acp` 与相应环境变量约定；指定 README 翻译配对检查通过 1 pair。当前未安装 CodeBuddy CLI，因此这只验收配置契约与文档一致性，不代表真实认证或 AutoDev 工程修改通过。

测试与验收：四类声明支持的工程分别有真实 Build/Test 成败样例；每个 Driver 的超时、取消、输出截断、无匹配项目和多驱动冲突有单测；Provider 动态注册/卸载、异步可用性、能力不符、Jev 低置信与切换后的审计均可重现；Codex/Claude 仍通过 DSH 官方插件调用，不出现重复登录或私有运行时。

## R6：完整 DSH 界面和人工操作

目标是使 Web UI 成为完整、可观察、可恢复的工作台，而不仅是已有只读侧栏。补齐创建任务与验收标准、Plan 审阅/批准、启动与进度、节点尝试、Provider/Jev 决策、Evidence 来源及新旧 Candidate 对比、Gate 的所有允许动作、Assumption/Concept/Knowledge 人工纠正和版本历史。将不可用动作显示原因；高风险 Promotion 需二次确认、候选摘要和身份记录。

Remote 仍由 Host 验证权限、参数、项目作用域和状态；Client 只能提交意图，不能绕过 Gate 或直接写库。既有侧栏与 `autodev` 命令继续作为入口，避免另建一个脱离 DSH 的 Web 应用；中英文文案、键盘操作、空/错误/断线/重连状态一并完善。

测试与验收：组件测试覆盖状态渲染与动作禁用；浏览器 E2E 在真实 DSH Web 中走完“创建→审阅→运行→查看证据和 Diff→处理 Gate→Promotion”；再走失败恢复与语义人工审阅路径。Host 必须拒绝跨 Run/Candidate 引用、超出 Run Scope 的知识详情和无效状态转移；Gateway 在 Remote 分派前负责拒绝未通过 DSH operator 认证的连接。当前 Gateway invocation 只有 operator Peer，没有可信的浏览器 Session 或自然人 principal，因此 AutoDev 不得把客户端传入的 `sessionId`/Peer ID 当作项目级或自然人授权凭据，也不宣称已实现跨 Operator 的项目 RBAC；这需要 DSH 上游认证层提供不可伪造的签名 principal/claims。UI 的成功提示不得早于 Host 状态提交。

### R6-M1：DSH Web AutoDev 浏览器工作台闭环（已实施并验收，2026-09-25）

新增 [AutoDev Web 工作台 E2E](apps/web/tests/autodev-workbench.e2e.ts)，直接启动真实 Web scaffold 和已安装的 AutoDev Profile Bundle，经生产 Sidebar/Remote/Host Runtime/SQLite/Git Worktree/Node Driver 完成两条路径：其一让确定性测试 Provider 在隔离 Worktree 中受控失败，断言原仓库未改动；关闭首个 Host composition，再以新的 DSH home 启动 composition、连接同一项目，恢复并读取持久 Gate，最后由 UI 显式 Abandon。其二由确定性 Provider 仅写入 Worktree 中的 `src/result.txt`，经 Node Build/Test、REVIEW 和 Candidate 绑定 Verification 到达 VERIFY；UI 显示 Diff 与摘要后，只有操作者二次确认才执行 Promotion，最终断言原仓库此前保持干净、之后仅 `src/result.txt` 改变，Run 为 PROMOTED，Candidate 有 PASS Promotion Evidence 且 Git Promotion ActionIntent 为 COMMITTED。

验证命令：`$env:DSH_AUTODEV_WEB_E2E_BROWSER = 'msedge'; pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/autodev-workbench.e2e.ts --retry=0 --maxWorkers=1 --no-file-parallelism`；Windows x64 / Node 24.16.0 / Playwright 1.61.1 / Microsoft Edge，本轮定向 1/1 通过，未重跑全套。CI 默认仍使用锁定版 Playwright Chromium。测试 Provider 是明确隔离的确定性替身；它验证真实 DSH Web/Remote/Host/Git/Driver 和人工动作闭环，不证明官方 Codex/Claude/Jev、认证账号、外部模型或 CodeBuddy ACP 行为。Host 重启通过销毁并重建 Web scaffold composition、共享 AutoDev data root 演练；不是 `dsh web` 独立 OS 进程与 Gateway 网络断线恢复测试。R6 的核心工作台正向/失败恢复路径已有浏览器证据；外部身份与真实进程/网络重连仍需验收。Host 的 Run Scope/资源引用负例由领域测试直接验收，跨 Operator 的项目权限不属于当前 DSH 单 Operator 能力。

### R6-M2：语义 Gate 人工审阅浏览器闭环（已实施并验收，2026-09-25）

扩展同一真实 DSH Web 工作台 E2E：确定性 Provider 在首次 Attempt 提交 `SemanticUncertainty` 与 `AssumptionRaised`，Host 进入 `NEEDS_INTERVENTION`，断言 Gate 解决前没有 Build/Test Evidence；操作者在 Sidebar 分别记录假设失效理由和不确定性处理结论，随后显式创建并批准 Plan v2。第二次 Agent 执行到达 VERIFY，断言 Agent Context 卡片及持久化 `AGENT_CONTEXT` Artifact 保留 `INVALIDATED`/`RESOLVED` 状态和人工决议原文，且 Build/Test PASS 仅来自该次新 Attempt。

验证命令同 R6-M1 的定向 Vitest 命令；Windows x64 / Node 24.16.0 / Playwright 1.61.1 / Microsoft Edge，单文件、单用例 1/1 通过，Duration 20.26 秒；未重跑全套。该确定性 Provider 只用于验证真实 DSH Web/Remote/Host/UI 生命周期，不替代官方 Provider/自然人身份验收。Gateway 的可信边界已按 R7.4 校准：项目级隔离指 Run Scope 与资源引用一致性，不是 Operator 之间的访问控制。当时尚未完成的 Concept 人工纠正与 Knowledge/Playbook 浏览器旅程随后分别由 R6-M3/M4 验收；OS 级进程/网络断线恢复仍待验收。

### R6-M3：Business Concept 人工纠正浏览器闭环（已实施并验收，2026-09-25）

在 R6-M2 的语义 Gate 浏览器旅程中加入一条明确标记的测试种子 Concept observation，再由操作者在 Sidebar 修改定义、Target、Effect、依据摘要和人工纠正理由。E2E 断言旧 observation 仍保留，新版为 `ESTABLISHED` v2 且追加 `HUMAN_CORRECTION` 来源/理由；语义变更保持 Replan Gate，Plan v2 纳入该 Concept，第二次 Agent Context 引用 v2 并携带修订后的业务效果。测试种子通过 Host 领域服务创建；从人工纠正开始的 UI/Remote/Host/Plan/Context 为真实 DSH Web 路径，不声称这是官方 Provider 产生的观察。

验证命令同 R6-M1；Windows x64 / Node 24.16.0 / Playwright 1.61.1 / Microsoft Edge，定向单文件/单用例 1/1 通过，Duration 18.40 秒；未跑全套。R6-M1/M2/M3 目前共用此一条真实 Web E2E，分别覆盖工作台失败恢复与 Promotion、Assumption/SemanticUncertainty Gate、Business Concept 版本化人工纠正。该时点尚未覆盖的 Knowledge/Playbook 浏览器旅程由后续 R6-M4 补齐。

### R6-M4：Knowledge 与 Playbook 人工审阅浏览器闭环（已实施并验收，2026-09-25）

扩展同一真实 Web E2E，覆盖 Knowledge 合并提案的人工接受、完整回归套件 PASS、使用可信 Evidence 显式晋级、Compaction 人工确认与版本保护恢复；再覆盖 Playbook 草稿创建、激活触发 Replan Gate、不可变 v2 修订、Plan 纳入 v2、Context/Playbook Fit，以及弃用后再次要求 Replan。浏览器实际操作已走过 Knowledge 与 Playbook v2 修订阶段；测试 Direct Host seed 仅用于建立同作用域 Knowledge/Concept 夹具，UI/Remote/Host 操作仍由真实 DSH Web composition 执行。

验证命令同 R6-M1：`$env:DSH_AUTODEV_WEB_E2E_BROWSER = 'msedge'; pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/autodev-workbench.e2e.ts --retry=0 --maxWorkers=1 --no-file-parallelism`。验收结果：真实 DSH Web E2E 定向单文件/单用例 1/1 通过，Duration 21.63 秒；未跑全套。诊断确认先前 `NEEDS_INTERVENTION` 并非语义/Playbook Fit，而是该复合旅程需要第三次显式实现、测试夹具仍使用默认 `maxAttempts=2`。仅将此隔离 E2E Profile 的上限设为 3，并断言 Playbook Plan v3 的执行 attempt 为 3；没有放宽产品默认上限或改变 Runtime。此用例在定位迭代中共定向执行 7 次，前 6 次暴露/修复定位或夹具问题，最终一次通过；不会把这些失败轮次记为通过，也未运行全套测试。Windows x64 / Node 24.16.0 / Playwright 1.61.1 / Microsoft Edge。该确定性 Provider 验证 DSH Web/Remote/Host 生命周期，不替代官方 Provider/Jev、真实自然人身份或 OS 级断线恢复验收。

边界说明：R6-M1 末段较早写下的“跨项目越权浏览器负例”按当前信任模型改为 Host 资源边界验收：拒绝跨 Run/Candidate 引用及超出 Run Scope 的资源读取。现有领域测试覆盖跨 Run Candidate Diff、错误 Run/六维 Scope 的 Assumption/Uncertainty、越界 Memory；本轮补上 Knowledge Detail 同作用域可读、越界拒绝的断言，并只定向执行该领域用例 1/1（2.39 秒），因此不再把重复的浏览器负例列为发布门禁。Gateway 当前是单 Operator，插件没有可验证的跨 Operator 项目权限；自然人/多用户 RBAC 只能在 DSH 上游提供签名 principal 后验收，不能以伪造的 UI Session ID 测试冒充。

## R7：安全运维、兼容性与发布

目标是把候选版变成可维护交付物。落实 ActionIntent 的身份、权限、风险级别、审批与审计；增加并发/租约、资源预算、Worktree 保留期和显式清理策略。SQLite schema 迁移必须可备份、恢复和从旧版本升级；升级或卸载不得静默丢失用户 Run、Evidence 和知识。明确日志脱敏、Artifact 大小与保留策略、凭据只由 DSH/环境配置持有。

测试与验收：全量单测、类型检查、Host/Client 构建、包内容审计和文档检查通过；全新 Profile 安装、普通 `dsh web` 启动、重启、升级、卸载、再安装各走一遍；真实 Codex/Claude/Jev、真实工程驱动和 UI E2E 全部在锁定版本矩阵重跑；故障注入覆盖进程中断、数据库恢复、Provider/网络失联、Promotion 冲突、并发争用与清理。发布记录包含版本/平台/命令/结果/证据链接/已知限制，由人工签收；任何 P0 安全或完成性缺陷、无证据的外部验收、无法恢复的数据迁移均为 No-Go。

### R7 子阶段与验收门禁

| 子阶段 | 范围与不变边界 | 自动验收 | 状态 |
|---|---|---|---|
| R7.1 备份/恢复 | SQLite 一致快照 + 所有已引用 Run Artifact；显式排除 Worktree/原仓库；目标必须是新目录；校验清单、路径和 schema 后恢复 | 往返、路径映射、内容哈希、损坏/篡改/覆盖/越界拒绝；Host Remote 与 Sidebar 二次确认 | **完成**：定向 Host/UI 测试 8/8、AutoDev typecheck 与 Host/Client Bundle 通过；Windows 隔离 RC.1 DSH Web Profile 经本地 Gateway token 创建 DRAFT Run 与 Evidence，通过 Sidebar Remote 备份 SQLite + 引用 Artifact 并恢复到全新数据根目录；清单两项文件哈希、Run/Plan、Artifact 内容与重映射路径均核对通过，Web 明确保持原数据根目录。真实外部账号、Agent 和其他 OS 矩阵不在此项验收内 |
| R7.2 Schema 迁移 | 保持 `autodev_meta.schema` 兼容；按版本执行 SQLite 事务迁移；写入不可变 SQL checksum 历史；并发启动需在写锁内重读版本 | 新库、v1→v2 数据保留、幂等重开、故障回滚/重试、未来版本拒绝、8 进程争用 | 离线迁移测试通过；定向 v1→v2 用例 4 项通过（Run/Evidence/Knowledge/Artifact 元数据及 Artifact 字节/哈希保留、失败回滚与重试、未来版本拒绝、8 进程争用）。该 v1 库是按旧 schema 契约构造的 fixture；另已验证 Alpha.2 实际写出的库为 schema v2，故 Alpha.2→RC.1 是有数据包升级保留验收，不代表 Alpha.2 曾写出 v1；Linux/macOS 仍未测 |
| R7.3a Retention Preview | DSH `retentionPreview` Remote + Sidebar；仅枚举托管根内由 Run/Candidate 引用的 Worktree；候选要求 Run 终态且达到可配置期限；活动 Runtime、Open Gate、PLANNED/AUTHORIZED/EXECUTING/UNKNOWN ActionIntent、非法时间、越界/链接/非目录/共享路径均保护；输出不含文件系统绝对路径且不执行删除 | Preview 查询前后数据库与 Worktree 内容不变；期限/状态/副作用/路径矩阵、未知路径保护；Remote 描述符、Sidebar 呈现和“仅预览、不删除”文案 | 完成；Host/Sidebar 预览覆盖已纳入当前 AutoDev 全包测试 |
| R7.3b Retention Execution | 保留 Run/Event/Evidence/Artifact；只清理显式选中的最多 10 个 Worktree；稳定指纹绑定保留策略、Run/Candidate/Gate/ActionIntent 版本与受管相对路径身份（不含生成时间）；持久化 Job/Item 状态和审计事件，不存/不返绝对 Worktree 路径；准备→二次确认→逐项执行；SQLite 执行租约阻止 Run 被重新打开；路径祖先/Git 注册/工作树干净性在确认和逐项删除前校验；仅用 Git 非强制移除，不作递归删除回退；重启后由文件系统与 Git 登记状态协调，歧义时停止并待人工复核。DSH Peer ID 只能记录为连接来源，不作为用户身份或授权依据 | 指纹稳定及状态变更测试；旧指纹/重复或越限选择/伪造确认拒绝；真实临时 Git 仓库的登记/干净/脏/路径边界/链接用例；执行租约阻止并发 Run 状态变更；删除前后故障注入和重启幂等恢复；Run/Evidence/Artifact 历史未变；Remote 描述符、Sidebar 二次确认与无路径断言 | 完成；10 项 Cleanup Host 测试 + Sidebar Job 生命周期覆盖；纳入 AutoDev 132/132 全包门禁 |
| R7.4 权限和审计 | 按 DSH Gateway 当前单一 operator 信任模型区分 `dsh-operator` 与 `autodev-runtime`；主体从调用期 `this.ctx.invocation` 派生，Peer ID 仅可作为连接引用；Plan Approval、Gate、Promotion、Cleanup 及受控知识变更追加结构化审计，ActionIntent 记录主体/授权理由/风险/结果；不接受 Client 传入 actor | Gateway 调用主体绑定、无调用上下文的内部来源标识、伪造 actor 字段无效；状态与审计一致提交、追加事件重启可读、UI 身份标签不冒充自然人且不显示 Peer ID、敏感数据不泄漏；Host/Client、类型、Bundle、文档门禁 | **离线门禁完成**：调用期身份、伪造字段隔离、SQLite 一致性/重启读取、知识与清理审计、双语 UI 已测；DSH 当前没有自然人账号或多用户 RBAC，真实认证 Web/Profile 与上游 principal 集成仍未验收 |
| R7.5 兼容矩阵与签收 | Node/OS/DSH Profile/Provider/Driver 版本矩阵、安装/启动/升级/卸载/恢复记录和发行说明 | 锁定矩阵的安装生命周期、包清单与真实外部 E2E 签收 | **Windows x64 / Node 24.16.0**：除 fresh install/start/uninstall 和空白 Profile 换包外，另在隔离 DSH Profile 中由真实 `0.1.7-alpha.2` `AutoDevStore` API 写入 Run、Evidence、Knowledge、Artifact 和事件；Alpha.2 实际 DB 为 schema v2。DSH plugin manager 换装 RC.1 tarball 后，真实 Web 启动成功；RC.1 `AutoDevStore` 读回全部数据，Artifact 字节数/SHA-256 一致，共 4 条记录和 4 条事件。同一隔离 Profile 卸载 RC.1 后数据库和 Artifact 字节未变，重新安装 Bundle 选择恢复且 Web 再次启动成功。**Node 22.20.0**：用同一隔离 RC.1 Profile 实际启动 Web 成功，DB/Artifact 哈希与数据快照不变；仅为运行时/Bundle 烟测。**最低支持版 Node 22.19.0**：官方便携 Node 下在既有数据 Profile 经 DSH plugin manager 实际卸载 RC.1，确认依赖、`dsh.profile.bundles` 选择和安装目录清除且 SQLite/Artifact 哈希不变；再从同一校验过的 RC.1 tarball 重装，确认 `0.1.7-rc.1` 与 Bundle 选择恢复并启动 Web（未认证 HTTP 401，正常停止后临时端口关闭）。既有数据 Profile 卸载/重装及启动已验收。另在全新隔离 DSH_HOME 中以 `--from-default-profile web` 建立 Web 模板 Profile，随后安装 RC.1 tarball，确认 `dsh-base` / `dsh-web-app` / AutoDev 三个 Bundle 选择、`0.1.7-rc.1` 版本，并在 Node 22.19.0 下启动 Web（端口 64595，未认证请求 401，正常停止后端口关闭）。Profile 本地 `pnpm peers check` 报告 5 个 AutoDev peers 缺失；DSH 运行时解析合并 installation anchor，本次真实 Web composition 成功。故最低版 fresh install/start 与既有数据卸载/重装已覆盖，但 Node 22.19.0 下 Alpha.2→RC.1 升级、完整测试套件仍未验收。相关 Node 22 临时端口已关闭且用户 3080 服务未中断。仍不证明 Linux/macOS 或真实 Provider/Jev/Agent E2E；详见[发布验证记录](packages/experimental/autodev/RELEASE-VERIFICATION.zh.md) |

### R7.4 实施方案与阶段验收

DSH Web 的 process token / 签名 Cookie 证明请求可代表当前 Harness 的本机 operator；Gateway 将已通过 Connection 校验的请求映射到 DSH operator Peer。协议没有账号名、用户 ID 或角色声明，因此 `dsh-operator` 是授权主体类别，不是某个自然人。`invocation.peer.id` 是连接层 Peer 标识，不能映射成审批人姓名、个人账号或权限。自动运行则标记为 `autodev-runtime`。缺少调用期 Gateway Context 的直接 Host 调用如实记录为内部来源，不伪造操作员身份；Remote 请求参数不得提供或覆盖 actor。

实现顺序：

1. **可信调用身份读取**：将 Remote 身份读取改为 Gateway 注入的调用期 `this.ctx.invocation`，而不是 Runtime 构造时捕获的 Host Context；定义 JSON-safe、无自然人字段的 Actor/授权来源契约。验收：真实 Gateway Service view 可见当次 Peer；多次调用不会串用；Client 传入同名字段无法影响主体；Host 内部直调标为 Runtime/Internal。
2. **持久审计和一致性**：复用 `autodev_events` append-only 表，不新增并行事件存储或迁移；为 Plan Approval、Gate 决议、Promotion、Cleanup 确认/取消及人工知识变更写入带 action、actor、authorization source、risk、result 与资源 ID 的事件；敏感摘要不得放入事件。ActionIntent 的 actor 与 authorization 字段随已有事务更新。验收：关键状态与审计事件同事务提交；重复 Remote 调用按现有幂等语义不重复伪造成功事件；回滚/失败记录准确；关闭重开后事件仍可读且不可改写。
3. **呈现与安全回归**：按 Run 提供有界 Audit Remote/Sidebar 时间线，清楚区分 DSH Operator、AutoDev Runtime 和历史/未知主体；Peer ID 仅在诊断展开项作为连接引用。验收：审批、Gate、Promotion、Cleanup、知识操作至少各有成功与拒绝/失败样例；无个人账号声明；UI 不显示本机绝对路径、提示词或凭据；Host/Client 测试、类型检查、Bundle 与 `doc-sync` 通过。

如果未来需要记录自然人审批人或按用户角色授权，必须由 DSH 增加由认证层产生、不能由 Client 伪造的签名 principal/authorization claims，并由 AutoDev 再做上游集成；本阶段不以匿名 ID、DSH Peer ID、浏览器 Cookie 内容或 DeepSeek 账号资料补造用户身份。

## 跨阶段验收矩阵与风险

每一阶段必须同时交付源码或配置、自动测试、最小真实样例、失败样例、更新后的契约文档和可复查验收记录。测试分层为纯单元与属性测试、Host/Remote 契约测试、隔离 Git 仓库进程测试、DSH Profile/Browser 集成测试以及带真实外部凭据的目标机 E2E；Mock 只覆盖前三类，不能顶替最后一类。所有结论使用“通过、失败、阻塞、未运行”四态，禁止把“待用户配置”写作通过。

| 发布门禁 | 必须看到的证据 | 失败处理 |
|---|---|---|
| 可安装可启动 | 锁定版本的 Profile 安装、`dsh web`、认证后 UI/工具、重启/升级/卸载记录 | 回到 Bundle/Profile 修复；不得宣传“默认自动加载” |
| 可执行可信 | 真实 Codex 和 Claude 各一条工程修改；原仓库隔离与 Promotion 记录 | 保留 Gate/Worktree；不能用 Loader 测试顶替 |
| 决策可控 | Jev 真实调用及 required/advisory/off、无效/超时/不可用路径 | 门禁或明确回退，不能静默 PASS |
| 验证可靠 | 当前 Candidate 的 Build/Test/Review/Side Effect PASS，负例全拒绝 | 保持 UNKNOWN/FAIL，不能 Promotion |
| 语义与知识可信 | 人工纠正、假设失效、Playbook Mismatch、知识 Promotion/Regression/Compaction 样例 | 暂停、降权或回到 Candidate，保留历史 |
| 用户可完成全程 | 浏览器创建、审阅、运行、证据、Gate、Promotion 与重连 E2E | 不得只以只读侧栏签收 UI |
| 可维护 | 迁移/恢复、权限审计、资源与清理、兼容矩阵 | 延后发布并公布阻塞项 |

主要风险是外部凭据/网络无法在开发机复现、DSH 上游版本漂移、现有 Profile 中其他插件的历史警告、Git/构建工具跨平台差异、知识自动提升导致污染以及长任务失败后的副作用不确定。处理顺序是先留证，再分类：环境缺口不改造成“通过”；上游漂移记录兼容矩阵；不确定副作用由人工确认；知识默认保守；仅在证据支持下调整现有设计。

## 当前执行状态（2026-09-25）

本节记录当前工作树能证明的增量，不代表任何尚未运行的目标机验收。R0-M1 后 Node 24.16.0 AutoDev Vitest 为 148 项通过、2 项可选 Maven/Gradle 真工程集成测试跳过（11 个测试文件）；本机 Node 22.20.0 同样为 148/2 跳过，Node 22 进程出现内置 SQLite experimental warning 但无失败。此前 Node 22.19.0 启用全部集成的 147/147 是 M1 前证据，本轮没有复跑该精确版本和两项集成。R0-M1 为 Run 初始聚合、Plan ID 不可覆盖、Replan 原子切换/旧 Plan SUPERSEDED、Gate 打开与非 Promotion 决议回滚新增事务和故障注入回归；AutoDev typecheck、Host/Client Bundle 通过。最近完整文档 `doc-sync` 为 42/42、101.57 秒；此后只更新验收记录，未重跑全量文档门禁。R2-M7 在 Windows 上完成 128 个独立 Host Promotion 竞态的 3 次初验和 10 轮串行短 soak；R2-M8 将 ActionIntent 幂等查找与 PLANNED 事件原子化；R2-M9 将授权、执行权领取和结果状态/账本提交分别原子化，128 Host 三类竞态各连续通过 3 次；R2-M10 以真实 Host SIGKILL 验证 Worktree 文件副作用已发生、结果尚未落账时恢复为 UNKNOWN 且不自动重试；R2-M11 又在同一故障窗口加入回环 HTTP 服务已接受的副作用，并验证恢复后服务端仍只收到一次请求；R2-M12 再验证原仓库已应用 Candidate Git patch 后 Host 崩溃，重启后 UNKNOWN/人工 Gate，显式批准 promote 才能对账完成（Provider/Build/Test/Promotion 均有进程级用例）。常规 Promotion 测试默认仍为 96，以控制普通 CI 资源开销。Harness 根目录 Host/Client 构建和导出 API JSDoc 的既有通过记录仍适用。测试覆盖 Candidate 历史快照/双 Diff、SQLite + Run Artifact 备份恢复、schema v1→v2 迁移、Retention Preview/Cleanup、Agent Protocol/Evidence、R3 多版本 Playbook/Plan/语义状态组合生命周期、R4 100 轮知识增长压缩和 200 条 Merge Proposal 窗口/小数相似度边界、真实 npm/pytest/Maven/Gradle 工程成败，以及 R5 四类 Driver 的子进程成功/非零退出/活动取消/超时/输出截断矩阵。

R7.4 已以调用期 Gateway invocation 派生主体，拒绝 Client 伪造主体字段；Plan 批准与 Gate、Cleanup、ActionIntent/知识操作审计在 SQLite 事务中追加，重开数据库后可读取最近 100 条。R7.5 已在 Node 24.16.0 / pnpm 11.19.0 / Windows x64，以仓库构建的 DSH CLI `0.1.7-alpha.2` 和临时 `DSH_HOME` 完成 tarball 安装、Web 配置组合、Web 启停和卸载；期间发现并修复 bundle 动态 chunk 未进入 package 的问题。迁移测试覆盖新库初始化、v1 Run/Event 保留、事务失败回滚、未来 schema 拒绝降级及 8 个独立进程并发冷启动。R2-M3 的 32 Host、R2-M4 的 48 Host、R2-M5 的 64 Host、R2-M6 的 96 Host 和 R2-M7 的 128 Host 独立 Node Promotion 竞争均连续通过 3 次；R2-M5 将 fresh Verification 写入移到原子 Promotion claim 后，R2-M6 又将 SQLite busy timeout 提升为 15 秒以承受完整套件并行负载；R2-M8 修复 ActionIntent 幂等键的跨 Host 查找/创建竞态且 128 Host 连续通过 3 次；R2-M9 又验证冲突授权、唯一 EXECUTING claim 和互斥结果竞争下的单条终态/账本写入；R2-M10/M11 通过 Windows 真实 Host SIGKILL 覆盖 Worktree 文件与回环服务已确认副作用、SideEffect 结果尚未落账的故障窗口，恢复后形成 UNKNOWN 与人工 Gate 且不重试。R3-M2 的六维 Scope/Evidence/Assumption/Uncertainty 边界、R3-M3 多版本生命周期和 Playbook Fit 负例也已通过。

R5-M4 本轮在隔离目录以 Maven 3.9.16 / Wrapper 3.3.4 和 Gradle 9.6.1 标准 Wrapper 对真实 JUnit 工程分别完成 Build/Test 成功与断言失败检测；工具分发文件均按官方校验值验证，未安装到系统 PATH。R7.6 首轮以官方 SHA-256 校验的 Node 22.19.0 在 Windows x64 全跑 139 项（含上述两项真工程集成）并完成 AutoDev typecheck/Bundle；纳入 R2-M12 后最低版本全套复验为 147/147。独立 Driver 结果不等于 AutoDev Run/真实 Agent 的端到端验收；其他 OS/Profile、升级恢复、认证后浏览器与真实外部 Provider/Jev 尚未验收。WSL 发行版枚举无响应并已终止，因此未运行 Linux 测试；合成 Knowledge 增长循环不等同于真实长期数据 soak。

| 阶段 | 状态 | 已有证据 | 剩余验收缺口 |
|---|---|---|---|
| R0 基线与契约 | 完成（保留历史证据限制） | S1–S4 历史契约映射、架构决策、威胁/失败矩阵、R0-M1 Run/Replan 原子事务、Plan ID 定义不可变、旧版 SUPERSEDED、Gate 开启/普通决议事务；全套 Node 24 与 Node 22.20 各 149 通过/2 跳过，typecheck、AutoDev Bundle 通过；此前完整 `doc-sync` 42/42 是历史结果，后续文档更新后的全量门禁状态另见 R5-M5 记录。历史测试数字明确标为对话声称 | 历史 Java 源仓库/PR/报告未找到，不能独立复验旧阶段结果；Promotion Gate admission 窄中断窗口已拆入 R2-M13 |
| R1 真实环境 | 阻塞（真实 Codex 调用超时） | DSH Web Profile `--dump-config` 可证明 AutoDev 与官方 Codex/Claude Provider 配置被组合；本机 Web 未认证请求返回 401；Maven/Gradle 独立 Driver 工程成败集成测试已由 R5-M4 通过。2026-09-24 在隔离临时 Git 仓库启动一次 ChatGPT-authenticated Codex Provider E2E；`codex login status` 显示 ChatGPT 登录，但 Responses sampling request 超时并由 Codex 内部重试到 3/5，随后手动停止；没有证明文件修改，不能计为通过。底层用例增加 45 秒 AbortController 主动取消和 65 秒 Vitest 上限；对应本地取消单测 1/1 通过（同文件 55 项跳过），只证明取消/清理路径。另新增 opt-in 的 [AutoDev Codex 完整链路 E2E](packages/experimental/autodev/tests/codex-chatgpt.e2e.ts)：实际 Codex Provider、Plan 批准、隔离 Worktree、Node Build/Test、Candidate Evidence/Verification、Promotion 前原仓库不变及显式 Promotion 后校验；原始 45 秒主动取消和 65 秒测试上限。2026-09-25 首次执行该真实用例，Responses sampling timeout 触发适配器内部第 1/5 次重试，45 秒主动取消，测试 1/1 失败；随后仅为验证 SOCKS5 代理假设，在测试子进程移除 `ALL_PROXY`、保留 HTTP(S) 代理，并用正确 `vitest.e2e.config.ts`、`--retry=0` 复验一次，仍于 45 秒主动取消（总时长 47.85 秒），测试 1/1 失败；两次均未完成文件修改或 Build/Test/Promotion。没有专用 Codex/Claude/Jev 凭据环境变量；`DEEPSEEK_API_KEY` 不代表这些 Provider 已认证 | 认证后的 Web 工具可见性、真实 Codex/Claude 修改、真实 Jev、真实 AutoDev Run→Worktree→Build/Test→Evidence→Promotion 闭环和重启/升级记录仍未完成；Codex 实际响应超时原因待查，禁止把登录状态或配置解析当作 E2E；除非出现新的有效认证或连通性证据，不再重发外部请求；不以独立 Driver 测试代替 E2E |
| R2 Agent Protocol / Evidence | 部分完成 | 协议 Task/Context/Provider 身份、Signal 白名单/序号、旧版协议拒绝、未知/恶意 Signal、Attempt 绑定、UNKNOWN 与旧证据失效、Promotion 前候选/Plan/Attempt/Worktree/Evidence 重验、Artifact SHA-256、Candidate 漂移与新 FAIL Evidence 阻断、重启 Gate 恢复均有测试；128 Host Promotion 竞态唯一获胜方提交 intent/SideEffect/PASS Evidence 且最终文件对应封存 Candidate（3 次初验 + 10 轮短 soak）；R2-M8 以 `BEGIN IMMEDIATE` 原子化 ActionIntent 幂等查找、Intent/Event 与 PLANNED SideEffect/Event，128 Host 连续 3 次只生成一套记录；R2-M9 将授权冲突隔离、`AUTHORIZED→EXECUTING` 唯一 claim，以及 COMMITTED/FAILED/UNKNOWN 状态、ActionIntent Event、审计与 SideEffect Ledger/Event 同事务提交纳入验证；R2-M10/M11 在 Provider/Build/Test 三阶段通过真实 Host SIGKILL，确认 Worktree 文件效果已落盘、回环 HTTP 服务已接受且结果账本仍为空；R2-M12 在 Git patch 已实际应用于原仓库但账本未落账时杀死 Host，恢复为 UNKNOWN/人工 Gate；只有显式 Gate `promote` 才执行精确 tree 对账，历史 UNKNOWN 保留且 Candidate 只应用一次；R2-M13 将 Gate 决议和 PROMOTING claim 合并为 SQLite 原子事务，验证 claim 回滚、数据库重开和进程级 SIGKILL 恢复、Gate 决议竞争与既有直接 Promotion 竞态。新增 SIGKILL 用例 1/1、M13 定向组 4/4、typecheck 通过；本机 Windows SIGKILL 5/5；Node 22.20.0 与 Node 22.19.0 下 M13 SIGKILL 定向用例均 1/1。Ubuntu/macOS 定向 CI 矩阵的配置契约测试 1/1，但两个远端 runner 尚无实际结果。加入该用例前最近全套 Node 24.16 与 Node 22.20 各 152 通过/2 个可选 Driver 集成跳过，未为测试专用改动重跑全包；Node 22.19 + Maven/Gradle 147/147 是 M1 前记录 | 更高扇入与长时 soak、Linux/macOS 竞态/恢复仍未验收；POSIX runner 结果待取得；HTTP 对端是同机测试假服务，不等同于真实 Provider 或支付、邮件、云 API 等生产副作用；真实 Provider 崩溃恢复和 R1 凭据驱动的官方 Provider E2E 仍缺 |
| R3 Memory / Concept / Playbook / Assumption | 部分完成 | 六维 Scope 隔离、限量检索/上下文预算、来源和 Context Artifact；Concept Observation→Candidate→人工纠正→ESTABLISHED 版本历史与歧义门禁；Assumption Evidence 可信度/失效和 SemanticUncertainty Gate；Playbook 不可变版本、Fit 与影响计划的 Replan；R3-M2/M3 领域闭环及错误 Scope/跨版本回归通过；R6-M2/M3/M4 浏览器覆盖语义 Gate、Concept v2、Knowledge 生命周期和 Playbook v2→Plan v3→Context Fit | 官方 Codex/Claude Provider 上下文端到端仍待 R1 真实认证与连通性验收；多项目真实用户边界仍待 R6/R7 |
| R4 Knowledge Evolution | 部分完成 | 真实 Evidence 与回归套件 Promotion 门槛、查询检索正/负例、热/温/冷有界检索、Candidate Context 卡片、逐项 Compaction 报告和事务化完整性/版本保护恢复；新增有界同作用域/同类型语义合并提案、解释词与输入版本快照、人工拒绝/接受为新 Candidate、源记录不变、接受事务内检测版本变化/过期输入并将提案置为 STALE 的 Host Remote/领域测试；Sidebar 可生成/审阅提案、创建/运行回归套件、按可信 PASS Evidence 和新鲜 PASS 回归晋级 Candidate，并人工确认压缩/受版本保护的恢复；重复 Knowledge Remote 调用使用调用级幂等 ID，同一 DSH `callId` 安全重放，新调用可重复创建用例/运行套件/压缩，Compaction 整批记录在 SQLite 事务内提交并覆盖中途失败回滚；新增跨 `projectVersion` Knowledge 正/负例隔离回归和不可变 Playbook v1/v2 同一新版本意图对照，验证 Fit 绑定精确 Playbook ID/版本且旧版本仍可审计；增长/检索/回归/压缩循环扩至 100 轮、2,602 条 Knowledge 候选，每轮验证回归 PASS、精确作用域与类型合并、跨版本隔离、不同类型不误合并、有界检索及 Evidence/Memory/来源/使用计数保全，期间 33 次压缩恢复，保留 100 份报告、233 条回归结果和 200 次成功使用计数；另有 202 条记录的 200 条 Merge Proposal 新旧窗口边界回归，并修复 minSimilarity 被整数 clamp 截断的问题；Node 24 默认全套及 Node 22 最低版本完整集成套件均通过 | 当前为 Windows 单进程合成数据压力，不等同于真实生产数据分布或多日线上 soak；更大规模/性能压力及 Linux/macOS 验收仍待 R7 |
| R5 Driver / Provider | 部分完成 | Maven/Gradle/Node/pytest 根标记识别、Plan 冻结、冲突拒绝及 argv 安全测试；npm/pytest 已跑真实临时工程成功/失败；四类 Driver 子进程成功、非零退出、活动取消、超时、输出截断矩阵；Maven 3.9.16/Wrapper 3.3.4 与 Gradle 9.6.1 标准 Wrapper 分别在隔离真实 JUnit 工程通过 Build/Test，并检测故意失败的测试，工具分发校验通过；动态 Provider 注册、Jev 路由选择、健康检查、argv 调用与 disposer 测试通过；Harness Subagent 和自定义 Provider 都需显式承诺 per-run Worktree cwd，trait 声明逐项校验且未知能力不作为通配符，不能满足契约的候选项不可用、直接调用 fail closed；CodeBuddy ACP/Ollama/FreeLLMAPI 分层接入说明；本机 Ollama 经动态声明的 `ollama-local` 路由通过真实 `llm-pi-ai → ctx.llm.stream()`，并由同一路由完成一轮 DSH AgentLoop 对话、提交 assistant Session 记录 | workspaceCwd 和自定义 Provider fail-closed 的源码、回归、类型检查及 Bundle 已通过；2026-09-24 在 Windows x64 / Node 24.16.0 / pnpm 11.25.0 上分别通过模型路由和 AgentLoop 定向 E2E 各 1/1（`qwen3:8b-fast`，localhost OpenAI-compatible endpoint），并提供可选复现用例与双语配置示例；证据覆盖 LLM adapter 与普通 DSH Agent 单轮，不代表 AutoDev Agent/Worktree 或 DSH Web profile 端到端。CodeBuddy CLI 当前不可用，故真实 CodeBuddy ACP/Auth/权限、官方 Codex/Claude 工程修改以及 AutoDev 外部 Agent 调用仍需单独验收。此前 AutoDev Node 24 默认 144 通过/2 个可选 Maven/Gradle 测试跳过，最低 Node 22 启用后 146/146；真实 Driver 测试仍不等同于 R1 Agent Run 闭环 |
| R6 完整界面 | 部分完成 | DSH Sidebar 已支持创建/批准/启动、全部 Gate 动作、Candidate Diff/历史、语义与 Concept/Knowledge/Playbook 操作、清理和审计；Host 有 Run Scope、跨 Run Candidate 引用及越界 Memory/Knowledge 详情拒绝校验，本轮新增 Knowledge Detail 正反例并定向通过 1/1。R6-M1/M2/M3/M4 由真实 Web composition E2E 覆盖失败恢复/放弃、验证与显式 Promotion、语义 Gate 人工决议、Concept v2、Knowledge 合并/回归/晋级/压缩恢复，以及 Playbook v2→Plan v3→Context Fit | 官方 Codex/Claude/Jev 认证任务、`dsh web` 进程级重启/网络重连和其他 OS/Profile 仍待验收；当前 DSH 单 Operator 模型不提供跨 Operator 项目 RBAC，自然人/项目级身份需 DSH 上游签名 principal 支持 |
| R7 运维与发布 | 部分完成 | SQLite/WAL、Artifact、ActionIntent、Host 重启恢复、经校验备份/恢复、v1→v2 迁移、Retention Preview 与持久 Cleanup Job 已有实现；R7.4 调用期 Gateway Actor 和事务化审计通过；R7.5 Windows x64 / Node 24.16.0 下，真实 Alpha.2 `AutoDevStore` 写入的 Run/Evidence/Knowledge/Artifact 及 4 条事件，经 DSH plugin manager 换装 RC.1、真实 Web 启动后由 RC.1 Store 全部读回且 Artifact 哈希/字节数匹配；同一隔离 Profile 卸载再安装 RC.1 后，数据库及 Artifact 两文件 SHA-256 与卸载前一致，重装的 Web 在端口 63714 启动后正常关闭；Node 22.20.0 使用同一 RC.1 Profile 启动 Web 于端口 49186 后正常关闭，持久数据仍与快照一致；Node 22.19.0 下既有 Profile 卸载/重装并在端口 65087 启动 Web，未认证请求为 401，SQLite/Artifact 哈希保持一致；另用全新 Web 模板 Profile 安装 RC.1，三个 Bundle 选择正确，在端口 64595 启动、未认证请求 401 后正常关闭。Profile 本地 peers check 报告 5 项缺失，DSH runtime resolution 合并 installation anchor 且本次 Web composition 成功；所有临时端口已关闭，用户 3080 仍运行。M14 本机 Windows SIGKILL 5/5，定向 Ubuntu/macOS runner job 与配置契约测试 1/1 已就绪，远端运行结果未取得；全包最近证据见上文且未为本轮生命周期用例重跑全包 | 备份不携带 Git Worktree/源仓库，不能承诺跨数据根续跑/晋级；Linux/macOS、Node 22.19.0 下 Alpha.2→RC.1 升级/未覆盖的其他 Node/Profile、M14 跨平台 SIGKILL 实际 CI、真实 Provider/Jev/Agent、自然人身份/RBAC 仍缺 |

下一依赖顺序：R0 基线、契约、R0-M1、R2-M13、R7.1 隔离备份恢复及 Node 24/Node 22.20/Node 22.19 本机 RC.1 生命周期运行均有记录。R7.5 已补上 Windows x64 / Node 24.16.0 的真实有数据 Alpha.2→RC.1 包升级，以及最低支持版 Node 22.19.0 的 Web 模板 fresh Profile 安装/启动和既有 Profile 卸载/重装、数据保留；最低版下 Alpha.2→RC.1 升级仍缺。R7.2 的旧 v1→v2 仍由契约 fixture 验证（4 项通过）。最近完整 `pnpm run doc-sync` 42/42、101.57 秒；后续仅增加验收记录，未重跑，记录变更以 `git diff --check` 校验。其他 OS/Node/Profile 与 M14 Linux/macOS 实际运行结果仍待补。

R1 真实环境仍是发布关键门禁：官方 Codex/Claude、Jev 与 AutoDev Run→Worktree→Build/Test→Evidence→Promotion 真实闭环尚未验收。近期 Codex Responses sampling 多次超时且无工程修改；除非认证或连通性出现新证据，不再重发外部请求，也不以登录状态、Mock 或配置解析替代。CodeBuddy CLI 不可用；本机 Ollama 已验普通 DSH AgentLoop，但非 AutoDev Agent/Worktree。R4 多日真实数据 soak、跨平台恢复及这些外部验收未完成前，完整版本保持 No-Go。

R3-M2 验收记录（2026-09-24）：此前记录的 133/133 是 R7.5 截止时基线；本阶段新增两项领域测试后，全套为 135/135（11 个测试文件），定向 `domain.spec.ts` 为 27/27。AutoDev typecheck、Harness 根目录 Host 与 Client Build 均通过。新增验证覆盖六维逐项冲突、Assumption Evidence scope、错误 Run/错误 Scope 解析拒绝和快照过滤；未覆盖真实认证浏览器或外部 Provider E2E。

R3-M3 验收记录（2026-09-24）：新增组合生命周期领域回归后，`domain.spec.ts` 为 28/28；Node 24.16.0 默认 AutoDev 全套为 137 通过、2 个可选 Maven/Gradle 集成跳过，Node 22.19.0 最低版本且启用两项真实集成后为 139/139。Node 22.19.0 下 AutoDev typecheck 与 Host/Client Bundle 通过。测试覆盖 Agent 在 v1 上下文中提出 Assumption/SemanticUncertainty、人工解决后将 Playbook 不可变升级为 v2、由 Plan v2 重审生成 Plan v3、批准后续跑；新上下文只引用 v2 并显示 INVALIDATED/RESOLVED 语义结论，Plan v2 与其 Agent Context Artifact 均保持原样，新的 Attempt Artifact 反映新版本快照。未覆盖认证后的真实 Provider 和浏览器人工审阅 E2E。

R2-M3 验收记录（2026-09-24）：跨进程 Promotion 屏障竞争从 16 个提升至 32 个独立 Node Host；每次全部进程正常收敛，恰好一个成功，最终只留下一个已提交 Promotion intent、SideEffect 和与封存 Candidate 对应的 PASS Promotion Evidence，仓库最终文件与该 Candidate 一致。该定向用例连续 3 次通过，随后 AutoDev 全套 135/135 通过。此证据仅适用于当前 Windows 环境；Linux/macOS、超过 32 个并发者、更长时间压力和其他 Side Effect 并发窗口仍待验收。

R2-M4 验收记录（2026-09-24）：独立 Node Host Promotion 屏障竞争提升到 48 个进程；48/48 进程正常退出，恰好一个 Promotion 成功，最终仅一条与封存 Candidate 对应的 PASS Promotion Evidence、一个 COMMITTED git-promotion intent/SideEffect，且仓库结果与获胜 Candidate 一致。定向用例连续 3 次通过。当前证据只覆盖 Windows；超过 48 个并发者、更长时长、Linux/macOS 和其他副作用窗口仍待验收。

R2-M5 验收记录（2026-09-24）：独立 Node Host Promotion 屏障竞争提升到 64 个进程，64/64 正常退出，恰好一个 Promotion 获胜；仅写入一个匹配封存 Candidate 的 PASS Promotion Evidence 和一个 COMMITTED intent/SideEffect，最终仓库文件与 Candidate 一致，定向用例连续 3 次通过。首轮压力暴露 64 个竞争者在原子 claim 前重复写 Verification 导致 `database is locked`；Runtime 现先用事务取得 PROMOTING claim，再由唯一获胜 Host 重验并落盘 Verification，因此无需弱化败者/副作用断言。Node 24.16.0 默认 AutoDev 套件 137 项通过、2 项可选 M/G 集成跳过；Node 22.19.0 启用完整 Maven/Gradle 集成后 139/139 通过，typecheck 与 Host/Client Bundle 通过。此证据限于 Windows；超过 64 个并发者、长时压力、Linux/macOS 和其他 Side Effect 并发窗口仍待验收。

R2-M6 验收记录（2026-09-24）：独立 Host Promotion 屏障竞争提升到 96 个进程，96/96 正常退出，恰好一个 Promotion 获胜；唯一 PASS Promotion Evidence、COMMITTED intent/SideEffect 与封存 Candidate 和最终仓库一致，定向测试连续 3 次通过。曾在完整套件并行负载下观测到 `ERR_SQLITE_ERROR`/`SQLITE_BUSY`（5），现由 `DatabaseSync` 构造器配置 15 秒有界 busy timeout；Node 24.16.0 完整默认套件为 137 通过、2 个可选集成跳过，最低 Node 22.19.0 启用 Maven/Gradle 集成后 139/139 通过，Node 22 typecheck 与 Host/Client Bundle 通过。该证据覆盖当前 Windows 本机文件系统与完整 AutoDev 套件负载；不代表 Linux/macOS、超过 96 个并发者、长时 soak 或其他 Side Effect 竞争已验收。

R2-M7 验收记录（2026-09-24）：为独立 Host Promotion 竞争测试加入受限的 `AUTODEV_PROMOTION_RACE_WORKERS` 压力参数（默认 96，范围 2–128），普通套件资源成本不变。本机 Windows x64 将并发提升为 128 个独立 Node Host，初始连续 3 次通过后，另做 10 轮串行短 soak；共 13 次成功，每轮均断言 128/128 进程正常退出、只有一个 Promotion 获胜，唯一 PASS Promotion Evidence 与 COMMITTED intent/SideEffect 均匹配封存 Candidate，最终仓库文件也与 Candidate 一致。此项是 Windows 本机文件系统的定向高扇入短 soak，不等于多小时/多日 soak、其他 OS、超过 128 个 Host 或其他副作用窗口并发验收。

R2-M8 验收记录（2026-09-24）：跨进程测试先将旧版 check-then-write 排程确定性对齐：16 个 Host 都在任何写入发生前读到幂等键不存在，旧实现因此创建 16 个不同 Intent ID。修复后由 Store 的单一 `BEGIN IMMEDIATE` 事务内查询同 Run 的幂等键，再共同写入 ActionIntent、`action/updated` Event 与 PLANNED SideEffect/Event；不新增表或 schema migration。128 个独立 Host 同时请求相同 Run/kind/target，均拿到同一 Intent ID，数据库恰好保留 1 条 Intent、1 条 PLANNED SideEffect 和各 1 条对应 Event；定向测试连续 3 次通过。Node 24.16.0 默认套件 141 项通过/2 项可选集成跳过；Node 22.19.0 启用 Maven/Gradle 后 143/143，最新 AutoDev Host/Client typecheck 与 Bundle 通过。此项仅证明“计划”幂等原子性；AUTHORIZED/EXECUTING/COMMITTED 的跨 Host 并发状态转换仍需单独验收。

R2-M9 验收记录（2026-09-24）：新增确定性跨进程屏障测试，将 128 个独立 Host 同时带到 ActionIntent 原子更新入口。授权竞争将 64 Host 设为理由 A、64 Host 设为理由 B，连续 3 次通过；相同理由重放幂等成功，冲突理由拒绝，只留一个 AUTHORIZED 状态 Event 和一条授权审计。`AUTHORIZED→EXECUTING` 执行权竞争连续 3 次通过，每轮恰好一个 Host 获得 EXECUTING，其他 127 个拒绝；状态与唯一 `action/updated` Event 一致。结果竞争将 64 个 Host 提交 COMMITTED、64 个 Host 提交 FAILED，连续 3 次通过；同一获胜结论的 64 个调用作为同一结果的幂等重放，互斥结论的 64 个调用拒绝，SQLite 最终仅有一个终态 ActionIntent Event、一个 action-result 审计事件及一条匹配的 SideEffect/Event。ActionIntent 状态、审计与结果 Ledger 现处于同一 `BEGIN IMMEDIATE` 事务，避免状态成功而结果记录未落账；状态时间戳单调推进以区分重试周期。Node 24.16.0 默认 144 项通过、2 个可选集成跳过；Node 22.19.0 启用真实 Maven/Gradle 集成后 146/146，AutoDev typecheck 与 Host/Client Bundle 通过。证据限于 Windows 本机文件系统、最多 128 Host、短时定向 soak；未覆盖跨 OS/长时压力，也不能让 SQLite 与外部命令/Provider 副作用形成分布式原子事务。外部效果已发生而 Host 在写入结果前崩溃时仍须保留 UNKNOWN/重启人工接管门禁。

R2-M10 验收记录（2026-09-24）：在 Windows 上以独立 Host 子进程执行 Provider、Build、Test 三类场景，在受管子进程已将 `AUTODEV_INTERRUPTED_EFFECT.txt` 写入 Agent Worktree、而 SideEffect 终态账本尚未提交时，对 Host 进程执行真实 `SIGKILL`。每阶段均先检查工作树副作用文件及 PID 标记已落盘、原始仓库无该文件、ActionIntent 仍为 EXECUTING 且无 COMMITTED/FAILED/UNKNOWN SideEffect 结果；随后重新创建 Runtime，确认 Run 进入 `NEEDS_INTERVENTION`，Node/ActionIntent/SideEffect/Evidence 转为 UNKNOWN，人工 Gate 不提供 retry，已有 Worktree 文件不变且未自动重试。定向用例 3/3 通过；Node 24.16.0 全套 144 通过/2 项可选集成跳过，便携 Node 22.19.0 启用 Maven/Gradle 集成后 146/146 通过（11 个测试文件）。这是本机文件型副作用和 Windows Host 崩溃恢复证据，不代表支付、邮件、云 API 等真实外部副作用、官方 Provider 的副作用语义或 Linux/macOS 已验收；下一步仍需扩展副作用类型与目标平台。

R2-M11 验收记录（2026-09-24）：在 R2-M10 的 Windows Provider/Build/Test Host SIGKILL 场景中加入测试专用 `127.0.0.1` HTTP 服务。受管子进程必须先 POST 副作用并收到服务端 `202`，然后才写入 Worktree/启动标记；服务端记录幂等键和请求体。Host 被杀后，先验证 ActionIntent 仍为 EXECUTING 且无终态 SideEffect 记录；Runtime 重启后再确认 Run/Node/Intent/SideEffect/Evidence 按恢复策略变为 UNKNOWN、出现不含 retry 的人工 Gate，服务端请求仍恰好一条，Worktree 标记保留且原始仓库未改变。定向用例 3/3 通过；Node 24.16.0 全套 144 通过/2 项可选集成跳过，Node 22.19.0 启用真实 Maven/Gradle 集成后 146/146；AutoDev typecheck 通过。该 HTTP 服务是同机测试替身，仅证明恢复流程不重复发送已确认请求；第三方服务幂等/超时/部分响应语义、真实 Provider 行为以及 Linux/macOS 仍未验收。

R2-M12 验收记录（2026-09-24）：新增 Windows 独立 Host 进程测试，在 Promotion 的 `git apply` 已成功修改临时原仓库、`git-promotion` ActionIntent 仍为 EXECUTING 且终态账本为空时，对 Host 执行真实 `SIGKILL`。重启后 Run/Intent/SideEffect/Evidence 转 UNKNOWN，人工 Gate 不提供 retry，但允许显式 promote；恢复前原仓库 tree hash 已与封存 Candidate 一致。只有测试显式选择 Gate 的 promote 后，Runtime 才以临时 Git index 重验到“候选已精确应用”，写入新的 COMMITTED Promotion 记录和 PASS Evidence；旧 UNKNOWN Intent 保留，最终 tree hash 和文件内容仍与 Candidate 一致，证明没有二次应用。定向 Host 崩溃用例 4/4 通过；Node 24.16.0 全套 145 通过/2 项可选集成跳过，Node 22.19.0 启用真实 Maven/Gradle 集成后 147/147。此项只覆盖 Windows 临时 Git 仓库及本机 Git patch；Linux/macOS、长时并发与真实第三方服务仍未验收。

R4 增长/压缩压力验收记录（2026-09-24）：将现有 Knowledge 生命周期回归扩至 100 轮，累计 2,602 条 Candidate、200 份 Evidence/Memory/source 关联与成功使用计数、100 份 Compaction 报告、233 条 Regression 结果和 33 次受版本保护恢复。最后一次迭代以 Compaction 收尾；每轮维持正/负检索回归 PASS，覆盖项目版本隔离、同文本不同 Knowledge 类型不误合并、有界检索、合并字段保全、Compaction 输出和恢复后回归。另以 202 条同作用域 Knowledge 覆盖 200 条 Merge Proposal 候选窗口，并修复小数相似度阈值被向下取整为 0.5 的缺陷。Node 24.16.0 默认全套 138 项通过/2 项集成跳过，Node 22.19.0 启用 Maven/Gradle 集成后全套 140/140 通过，Node 22 typecheck 与 Host/Client Bundle 通过。Windows 单进程合成数据不替代跨平台、多日线上 soak 或真实生产数据分布验收。

R5-M4 验收记录（2026-09-24）：`drivers.spec.ts` 新增 Maven/Gradle/Node/pytest 四类 Driver 共用的真实子进程矩阵，成功、非零退出、活动 AbortSignal、超时与 96-byte 输出上限均通过；真实 Maven 3.9.16 + Apache Wrapper 3.3.4 与 Gradle 9.6.1 Wrapper 分别在隔离 JUnit 工程完成 Build/Test 成功及故意失败检测。Maven ZIP SHA-512 按 Apache 发布值验证，Wrapper 使用对应 ZIP 派生 SHA-256；Gradle ZIP 与生成的 Wrapper JAR SHA-256 均与 Gradle 官方校验表一致。测试定向运行 2/2 通过；默认全包 137 项通过，两个需要工具变量的 M/G 集成用例按设计跳过。工具不安装到 PATH，工程和缓存均位于隔离临时目录。该记录不覆盖 AutoDev Run/真实 Agent 全流程、其他 OS 或外部 Provider/Jev。

R5-M5 本机 Ollama 模型路由验收记录（2026-09-24）：新增可选 `packages/llm/llm-pi-ai/tests/ollama-local.e2e.ts`，仅当显式配置 `DSH_OLLAMA_BASE_URL` 与 `DSH_OLLAMA_API_KEY` 时执行；测试挂载真实 `@deepseek-ai/dsh-llm` 与 `@deepseek-ai/dsh-llm-pi-ai`，动态声明 `ollama-local` / `openai-completions` / 手工模型目录，再经 `ctx.llm.stream()` 和 `BlockAssembler` 发出真实请求，定向 1/1 通过。随后新增 `packages/core/agent-loop/tests/ollama-agent.e2e.ts`，以相同路由运行真实 AgentLoop，确认一轮 `assistant/message` 写入 Session，定向 1/1 通过。两次均在 Windows x64、Node 24.16.0、pnpm 11.25.0、本机 `127.0.0.1:11434/v1` 的 `qwen3:8b-fast` 上完成；使用仅供本地无鉴权端点通过客户端 API-key 检查的临时占位值，没有真实密钥或第三方账单。中英文 README 增加路由与默认 Agent 模型示例、凭据说明及单轮复现命令。文档门禁首轮 41/42，唯一失败为中英文 README 的翻译配对记录/代码块未同步；修正代码示例为字节一致、用 `verify-translation-pairing --write` 更新 sidecar 后，命名 pair 的定向检查通过。为了避免再次运行 42 项全局门禁，本轮未重跑完整 `doc-sync`；最终完整文档门禁仍需在文档收敛时统一复验。该证据证明 LLM adapter→Harness LLM service→普通 DSH AgentLoop 的本机模型调用，不证明 DSH Web Profile 设置持久化、AutoDev Provider/Worktree 文件操作、代码工程验收、远程 Ollama 鉴权或 Agent 权限隔离。

R7.6 验收记录（2026-09-24）：以 Node.js 官方 `v22.19.0` Windows x64 ZIP 便携运行，其 SHA-256 与 Node.js 官方发布清单一致；未替换系统 Node 24.16.0，也未安装到 PATH。R7.6 首轮时使用该 `node.exe` 执行 AutoDev Vitest 全套并启用 Maven/Gradle 两个真实工程集成用例，139/139 全通过；随后纳入 R2/R4 新增回归后再次运行，11 个测试文件 140/140 全通过。本轮自定义 Provider fail-closed、R2-M7 压测和 R2-M8 ActionIntent 幂等竞态加入后曾复验为 143/143；再纳入 R2-M9 授权/执行/结果竞态后为 146/146；纳入 R2-M12 后 Node 22.19.0 启用真实 Maven/Gradle 集成当前为 147/147，AutoDev typecheck 通过。进程中出现 Node 22.19.0 内置 SQLite experimental warning，但未导致测试失败。该证据确认本项目声明的最低 Node 版本可运行 Windows AutoDev 套件；不代表 Linux/macOS 或其他 Profile/DSH 全仓兼容已通过。

R7.1 用户入口验收记录（2026-09-24）：Host Remote 备份/恢复、目标路径复核、Sidebar 和中英文文案通过定向 Host/UI 测试 8/8；AutoDev TypeScript 项目检查与 Host/Client Bundle 通过。随后在 Windows Node 24.16.0 的全新临时 DSH_HOME 安装工作区链接的 `0.1.7-rc.1` AutoDev、启动 Web Profile，并使用本地 Gateway token 访问真实 Sidebar。UI 创建 DRAFT Run，Host 持久化 Plan、REPOSITORY_BASELINE 与 ENVIRONMENT PASS Evidence；停止 Host 后通过生产 AutoDevStore 为该 Run 写入一份隔离恢复测试 Artifact，再重启 Web。Sidebar `createBackup` Remote 生成 schema v2 清单，包含 `autodev.sqlite` 与该 Run 的 Artifact，排除 Worktree；对两个文件逐项重算 SHA-256 均匹配。Sidebar `restoreBackup` Remote 在目标路径逐字二次确认后恢复到全新数据根目录；恢复后的 Run/Plan 状态、Artifact 内容、哈希及路径重映射均通过生产 Store 核对，页面确认当前 Profile 仍使用原始数据根目录；原始临时 Git 仓库未复制、未修改，备份内没有 Worktree。该演练未启动 Agent、不验证 Codex/Claude/Jev、用户账号或自然人身份。真实 Profile 首次启动还发现 `remote.autodev` 客户端动态注入缺口：根插件只依赖 `remote`，挂载生成的 Remote 后再由子 scope 等待并注入 `remote.autodev`；修正后的 TypeScript/Host/Client Bundle 与本次真实 Web Remote 往返通过。没有因该修复重跑 AutoDev 全套。

## 参考资料

- [项目介绍与既有 P0–P4 待办](PROJECT-INTRODUCTION.zh-CN.md)
- [讨论摘要与用户边界](PROJECT-DISCUSSION-SUMMARY.zh-CN.md)
- [AutoDev README](packages/experimental/autodev/README.zh.md)
- [发布验证记录](packages/experimental/autodev/RELEASE-VERIFICATION.zh.md)
- [DSH 架构与 Bundle/Profile 规则](docs/architecture.md)
- [AutoDev 源码](packages/experimental/autodev/src/)与[测试](packages/experimental/autodev/tests/)
- [Java/Maven 示例](examples/autodev-java/)

本计划还参考了用户提供的“DSH 项目设计总结”附件；该附件不在仓库中，故不把它当作当前实现的事实来源。S1–S4 的历史细节另由上方用户分享链接提供，但未找到旧 Java 工程与所引报告，所有历史通过数字均为 transcript-reported，不能作为当前代码验收凭证。

## Dev Note

2026-09-25：R7.2 的 v1→v2 按旧 schema 契约 fixture 覆盖 Run、Evidence、Knowledge、Artifact 元数据与磁盘字节；只运行 `migrations.spec.ts` 4 个相关用例，4/4 通过，AutoDev typecheck 通过，未运行 AutoDev 全套。随后用 DSH `createRuntimeResolution` / `installRuntimeInterception` 加载隔离 Profile 的 Alpha.2 包，证实其 Store 真实写入 schema v2，并创建 Run、Evidence、Knowledge、Artifact 与事件；同一 Profile 通过 DSH plugin manager 换装 RC.1 tarball，真实 Web 在临时端口启动后由 RC.1 Store 读回全部 4 条记录、4 条事件并校验 Artifact 字节数/SHA-256。Web 已停止，临时端口关闭；仅证明 Windows x64 / Node 24.16.0 单矩阵，不代表 Alpha.2→RC.1 执行 v1→v2 数据迁移，也未跑跨平台或完整外部 Provider。

本计划仍在执行中。2026-09-25 R7.5 Windows x64 / Node 24.16.0 验收补齐真实 Alpha.2→RC.1 有数据升级及卸载重装：Alpha.2 Store 写入 schema v2 的 Run、Evidence、Knowledge、Artifact 与事件；plugin manager 换 RC.1 后真实 Web 启动，RC.1 Store 全部读回并核对 Artifact 哈希/字节数；再卸载 AutoDev，确认数据库和 Artifact SHA-256 保持不变，重新安装 RC.1 后 Web 再次启动成功。Node 22.20.0 与最低支持版 Node 22.19.0 另以同一隔离 Profile 启动 RC.1 Web 成功，认证保护生效，持久数据哈希仍匹配快照；Node 22.19.0 又完成既有数据 Profile 的真实卸载/重装往返，以及从 `web` 默认模板创建全新 Web Profile、安装 RC.1 并启动；Profile 本地 `pnpm peers check` 提示 5 项 peer 缺失，CLI runtime resolution 还会合并 DSH installation anchor，实际 Web composition 启动成功。最低版 fresh Web Profile 安装/启动现已覆盖，但上述均非完整 Node 22 测试套件，且 Node 22.19.0 下 Alpha.2→RC.1 升级仍缺。测试端口 `63714` / `49186` / `55571` / `65087` / `64595` 已关闭，用户 Web `3080` 持续监听；未因本项重跑测试套件。R7.2 的 v1→v2 验收仍来自旧 schema 契约 fixture，相关 4 个定向用例通过；未将其冒称为 Alpha.2 真实数据迁移。最近完整 `pnpm run doc-sync` 42/42 通过（101.57 秒；0 failed、0 skipped）；之后只更新验收记录，未重跑 doc-sync 或 AutoDev 全套。R0 历史 Java 仓库/提交/报告仍未找到。R1 官方 Codex/Claude/Jev 与 Run→Worktree→Build/Test→Evidence→Promotion 真实链路未验收；既有 Codex 请求因 Responses sampling timeout 结束且没有工程修改，只有新的认证或连通性证据出现才考虑再试。CodeBuddy CLI 不可用；Ollama 仅验证了普通 DSH AgentLoop，不能替代 AutoDev Agent/Worktree。R2-M14 的 CI 现有可单独触发的 Ubuntu/macOS 五场景矩阵，workflow 契约定向测试 1/1 通过；远端执行结果尚未取得，本机 WSL 仍不可用。R4 多日真实数据 soak 与其他 OS 验收仍缺。外部凭据/目标系统缺失时继续推进可离线的 R2/R4/R7 工作，完整版本在所有门禁满足前保持 No-Go。

2026-09-25：M13 `promote Gate claim after SIGKILL` 在 Node 22.20.0 与精确最低版本 Node 22.19.0 下分别定向运行，均 1/1 通过，`core.spec.ts` 其余 66 项按 `-t` 过滤跳过；用时分别为 2.15 秒和 2.11 秒。Node 22.19.0 Windows x64 官方便携 ZIP（35,424,607 字节）在临时目录下载，SHA-256 `ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86` 与 [Node 官方校验清单](https://nodejs.org/download/release/v22.19.0/SHASUMS256.txt)一致，未安装或替换系统 Node；归档和解压目录保留在系统 Temp。该项仅关闭 M13 的最低 Node 定向回归，不代表 Node 22.19 全套在 M13 后复验。

2026-09-25：R5-M6 将扩展 Bundle 的动态路由操作收敛到 AutoDev Runtime 公共 API：`registerRoutedProvider(routeName, provider, candidate?)` 成对注册自定义 Provider 与 Route candidate，若 Route 注册失败即回滚 Provider；返回的 disposer 幂等地同时移除两者。`registerRouteCandidate(routeName, candidate)` 用于把已由 Harness 加载的 ACP 等 Subagent 接入现有 Route。双语 README 示例已更新，明确两种扩展边界，未把 CodeBuddy 配置示例写成真实 CLI/Auth 验收。验收：新增 Runtime API 测试 3/3（注册/选择/调用/成对卸载、失败回滚、已加载 Subagent 候选增删），AutoDev typecheck 通过，目标 README 翻译配对 1/1 一致；未重跑 AutoDev 全套、Bundle 或全局 `doc-sync`。此项改善了动态集成的原子性和公开入口，不关闭真实 CodeBuddy/官方 Provider E2E、POSIX runner 或其他外部验收门禁。

2026-09-25：R2-M14 进程崩溃测试清理审查发现并修复两处失败路径风险：测试在副作用子进程写入 PID、Host 尚未写入 ready 标记时失败，父测试原先无法回收该目标进程；Promotion 用例还会在 Host 已被杀并确认退出后，再对同一 PID 发送 SIGKILL。现在失败清理可从本用例专属的副作用启动标记补取 PID、等待其退出；Promotion 目标属于 Host 自身，不做二次 signal。仅定向复验 Windows Provider Host-SIGKILL 场景 1/1（core.spec.ts 其余 66 项按名称跳过）；这不是完整五场景重跑，Linux/macOS runner 尚未执行，M14 跨平台门禁继续保持未完成。

2026-09-25 本机收尾（Windows）：按用户要求将跨平台矩阵移出本轮验收范围。Node 24.16.0 与便携 Node 22.19.0 各完整运行 AutoDev 套件一次，均 13 个文件、159 passed / 2 skipped；没有调用计费模型。一次 `pnpm run doc-sync` 为 39/42 通过，3 个失败均由新增路由 API 的文档类型归属和双语 README 代码片段语法导致；修复并生成文档后，三个对应门禁 `verify-doc-graphs`、`verify-cordis-catalog`、`doc-typecheck:contracts-ready` 定向复验全通过。其余 39 项保留首轮通过证据，没有再次重跑全套。DSH Host/AutoDev Bundle 构建成功，86 个文档代码块编译通过。仍未覆盖：真实官方 Provider E2E（凭据/额度）、多日真实数据 soak、Node 22.19.0 下 Alpha.2→RC.1 有数据升级；本轮未触碰用户 Profile。该记录不将这些限制条件或未执行的跨平台矩阵宣称为通过。
