---
description: "A small Java 17 and Maven fixture for checking AutoDev Worktree execution, build and test Evidence, Candidate review, and explicit promotion."
---

# AutoDev Java Example

English | [中文](README.zh.md)

## Summary

This fixture is a small Java 17 project built with Maven and JUnit. Use it to exercise AutoDev's Git baseline, isolated Worktree, Build/Test, Candidate diff, and explicit promotion flow. It contains no Harness runtime code and does not configure a model Provider. Copy it outside the Harness repository before creating a Git baseline so Git operations cannot affect the Harness checkout.

## Table of Contents

- [Build the fixture](#build-the-fixture)
- [Prepare a clean Git baseline](#prepare-a-clean-git-baseline)
- [Run it through AutoDev](#run-it-through-autodev)
- [Limitations](#limitations)
- [Dev Note](#dev-note)

-----

<a id="build-the-fixture"></a>
## Build the fixture

Run the fixture's tests from this directory to verify the Java and Maven prerequisites before using AutoDev.

```powershell
mvn -q test
```

Maven may need network access the first time it downloads the declared dependencies.

<a id="prepare-a-clean-git-baseline"></a>
## Prepare a clean Git baseline

Choose a new empty working directory, copy the fixture there, then initialize and commit that copy. Do not initialize a nested Git repository inside the Harness checkout.

```powershell
$destination = "C:\work\autodev-java"
if (Test-Path -LiteralPath $destination) { throw "Choose a new destination" }
Copy-Item -Recurse .\examples\autodev-java $destination
Set-Location $destination
git init
git add .
git commit -m "baseline"
```

The target directory must be a clean Git repository so AutoDev can record and later recheck its baseline.

<a id="run-it-through-autodev"></a>
## Run it through AutoDev

Load AutoDev and a Coding Agent Provider into a DSH profile, then create a Run for the copied fixture:

```text
autodev_create
repo_path: C:\work\autodev-java
request: Add multiply(int left, int right) to Calculator and add a JUnit test.
acceptance_criteria: multiply(4, 3) == 12
```

Review the immutable Plan before calling `autodev_run`; the Maven driver is frozen into the Plan and runs the package build and tests in the isolated Worktree.

Inspect the Candidate diff, Build/Test Evidence, and any Human Gate in the AutoDev panel. Call `autodev_promote` only after you review the candidate and explicitly approve the change.

<a id="limitations"></a>
## Limitations

- The fixture tests the Maven path only; it does not validate Gradle, Node, or pytest drivers.
- A test Provider or offline fake can check the AutoDev contract, but it does not count as a real Codex or Claude Code end-to-end run.
- A successful local fixture run does not replace release checks against the target DSH profile and real project dependencies.

<a id="dev-note"></a>
### Dev Note

None.
