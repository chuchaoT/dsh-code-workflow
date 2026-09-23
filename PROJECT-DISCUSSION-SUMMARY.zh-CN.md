# DSH AutoDev 项目讨论摘要

## Summary

本文记录从“依据分享内容在家搭建一套工程 Agent”到 AutoDev 接入 DeepSeek Harness（DSH）、形成可扩展架构、确认界面与启动状态，并发布到个人 GitHub 仓库的讨论结论。当前仓库包含可安装候选版和离线验收结果；真实外部 Provider 与 Jev 调用仍需在具备凭据的目标环境验收。

## Contents

- [项目目标与交付要求](#项目目标与交付要求)
- [架构与技术选型](#架构与技术选型)
- [核心能力与扩展方式](#核心能力与扩展方式)
- [界面、安装与启动](#界面安装与启动)
- [当前实现和验证边界](#当前实现和验证边界)
- [后续规划要求](#后续规划要求)
- [GitHub 发布状态](#github-发布状态)
- [项目资料](#项目资料)

## 项目目标与交付要求

项目起点是用户提供的讨论链接，并希望在家从头搭建一套工程自动化能力；后续明确要求把实现接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，而不是另建一套与 DSH 脱节的 Agent Framework 或 Workflow Engine。

用户允许先做 MVP，但最终目标是可安装、可运行、可扩展并有验收依据的完整交付。每个实施阶段都应有测试和明确的验收标准；不能把接口占位、离线模拟或已加载 Provider 包等同于真实业务 E2E。

## 架构与技术选型

实现语言选择 TypeScript，客户端使用 React/TSX；该选择沿用 DSH 的 TypeScript、Cordis Bundle、Host/Client、Typert Remote 和 Subagent 扩展机制。

AutoDev 包为 `@deepseek-ai/dsh-experimental-autodev`。DSH Host 中的 `AutoDevRuntime` 持有 Run、Plan、执行、验证、人工 Gate 和 Promotion 的权威状态；SQLite 与 Artifact 保存运行记录；Client 通过受限 Remote 展示和发起操作，不直接访问数据库或修改原仓库。

工程修改在独立 Git Worktree 中执行。只有经过 Evidence、Verification 和明确 Promotion 检查后，结果才允许回写原仓库；Agent 的文字声明本身不能证明任务完成。

## 核心能力与扩展方式

- Agent Protocol 统一任务、上下文、结果和 Signal，使 Runtime 不依赖某个 Agent 的私有输出格式。
- Evidence 与 Verification 记录执行、构建、测试、审查和 Candidate 关联信息；缺少有效证据时不能报告为已验证完成。
- Project Memory 按项目范围检索，并通过摘要和详情分层返回，降低跨项目混用和无界上下文读取风险。
- Business Concept 保留业务语义的候选、证据和人工纠正，不把代码实现猜测直接提升为业务规则。
- Playbook 作为带版本和适配度信息的建议；它不能自行证明任务完成或修改 Plan。
- Assumption 与 SemanticUncertainty 分开记录，支持明确解决或驳回语义判断，不把不确定性伪装成执行失败。
- Knowledge 支持候选、证据支持的 Promote、回归用例、使用记录和 Compaction；整理或去重不会自动把候选变成已确立知识。
- Side Effect、Action Intent、取消、未知外部结果和 Human Gate 用于保留操作审计与人工接管能力。
- Jev 已纳入决策流程，用于 Provider 路由、失败处理、质量和完成类判断；支持 `required`、`advisory`、`off` 模式及受约束的回退策略。

Provider 调用采用动态注册表：Provider Registry 描述可用执行后端，Route Registry 决定任务可选后端，Agent Protocol 统一 Runtime 使用的输入与结果。AutoDev 通过 DSH 官方 Subagent 插件调用 Codex 和 Claude Code，不重复实现这两个工具的登录、进程生命周期和权限管理。

CodeBuddy、Ollama 等后续 Provider 可通过注册 Provider 和 Route 接入。命令适配器提供 argv 参数、工作目录、超时、取消和输出上限；目前扩展点已具备，不代表每个第三方 Provider 的专用适配器和真实调用都已完成验收。

## 界面、安装与启动

AutoDev 有 DSH Client 界面：在 DSH Web/Desktop 中打开右侧 AutoDev Sidebar，可查看 Run、Plan、Evidence、Verification、Agent Signal、语义状态、Memory/Knowledge/Concept/Playbook、Side Effect、Candidate Diff 和 Gate，并执行受限的刷新、取消、放弃或 Promote 操作。`autodev` 是对应的命令入口。

该界面随 DSH Client Bundle 加载，不是独立 Web 应用；纯 CLI/headless 模式没有可视化面板。安装 Bundle 后新增或更新模块需要重启对应 Profile。若 Profile 没有加载真实 Provider，路由会记录 Provider 不可用，而不会假装完成调用。

本地隔离 `DSH_HOME` 验证已覆盖 Plugin Manager 安装、`--dump-config` 中出现 AutoDev、`runProfile()` 获取 AutoDev Runtime，以及 DSH Host 中动态注册 Provider/Route。它证明安装与 Host 加载链路接通，不等同于在用户目标机完成真实登录态下的完整操作。

## 当前实现和验证边界

AutoDev 包级验证记录为 TypeScript typecheck、Host/Client Bundle、`pnpm run build:lib` 通过，Vitest 22/22 通过；测试覆盖协议、Jev 策略、动态路由、Worktree、Evidence/Verification、Memory、Concept、Playbook、Knowledge、Compaction 和 Side Effect 等路径。

DSH 集成验证包括本地 Bundle 安装、配置解析、Runtime 启动、动态路由，以及官方 Codex 和 Claude Code Provider Loader Composition E2E（各 1 项通过）。提交时仓库 lint/空白检查和推送前 Host 构建、Client 类型检查也通过。

当前仍不能声明真实 Codex/Claude Code 工程任务和 Jev HTTP 业务调用已完成验收。它们需要目标环境提供登录态、原生进程、网络、目标仓库和 Jev 凭据；当前发布验证记录将这些列为外部环境门禁。

## 后续规划要求

用户要求对照 S1-S4 已有实现做 Gap Analysis，区分已具备、缺失和需要调整的设计；先产出架构方案与实施计划，再改代码。优先检查 Agent Protocol、Evidence/Verification、Project Memory、Business Concept、Playbook、Assumption/SemanticUncertainty 和 Knowledge Evolution/Compaction。

项目介绍目前记录了目标机外部验证、Build/Test Driver 扩展、知识质量与检索、安全运维和产品体验等后续优先级。下一阶段仍应把 S1-S4 与当前代码逐项对应，并为每阶段写明测试和验收条件；这不要求推翻已经合理的 DSH 集成设计。

## GitHub 发布状态

项目已发布到 [chuchaoT/dsh-code-workflow](https://github.com/chuchaoT/dsh-code-workflow)，分支为 `main`。仓库包含此次工作区的 AutoDev 源码、测试、构建配置、Java 示例和项目文档；本地 `main` 追踪该远程，原有 `origin` 仍指向官方 DSH 仓库。

发布内容基于当时本地的 DSH 提交。推送前补齐了浅克隆历史，但没有把当时官方 `master` 相对本地基线新增的 162 个提交合并到个人仓库。因此个人仓库包含完整的本地项目状态和 AutoDev 改动，但不是最新官方 `master` 的镜像。

## 项目资料

- [完整项目介绍与操作说明](PROJECT-INTRODUCTION.zh-CN.md)
- [AutoDev 中文 README](packages/experimental/autodev/README.zh.md)
- [发布验证记录](packages/experimental/autodev/RELEASE-VERIFICATION.zh.md)
- [AutoDev 源码与测试](packages/experimental/autodev/)
- [Java/Maven 示例](examples/autodev-java/)
- [个人 GitHub 仓库](https://github.com/chuchaoT/dsh-code-workflow)
- [DSH 官方上游仓库](https://github.com/deepseek-ai/deepseek-harness)
