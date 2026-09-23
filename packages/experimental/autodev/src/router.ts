/** Dynamic, capability-aware Coding Agent routing with Jev assistance. */

import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type {
  ProviderInfo,
  ProviderRunRequest,
  ProviderRunResult,
  RouteCandidate,
  RouteDecision,
  RoutePolicy,
} from './contracts.ts'
import type { AgentAdapter, AgentAdapterRequest, AgentResult } from './protocol.ts'
import { HarnessCommandExecutor, type CommandExecutor } from './command.ts'
import { answerOf, DecisionCoordinator, questionsFor, replaceQuestionChoices } from './jev.ts'
import type { AutoDevStore } from './store.ts'

export interface CustomProvider {
  readonly name: string
  readonly kind: 'command' | 'model' | 'subagent'
  readonly traits: readonly string[]
  readonly isAvailable?: () => boolean | Promise<boolean>
  run(request: ProviderRunRequest): Promise<ProviderRunResult>
}

/**
 * Adapter options for CLI-backed providers such as CodeBuddy or Ollama.
 * The adapter still runs through AutoDev's bounded argv executor; it never
 * interpolates a shell string and it receives only the active Worktree cwd.
 */
export interface CommandProviderOptions {
  readonly name: string
  readonly executable: string
  readonly args: readonly string[] | ((request: ProviderRunRequest) => readonly string[])
  readonly traits: readonly string[]
  readonly isAvailable?: () => boolean | Promise<boolean>
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly executor?: CommandExecutor
}

export function commandProvider(options: CommandProviderOptions): CustomProvider {
  const executor = options.executor ?? new HarnessCommandExecutor()
  return {
    name: options.name,
    kind: 'command',
    traits: options.traits,
    ...(options.isAvailable === undefined ? {} : { isAvailable: options.isAvailable }),
    async run(request) {
      const args = typeof options.args === 'function' ? options.args(request) : options.args
      const result = await executor.run([options.executable, ...args], request.cwd, {
        signal: request.signal,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
        ...(options.env === undefined ? {} : { env: options.env }),
      })
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
      if (request.signal.aborted || result.signal !== null) {
        return { provider: request.provider, status: 'aborted', output, diagnostic: 'command provider was aborted' }
      }
      if (result.timedOut || result.exitCode !== 0) {
        return {
          provider: request.provider,
          status: 'error',
          output,
          diagnostic: result.timedOut ? 'command provider timed out' : `command provider exited ${String(result.exitCode)}`,
        }
      }
      return { provider: request.provider, status: 'completed', output }
    },
  }
}

export interface RouteSelection {
  readonly candidate?: RouteCandidate
  readonly decision: RouteDecision
}

export interface ProviderRouterOptions {
  readonly routes?: Readonly<Record<string, RoutePolicy>> | undefined
  readonly subagents?: SubagentRuntime | undefined
  readonly decisions: DecisionCoordinator
  readonly store?: AutoDevStore | undefined
}

const DEFAULT_ROUTES: Readonly<Record<string, RoutePolicy>> = {
  implement: {
    candidates: [
      { kind: 'subagent', provider: 'codex', traits: ['code-edit', 'local-workspace'] },
      { kind: 'subagent', provider: 'claude-code', traits: ['code-edit', 'local-workspace'] },
      { kind: 'subagent', provider: 'spawn', traits: ['code-edit', 'local-workspace'] },
    ],
    requiredTaskTraits: ['code-edit', 'local-workspace'],
    minConfidence: 0.55,
  },
  review: {
    candidates: [
      { kind: 'subagent', provider: 'claude-code', traits: ['read-only'] },
      { kind: 'subagent', provider: 'codex', traits: ['read-only'] },
    ],
    requiredTaskTraits: ['read-only'],
    minConfidence: 0.55,
  },
}

/** Registry-backed route selector. Registering a future provider does not change this class. */
export class ProviderRouter {
  private readonly routes: Record<string, RoutePolicy>
  private readonly custom = new Map<string, CustomProvider>()
  private readonly decisions: DecisionCoordinator
  private readonly store: AutoDevStore | undefined
  private readonly subagents: SubagentRuntime | undefined

  constructor(options: ProviderRouterOptions) {
    this.routes = { ...DEFAULT_ROUTES, ...(options.routes ?? {}) }
    this.decisions = options.decisions
    this.store = options.store
    this.subagents = options.subagents
  }

  register(provider: CustomProvider): () => void {
    if (this.custom.has(provider.name)) throw new Error(`AutoDev provider "${provider.name}" is already registered`)
    this.custom.set(provider.name, provider)
    return () => { this.custom.delete(provider.name) }
  }

