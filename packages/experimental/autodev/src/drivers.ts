/** Deterministic argv-based Build/Test driver detection and command selection. */

import { existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import type { BuildDriverId, DriverCommandSettings, MavenConfig } from './contracts.ts'

/** Deterministic repository validation stage supported by a Driver. */
export type BuildTestStage = 'build' | 'test'

/** Shell-free executable and argv selected for one validation stage. */
export interface DriverCommand {
  readonly driverId: BuildDriverId
  readonly stage: BuildTestStage
  readonly argv: readonly string[]
}

/** Per-Driver command overrides accepted by the command resolver. */
export type DriverSettings = Partial<Record<BuildDriverId, DriverCommandSettings>> & {
  readonly maven?: MavenConfig
}

/** Detect supported Drivers from recognized repository-root markers only.
 * Nested workspaces are ignored and require an explicit project-root configuration.
 * @param root - Repository root to inspect.
 * @returns Detected Build/Test Driver IDs in stable preference order.
 */
export function detectBuildDrivers(root: string): readonly BuildDriverId[] {
  const found: BuildDriverId[] = []
  if (existsSync(join(root, 'pom.xml'))) found.push('maven')
  if (['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].some(file => existsSync(join(root, file)))) found.push('gradle')
  if (existsSync(join(root, 'package.json'))) found.push('node')
  if (hasPytestMarker(root)) found.push('pytest')
  return found
}

/** Require a unique detected Driver for auto-selection; explicit choices are honored
 * even for greenfield repositories where the project files will be created in the Worktree.
 * @param root - Repository root whose markers determine the available Drivers.
 * @param requested - Explicit Driver ID, or `auto` to require unambiguous detection.
 * @returns The selected deterministic Build/Test Driver.
 */
export function selectBuildDriver(root: string, requested: BuildDriverId | 'auto' | undefined = 'auto'): BuildDriverId {
  const detected = detectBuildDrivers(root)
  if (requested !== undefined && requested !== 'auto') {
    return requested
  }
  if (detected.length === 1) return detected[0] as BuildDriverId
  if (detected.length === 0) throw new Error('no supported root Build/Test driver was detected (expected pom.xml, Gradle root files, package.json, or a pytest configuration); choose a supported driver and configure its project root')
  throw new Error(`multiple root Build/Test drivers were detected (${detected.join(', ')}); set buildDriver on the Run or AutoDev configuration`)
}

/** Resolve a shell-free argv vector for one Driver stage.
 * @param driverId - Driver whose command contract is selected.
 * @param stage - Whether the command performs Build or Test validation.
 * @param root - Repository root used for wrapper and package-manager detection.
 * @param settings - Optional executable and argv overrides.
 * @returns The selected Driver ID, stage, and executable argv vector.
 */
export function commandForDriver(
  driverId: BuildDriverId,
  stage: BuildTestStage,
  root: string,
  settings: DriverSettings = {},
): DriverCommand {
  const configured = driverId === 'maven' ? settings.maven : settings[driverId]
  const configuredArgs = stage === 'build' ? configured?.buildArgs : configured?.testArgs
  const args = configuredArgs === undefined ? defaults(driverId, stage, root) : validateArgs(configuredArgs, `${driverId} ${stage} args`)
  if (process.platform === 'win32' && configured?.executable === undefined && (driverId === 'maven' || driverId === 'gradle')) {
    return windowsJavaWrapperCommand(driverId, stage, root, args)
  }
  if (driverId === 'node' && configured?.executable === undefined && process.platform === 'win32') {
    const manager = nodePackageManager(root)
    return { driverId, stage, argv: manager === 'bun'
      ? ['bun.exe', ...args]
      : [process.execPath, resolveNodeManagerCli(manager, root), ...args] }
  }
  const executable = validateExecutable(configured?.executable ?? defaultExecutable(driverId, root), `${driverId} executable`)
  return { driverId, stage, argv: [executable, ...args] }
}

function windowsJavaWrapperCommand(
  driverId: 'maven' | 'gradle',
  stage: BuildTestStage,
  root: string,
  args: readonly string[],
): DriverCommand {
  const wrapperJar = driverId === 'maven'
    ? join(root, '.mvn', 'wrapper', 'maven-wrapper.jar')
    : join(root, 'gradle', 'wrapper', 'gradle-wrapper.jar')
  if (!existsSync(wrapperJar)) {
    const wrapperScript = driverId === 'maven' ? join(root, 'mvnw.cmd') : join(root, 'gradlew.bat')
    const detail = existsSync(wrapperScript)
      ? `the ${driverId} batch wrapper exists but its supported Wrapper JAR is missing`
      : `no ${driverId} Wrapper JAR was found`
    throw new Error(`Windows ${driverId} execution requires ${wrapperJar}; ${detail}. Batch wrappers are never launched through a shell. Configure a directly executable binary if available.`)
  }
  const java = resolveJavaExecutable()
  const argv = driverId === 'maven'
    ? [java, '-classpath', wrapperJar, `-Dmaven.multiModuleProjectDirectory=${resolve(root)}`, 'org.apache.maven.wrapper.MavenWrapperMain', ...args]
    : [java, '-Dorg.gradle.appname=gradlew', '-jar', wrapperJar, ...args]
  return { driverId, stage, argv }
}

function resolveJavaExecutable(): string {
  const javaHome = process.env.JAVA_HOME?.trim()
  if (javaHome !== undefined && javaHome !== '') {
    const java = join(javaHome.replace(/^"|"$/gu, ''), 'bin', 'java.exe')
    if (!existsSync(java)) throw new Error(`JAVA_HOME does not contain a directly executable Windows Java runtime at ${java}`)
    return java
  }
  return 'java.exe'
}

/** Windows cannot CreateProcess a .cmd shim with shell:false. Resolve the installed
 * package manager's JavaScript entry instead of interpreting a shell command.
 */
function resolveNodeManagerCli(manager: 'pnpm' | 'yarn' | 'npm', root: string): string {
  const entries = manager === 'npm' ? ['npm/bin/npm-cli.js']
    : manager === 'pnpm' ? ['pnpm/bin/pnpm.cjs', 'pnpm/bin/pnpm.mjs']
      : ['yarn/bin/yarn.js', 'yarn/bin/yarn.cjs']
  const roots = [root, dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)]
  for (const start of roots) {
    let directory = resolve(start)
    for (let depth = 0; depth < 5; depth++) {
      for (const entry of entries) {
        for (const prefix of ['node_modules', join('node', 'node_modules')]) {
          const path = join(directory, prefix, entry)
          if (existsSync(path)) return path
        }
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  throw new Error(`cannot find the ${manager} JavaScript CLI on Windows; install it alongside Node or configure a directly executable node.executable`)
}

function defaults(driverId: BuildDriverId, stage: BuildTestStage, root: string): readonly string[] {
  switch (driverId) {
    case 'maven': return stage === 'build' ? ['-q', '-DskipTests', 'package'] : ['-q', 'test']
    case 'gradle': return stage === 'build' ? ['build', '-x', 'test'] : ['test']
    case 'node': {
      const manager = nodePackageManager(root)
      return manager === 'yarn'
        ? ['run', ...(stage === 'build' ? ['build'] : ['test'])]
        : manager === 'bun'
          ? ['run', ...(stage === 'build' ? ['build'] : ['test'])]
          : stage === 'build' ? ['run', 'build'] : ['test']
    }
    case 'pytest': return stage === 'build' ? ['-m', 'compileall', '-q', '.'] : ['-m', 'pytest', '-q']
  }
}

function defaultExecutable(driverId: BuildDriverId, root: string): string {
  const windows = process.platform === 'win32'
  switch (driverId) {
    case 'maven':
      if (windows && existsSync(join(root, 'mvnw.cmd'))) return 'mvnw.cmd'
      if (!windows && existsSync(join(root, 'mvnw'))) return './mvnw'
      return 'mvn'
    case 'gradle':
      if (windows && existsSync(join(root, 'gradlew.bat'))) return 'gradlew.bat'
      if (!windows && existsSync(join(root, 'gradlew'))) return './gradlew'
      return windows ? 'gradle.bat' : 'gradle'
    case 'node': {
      const manager = nodePackageManager(root)
      return windows ? `${manager}.cmd` : manager
    }
    case 'pytest': return windows ? 'python.exe' : 'python3'
  }
}

function nodePackageManager(root: string): 'pnpm' | 'yarn' | 'npm' | 'bun' {
  const detected = [
    ...(existsSync(join(root, 'pnpm-lock.yaml')) ? ['pnpm'] as const : []),
    ...(existsSync(join(root, 'yarn.lock')) ? ['yarn'] as const : []),
    ...(existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb')) ? ['bun'] as const : []),
    ...(existsSync(join(root, 'package-lock.json')) || existsSync(join(root, 'npm-shrinkwrap.json')) ? ['npm'] as const : []),
  ]
  if (detected.length > 1) throw new Error(`multiple Node package-manager lockfiles were detected (${detected.join(', ')}); remove stale lockfiles or configure one executable and both stage argument arrays`)
  return detected[0] ?? 'npm'
}

function hasPytestMarker(root: string): boolean {
  if (existsSync(join(root, 'pytest.ini'))) return true
  for (const [file, marker] of [['pyproject.toml', '[tool.pytest.ini_options]'], ['setup.cfg', '[tool:pytest]']] as const) {
    const path = join(root, file)
    if (existsSync(path)) {
      try {
        if (readFileSync(path, 'utf8').includes(marker)) return true
      } catch {
        return false
      }
    }
  }
  return false
}

function validateExecutable(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512 || value.includes('\0')) {
    throw new TypeError(`${label} must be a non-empty bounded executable name`)
  }
  return value.trim()
}

function validateArgs(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values) || values.length > 128 || values.some(item => typeof item !== 'string' || item.length > 8192 || item.includes('\0'))) {
    throw new TypeError(`${label} must be an argv array of at most 128 bounded strings`)
  }
  return [...values]
}
