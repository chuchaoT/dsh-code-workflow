import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessCommandExecutor } from '../src/command.ts'
import { commandForDriver, detectBuildDrivers, selectBuildDriver } from '../src/drivers.ts'

const roots: string[] = []
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-autodev-driver-'))
  roots.push(root)
  return root
}

function findJdkTool(executable: string): string | undefined {
  return (process.env.PATH ?? '').split(delimiter).map(directory => join(directory, executable)).find(existsSync)
}

function findPytestPython(): string | undefined {
  const candidates = process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']
  for (const candidate of candidates) {
    const executable = findJdkTool(candidate)
    if (executable === undefined) continue
    try {
      execFileSync(executable, ['-c', 'import pytest'], { stdio: 'ignore' })
      return executable
    } catch {
      // This Python installation cannot run the optional real-project fixture.
    }
  }
  return undefined
}

const pytestPython = findPytestPython()
const mavenWrapperJar = process.env.AUTODEV_MAVEN_WRAPPER_JAR
const mavenDistributionUrl = process.env.AUTODEV_MAVEN_DISTRIBUTION_URL
const mavenDistributionSha256 = process.env.AUTODEV_MAVEN_DISTRIBUTION_SHA256
const gradleHome = process.env.AUTODEV_GRADLE_HOME
const gradleDistributionUrl = process.env.AUTODEV_GRADLE_DISTRIBUTION_URL
const hasMavenIntegrationArtifacts = process.platform === 'win32'
  && mavenWrapperJar !== undefined && existsSync(mavenWrapperJar)
  && mavenDistributionUrl !== undefined && mavenDistributionUrl !== ''
  && mavenDistributionSha256 !== undefined && /^[a-f0-9]{64}$/u.test(mavenDistributionSha256)
const hasGradleIntegrationArtifacts = process.platform === 'win32'
  && gradleHome !== undefined && existsSync(join(gradleHome, 'lib'))
  && gradleDistributionUrl !== undefined && gradleDistributionUrl !== ''

function createWrapperJar(root: string, packageName: string, className: string, jarPath: string): void {
  const sourceRoot = join(root, 'src')
  const packagePath = packageName.split('.').reduce((current, part) => join(current, part), sourceRoot)
  const classes = join(root, 'classes')
  mkdirSync(packagePath, { recursive: true })
  mkdirSync(classes, { recursive: true })
  const sourcePath = join(packagePath, `${className}.java`)
  const qualifiedName = `${packageName}.${className}`
  const propertyOutput = className === 'MavenWrapperMain' ? 'System.getProperty("maven.multiModuleProjectDirectory") + "|" + ' : ''
  writeFileSync(sourcePath, `package ${packageName}; public class ${className} { public static void main(String[] args) { System.out.print(${propertyOutput}String.join("|", args)); } }`)
  const manifestPath = join(root, 'manifest.mf')
  writeFileSync(manifestPath, `Manifest-Version: 1.0\r\nMain-Class: ${qualifiedName}\r\n\r\n`)
  const javac = findJdkTool('javac.exe')
  const jar = findJdkTool('jar.exe')
  if (javac === undefined || jar === undefined) throw new Error('JDK compiler and jar tools are required for this wrapper smoke test')
  execFileSync(javac, ['-d', classes, sourcePath], { stdio: 'pipe' })
  execFileSync(jar, ['cfm', jarPath, manifestPath, '-C', classes, '.'], { stdio: 'pipe' })
}