  list(): readonly ProviderInfo[] {
    const names = new Map<string, Omit<ProviderInfo, 'name'>>()
    for (const name of this.subagents?.list() ?? []) {
      names.set(name, { kind: 'subagent', available: true, traits: ['unknown'] })
    }
    for (const provider of this.custom.values()) {
      // `list()` is intentionally synchronous for tool/UI callers. Async health checks
      // are authoritative in `select()`; here we report an optimistic registration
      // state instead of incorrectly treating a Promise as `false`.
      const available = true
      names.set(provider.name, { kind: provider.kind, available, traits: provider.traits })
    }
    return [...names.entries()].map(([name, value]) => ({ name, ...value }))
  }

  policy(name: string): RoutePolicy | undefined {
    return this.routes[name]
  }

  /** Add a route without rebuilding the Host; the disposer restores the prior absence. */
  registerRoute(name: string, policy: RoutePolicy): () => void {
    if (name.trim() === '') throw new TypeError('AutoDev route name must be non-empty')
    if (this.routes[name] !== undefined) throw new Error(`AutoDev route "${name}" is already registered`)
    this.routes[name] = policy
    return () => {
      if (this.routes[name] === policy) Reflect.deleteProperty(this.routes, name)
    }
  }

  /** Return a detached route catalog suitable for a Remote or tool response. */
  listRoutes(): Readonly<Record<string, RoutePolicy>> {
    return { ...this.routes }
  }

  async select(
    runId: string | undefined,
    nodeId: string | undefined,
    purpose: 'agent-route',
    routeName: string,
    state: unknown,
    requiredTraits: readonly string[] = [],
    signal: AbortSignal,
  ): Promise<RouteSelection> {
    const policy = this.routes[routeName]
    if (policy === undefined) throw new Error(`AutoDev route "${routeName}" is not configured`)
    const required = [...new Set([...(policy.requiredTaskTraits ?? []), ...requiredTraits])]
    const rejections: { provider: string; reason: string }[] = []
    const eligible: RouteCandidate[] = []
    for (const candidate of policy.candidates) {
      if (candidate.enabled === false) {
        rejections.push({ provider: candidate.provider, reason: 'disabled by route configuration' })
        continue
      }
      if (!hasTraits(candidate.traits ?? [], required)) {
        rejections.push({ provider: candidate.provider, reason: `missing required traits: ${required.join(', ')}` })
        continue
      }
      let available = false
      try {
        available = await this.isAvailable(candidate)
      } catch {
        available = false
      }
      if (!available) {
        rejections.push({ provider: candidate.provider, reason: 'provider is not installed or loaded' })
        continue
      }
      eligible.push(candidate)
    }

    let selected: RouteCandidate | undefined
    let confidence: number | undefined
    let reason = 'no eligible provider'
    if (eligible.length > 0) {
      const questions = replaceQuestionChoices(questionsFor(purpose), eligible.map(item => item.provider))
      const decision = await this.decisions.evaluate(purpose, {
        ...asRecord(state),
        eligibleProviders: eligible.map(item => item.provider),
      }, signal, questions)
      const answer = answerOf(decision, 'provider')
      confidence = answer?.probability
      const requested = typeof answer?.value === 'string' ? answer.value : undefined
      selected = eligible.find(item => item.provider === requested)
      const threshold = policy.minConfidence ?? 0
      if (selected === undefined || (confidence !== undefined && confidence < threshold)) {
        selected = eligible[0]
        reason = selected === undefined
          ? 'Jev did not choose an eligible provider'
          : `Jev choice was invalid or below confidence ${threshold}; deterministic first eligible provider used`
      } else {
        reason = `Jev selected ${selected.provider}`
      }
    }
    const decision: RouteDecision = {
      id: cryptoRandomId(),
      ...(runId === undefined ? {} : { runId }),
      ...(nodeId === undefined ? {} : { nodeId }),
      policyVersion: 'autodev.routes.v1',
      purpose,
      candidates: policy.candidates,
      eligible,
      ...(selected === undefined ? {} : { selected }),
      ...(confidence === undefined ? {} : { confidence }),
      reason,
      rejections,
      createdAt: new Date().toISOString(),
    }
    this.store?.saveRouteDecision(decision)
    return { ...(selected === undefined ? {} : { candidate: selected }), decision }
  }

