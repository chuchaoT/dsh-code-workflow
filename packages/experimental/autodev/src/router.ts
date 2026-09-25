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

/** A dynamically registered provider normalized to AutoDev's run contract. */
export interface CustomProvider {
  readonly name: string
  readonly kind: 'command' | 'model' | 'subagent'
  readonly traits: readonly string[]
  /** Set to true only when `run()` honors the caller's `request.cwd` for every workspace operation. */
  readonly workspaceCwd?: boolean
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

/** Adapt an external CLI to the provider contract using bounded argv execution.
 * @param options Executable, arguments, capability traits, and execution bounds.
 * @returns A provider registration compatible with {@link ProviderRouter}.
 */
export function commandProvider(options: CommandProviderOptions): CustomProvider {
  const executor = options.executor ?? new HarnessCommandExecutor()
  return {
    name: options.name,
    kind: 'command',
    traits: [...new Set([...options.traits, 'worktree-cwd'])],
    workspaceCwd: true,
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
      if (request.signal.aborted) {
        return { provider: request.provider, status: 'aborted', output, diagnostic: 'command provider was aborted' }
      }
      if (result.timedOut) {
        return {
          provider: request.provider,
          status: 'error',
          output,
          diagnostic: 'command provider timed out',
        }
      }
      if (result.signal !== null) {
        return { provider: request.provider, status: 'aborted', output, diagnostic: 'command provider was aborted' }
      }
      if (result.exitCode !== 0) {
        return { provider: request.provider, status: 'error', output, diagnostic: `command provider exited ${String(result.exitCode)}` }
      }
      return { provider: request.provider, status: 'completed', output }
    },
  }
}

/** Provider choice together with the auditable routing decision. */
export interface RouteSelection {
  readonly candidate?: RouteCandidate
  readonly decision: RouteDecision
}