describe('Build/Test drivers', () => {
  it('selects a unique Maven, Gradle, Node, or pytest root without executing a shell', () => {
    const maven = tempRoot()
    writeFileSync(join(maven, 'pom.xml'), '<project/>')
    expect(detectBuildDrivers(maven)).toEqual(['maven'])
    expect(selectBuildDriver(maven)).toBe('maven')
    expect(commandForDriver('maven', 'test', maven, { maven: { executable: 'fake-mvn', testArgs: ['-q', 'test'] } }).argv)
      .toEqual(['fake-mvn', '-q', 'test'])

    const gradle = tempRoot()
    writeFileSync(join(gradle, 'settings.gradle.kts'), 'rootProject.name = "sample"')
    expect(selectBuildDriver(gradle)).toBe('gradle')
    expect(commandForDriver('gradle', 'build', gradle, { gradle: { executable: 'fake-gradle' } }).argv)
      .toEqual(['fake-gradle', 'build', '-x', 'test'])

    const node = tempRoot()
    writeFileSync(join(node, 'package.json'), '{"scripts":{"build":"tsc","test":"vitest"}}')
    writeFileSync(join(node, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"')
    mkdirSync(join(node, 'node_modules', 'pnpm', 'bin'), { recursive: true })
    writeFileSync(join(node, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '')
    const command = commandForDriver('node', 'build', node)
    if (process.platform === 'win32') {
      expect(command.argv[0]).toBe(process.execPath)
      expect(command.argv[1]).toMatch(/pnpm[\\/]bin[\\/]pnpm\.(?:cjs|mjs)$/)
      expect(command.argv.slice(2)).toEqual(['run', 'build'])
    } else {
      expect(command.argv).toEqual(['pnpm', 'run', 'build'])
    }
    const literalShellMetacharacters = commandForDriver('node', 'test', node, {
      node: { executable: 'pnpm', testArgs: ['test', '; do-not-execute-this'] },
    })
    expect(literalShellMetacharacters.argv).toEqual(['pnpm', 'test', '; do-not-execute-this'])

    const python = tempRoot()
    writeFileSync(join(python, 'pyproject.toml'), '[tool.pytest.ini_options]\ntestpaths = ["tests"]')
    expect(selectBuildDriver(python)).toBe('pytest')
    expect(commandForDriver('pytest', 'test', python).argv.slice(1)).toEqual(['-m', 'pytest', '-q'])
  })

  it('rejects missing and ambiguous project roots unless the caller explicitly selects a detected driver', () => {
    const empty = tempRoot()
    expect(() => selectBuildDriver(empty)).toThrow(/no supported root Build\/Test driver/)

    const monorepo = tempRoot()
    writeFileSync(join(monorepo, 'pom.xml'), '<project/>')
    writeFileSync(join(monorepo, 'package.json'), '{}')
    expect(detectBuildDrivers(monorepo)).toEqual(['maven', 'node'])
    expect(() => selectBuildDriver(monorepo)).toThrow(/multiple root Build\/Test drivers/)
    expect(selectBuildDriver(monorepo, 'node')).toBe('node')
    expect(() => selectBuildDriver(monorepo, 'pytest')).toThrow(/was not detected/)
  })

  it('rejects NUL bytes and oversized custom argv instead of invoking a shell', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'package.json'), '{}')
    expect(() => commandForDriver('node', 'build', root, { node: { executable: 'npm\0.cmd' } })).toThrow(/executable name/)
    expect(() => commandForDriver('node', 'build', root, { node: { buildArgs: Array.from({ length: 129 }, () => 'arg') } })).toThrow(/argv array/)
  })

  it('rejects conflicting Node lockfiles unless both stage commands are explicitly configured', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'package.json'), '{}')
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"')
    writeFileSync(join(root, 'package-lock.json'), '{}')
    expect(() => commandForDriver('node', 'build', root)).toThrow(/multiple Node package-manager lockfiles/)
    expect(commandForDriver('node', 'build', root, {
      node: { executable: 'node-project-runner', buildArgs: ['build'], testArgs: ['test'] },
    }).argv).toEqual(['node-project-runner', 'build'])
  })

  it.skipIf(process.platform !== 'win32')('launches Maven and Gradle Wrapper JARs directly through Java without a batch shell', () => {
    const maven = tempRoot()
    writeFileSync(join(maven, 'pom.xml'), '<project/>')
    mkdirSync(join(maven, '.mvn', 'wrapper'), { recursive: true })
    writeFileSync(join(maven, '.mvn', 'wrapper', 'maven-wrapper.jar'), 'fixture')
    writeFileSync(join(maven, 'mvnw.cmd'), 'must not be executed')
    const mavenCommand = commandForDriver('maven', 'build', maven)
    expect(mavenCommand.argv[0]).toMatch(/java\.exe$/i)
    expect(mavenCommand.argv.slice(1)).toEqual([
      '-classpath', join(maven, '.mvn', 'wrapper', 'maven-wrapper.jar'),
      `-Dmaven.multiModuleProjectDirectory=${maven}`,
      'org.apache.maven.wrapper.MavenWrapperMain', '-q', '-DskipTests', 'package',
    ])
    expect(mavenCommand.argv[0]).not.toMatch(/\.(?:cmd|bat)$/i)

    const gradle = tempRoot()
    writeFileSync(join(gradle, 'settings.gradle.kts'), 'rootProject.name = "sample"')
    mkdirSync(join(gradle, 'gradle', 'wrapper'), { recursive: true })
    writeFileSync(join(gradle, 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'fixture')
    writeFileSync(join(gradle, 'gradlew.bat'), 'must not be executed')
    const gradleCommand = commandForDriver('gradle', 'test', gradle)
    expect(gradleCommand.argv[0]).toMatch(/java\.exe$/i)
    expect(gradleCommand.argv.slice(1)).toEqual([
      '-Dorg.gradle.appname=gradlew', '-jar', join(gradle, 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'test',
    ])
    expect(gradleCommand.argv[0]).not.toMatch(/\.(?:cmd|bat)$/i)
  })

  it.skipIf(process.platform !== 'win32')('fails clearly when a Windows Maven or Gradle Wrapper JAR is missing', () => {
    const maven = tempRoot()
    writeFileSync(join(maven, 'pom.xml'), '<project/>')
    writeFileSync(join(maven, 'mvnw.cmd'), 'unsupported script wrapper')
    expect(() => commandForDriver('maven', 'test', maven)).toThrow(/supported Wrapper JAR is missing.*never launched through a shell/u)

    const gradle = tempRoot()
    writeFileSync(join(gradle, 'settings.gradle'), 'rootProject.name = "sample"')
    writeFileSync(join(gradle, 'gradlew.bat'), 'unsupported script wrapper')
    expect(() => commandForDriver('gradle', 'test', gradle)).toThrow(/supported Wrapper JAR is missing.*never launched through a shell/u)
    expect(commandForDriver('maven', 'test', maven, { maven: { executable: 'maven.exe' } }).argv[0]).toBe('maven.exe')
  })

  it.skipIf(process.platform !== 'win32' || findJdkTool('javac.exe') === undefined || findJdkTool('jar.exe') === undefined)(
    'executes Java-backed Maven and Gradle wrapper JARs without invoking their batch launchers',
    async () => {
      const executor = new HarnessCommandExecutor()
      const maven = tempRoot()
      writeFileSync(join(maven, 'pom.xml'), '<project/>')
      const mavenJar = join(maven, '.mvn', 'wrapper', 'maven-wrapper.jar')
      mkdirSync(join(maven, '.mvn', 'wrapper'), { recursive: true })
      createWrapperJar(maven, 'org.apache.maven.wrapper', 'MavenWrapperMain', mavenJar)
      writeFileSync(join(maven, 'mvnw.cmd'), 'must not be executed')
      const mavenResult = await executor.run(commandForDriver('maven', 'test', maven).argv, maven, { timeoutMs: 15_000 })
      expect(mavenResult.exitCode).toBe(0)
      expect(mavenResult.stdout.trim()).toBe(`${maven}|-q|test`)

      const gradle = tempRoot()
      writeFileSync(join(gradle, 'settings.gradle.kts'), 'rootProject.name = "sample"')
      const gradleJar = join(gradle, 'gradle', 'wrapper', 'gradle-wrapper.jar')
      mkdirSync(join(gradle, 'gradle', 'wrapper'), { recursive: true })
      createWrapperJar(gradle, 'org.gradle.wrapper', 'GradleWrapperMain', gradleJar)
      writeFileSync(join(gradle, 'gradlew.bat'), 'must not be executed')
      const gradleResult = await executor.run(commandForDriver('gradle', 'test', gradle).argv, gradle, { timeoutMs: 15_000 })
      expect(gradleResult.exitCode).toBe(0)
      expect(gradleResult.stdout.trim()).toBe('test')
    },
  )

  it.skipIf(process.platform !== 'win32')('runs an npm test in an isolated project through node.exe rather than npm.cmd', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node build.js', test: 'node test.js' } }))
    writeFileSync(join(root, 'build.js'), 'process.stdout.write("autodev-build-ok")\n')
    writeFileSync(join(root, 'test.js'), 'process.stdout.write("autodev-test-ok")\n')
    const executor = new HarnessCommandExecutor()
    const buildCommand = commandForDriver('node', 'build', root)
    expect(buildCommand.argv[0]).toBe(process.execPath)
    expect(buildCommand.argv[1]).toMatch(/npm[\\/]bin[\\/]npm-cli\.js$/)
    const build = await executor.run(buildCommand.argv, root, { timeoutMs: 15_000 })
    expect(build.exitCode).toBe(0)
    expect(build.stdout).toContain('autodev-build-ok')

    const testCommand = commandForDriver('node', 'test', root)
    const test = await executor.run(testCommand.argv, root, { timeoutMs: 15_000 })
    expect(test.exitCode).toBe(0)
    expect(test.stdout).toContain('autodev-test-ok')

    writeFileSync(join(root, 'test.js'), 'process.exitCode = 7\n')
    const failedTest = await executor.run(testCommand.argv, root, { timeoutMs: 15_000 })
    expect(failedTest.exitCode).toBe(7)
    expect(failedTest.timedOut).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('rejects a batch wrapper rather than attempting an invalid spawn', async () => {
    const root = tempRoot()
    await expect(new HarnessCommandExecutor().run(['npm.cmd', 'test'], root))
      .rejects.toThrow(/Windows batch wrappers cannot run without a shell/)
  })

  it('reports timeout, cancellation, bounded output, and a missing executable distinctly', async () => {
    const root = tempRoot()
    const executor = new HarnessCommandExecutor()
    const output = await executor.run([process.execPath, '-e', 'process.stdout.write("x".repeat(4096))'], root, { maxOutputBytes: 128 })
    expect(output.exitCode).toBe(0)
    expect(Buffer.byteLength(output.stdout)).toBe(128)

    const timeout = await executor.run([process.execPath, '-e', 'setInterval(() => {}, 1000)'], root, { timeoutMs: 250 })
    expect(timeout.timedOut).toBe(true)
    expect(timeout.exitCode).not.toBe(0)

    const cancelled = new AbortController()
    cancelled.abort()
    await expect(executor.run([process.execPath, '-e', 'process.exit(0)'], root, { signal: cancelled.signal }))
      .rejects.toThrow()
    await expect(executor.run(['autodev-executable-does-not-exist-7159'], root)).rejects.toThrow()
  })

  it('applies success, nonzero exit, active cancellation, timeout, and output bounds to every Driver contract', async () => {
    const executor = new HarnessCommandExecutor()
    const drivers = [
      { id: 'maven', marker: ['pom.xml', '<project/>'] },
      { id: 'gradle', marker: ['build.gradle', ''] },
      { id: 'node', marker: ['package.json', '{}'] },
      { id: 'pytest', marker: ['pytest.ini', '[pytest]\n'] },
    ] as const

    for (const driver of drivers) {
      const root = tempRoot()
      writeFileSync(join(root, driver.marker[0]), driver.marker[1])
      const configured = (buildArgs: string[], testArgs: string[], executable = process.execPath) => {
        const commandSettings = { executable, buildArgs, testArgs }
        return driver.id === 'maven'
          ? { maven: commandSettings }
          : { [driver.id]: commandSettings }
      }

      const passing = commandForDriver(driver.id, 'build', root, configured(['-e', 'process.stdout.write("build-ok")'], ['-e', 'process.exit(23)']))
      const passed = await executor.run(passing.argv, root, { timeoutMs: 10_000 })
      expect(passed.exitCode, `${driver.id} build`).toBe(0)
      expect(passed.stdout).toBe('build-ok')

      const failing = commandForDriver(driver.id, 'test', root, configured(['-e', 'process.exit(0)'], ['-e', 'process.stderr.write("test-failed"); process.exit(23)']))
      const failed = await executor.run(failing.argv, root, { timeoutMs: 10_000 })
      expect(failed.exitCode, `${driver.id} test failure`).toBe(23)
      expect(failed.stderr).toContain('test-failed')

      const timedCommand = commandForDriver(driver.id, 'build', root, configured(['-e', 'setInterval(() => {}, 1000)'], ['-e', 'process.exit(0)']))
      const timed = await executor.run(timedCommand.argv, root, { timeoutMs: 200 })
      expect(timed.timedOut, `${driver.id} timeout`).toBe(true)
      expect(timed.exitCode).not.toBe(0)

      const controller = new AbortController()
      const activeCommand = commandForDriver(driver.id, 'test', root, configured(['-e', 'process.exit(0)'], ['-e', 'setInterval(() => {}, 1000)']))
      const activeRun = executor.run(activeCommand.argv, root, { signal: controller.signal, timeoutMs: 10_000 })
      setTimeout(() => controller.abort(), 100)
      const cancelled = await activeRun
      expect(cancelled.timedOut, `${driver.id} active cancellation`).toBe(false)
      expect(cancelled.exitCode, `${driver.id} active cancellation`).not.toBe(0)

      const noisy = commandForDriver(driver.id, 'test', root, configured(['-e', 'process.exit(0)'], ['-e', 'process.stdout.write("z".repeat(4096))']))
      const bounded = await executor.run(noisy.argv, root, { maxOutputBytes: 96 })
      expect(bounded.exitCode).toBe(0)
      expect(Buffer.byteLength(bounded.stdout)).toBeLessThanOrEqual(96)
    }
  })

  it.skipIf(!hasMavenIntegrationArtifacts)('runs a real Maven Wrapper project through Build/Test and detects a failing JUnit test', async () => {
    const source = join(repositoryRoot, 'examples', 'autodev-java')
    const root = tempRoot()
    const project = join(root, 'maven-project')
    cpSync(source, project, { recursive: true })
    const wrapperDirectory = join(project, '.mvn', 'wrapper')
    mkdirSync(wrapperDirectory, { recursive: true })
    cpSync(mavenWrapperJar as string, join(wrapperDirectory, 'maven-wrapper.jar'))
    writeFileSync(join(wrapperDirectory, 'maven-wrapper.properties'), [
      `distributionUrl=${mavenDistributionUrl}`,
      `distributionSha256Sum=${mavenDistributionSha256}`,
      '',
    ].join('\n'))

    const repo = join(root, 'maven-repository')
    const settings = { maven: {
      buildArgs: ['-q', `-Dmaven.repo.local=${repo}`, '-DskipTests', 'package'],
      testArgs: ['-q', `-Dmaven.repo.local=${repo}`, 'test'],
    } }
    const executor = new HarnessCommandExecutor()
    const env = { MAVEN_USER_HOME: join(root, 'maven-user-home') }
    const build = await executor.run(commandForDriver('maven', 'build', project, settings).argv, project, { timeoutMs: 300_000, env })
    expect(build.exitCode, `${build.stdout}\n${build.stderr}`).toBe(0)
    const passing = await executor.run(commandForDriver('maven', 'test', project, settings).argv, project, { timeoutMs: 300_000, env })
    expect(passing.exitCode, `${passing.stdout}\n${passing.stderr}`).toBe(0)
    const mavenReport = join(project, 'target', 'surefire-reports', 'TEST-example.CalculatorTest.xml')
    expect(readFileSync(mavenReport, 'utf8')).toMatch(/failures="0"/u)

    writeFileSync(join(project, 'src', 'test', 'java', 'example', 'CalculatorTest.java'), [
      'package example;',
      'import static org.junit.jupiter.api.Assertions.assertEquals;',
      'import org.junit.jupiter.api.Test;',
      'class CalculatorTest { @Test void detectsFailure() { assertEquals(0, Calculator.add(2, 3)); } }',
      '',
    ].join('\n'))
    const failing = await executor.run(commandForDriver('maven', 'test', project, settings).argv, project, { timeoutMs: 300_000, env })
    expect(failing.exitCode, `${failing.stdout}\n${failing.stderr}`).not.toBe(0)
    expect(readFileSync(mavenReport, 'utf8')).toMatch(/failures="1"/u)
  }, 660_000)

  it.skipIf(!hasGradleIntegrationArtifacts)('runs a real Gradle Wrapper project through Build/Test and detects a failing JUnit test', async () => {
    const root = tempRoot()
    const project = join(root, 'gradle-project')
    const wrapperDirectory = join(project, 'gradle', 'wrapper')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'settings.gradle'), "rootProject.name = 'autodev-gradle-fixture'\n")
    writeFileSync(join(project, 'build.gradle'), [
      "plugins { id 'java' }",
      'repositories { mavenCentral() }',
      "dependencies { testImplementation 'org.junit.jupiter:junit-jupiter:5.10.2'; testRuntimeOnly 'org.junit.platform:junit-platform-launcher' }",
      'test { useJUnitPlatform() }',
      '',
    ].join('\n'))
    const source = join(project, 'src', 'main', 'java', 'example')
    const tests = join(project, 'src', 'test', 'java', 'example')
    mkdirSync(source, { recursive: true })
    mkdirSync(tests, { recursive: true })
    writeFileSync(join(source, 'Calculator.java'), 'package example; public final class Calculator { public static int add(int left, int right) { return left + right; } }\n')
    const testFile = join(tests, 'CalculatorTest.java')
    writeFileSync(testFile, [
      'package example;',
      'import static org.junit.jupiter.api.Assertions.assertEquals;',
      'import org.junit.jupiter.api.Test;',
      'class CalculatorTest { @Test void adds() { assertEquals(5, Calculator.add(2, 3)); } }',
      '',
    ].join('\n'))

    const executor = new HarnessCommandExecutor()
    const settings = { GRADLE_USER_HOME: join(root, 'gradle-user-home') }
    const java = findJdkTool('java.exe') ?? 'java.exe'
    const wrapperGeneration = await executor.run([
      java,
      '-classpath', join(gradleHome as string, 'lib', '*'),
      'org.gradle.launcher.GradleMain',
      'wrapper',
      '--no-daemon',
      '--gradle-distribution-url', gradleDistributionUrl as string,
      '--gradle-distribution-sha256-sum', '9c0f7faeeb306cb14e4279a3e084ca6b596894089a0638e68a07c945a32c9e14',
    ], project, { timeoutMs: 300_000, env: settings })
    expect(wrapperGeneration.exitCode, `${wrapperGeneration.stdout}\n${wrapperGeneration.stderr}`).toBe(0)
    const generatedWrapperJar = join(wrapperDirectory, 'gradle-wrapper.jar')
    expect(existsSync(generatedWrapperJar)).toBe(true)
    expect(createHash('sha256').update(readFileSync(generatedWrapperJar)).digest('hex'))
      .toBe('497c8c2a7e5031f6aa847f88104aa80a93532ec32ee17bdb8d1d2f67a194a9c7')

    const gradleSettings = { gradle: { buildArgs: ['--no-daemon', 'build', '-x', 'test'], testArgs: ['--no-daemon', 'test'] } }
    const build = await executor.run(commandForDriver('gradle', 'build', project, gradleSettings).argv, project, { timeoutMs: 300_000, env: settings })
    expect(build.exitCode, `${build.stdout}\n${build.stderr}`).toBe(0)
    const passing = await executor.run(commandForDriver('gradle', 'test', project, gradleSettings).argv, project, { timeoutMs: 300_000, env: settings })
    expect(passing.exitCode, `${passing.stdout}\n${passing.stderr}`).toBe(0)
    const gradleReport = join(project, 'build', 'test-results', 'test', 'TEST-example.CalculatorTest.xml')
    expect(readFileSync(gradleReport, 'utf8')).toMatch(/failures="0"/u)

    writeFileSync(testFile, [
      'package example;',
      'import static org.junit.jupiter.api.Assertions.assertEquals;',
      'import org.junit.jupiter.api.Test;',
      'class CalculatorTest { @Test void detectsFailure() { assertEquals(0, Calculator.add(2, 3)); } }',
      '',
    ].join('\n'))
    const failing = await executor.run(commandForDriver('gradle', 'test', project, gradleSettings).argv, project, { timeoutMs: 300_000, env: settings })
    expect(failing.exitCode, `${failing.stdout}\n${failing.stderr}`).not.toBe(0)
    expect(readFileSync(gradleReport, 'utf8')).toMatch(/failures="1"/u)
  }, 660_000)

  it.skipIf(pytestPython === undefined)('runs a real pytest project through Build/Test and preserves syntax and assertion failures', async () => {
    const root = tempRoot()
    const executor = new HarnessCommandExecutor()
    const settings = { pytest: { executable: pytestPython as string } }
    const testRoot = join(root, 'tests')
    mkdirSync(testRoot, { recursive: true })
    writeFileSync(join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n')
    writeFileSync(join(root, 'rules.py'), 'def amount():\n    return 42\n')
    const testFile = join(testRoot, 'test_rules.py')
    writeFileSync(testFile, 'from rules import amount\n\ndef test_amount():\n    assert amount() == 42\n')

    const build = await executor.run(commandForDriver('pytest', 'build', root, settings).argv, root, { timeoutMs: 30_000 })
    expect(build.exitCode).toBe(0)
    const passingTests = await executor.run(commandForDriver('pytest', 'test', root, settings).argv, root, { timeoutMs: 30_000 })
    expect(passingTests.exitCode).toBe(0)
    expect(`${passingTests.stdout}\n${passingTests.stderr}`).toContain('1 passed')

    writeFileSync(join(root, 'syntax_error.py'), 'def broken(:\n    return None\n')
    const failedBuild = await executor.run(commandForDriver('pytest', 'build', root, settings).argv, root, { timeoutMs: 30_000 })
    expect(failedBuild.exitCode).not.toBe(0)
    rmSync(join(root, 'syntax_error.py'))

    writeFileSync(testFile, 'from rules import amount\n\ndef test_amount():\n    assert amount() == 0\n')
    const failedTests = await executor.run(commandForDriver('pytest', 'test', root, settings).argv, root, { timeoutMs: 30_000 })
    expect(failedTests.exitCode).toBe(1)
    expect(`${failedTests.stdout}\n${failedTests.stderr}`).toContain('1 failed')
  })
})
