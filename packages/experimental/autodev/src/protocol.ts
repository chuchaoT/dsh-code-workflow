/**
 * The normalized Agent Protocol used by AutoDev.
 *
 * Provider-specific transports remain behind ProviderRouter. This module only
 * defines the stable task/context/result/signal vocabulary that the runtime can
 * persist and reason about regardless of whether the provider is Codex, Claude
 * Code, a CLI, or a future local adapter.
 */

export const AGENT_PROTOCOL_VERSION = 'dsh.agent.v1' as const

export type AgentTaskKind = 'implement' | 'review' | 'analyze' | 'verify' | 'custom'

export interface AgentTask {
  readonly protocolVersion: typeof AGENT_PROTOCOL_VERSION
  readonly id: string
  readonly runId: string
  readonly planVersionId: string
  readonly nodeId: string
  readonly attempt: number
  readonly kind: AgentTaskKind
  readonly instruction: string
  readonly acceptanceCriteria: readonly string[]
  readonly workspacePath: string
  readonly createdAt: string
}

/** Structured action proposal; Runtime policy, not an Agent, authorizes it. */
export interface AgentAction {
  readonly id: string
  readonly taskId: string
  readonly kind: string
  readonly target: string
  readonly risk: 'low' | 'medium' | 'high' | 'destructive'
  readonly idempotencyKey?: string
  readonly preconditions?: readonly string[]
}

export interface AgentSession {
  readonly id: string
  readonly provider: string
  readonly taskId: string
  readonly startedAt: string
  readonly endedAt?: string
  readonly status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN' | 'ABORTED'
}

export interface AgentExecution {
  readonly id: string
  readonly sessionId: string
  readonly taskId: string
  readonly actionIds: readonly string[]
  readonly status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN' | 'ABORTED'
  readonly startedAt: string
  readonly endedAt?: string
}

/** Context is intentionally a reference card, not a transcript dump. */
export interface AgentContext {
  readonly runId: string
  readonly projectKey: string
  readonly repoRoot: string
  readonly baseCommit: string
  readonly workspacePath: string
  readonly planVersionId: string
  readonly nodeId: string
  readonly attempt: number
  readonly evidenceIds: readonly string[]
  readonly memoryRefs?: readonly string[]
  readonly playbookRefs?: readonly string[]
}

export type AgentSignal =
  | { readonly type: 'PlanProposed'; readonly summary?: string; readonly planFingerprint?: string }
  | { readonly type: 'AssumptionRaised'; readonly statement?: string; readonly confidence?: number; readonly conflictsWith?: readonly string[] }
  | { readonly type: 'SemanticUncertainty'; readonly subject?: string; readonly reason?: string; readonly alternatives?: readonly string[]; readonly assumptionIds?: readonly string[] }
  | { readonly type: 'PlaybookMatched'; readonly playbookId?: string; readonly playbookVersion?: string; readonly fit?: 'MATCH' | 'PARTIAL' }
  | { readonly type: 'PlaybookMismatch'; readonly playbookId?: string; readonly reason?: string }
  | { readonly type: 'EvidenceProduced'; readonly evidenceId?: string; readonly summary?: string; readonly status?: 'PASS' | 'FAIL' | 'WARN' | 'UNKNOWN' }
  | { readonly type: 'ExecutionBlocked'; readonly reason?: string; readonly recoverable?: boolean }
  | { readonly type: 'ReplanRequested'; readonly reason?: string }
  | { readonly type: 'HumanDecisionRequired'; readonly question?: string; readonly options?: readonly string[]; readonly risk?: string }
  | { readonly type: 'KnowledgeCandidate'; readonly subject?: string; readonly summary?: string; readonly confidence?: number }
  | { readonly type: 'VerificationFailed'; readonly checkId?: string; readonly reason?: string }
  | { readonly type: 'UnexpectedSideEffect'; readonly description?: string; readonly path?: string; readonly severity?: 'low' | 'medium' | 'high' }
  | { readonly type: 'UnknownSignal'; readonly name: string; readonly payload: AgentJsonObject }

/** Adapter input accepts future signal kinds and preserves them as UnknownSignal. */
export type AgentSignalInput = AgentSignal | { readonly type: string; readonly [key: string]: unknown }

export type AgentJsonValue = null | boolean | number | string | AgentJsonValue[] | AgentJsonObject
export interface AgentJsonObject {
  readonly [key: string]: AgentJsonValue
}

export interface AgentSignalEnvelope {
  readonly protocolVersion: typeof AGENT_PROTOCOL_VERSION
  readonly id: string
  readonly taskId: string
  readonly runId: string
  readonly nodeId: string
  readonly provider: string
  readonly sequence: number
  readonly signal: AgentSignal
  readonly createdAt: string
}

export interface AgentCapabilities {
  readonly traits: readonly string[]
  readonly taskKinds: readonly AgentTaskKind[]
  readonly workspace: 'isolated' | 'shared' | 'external'
  readonly supportsCancellation: boolean
  readonly supportsSignals: boolean
}

export interface AgentAdapterInfo {
  readonly name: string
  readonly kind: string
  readonly capabilities: AgentCapabilities
  readonly available: boolean
}

export interface AgentResult {
  readonly provider: string
  readonly status: 'completed' | 'error' | 'aborted' | 'unknown'
  readonly output: string
  readonly diagnostic?: string
  readonly artifactIds?: readonly string[]
  readonly signals?: readonly AgentSignalInput[]
}