/** Dependencies and initial route policies for a provider router. */
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

  /** Register a custom provider and return a disposer that unregisters it.
   * @param provider Provider adapter to add.
   * @returns Idempotent cleanup callback.
   */
  register(provider: CustomProvider): () => void {
    if (this.custom.has(provider.name)) throw new Error(`AutoDev provider "${provider.name}" is already registered`)
    this.custom.set(provider.name, provider)
    return () => {
      if (this.custom.get(provider.name) === provider) this.custom.delete(provider.name)
    }
  }

  /** List loaded subagents and dynamically registered providers.
   * @returns Provider names, kinds, availability, and declared traits.
   */
  list(): readonly ProviderInfo[] {
    const names = new Map<string, Omit<ProviderInfo, 'name'>>()
    for (const name of this.subagents?.list() ?? []) {
      const supportsWorkspaceCwd = this.subagents?.getProvider(name)?.capabilities.workspaceCwd === true
      names.set(name, {
        kind: 'subagent',
        available: supportsWorkspaceCwd,
        traits: supportsWorkspaceCwd ? ['unknown', 'worktree-cwd'] : ['unknown'],
      })
    }
    for (const provider of this.custom.values()) {
      // `list()` is intentionally synchronous for tool/UI callers. Async health checks
      // are authoritative in `select()`; here we report an optimistic registration
      // state instead of incorrectly treating a Promise as `false`. Workspace
      // support is different: it is a synchronous safety precondition.
      const supportsWorkspaceCwd = provider.workspaceCwd === true
      names.set(provider.name, {
        kind: provider.kind,
        available: supportsWorkspaceCwd,
        traits: customProviderTraits(provider),
      })
    }
    return [...names.entries()].map(([name, value]) => ({ name, ...value }))
  }

  /** Read the policy associated with one route name.
   * @param name Route identifier.
   * @returns Route policy, or undefined when it is not registered.
   */
  policy(name: string): RoutePolicy | undefined {
    return this.routes[name]
  }

  /** Add a route without rebuilding the Host; the disposer restores the prior absence.
   * @param name Unique route identifier.
   * @param policy Candidate ordering, required traits, and confidence threshold.
   * @returns Cleanup callback that removes this exact policy if it is still current.
   */
  registerRoute(name: string, policy: RoutePolicy): () => void {
    if (name.trim() === '') throw new TypeError('AutoDev route name must be non-empty')
    if (this.routes[name] !== undefined) throw new Error(`AutoDev route "${name}" is already registered`)
    this.routes[name] = policy
    return () => {
      if (this.routes[name] === policy) Reflect.deleteProperty(this.routes, name)
    }
  }

  /** Add one reversible Provider candidate to an existing route policy.
   * @param routeName Existing route identifier, such as the default `implement` route.
   * @param candidate Provider name, adapter kind, and declared traits to append.
   * @returns Idempotent cleanup callback that removes only this registered candidate.
   */
  registerCandidate(routeName: string, candidate: RouteCandidate): () => void {
    const name = requireText(routeName, 'AutoDev route name')
    const route = this.routes[name]
    if (route === undefined) throw new Error(`AutoDev route "${name}" is not registered`)
    const provider = requireText(candidate.provider, 'AutoDev provider name')
    if (route.candidates.some(item => item.provider === provider)) {
      throw new Error(`AutoDev provider "${provider}" is already a candidate for route "${name}"`)
    }
    const registered: RouteCandidate = {
      ...candidate,
      provider,
      ...(candidate.traits === undefined ? {} : { traits: [...candidate.traits] }),
    }
    this.routes[name] = { ...route, candidates: [...route.candidates, registered] }
    return () => {
      const current = this.routes[name]
      if (current === undefined) return
      const candidates = current.candidates.filter(item => item !== registered)
      if (candidates.length !== current.candidates.length) this.routes[name] = { ...current, candidates }
    }
  }

  /** Return a detached route catalog suitable for a Remote or tool response.
   * @returns A shallow copy of the registered route policies.
   */
  listRoutes(): Readonly<Record<string, RoutePolicy>> {
    return { ...this.routes }
  }

  /** Select an available provider using Jev while recording rejections and rationale.
   * @param runId Optional AutoDev Run identifier for decision persistence.
   * @param nodeId Optional plan-node identifier.
   * @param purpose Decision purpose supported by this router.
   * @param routeName Route whose policy will be evaluated.
   * @param state Decision context supplied to Jev.
   * @param requiredTraits Additional capabilities required by the task.
   * @param signal Cancellation signal for the decision.
   * @returns Selected candidate, when any, and the complete routing decision.
   */
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

  /** Execute a selected provider using its custom adapter or official subagent runtime.
   * @param candidate Selected provider and optional model.
   * @param request Normalized task, isolated cwd, cancellation, and Agent context.
   * @returns Provider outcome; adapter failures are represented as error results.
   */
  async invoke(candidate: RouteCandidate, request: Omit<ProviderRunRequest, 'provider' | 'model'>): Promise<ProviderRunResult> {
    const custom = this.custom.get(candidate.provider)
    if (custom !== undefined) {
      if (custom.workspaceCwd !== true) {
        return {
          provider: candidate.provider,
          status: 'error',
          output: '',
          diagnostic: `provider ${candidate.provider} cannot honor AutoDev's per-run Worktree cwd`,
        }
      }
      if (custom.kind !== candidate.kind || !coversDeclaredTraits(customProviderTraits(custom), candidate.traits ?? [])) {
        return {
          provider: candidate.provider,
          status: 'error',
          output: '',
          diagnostic: `provider ${candidate.provider} does not satisfy its route candidate declaration`,
        }
      }
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
    const loadedSubagent = this.subagents.getProvider(candidate.provider)
    if (loadedSubagent?.capabilities.workspaceCwd !== true) {
      return {
        provider: candidate.provider,
        status: 'error',
        output: '',
        diagnostic: `provider ${candidate.provider} cannot honor AutoDev's per-run Worktree cwd`,
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
      workspaceCwd: request.cwd,
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

  /** Adapt one selected dynamic route to the normalized Agent Protocol.
   * @param candidate Provider selected by routing policy.
   * @returns Agent adapter backed by this router's invocation path.
   */
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
    if (custom !== undefined) {
      if (
        custom.workspaceCwd !== true
        || custom.kind !== candidate.kind
        || !coversDeclaredTraits(customProviderTraits(custom), candidate.traits ?? [])
      ) return false
      return custom.isAvailable === undefined ? true : await custom.isAvailable()
    }
    return candidate.kind === 'subagent'
      && this.subagents?.getProvider(candidate.provider)?.capabilities.workspaceCwd === true
  }
}

function customProviderTraits(provider: CustomProvider): readonly string[] {
  return provider.workspaceCwd === true
    ? [...new Set([...provider.traits, 'worktree-cwd'])]
    : provider.traits
}

/** Custom adapter declarations are affirmative claims, not unknown/wildcard capabilities. */
function coversDeclaredTraits(actual: readonly string[], claimed: readonly string[]): boolean {
  return claimed.every(trait => actual.includes(trait))
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
    `Project Memory (${request.context?.contextBudget?.usedChars ?? 0}/${request.context?.contextBudget?.maxChars ?? 0} context characters; references are scoped and advisory):`,
    (request.context?.memoryCards ?? []).map(card => `- ${card}`).join('\n') || '(none)',
    `Business Concepts (versioned scoped vocabulary; status and Evidence are shown, candidates are not established facts; references=${(request.context?.conceptRefs ?? []).join(', ') || 'none'}):`,
    (request.context?.conceptCards ?? []).map(card => `- ${card}`).join('\n') || '(none)',
    `Assumptions (only CONFIRMED items with current trusted PASS Evidence are confirmed; PROPOSED, INVALIDATED, and UNKNOWN items are not facts; references=${(request.context?.assumptionRefs ?? []).join(', ') || 'none'}):`,
    (request.context?.assumptionCards ?? []).map(card => `- ${card}`).join('\n') || '(none)',
    `Semantic Uncertainty (resolved decisions are historical guidance; OPEN items require clarification; references=${(request.context?.uncertaintyRefs ?? []).join(', ') || 'none'}):`,
    (request.context?.uncertaintyCards ?? []).map(card => `- ${card}`).join('\n') || '(none)',
    `Scoped Knowledge (hot/warm/cold retrieval; candidates remain untrusted until evidence-backed promotion; references=${(request.context?.knowledgeRefs ?? []).join(', ') || 'none'}):`,
    (request.context?.knowledgeCards ?? []).map(card => `- ${card}`).join('\n') || '(none)',
    `Advisory Playbooks (fit is not truth; use only when target/effect match; references=${(request.context?.playbookRefs ?? []).join(', ') || 'none'}):`,
    (request.context?.playbookCards ?? []).map(card => `- ${card}`).join('\n') || '(none)',
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

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be non-empty`)
  return value.trim()
}
