# AutoDev 发布校验记录

这份记录对应当前源码树中的 `@deepseek-ai/dsh-experimental-autodev`，用于区分“源码、契约和离线链路已验证”与“需要本机凭据/外部 Provider 才能验证”的项目。

本轮复核时间：2026-09-25。当前状态是“R7.1 Host/UI 定向验证与 Windows 隔离 RC.1 DSH Web Profile 的含 Run/Artifact 实际备份恢复往返通过；RC.1 tarball 在 Windows 隔离 Profile 的安装、配置组合、Web 启动、卸载/重装和数据保留通过；另已用 Alpha.2 真实 `AutoDevStore` API 生成持久 Run/Evidence/Knowledge/Artifact，在同一隔离 Profile 换装 RC.1 并启动 Web 后，由 RC.1 Store 全部读回且 Artifact 哈希一致；Node 22.20.0 与最低支持版 22.19.0 下均完成 RC.1 Web 启动烟测，且 Node 22.19.0 下完成 fresh Web Profile 安装/启动及既有数据 Profile 卸载/重装验证；其他 OS/Profile 矩阵、R1 真实 Codex/Claude/Jev Agent 全流程及自然人身份仍未通过”。

## 已通过

- 本地 Ollama 决策链实现与验证（2026-09-25）：AutoDev 新增 Ollama 原生 `/api/chat` Provider；在独立 `decisions` 配置下，`jev.mode: off` 不会关闭 Ollama；自动工作模式会调用决策链，显式模式优先；低置信度会按配置升级到 DSH `ctx.subagents`，无可信质量审查者时保留 Human Gate。新增决策 Provider 测试，并调整两项领域测试使用明确可信的离线审查夹具。AutoDev 全套测试 16 文件、174 passed / 4 skipped；TypeScript 检查和 Host/Client Bundle 均通过。对本机 Ollama `qwen3:8b-fast` 实际执行了 Provider 冒烟及 Jev 关闭条件下的 Runtime `create`，均成功并确认写入 `local-model` 决策审计。Codex/Claude/spawn 子代理仅有模拟服务契约测试，本次没有真实启动子代理或发起云端模型调用；也没有更改或安装到用户 DSH Profile。
- R2-M14 SIGKILL 测试清理硬化（2026-09-25）：静态审查修复了副作用目标写入 PID 后、Host 就绪标记发布前失败时的孤儿进程清理，并阻止 Promotion 测试在 Host 已退出后再次向其 PID 发信号。Windows Provider 阶段定向回归 1/1（同文件其他 66 项按名称过滤跳过）；未重跑五场景全组，Linux/macOS runner 也未执行，故不将此项记为 M14 跨平台验收通过。
- R5-M6 Runtime 动态路由注册 API（2026-09-25）：新增 `registerRoutedProvider(routeName, provider, candidate?)`，以失败回滚与幂等 disposer 保证自定义 Provider/Route candidate 成对注册和卸载；另新增 `registerRouteCandidate(routeName, candidate)`，用于把已加载的 Harness ACP/Subagent 添加至路由。新增隔离 Runtime 回归 3/3（Provider 注册、候选选择与 Worktree cwd 调用、成对卸载；Route 失败后 Provider 回滚；Subagent 候选增删），AutoDev typecheck 通过；README 中英文示例及翻译配对 1/1 通过。未运行 AutoDev 全套、Bundle 或全局 `doc-sync`。仅证明 Runtime 路由扩展 API 与离线契约，不代表 CodeBuddy CLI/Auth、真实官方 Agent/Jev 或完整 AutoDev E2E 验收。
- R7.5 Alpha.2→RC.1 有数据升级及卸载重装数据保留（2026-09-25，Windows x64 / Node 24.16.0）：隔离 `DSH_HOME` 的 Profile 安装本地 Alpha.2 tarball（SHA-256 `084464F4B583DA8E504469AD9A4C1B65DEF8ADEF557D893DAA920DBC8D64C79C`）。使用 DSH `createRuntimeResolution` / `installRuntimeInterception` 加载旧包，并由 `0.1.7-alpha.2` 实际 `AutoDevStore` API 在默认数据根写入 Run、TEST Evidence、ESTABLISHED Knowledge、Artifact 文件/元数据与事件。旧包写出的 SQLite `schema=2`、migration history 两条；4 条 records、4 条 events，旧 Store 读 Artifact SHA-256/字节数成功。随后通过 DSH plugin manager 换装本轮 RC.1 tarball（SHA-256 `520A3809828478022237E349A02188994B101B700BC1560978B4B992168929B9`），同一 Profile 的真实 `dsh web` 在端口 `59722` 启动且无 AutoDev bundle import failure。由 `0.1.7-rc.1` 实际 `AutoDevStore` 再读回 4 类记录和事件，并重验 Artifact 内容、字节数和 SHA-256。随后在关闭 Web 的隔离 Profile 中卸载 AutoDev，确认 bundle/dependency 已移除，同时 SQLite（36,864 字节，SHA-256 `FA751A2CD0FB8665E81ABCFCD34BB696B28356709F37A47525B4BF2EE268C7DA`）和 Artifact（54 字节，SHA-256 `FE9E573DB92EB4E8F8872322ECC67312C8D69E83FF70E71C23BE15D72922C812`）与卸载前快照逐字节相同；从同一 RC.1 tarball 重新安装后，Profile 再次选择 AutoDev bundle，真实 `dsh web` 在隔离端口 `63714` 成功启动且无 bundle import failure，随后正常停止、端口关闭，用户现有 Web `3080` 仍在监听。Alpha.2 写出的 schema 已是 v2，不代表本次发生 v1→v2 迁移；仍未覆盖 Linux/macOS、Node 22.19.0 下 Alpha.2→RC.1 升级、浏览器 Remote 数据展示或真实 Provider/Jev/Agent E2E。
- R7.5 Node 22.20.0 Web/Bundle 兼容烟测（2026-09-25，Windows x64）：复用上一项 RC.1 隔离 Profile，临时将 Node `v22.20.0` 放到 `PATH` 前端并保留隔离 `DSH_HOME`，执行 `pnpm exec dsh --profile autodev-data-upgrade --no-open --port 0`；Profile 托管 pnpm `11.7.0`，AutoDev Bundle 加载无错误，Web 在 `127.0.0.1:49186` 监听后正常停止，端口关闭。SQLite（36,864 字节，SHA-256 `FA751A2CD0FB8665E81ABCFCD34BB696B28356709F37A47525B4BF2EE268C7DA`）和 Artifact（54 字节，SHA-256 `FE9E573DB92EB4E8F8872322ECC67312C8D69E83FF70E71C23BE15D72922C812`）仍与 Alpha.2→RC.1 / 卸载重装快照一致。此项只证明 Node 22.20.0 下现有 Profile 的 Web/Bundle 启动和持久文件未变，不等同于完整测试套件、Node 22.19.0 精确最低版本或安装生命周期签收。
- R7.5 Node 22.19.0 Web/Bundle 最低版本启动烟测（2026-09-25，Windows x64）：复用同一隔离 RC.1 Profile，以官方便携版 Node `v22.19.0` 启动 `dsh web --no-open --port 0`；AutoDev Bundle 正常加载，Web 在 `127.0.0.1:55571` 监听，未携带 token 的本地 HTTP 请求返回 401（认证保护生效）。随后正常停止，临时端口关闭，用户 Web `3080` 仍在监听；SQLite 与 Artifact 的 SHA-256 均与既有快照一致。只补充最低 Node 版本下的 Web/Bundle 启动兼容性，不代表 Node 22.19.0 完整测试套件或安装/升级/卸载生命周期验收。
- R7.5 Node 22.19.0 既有数据 Profile 卸载/重装验收（2026-09-25，Windows x64）：以官方便携版 Node `v22.19.0` 和 DSH plugin manager 从隔离 `autodev-data-upgrade` Profile 移除 `0.1.7-rc.1`，核实依赖、Profile Bundle 选择与安装目录均已移除；卸载前后 SQLite（36,864 字节，SHA-256 `FA751A2CD0FB8665E81ABCFCD34BB696B28356709F37A47525B4BF2EE268C7DA`）及 Artifact（54 字节，SHA-256 `FE9E573DB92EB4E8F8872322ECC67312C8D69E83FF70E71C23BE15D72922C812`）一致。随后从 SHA-256 `520A3809828478022237E349A02188994B101B700BC1560978B4B992168929B9` 的同一 RC.1 tarball 重装，确认版本为 `0.1.7-rc.1` 且重新加入 Profile Bundle；实际 Web 在 `127.0.0.1:65087` 启动，未携带 token 的本地 HTTP 返回 401，随后正常停止、临时端口关闭、用户 Web `3080` 持续监听，SQLite/Artifact 哈希仍未变化。该项关闭最低 Node 版本下已有数据 Profile 的卸载/重装与启动缺口，不等于 Node 22.19.0 全新 Profile 安装、Alpha.2→RC.1 升级或完整测试套件验收。
- R7.5 Node 22.19.0 全新 DSH Web Profile 安装/启动（2026-09-25，Windows x64）：在全新隔离 `DSH_HOME` 中以 `--from-default-profile web` 从随附 Web 模板创建自定义 Profile，确认初始 Bundle 为 `dsh-base` + `dsh-web-app`；再通过 DSH plugin manager 安装 SHA-256 `520A3809828478022237E349A02188994B101B700BC1560978B4B992168929B9` 的 RC.1 tarball。最终 manifest 选择 `dsh-base`、`dsh-web-app` 与 AutoDev，安装版本 `0.1.7-rc.1`。以官方便携 Node `v22.19.0` 启动 Web，端口 `64595` 监听，未认证 HTTP 返回 401；正常停止后端口关闭，用户 Web `3080` 仍在监听。独立 `pnpm peers check` 在 Profile 本地依赖范围报告 5 个 AutoDev peer 未安装；DSH 的运行时解析还包含安装锚点，且本次真实 Web composition 成功启动，无 bundle import failure。该诊断如实保留，不等同于 Node 22.19.0 下 Alpha.2→RC.1 升级或 Linux/macOS 验收。
- Host TypeScript 项目引用检查。
- Client TypeScript 项目引用检查。
- AutoDev Host 与 Client 独立 tsdown 构建。
- AutoDev bundle：`pnpm --filter @deepseek-ai/dsh-experimental-autodev bundle` 通过（包括 Host Typert Remote 生成与 Client Bundle）。
- R7.1 Host Remote 与 Sidebar 备份/恢复：Host/UI 定向测试 8/8 通过，AutoDev typecheck、Host Typert Remote 生成和 Client Bundle 通过。Windows 隔离 RC.1 Profile 的真实恢复记录见下文。
- R2-M13 Promotion Gate 原子领取：Gate 决议、Run `PROMOTING` claim 与清除 `currentGateId` 在单个 SQLite 事务中提交；Candidate/Plan/Worktree/基线/Attempt admission 在消费 Gate 前校验，Git I/O 在事务外执行。Run claim 注入失败时 Gate/Run/Event 回滚；3 项定向原子性、回滚、关闭并重开数据库后的恢复测试通过，Gate 决议竞争只有一个获胜者；既有直接 `promote()` 独立 Host 竞态 1/1 通过。恢复测试是数据库关闭/重开模拟，不是 Host 进程级 SIGKILL；进程级证据仍由既有 R2-M10/M11/M12 覆盖其各自故障窗口。
- R2-M13 另有独立 Host 进程级恢复回归：Host 在 Gate claim 已提交、首次只读 `treeHash` 已确认 Run 为 `PROMOTING` 且尚无 Promotion ActionIntent 时遭 SIGKILL；重启后 Gate 可操作、无 Promotion intent/已提交副作用，原仓库 tree hash 不变。该用例已移除 Windows-only skip；本机 Windows 定向测试 1/1、M13 定向组 4/4。`ci-master.yml` 现将 Linux 与 macOS 放入同一 POSIX matrix，可由 master push 或 `autodev-recovery` 手动触发并只运行五个 Host SIGKILL 场景；workflow 契约定向测试 1/1 通过。Linux/macOS 尚无本次变更的运行结果，不视为跨平台验收通过。AutoDev typecheck 通过。Node 24/Node 22.20 最近全套 152 passed / 2 skipped 的结果早于此测试专用变更，本次未重跑全包，不把它计作新增用例后的全套结果。
- R2-M13 在 Node 22.20.0 上的定向兼容性复验：`pnpm exec vitest run --root . packages/experimental/autodev/tests/core.spec.ts -t 'promote Gate claim after SIGKILL' --retry=0 --maxWorkers=1 --no-file-parallelism`，1 passed / 66 skipped，用时 2.15 秒；Node SQLite experimental warning 非阻塞。
- R2-M13 在精确最低 Node 22.19.0 上的同一条定向复验：1 passed / 66 skipped，用时 2.11 秒。便携 Node v22.19.0 Windows x64 官方 ZIP（35,424,607 bytes）SHA-256 `ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86` 与 [Node 官方校验清单](https://nodejs.org/download/release/v22.19.0/SHASUMS256.txt)相同；仅展开到系统 Temp，并临时置于测试进程的 `PATH` 前端，没有安装/替换系统 Node。此项仅覆盖 M13 单场景，不是该版本全套测试复验；ZIP 与便携目录保留在 Temp。
- R2-M10/M11/M12 的 Provider、Build、Test、Promotion Host 崩溃场景现与 M13 一样不再限定 Windows；POSIX 测试会在验证 Host 崩溃后终止其已记录的目标子进程。本机 Windows 五个进程级故障用例 5/5；Linux/macOS 现在由手动可触发的定向 CI matrix 执行同一五场景，尚未运行本次变更，跨平台恢复仍待签收。
- 新增 M13 进程级 SIGKILL 回归前最近一次 AutoDev 全套：Node 24.16.0 和 Node 22.20.0 各 152 passed / 2 skipped（可选 Maven/Gradle 集成需工具变量；11 个测试文件）；typecheck、Host/Client Bundle 通过。
- AutoDev Vitest：R0-M1 后 Node 24.16.0 默认套件 149 项通过、2 项可选真实 Maven/Gradle 集成测试因未设置下载产物环境变量而跳过（11 个测试文件）；本机 Node 22.20.0 同为 149 通过/2 跳过。此前 Node 22.19.0 启用两项真实集成的 147/147 是 M1 前记录，未冒称本轮重跑。覆盖 Agent Protocol、Evidence/Verification、语义/Memory/Concept/Playbook/Knowledge 生命周期、动态 Provider、Build/Test Driver、Host 崩溃恢复、128 Host Promotion 竞争与 128 Host ActionIntent 计划/授权/执行权/终态竞争、R2-M10/M11/M12 四阶段真实 Host SIGKILL 后 UNKNOWN/人工 Gate/不自动重试恢复；验证回环服务已确认请求不重复，并验证 Git patch 已应用后经人工 Gate 精确对账成功、Candidate 不二次应用；R4 100 轮、2,602 条候选的 Knowledge 增长/压缩/恢复回归、202 条记录下的 Merge Proposal 200 条窗口与小数阈值验证，以及 Sidebar 流程；另有四类 Driver 的成功、非零退出、活动取消、超时和输出截断矩阵。R0-M1 新增 Run 初始聚合、Plan ID 不可变、Replan Plan/Run/Node 原子切换和 Gate 决议回滚测试。Candidate 历史与双 Diff、SQLite+Artifact 备份/恢复、schema v1→v2、Retention Preview/Cleanup、R7.4 Gateway 调用期 Actor/审计、发布清单根级 JS 分块回归、R3-M2 六维 Scope 隔离及 R3-M3 Playbook v1/v2、Plan v2/v3、Assumption/Uncertainty 和不可变 Agent Context Artifact 的组合生命周期均有回归覆盖。R5 最新回归还证明自定义 Provider 必须显式承诺 Worktree cwd，路由 traits 逐项匹配且 `unknown` 不具通配语义，否则不可选择并在直接调用时 fail closed。结构化 Audit 与 Plan Approval、Gate、Cleanup、ActionIntent 和受控 Knowledge 操作同事务追加；UI 明示 DSH 本机 Operator 非个人账号，隐藏 Peer ID，并将 Cleanup Job 事件本地化。Retention 覆盖稳定指纹、终态/期限、活动 Host、Gate/ActionIntent、越界/共享/符号链接路径、最多 10 项与请求幂等、Git 登记和脏/未跟踪树拒绝、SQLite 跨连接租约、Run 更新阻挡、删除前/后崩溃协调及 Run/Evidence/Artifact 不变。
- R2-M3 跨进程 Promotion 压力用例由 16 个扩展到 32 个独立 Host，连续 3 次通过；R2-M4 扩展到 48 个，R2-M5 扩展到 64 个，R2-M6 扩展到 96 个；R2-M7 提升至 128 Host，初始连续 3 次通过后追加 10 轮串行短 soak。64 个竞争者曾暴露原子 claim 前重复写 Verification 的 SQLite 锁争用；Runtime 调整为先原子取得 Promotion claim，再由获胜 Host 刷新并持久化 Verification。96 Host 完整套件并行负载曾出现 SQLITE_BUSY；SQLite `DatabaseSync` 连接现设置 15 秒 busy timeout。128 Host 压力通过受限测试参数启用，常规套件默认仍为 96。每轮所有进程正常退出、仅一个 Promotion 获胜、仅一份匹配 Candidate 的 PASS Promotion Evidence 和 COMMITTED intent/SideEffect，最终仓库文件与获胜 Candidate 一致。该证据仅覆盖本机 Windows 的短 soak，不代表多小时/多日运行、Linux/macOS 或高于 128 个进程。
- R2-M8 复现到 `SideEffectService.plan()` 的 TOCTOU：16 个独立 Host 在写入前都观察到幂等键不存在。现由 `AutoDevStore.createActionIntentIfAbsent()` 在单个 SQLite `BEGIN IMMEDIATE` 事务中查找并创建 Intent、Run Event、PLANNED SideEffect/Event；无新增 schema。128 个 Host 同时计划同一副作用时返回同一 Intent ID，数据库只保留一组计划记录，定向测试连续 3 次通过。
- R2-M9 为跨进程 ActionIntent 授权、执行与结果竞态增加原子边界：冲突授权只保留一个版本，`AUTHORIZED→EXECUTING` 只授予一个 Host；结果更新在同一事务提交 ActionIntent、Run Event、Audit 和 SideEffect/Event。同一授权/结果重放幂等，冲突授权或互斥结果拒绝。128 Host 授权、执行权和成功/失败竞争各连续 3 次通过。测试屏障曾放在持锁后的公开读取回调中导致一次超时，现移至事务入口，持久化也改用私有读取；未新增 schema。外部命令/Provider 发生后进程崩溃的分布式原子性仍不在覆盖范围内，须走 UNKNOWN/人工恢复。
- R2-M10 在 Windows 上用真正 Host `SIGKILL` 验证 Provider、Build、Test 三阶段的故障窗口：受管子进程已将文件效果写入 Agent Worktree，但 ActionIntent 仍是 EXECUTING、SideEffect 结果尚未提交。重启后相关 Node/ActionIntent/SideEffect/Evidence 均为 UNKNOWN，Run 打开人工 Gate、不可 retry；Worktree 文件保留、原始仓库不变，确认没有自动重试。3/3 定向通过。该测试证明本机 Worktree 文件型效果的恢复路径，不等同于支付/邮件/云 API 等真实外部系统语义，也未覆盖 Linux/macOS。
- R2-M11 在同一故障窗口加入同机回环 HTTP 测试服务：受管子进程先 POST 并收到 `202`，服务端记录幂等键和请求体，之后才写标记并等待。Host 被 SIGKILL、Runtime 重启后，服务端仍恰好只有一条已确认请求；本地 ActionIntent/SideEffect 转 UNKNOWN、Gate 禁止 retry。3/3 定向通过。该替身用于验证不会重复发送副作用请求，不代表真实第三方 API 的幂等保证、Provider E2E 或 Linux/macOS 恢复。
- R2-M12 通过 Windows Host 进程级 Promotion 故障注入：先让 `git apply` 成功修改临时原仓库，再暂停在结果账本提交前并杀死 Host。恢复后 Git Promotion Intent 为 UNKNOWN，Run 处于人工 Gate，未自动 retry；只有显式选择 Gate `promote` 后，Runtime 才将仓库 tree 与封存 Candidate 精确对账，记录新的 COMMITTED intent/PASS Evidence，保留旧 UNKNOWN 历史且不二次应用补丁。4/4 Host 崩溃阶段定向通过；该验证仅代表 Windows 临时仓库。
- AutoDev `bundle`（Host Typert Remote 生成与 Client Bundle）通过；Harness 根目录 `build:lib:host` 与 `build:lib:client` 分别通过。
- 本轮 R7.4/R7.5 双语 UI、发布矩阵和计划文档更新后的完整 `pnpm run doc-sync`：42/42 通过；导出 API JSDoc 门禁通过。
- 2026-09-25 当前工作树收敛后的 `pnpm run doc-sync`：42 passed、0 failed、0 skipped，用时 101.57 秒；覆盖文档类型检查、站点构建、Markdown/引用、生成目录与文档标准测试。运行前备份的 `website/.generated` 共 192 个文件、4,399,829 字节，门禁前后所有文件 SHA-256 相同，无需恢复或覆盖现有生成产物。
- 纳入 R2-M10/M11/M12 恢复证据与当前验收文档后的 `pnpm run doc-sync`：42/42 通过；AutoDev typecheck 通过。
- 纳入 R0-M1、R2-M13 实施记录和 S1–S4 历史材料证据等级的 `pnpm run doc-sync`：42/42 通过。
- 项目 `typecheck` 通过；Harness Windows 原生依赖提示与 Vite 路径插件迁移提示为非阻塞 Warning。
- R7.6 Node 最低版本矩阵：此前使用 [Node.js 22.19.0 官方 Windows x64 归档与 SHA-256](https://nodejs.org/en/blog/release/v22.19.0) 的便携 `node.exe`（未安装/替换系统 Node），纳入 R2-M12 后完整 AutoDev 套件启用真实 Maven/Gradle 集成 147/147 通过；此记录早于 R0-M1。本轮另以本机 Node 22.20.0 直接调用 Vitest，全套 149 通过/2 个可选集成跳过。Node 22 内置 SQLite 有实验性 API Warning，但无失败。
- 当前 tarball 内容审计：Host、Remote、Client、Typert 声明、类型文件、根级生成 JS（含动态 Hash chunk）、Bundle patch、README、许可证均在包内；新增 `lib/*.js` 发布文件模式和 package metadata 回归测试。此修复源于本轮真实 Profile smoke 发现此前 `files` 漏掉 `router-*.js`，导致 AutoDev 启动导入失败。
- Windows 隔离 DSH Profile 生命周期（仓库构建 CLI）：Node `24.16.0`、pnpm `11.19.0`、DSH CLI `0.1.7-alpha.2`、AutoDev `0.1.7-alpha.2`。临时 `DSH_HOME` 内安装打包 tarball，`--dump-config` 显示 AutoDev 层，普通 Web Profile 在随机端口启动且无 bundle import failure，停止后卸载并再次 dump config，确认 AutoDev 层已移除。整个循环未触碰用户现有 DSH Profile。
- Windows 隔离 DSH Profile 生命周期（RC.1 tarball，2026-09-25）：Node `24.16.0`、打包端 pnpm `11.25.0`、DSH CLI `0.1.7-rc.1`；通过 `pnpm pack` 生成 `@deepseek-ai/dsh-experimental-autodev@0.1.7-rc.1`，归档清单包含所有动态 `router-*.js` chunk，workspace peer range 已改写为 `^0.1.7-rc.1`。在全新临时 `DSH_HOME`/Profile 中由 DSH plugin manager 安装 tarball（其托管 pnpm `11.7.0`），`--dump-config` 能看到 AutoDev layer；`dsh web --no-open --port 0` 实际启动于 OS 分配端口 `59602`，无 bundle import failure。安装时有 peer-dependency warning，但不妨碍模块加载和 Web 启动。通过 Ctrl+C 停止后确认监听端口关闭；卸载命令成功，再次 `--dump-config` 确认 AutoDev layer 消失。只覆盖 Windows x64、当前源码构建 CLI 与 fresh install/start/uninstall；本条 fresh-install 记录不覆盖 alpha.2 升级、真实 Provider、已有用户数据迁移或其他 OS/Node。用户原有 DSH Home 未用于此隔离安装演练。
- Windows 隔离 DSH Profile 软件包升级（2026-09-25）：使用此前本地生成且 manifest 版本为 `0.1.7-alpha.2` 的 tarball（SHA-256 `084464F4B583DA8E504469AD9A4C1B65DEF8ADEF557D893DAA920DBC8D64C79C`；官方 npm registry 与配置镜像均无此版本），在同一临时 Profile 安装 alpha.2、核对组合配置并实际启动 Web（端口 `62034`）；停止且确认监听关闭后，通过 DSH plugin manager 换装 RC.1 tarball，确认 Profile manifest 指向 RC.1、配置仍包含 AutoDev，再次实际启动 Web（端口 `61991`）。之后卸载成功、配置不再包含 AutoDev，两个测试端口均已关闭；RC.1 tarball SHA-256 `520A3809828478022237E349A02188994B101B700BC1560978B4B992168929B9`。安装两版时均出现 peer-dependency warning，但两次 Web 均启动成功。本轮没有在 alpha.2 期间创建 Run/Knowledge/Artifact 或其他持久 AutoDev 数据，因此只证明空白 Profile 的包替换与加载，不证明已有数据库/用户数据的跨版本迁移；R7.2 数据迁移测试仍是独立证据。
- R7.2 旧 Schema 数据类别迁移回归（2026-09-25）：扩充 v1 fixture 至完整 Run、TEST Evidence、ESTABLISHED Knowledge、Artifact 元数据及实际 Artifact 文件；通过 RC.1 `AutoDevStore` 打开后逐条读取，并以存储的 SHA-256/字节数校验 Artifact。对升级、失败回滚及重试、未来 schema 拒绝、8 个独立进程并发启动共定向运行 4 项，通过 4/4；AutoDev typecheck 通过；未运行该文件中的 fresh-schema 初始化用例或 AutoDev 全套。该 fixture 按旧 schema 契约构造，不是 Alpha.2 输出；Alpha.2 实际数据包升级另见上方 R7.5 验收，旧版数据库实际为 schema v2。
- R7.1 Windows 真实隔离 Profile 备份恢复（2026-09-24）：Node `24.16.0`；DSH CLI 与 AutoDev 均为 `0.1.7-rc.1`，AutoDev 通过 `pnpm dsh plugin --profile autodev add .\packages\experimental\autodev` 链接当前工作区源码（不是 tarball 测试）；全新临时 `DSH_HOME` 从 Web 模板创建 Profile。用 DSH 输出的本地 Gateway token 打开 loopback Web，在真实 Sidebar 创建 DRAFT Run，并得到持久化 Plan、`REPOSITORY_BASELINE` 与 `ENVIRONMENT` PASS Evidence；未批准/启动 Agent。停止 Host 后用生产 `AutoDevStore.writeArtifact()` 为该 Run 写入一份仅供恢复测试的 Candidate Diff Artifact，再启动同一隔离 Profile。实际 Sidebar `createBackup` Remote 生成 schema v2 清单，包含 `autodev.sqlite` 和引用 Artifact 两个文件、声明不含 Worktree；两项文件重新计算 SHA-256 均匹配。实际 `restoreBackup` Remote 在 UI 要求用户逐字复核目标路径后，将备份恢复到全新数据根目录；重新打开生产 Store 后 Run/DRAFT/Plan 和 Artifact 内容均一致，Artifact 路径已映射到新数据根；UI 明确显示运行中的 Profile 仍使用原数据根。原始临时 Git 仓库位于备份外，仍存在且未被修改；备份目录不含 Worktree。首次 Web 真实加载发现 `remote.autodev` 动态 namespace 的作用域注入缺口；修正为先挂载生成 Remote，再在子 scope 等待 `remote.autodev` 后注册 UI，修复后的 Client/Host Bundle 和本次完整 UI/Remote 往返通过。该演练不覆盖 DSH 云账号、自然人 principal/RBAC、Provider/Jev 或真实 Agent 执行；本轮未重跑 AutoDev 全套。
- Windows 路径约束：Worktree 只能位于配置的 managed root；Artifact Remote 不返回宿主机路径。
- R5 真实构建工具集成：隔离临时工程分别通过 Maven 3.9.16 + Maven Wrapper 3.3.4、Gradle 9.6.1 标准 Wrapper 路径；两者均完成 Build、JUnit 成功测试和故意错误断言的非零失败检测。Gradle 分发包 SHA-256 与 [Gradle 官方校验表](https://gradle.org/release-checksums/)一致；生成的 Wrapper JAR 也与该版本官方 SHA-256 一致。Maven 分发包先按 [Apache 官方 SHA-512](https://maven.apache.org/download.cgi)验证，再以本地 `file:` URL 和派生 SHA-256 运行 Wrapper。工具/缓存均放在仓库隔离目录，没有安装到 PATH；真实集成测试受 `AUTODEV_*` 环境变量显式启用。

alpha.2 tarball 的原始空白 Profile 生命周期只覆盖 Windows x64 / Node 24.16.0 / pnpm 11.19.0；本轮另完成真正有数据的 Alpha.2→RC.1 升级：旧版 Store 实际生成 v2 数据，RC.1 tarball 换包与真实 Web 启动后，Run/Evidence/Knowledge/Artifact 与事件均由 RC.1 Store 读回且 Artifact SHA-256/字节数匹配。v1→v2 另由按契约构造的 fixture 覆盖，不应误写为 Alpha.2 v1 数据迁移。尚未覆盖其他 Node/OS、浏览器 Remote 展示或真实 Provider/Jev/Agent。RC.1 恢复演练另覆盖工作区链接包。生命周期均使用隔离 `DSH_HOME`；一次独立 `dsh plugin --help` 查询误漏 `DSH_HOME`，曾初始化一个空白测试 Profile（仅模板文件与空日志，未安装插件、未启动服务）；该确切目录已移至系统 Temp 留作恢复副本，原 Profile 路径不存在。Maven/Gradle 真工程已由 R5 独立 Driver 集成测试通过，但尚未嵌入真实 Agent 的 AutoDev Run/Worktree/Evidence 全流程。

## R5 真实构建驱动复验

默认 AutoDev 测试不下载大型构建工具。Windows 上设置以下变量后，`drivers.spec.ts` 才会启用两个真实工程集成用例：

```powershell
$env:AUTODEV_MAVEN_WRAPPER_JAR = '<Apache Maven Wrapper 3.3.4 的 maven-wrapper-3.3.4.jar>'
$env:AUTODEV_MAVEN_DISTRIBUTION_URL = '<已按 Apache SHA-512 校验的 Maven 3.9.16 ZIP 的 file: URL>'
$env:AUTODEV_MAVEN_DISTRIBUTION_SHA256 = '<该 ZIP 的 SHA-256，小写 64 位十六进制>'
$env:AUTODEV_GRADLE_HOME = '<已按 Gradle 官方 SHA-256 校验并解压的 Gradle 9.6.1 目录>'
$env:AUTODEV_GRADLE_DISTRIBUTION_URL = '<该 Gradle 9.6.1 ZIP 的 file: URL>'
pnpm --filter @deepseek-ai/dsh-experimental-autodev exec vitest run --root ../../../ packages/experimental/autodev/tests/drivers.spec.ts --testNamePattern 'real Maven Wrapper|real Gradle Wrapper'
```

Maven 测试复制仓库内 `examples/autodev-java` 到临时工程；Gradle 测试使用已校验的 Gradle 分发包生成 Wrapper，并校验生成的 Wrapper JAR。两者均以隔离的工具缓存、项目目录和仓库运行，不改动示例原件。完整测试/类型检查命令见下方。

## R5 Provider 工作目录与动态路由复验

- `SubagentStartRequest.workspaceCwd` 是显式的单次调用 cwd；没有 `workspaceCwd` capability 的 Provider 会在启动前被拒绝。进程外适配优先使用请求 cwd，其次静态配置 cwd，最后才继承父 Session cwd；进程内 Provider 会校验绝对路径和目录可进入性，再以它创建子 Session。该保证只限定当前子进程/Session 的工作目录，不等价于 OS sandbox。
- Codex、Claude Code、ACP、DSH SDK、spawn/fork in-process Provider 均通过对应源码/契约测试验证 per-run cwd；AutoDev 只展示/选择明确支持该能力的 Harness subagent，并在请求中传递实际 Worktree 路径。手写 `CustomProvider` 也必须显式设 `workspaceCwd: true`，承诺每个 workspace operation 都使用请求的 `request.cwd`；候选声明的 traits 需逐项由 Provider 覆盖，`unknown` 不作为通配符。能力不足的自定义 Provider 不可选择，直接调用也 fail closed。`commandProvider()` 默认以受限子进程 cwd 实现此承诺。动态 Route candidate 的注册、执行、卸载和同名重注册由 AutoDev Core 测试覆盖。
- 本轮 8 个受影响 Subagent/Provider 测试文件：333 passed、2 skipped；AutoDev 11 个测试文件：Node 24.16.0 默认 144 passed、2 skipped（可选 Maven/Gradle 集成需外部工具变量），Node 22.19.0 启用两项真实集成后 146/146。AutoDev typecheck 与 Bundle 通过，最低 Node 版本也重新运行了最新 Host/Client typecheck 和 Bundle。实际 CodeBuddy CLI/auth 不在本机可用，Ollama 二进制存在但服务端未运行，因此 CodeBuddy ACP、真实 Ollama 请求及真实 FreeLLMAPI Gateway 均未执行；文档配置示例不代表端点 E2E 已验收。
- CodeBuddy 应复用 `@deepseek-ai/dsh-subagent-acp` (`codebuddy --acp`)；其默认 `permission: reject` 会拒绝 ACP 权限请求，改成 `allow` 会自动应答，且 cwd 不会替代 CodeBuddy 或操作系统沙箱。Ollama/FreeLLMAPI 应复用 `@deepseek-ai/dsh-llm-pi-ai` 作为模型路由，不注册成代码执行 Agent。

128 Host 压力复现（在 Windows/Node 24 环境串行执行三次）：

```powershell
$env:AUTODEV_PROMOTION_RACE_WORKERS = '128'
pnpm exec vitest run --root . packages/experimental/autodev/tests/core.spec.ts --testNamePattern 'serializes a real simultaneous promotion race across independent Host processes'
```

测试默认仍启动 96 个 Host；压力参数允许 2–128，验收后可清除该 PowerShell 环境变量。

## 发布前仍需在目标机器执行

- 在安装了官方 Codex Provider 的真实 Profile 中完成一次真实修改。
- 在安装了官方 Claude Code Provider 的真实 Profile 中完成一次真实修改。
- 配置 `TYPESAFE_API_KEY` 后执行 Jev `POST /v1/systemone` 真实契约与失败重试验证。
- 在真实 AutoDev Run/Worktree 中执行一次 Maven/JUnit Build/Test，并确认运行时 Evidence 绑定当前 Candidate（R5 已通过独立 Driver 成败集成测试，此项仍是完整 R1 工作流门禁）。
- 在认证后的 DSH Web Profile 中从 Sidebar 创建备份，再恢复到全新的数据根目录；重启时显式指向恢复目录，并核对 Run、Evidence、Artifact 可读、路径重映射正确且原 Profile 数据未被覆盖。
- 做一次升级/卸载后重启验证，并记录目标 Harness 版本、Node、Git、JDK、Maven 和 Provider 版本。

由于当前交付环境没有用户提供的 Codex/Claude Code/Jev 凭据，不能把上述三项外部 E2E 宣称为已验收；当前产物应标记为“可安装候选版，外部凭据门禁待执行”。

## 建议命令

```powershell
pnpm install --frozen-lockfile --offline --ignore-scripts
pnpm --filter @deepseek-ai/dsh-experimental-autodev test
pnpm run build:lib
pnpm --filter @deepseek-ai/dsh-experimental-autodev pack --pack-destination $env:TEMP\dsh-autodev-pack
```

## 2026-09-25 本机收尾验收（Windows；跨平台项按用户要求不执行）

- AutoDev 完整套件在 Node 24.16.0 与便携 Node 22.19.0 各运行一次，均为 13 个测试文件、159 passed、2 skipped（161 total）。Node 22.19.0 使用 Temp 中已存在的官方便携运行时，没有替换系统 Node 或安装到 PATH。
- `pnpm run doc-sync` 一次运行得到 39 passed、3 failed、0 skipped。3 项失败分别是 API 文档图/目录未收录新公开类型，以及双语 README 的 ACP 示例多了一个闭合括号。修复类型链接归属并重新生成文档后，只定向复验这 3 项：`verify-doc-graphs`、`verify-cordis-catalog`、`doc-typecheck:contracts-ready` 全部通过；因此 42 项门禁均已有通过证据，但没有为获得单次聚合 42/42 再跑整套 doc-sync。
- 文档类型检查期间的 DSH Host 构建和 AutoDev Bundle 构建成功；修复示例后，86 个文档代码块编译通过。
- 本轮没有调用 Codex、Claude、Jev 或其他计费模型，也没有触碰用户 Web Profile。真实官方 Provider E2E、真实数据多日 soak，以及 Node 22.19.0 下 Alpha.2→RC.1 有数据升级仍未由本轮覆盖；跨平台矩阵按用户要求不作为本轮验收项。
