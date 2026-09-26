/** Safe argv-based command execution through Harness's subprocess seam. */

import { spawn as nodeSpawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Output channel exposed by a bounded command execution. */
export type CommandOutputStream = 'stdout' | 'stderr'

/** Optional bounds and live-output observer for one command invocation. */
export interface CommandRunOptions {
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly maxOutputBytes?: number
  readonly onOutput?: ((stream: CommandOutputStream, text: string) => void) | undefined
}

/** Bounded result captured from one argv-based command execution. */
export interface CommandResult {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly durationMs: number
}

/** Execution seam used by Git, Drivers, and Provider adapters. */
export interface CommandExecutor {
  run(argv: readonly string[], cwd: string, options?: CommandRunOptions): Promise<CommandResult>
}

/** Uses the Harness process-range owner when one is available. */
export class HarnessCommandExecutor implements CommandExecutor {
  constructor(private readonly subprocess?: SubprocessRuntime) {}

  async run(argv: readonly string[], cwd: string, options: CommandRunOptions = {}): Promise<CommandResult> {
    if (argv.length === 0 || argv[0] === undefined || argv[0].length === 0) {
      throw new TypeError('command argv must contain a non-empty executable')
    }
    options.signal?.throwIfAborted()
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(argv[0])) {
      throw new TypeError('Windows batch wrappers cannot run without a shell; configure a directly executable binary or JavaScript CLI')
    }
    if (this.subprocess !== undefined) {
      return this.runWithHarness(this.subprocess, argv, cwd, options)
    }
    return runWithNode(argv, cwd, options)
  }

  private async runWithHarness(
    subprocess: SubprocessRuntime,
    argv: readonly string[],
    cwd: string,
    options: CommandRunOptions,
  ): Promise<CommandResult> {
    const started = Date.now()
    const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024
    const timeout = options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)
    const signal = combineSignals(options.signal, timeout)
    const handle: SubprocessHandle = subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
      graceMs: 2_000,
      signal,
      env: options.env,
    })
    let timedOut = false
    const output = createOutputCollector(options.onOutput, maxOutputBytes)
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    handle.stdout?.on('data', chunk => output.append('stdout', stdoutDecoder.write(Buffer.from(chunk as Uint8Array))))
    handle.stderr?.on('data', chunk => output.append('stderr', stderrDecoder.write(Buffer.from(chunk as Uint8Array))))
    const timeoutListener = (): void => {
      timedOut = options.timeoutMs !== undefined && timeout?.aborted === true
      handle.terminate()
    }
    signal?.addEventListener('abort', timeoutListener, { once: true })
    try {
      const outcome = await handle.done
      await handle.waitForExit()
      output.append('stdout', stdoutDecoder.end())
      output.append('stderr', stderrDecoder.end())
      return {
        argv,
        cwd,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: output.stdout || readCollected(handle.collected.stdout),
        stderr: output.stderr || readCollected(handle.collected.stderr),
        timedOut,
        durationMs: Date.now() - started,
      }
    } finally {
      signal?.removeEventListener('abort', timeoutListener)
    }
  }
}

function readCollected(reader: { readFrom(offset: number): { text: string } } | undefined): string {
  return reader?.readFrom(0).text ?? ''
}

interface CommandOutputCollector {
  append(stream: CommandOutputStream, text: string): void
  readonly stdout: string
  readonly stderr: string
}

function createOutputCollector(
  onOutput: CommandRunOptions['onOutput'],
  maxOutputBytes: number,
): CommandOutputCollector {
  let stdout = ''
  let stderr = ''
  const append = (stream: CommandOutputStream, text: string): void => {
    if (text.length === 0) return
    if (stream === 'stdout') stdout = tail(stdout + text, maxOutputBytes)
    else stderr = tail(stderr + text, maxOutputBytes)
    try {
      onOutput?.(stream, text)
    } catch {
      // Progress observers are non-authoritative and cannot fail a command.
    }
  }
  return {
    append,
    get stdout() { return stdout },
    get stderr() { return stderr },
  }
}

async function runWithNode(
  argv: readonly string[],
  cwd: string,
  options: {
    readonly signal?: AbortSignal | undefined
    readonly timeoutMs?: number
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly maxOutputBytes?: number
    readonly onOutput?: ((stream: CommandOutputStream, text: string) => void) | undefined
  },
): Promise<CommandResult> {
  const started = Date.now()
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024
  const child = nodeSpawn(argv[0] as string, argv.slice(1), {
    cwd,
    shell: false,
    windowsHide: true,
    env: options.env === undefined ? undefined : mergeEnv(options.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = createOutputCollector(options.onOutput, maxOutputBytes)
  let timedOut = false
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  child.stdout?.on('data', chunk => output.append('stdout', stdoutDecoder.write(Buffer.from(chunk as Uint8Array))))
  child.stderr?.on('data', chunk => output.append('stderr', stderrDecoder.write(Buffer.from(chunk as Uint8Array))))
  const timeout = options.timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true
    child.kill()
  }, options.timeoutMs)
  const abort = (): void => { child.kill() }
  options.signal?.addEventListener('abort', abort, { once: true })
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  })
  output.append('stdout', stdoutDecoder.end())
  output.append('stderr', stderrDecoder.end())
  return {
    argv,
    cwd,
    exitCode: outcome.code,
    signal: outcome.signal,
    stdout: output.stdout,
    stderr: output.stderr,
    timedOut,
    durationMs: Date.now() - started,
  }
}

function tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) return value
  return bytes.subarray(bytes.byteLength - maxBytes).toString('utf8')
}

function mergeEnv(overrides: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) Reflect.deleteProperty(env, key)
    else env[key] = value
  }
  return env
}

function combineSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  return AbortSignal.any(active)
}

/** Kept exported for tests that feed a stream-like mock to the collector. */
export type CommandReadable = Readable
