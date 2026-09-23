# AutoDev 发布校验记录

这份记录对应当前源码树中的 `@deepseek-ai/dsh-experimental-autodev`，用于区分“源码、契约和离线链路已验证”与“需要本机凭据/外部 Provider 才能验证”的项目。

## 已通过

- Host TypeScript 项目引用检查。
- Client TypeScript 项目引用检查。
- AutoDev Host 与 Client 独立 tsdown 构建。
- Harness 根目录 `build:lib` 全量 Host → Client 构建。
- AutoDev Vitest：22/22 通过，覆盖持久化、Artifact、Agent Protocol/Signal、Evidence Verification（缺失证据不得完成且必须绑定当前 Candidate）、Jev 四类决策契约、置信度/非法答案门禁、质量评分 Gate、官方 Subagent 路由、动态 Provider、命令 Provider、重启恢复、最大尝试次数 Gate、未知外部结果不自动重试、Git Worktree、Maven/JUnit 假执行器、Diff Remote 与 Promote、Project Memory、Assumption/SemanticUncertainty、Business Concept、Playbook 版本与 Fit、Knowledge Compaction/Regression、SideEffect Ledger。
- `pnpm pack` tarball 内容审计：Host、Remote、Client、Typert 声明、类型文件、Hash chunk、Bundle patch、README、许可证均在包内。
- 临时 DSH profile 的 `plugin add`、配置组合、`plugin remove`、再次添加和 `--dump-config`。
- Windows 路径约束：Worktree 只能位于配置的 managed root；Artifact Remote 不返回宿主机路径。

## 发布前仍需在目标机器执行

- 在安装了官方 Codex Provider 的真实 Profile 中完成一次真实修改。
- 在安装了官方 Claude Code Provider 的真实 Profile 中完成一次真实修改。
- 配置 `TYPESAFE_API_KEY` 后执行 Jev `POST /v1/systemone` 真实契约与失败重试验证。
- 用仓库根目录的 `../../../examples/autodev-java` 执行真实 Maven/JUnit 下载和测试。
- 做一次升级/卸载后重启验证，并记录目标 Harness 版本、Node、Git、JDK、Maven 和 Provider 版本。

由于当前交付环境没有用户提供的 Codex/Claude Code/Jev 凭据，不能把上述三项外部 E2E 宣称为已验收；当前产物应标记为“可安装候选版，外部凭据门禁待执行”。

## 建议命令

```powershell
pnpm install --frozen-lockfile --offline --ignore-scripts
pnpm --filter @deepseek-ai/dsh-experimental-autodev test
pnpm run build:lib
pnpm --filter @deepseek-ai/dsh-experimental-autodev pack --pack-destination $env:TEMP\dsh-autodev-pack
```