  async invoke(candidate: RouteCandidate, request: Omit<ProviderRunRequest, 'provider' | 'model'>): Promise<ProviderRunResult> {
    const custom = this.custom.get(candidate.provider)
    if (custom !== undefined) {
      return custom.run({ ...request, provider: candidate.provider, ...(candidate.model === undefined ? {} : { model: candidate.model }) })
    }
    if (candidate.kind !== 'subagent' || this.subagents === undefined) {
      return {
        provider: candidate.provider,
        status: 'error',
        output: '',
        diagnostic: `provider ${candidate.provider} has no loaded AutoDev adapter`,
      }
    }
    if (request.parentAgent === undefined) {
      return {
        provider: candidate.provider,
        status: 'error',
        output: '',
        diagnostic: 'official Harness subagent providers require a live parent Agent; invoke AutoDev from a model tool or continue it from a live Session',
      }
    }
    const run = await this.subagents.start(candidate.provider, {
      label: `AutoDev: ${request.request.slice(0, 120)}`,
      prompt: [{ type: 'text', text: buildPrompt(request) }] as never,
      parent: request.parentAgent as never,
      signal: request.signal,
      ...(candidate.model === undefined ? {} : { agentOptions: { model: candidate.model } as never }),
    })
    try {
      const result = await run.result
      return {
        provider: candidate.provider,
        status: result.stopReason === 'completed' ? 'completed' : result.stopReason === 'aborted' ? 'aborted' : 'error',
        output: textFromBlocks(result.output),
        ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
      }
    } finally {
      await run.dispose()
    }
  }

  /** Adapt one selected dynamic route to the normalized Agent Protocol. */
  agentAdapter(candidate: RouteCandidate): AgentAdapter {
    return {
      name: candidate.provider,
      kind: candidate.kind,
      capabilities: {
        traits: candidate.traits ?? [],
        taskKinds: ['implement', 'review', 'analyze', 'verify', 'custom'],
        workspace: 'isolated',
        supportsCancellation: true,
        supportsSignals: true,
      },
      isAvailable: () => this.isAvailable(candidate),
      execute: async (request: AgentAdapterRequest): Promise<AgentResult> => {
        const result = await this.invoke(candidate, {
          request: request.task.instruction,
          acceptanceCriteria: request.task.acceptanceCriteria,
          cwd: request.context.workspacePath,
          signal: request.signal,
          parentAgent: request.parentAgent,
          task: request.task,
          context: request.context,
          emitSignal: request.emitSignal,
        })
        return {
          provider: result.provider,
          status: result.status,
          output: result.output,
          ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
          ...(result.signals === undefined ? {} : { signals: result.signals }),
        }
      },
    }
  }

  private async isAvailable(candidate: RouteCandidate): Promise<boolean> {
    const custom = this.custom.get(candidate.provider)
    if (custom !== undefined) return custom.isAvailable === undefined ? true : await custom.isAvailable()
    return candidate.kind === 'subagent' && this.subagents?.list().includes(candidate.provider) === true
  }
}

function hasTraits(actual: readonly string[], required: readonly string[]): boolean {
  if (required.length === 0 || actual.includes('unknown')) return true
  return required.every(item => actual.includes(item))
}

function buildPrompt(request: Omit<ProviderRunRequest, 'provider' | 'model'>): string {
  const criteria = request.acceptanceCriteria.length === 0
    ? '(no extra acceptance criteria)'
    : request.acceptanceCriteria.map(item => `- ${item}`).join('\n')
  return [
    'You are the implementation Agent inside a DeepSeek Harness AutoDev run.',
    'Work only inside the supplied current working directory. Do not modify the parent checkout, credentials, or unrelated directories.',
    'Inspect the repository before editing. Make the smallest complete change that satisfies the request.',
    'Do not claim completion without making the files change when a code change is required.',
    '',
    `Request:\n${request.request}`,
    `Acceptance criteria:\n${criteria}`,
    '',
    `Project memory references (summaries only; retrieve details when needed): ${(request.context?.memoryRefs ?? []).join(', ') || '(none)'}`,
    `Advisory Playbook references (fit is not truth): ${(request.context?.playbookRefs ?? []).join(', ') || '(none)'}`,
    '',
    `Working directory: ${request.cwd}`,
  ].join('\n')
}

function textFromBlocks(blocks: readonly unknown[]): string {
  return blocks.map((block) => {
    if (typeof block !== 'object' || block === null) return ''
    const value = block as { type?: unknown; text?: unknown }
    return value.type === 'text' && typeof value.text === 'string' ? value.text : ''
  }).join('')
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : { value }
}

function cryptoRandomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}
