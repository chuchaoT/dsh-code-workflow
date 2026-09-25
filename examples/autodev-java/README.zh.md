---
description: "用于检查 AutoDev Worktree 执行、构建和测试 Evidence、Candidate 审阅及显式晋级的小型 Java 17 与 Maven Fixture。"
---

# AutoDev Java Example

[English](README.md) | 中文

## 概述

此 Fixture 是一个使用 Maven 和 JUnit 构建的小型 Java 17 项目。可用它验证 AutoDev 的 Git baseline、隔离 Worktree、Build/Test、Candidate Diff 和显式晋级流程。它不包含 Harness Runtime 代码，也不会配置模型 Provider。创建 Git baseline 前，请将其复制到 Harness 仓库之外，避免 Git 操作影响 Harness 工作区。

## 目录

- [构建 Fixture](#build-the-fixture)
- [准备干净的 Git baseline](#prepare-a-clean-git-baseline)
- [通过 AutoDev 运行](#run-it-through-autodev)
- [限制](#limitations)
- [开发备注](#dev-note)

-----

<a id="build-the-fixture"></a>
## 构建 Fixture

在此目录运行 Fixture 测试，先确认 Java 和 Maven 前置条件满足，再使用 AutoDev。

```powershell
mvn -q test
```

首次下载声明的依赖时，Maven 可能需要网络访问。

<a id="prepare-a-clean-git-baseline"></a>
## 准备干净的 Git baseline

选择一个全新空工作目录，将 Fixture 复制到该目录，再初始化并提交副本。不要在 Harness 仓库内部初始化嵌套 Git 仓库。

```powershell
$destination = "C:\work\autodev-java"
if (Test-Path -LiteralPath $destination) { throw "Choose a new destination" }
Copy-Item -Recurse .\examples\autodev-java $destination
Set-Location $destination
git init
git add .
git commit -m "baseline"
```

目标目录必须是干净的 Git 仓库，AutoDev 才能记录并在之后重新检查 baseline。

<a id="run-it-through-autodev"></a>
## 通过 AutoDev 运行

将 AutoDev 和 Coding Agent Provider 加载到 DSH Profile，然后为复制后的 Fixture 创建 Run：

```text
autodev_create
repo_path: C:\work\autodev-java
request: Add multiply(int left, int right) to Calculator and add a JUnit test.
acceptance_criteria: multiply(4, 3) == 12
```

调用 `autodev_run` 前先审阅不可变 Plan；Maven Driver 会固化到 Plan，并在隔离 Worktree 中执行打包构建和测试。

在 AutoDev 面板中检查 Candidate Diff、Build/Test Evidence 和 Human Gate。只有审阅 Candidate 并显式批准变更后，才调用 `autodev_promote`。

<a id="limitations"></a>
## 限制

- 此 Fixture 只测试 Maven 路径，不验证 Gradle、Node 或 pytest Driver。
- 测试 Provider 或离线 Fake 可以检查 AutoDev 契约，但不能算作真实 Codex 或 Claude Code 端到端运行。
- 本地 Fixture 成功不能替代在目标 DSH Profile 和真实项目依赖上的发布检查。

<a id="dev-note"></a>
### 开发备注

None.