export type AgentExecutionResult = Omit<AgentResult, 'signals'> & {
  readonly signals: readonly AgentSignalEnvelope[]
}

export interface AgentAdapterRequest {
  readonly task: AgentTask
  readonly context: AgentContext
  readonly signal: AbortSignal
  readonly parentAgent?: unknown
  readonly emitSignal: (signal: AgentSignalInput) => void
}

export interface AgentAdapter {
  readonly name: string
  readonly kind: string
  readonly capabilities: AgentCapabilities
  readonly isAvailable?: () => boolean | Promise<boolean>
  execute(request: AgentAdapterRequest): Promise<AgentResult>
}

/**
 * Protocol boundary and optional adapter registry. AutoDev currently obtains
 * adapters from ProviderRouter; the registry is public so future plugins can
 * add a native adapter without changing the Runtime.
 */
export class AgentProtocol {
  private readonly adapters = new Map<string, AgentAdapter>()

  register(adapter: AgentAdapter): () => void {
    if (adapter.name.trim() === '') throw new TypeError('Agent adapter name must be non-empty')
    if (this.adapters.has(adapter.name)) throw new Error(`Agent adapter "${adapter.name}" is already registered`)
    this.adapters.set(adapter.name, adapter)
    return () => {
      if (this.adapters.get(adapter.name) === adapter) this.adapters.delete(adapter.name)
    }
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name)
  }

  list(): readonly AgentAdapterInfo[] {
    return [...this.adapters.values()].map(adapter => ({
      name: adapter.name,
      kind: adapter.kind,
      capabilities: adapter.capabilities,
      available: true,
    }))
  }

  async execute(
    adapterOrName: AgentAdapter | string,
    request: Omit<AgentAdapterRequest, 'emitSignal'>,
  ): Promise<AgentExecutionResult> {
    const adapter = typeof adapterOrName === 'string' ? this.adapters.get(adapterOrName) : adapterOrName
    if (adapter === undefined) throw new Error(`no Agent Protocol adapter named "${String(adapterOrName)}"`)
    if (request.task.protocolVersion !== AGENT_PROTOCOL_VERSION) {
      throw new Error(`unsupported Agent Protocol version ${request.task.protocolVersion}`)
    }
    if (request.signal.aborted) throw new Error('Agent Protocol request was aborted before execution')

    const emitted: AgentSignalInput[] = []
    const result = await adapter.execute({
      ...request,
      emitSignal: (signal) => { emitted.push(signal) },
    })
    const normalized = normalizeResult(adapter.name, result)
    const rawSignals = [...emitted, ...(result.signals ?? [])]
    const signals = rawSignals.map((signal, index) => ({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      id: protocolId(),
      taskId: request.task.id,
      runId: request.task.runId,
      nodeId: request.task.nodeId,
      provider: normalized.provider,
      sequence: index + 1,
      signal: normalizeSignal(signal),
      createdAt: new Date().toISOString(),
    } satisfies AgentSignalEnvelope))
    return { ...normalized, signals }
  }
}

function protocolId(): string {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return cryptoLike?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
}

function normalizeResult(provider: string, result: AgentResult): AgentResult {
  const status = result.status === 'completed'
    || result.status === 'error'
    || result.status === 'aborted'
    || result.status === 'unknown'
    ? result.status
    : 'unknown'
  return {
    provider: typeof result.provider === 'string' && result.provider.trim() !== '' ? result.provider : provider,
    status,
    output: typeof result.output === 'string' ? result.output : String(result.output ?? ''),
    ...(result.diagnostic === undefined ? {} : { diagnostic: String(result.diagnostic) }),
    ...(result.artifactIds === undefined ? {} : { artifactIds: [...result.artifactIds] }),
    ...(result.signals === undefined ? {} : { signals: [...result.signals] }),
  }
}

const KNOWN_SIGNAL_TYPES = new Set([
  'PlanProposed',
  'AssumptionRaised',
  'SemanticUncertainty',
  'PlaybookMatched',
  'PlaybookMismatch',
  'EvidenceProduced',
  'ExecutionBlocked',
  'ReplanRequested',
  'HumanDecisionRequired',
  'KnowledgeCandidate',
  'VerificationFailed',
  'UnexpectedSideEffect',
  'UnknownSignal',
])

/** Normalize future/foreign signals without letting them break the run. */
export function normalizeSignal(value: AgentSignalInput): AgentSignal {
  if (!isRecord(value) || typeof value.type !== 'string' || value.type.trim() === '') {
    return { type: 'UnknownSignal', name: 'invalid', payload: toJsonObject({ value }) }
  }
  const type = value.type.trim()
  if (KNOWN_SIGNAL_TYPES.has(type)) return toJsonObject(value) as AgentSignal
  return { type: 'UnknownSignal', name: type, payload: toJsonObject(value) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toJsonObject(value: unknown, depth = 0): AgentJsonObject {
  if (!isRecord(value)) return { value: toJsonValue(value, depth + 1) }
  const entries = Object.entries(value).slice(0, 64).map(([key, item]) => [key.slice(0, 128), toJsonValue(item, depth + 1)] as const)
  return Object.fromEntries(entries) as AgentJsonObject
}

function toJsonValue(value: unknown, depth: number): AgentJsonValue {
  if (depth > 8) return '[truncated]'
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') return value.slice(0, 4096)
  if (Array.isArray(value)) return value.slice(0, 64).map(item => toJsonValue(item, depth + 1))
  if (isRecord(value)) return toJsonObject(value, depth)
  return String(value).slice(0, 4096)
}
