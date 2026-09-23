# AutoDev Java Example

这是 AutoDev v1 的最小 Java 17 + Maven + JUnit 工程。它用于验证 Git baseline、Worktree、Maven build/test、Candidate Diff、Evidence 和显式 Promote，不包含任何 Harness 运行时代码。

## 先确认示例本身可构建

在本目录执行：

```powershell
mvn -q test
```

## 用 AutoDev 运行

1. 在 `deepseek-harness` 根目录先构建并安装 `@deepseek-ai/dsh-experimental-autodev`。
2. 把本示例目录初始化为 Git 仓库，并提交初始版本：

   ```powershell
   git init
   git add .
   git commit -m "baseline"
   ```

3. 在 Harness 会话中创建 Run：

   ```text
   autodev_create
   repo_path: <本示例的绝对路径>
   request: 为 Calculator 增加 multiply(int left, int right)，并补充一个 JUnit 测试
   acceptance_criteria: multiply(4, 3) == 12
   ```

4. 调用 `autodev_run`。运行会在独立 Worktree 中执行 Agent、`mvn package -DskipTests` 与 `mvn test`。
5. 查看 AutoDev 面板里的 Candidate Diff、Build/Test Evidence 和 Human Gate；只有确认后才调用 `autodev_promote`。

如果当前没有官方 Codex/Claude Code Provider，仍可用测试夹具或第三方动态 Provider 验证路由和状态机；这不等价于真实 Agent E2E。
