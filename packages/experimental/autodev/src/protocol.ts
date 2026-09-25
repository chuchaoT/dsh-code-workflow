/**
 * The normalized Agent Protocol used by AutoDev.
 *
 * Provider-specific transports remain behind ProviderRouter. This module only
 * defines the stable task/context/result/signal vocabulary that the runtime can
 * persist and reason about regardless of whether the provider is Codex, Claude
 * Code, a CLI, or a future local adapter.
 */

export const AGENT_PROTOCOL_VERSION = 'dsh.agent.v1' as const

/** Maximum combined characters for Host-curated, supplemental Agent context cards. */
export const MAX_AGENT_CONTEXT_CHARS = 6000

/** Task categories understood by the normalized Agent Protocol. */
export type AgentTaskKind = 'implement' | 'review' | 'analyze' | 'verify' | 'custom'

/** One bounded unit of Agent work tied to a Run, Plan version, Node, and Attempt. */
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

/** Lifecycle identity for one Provider session serving an Agent Task. */
export interface AgentSession {
  readonly id: string
  readonly provider: string
  readonly taskId: string
  readonly startedAt: string
  readonly endedAt?: string
  readonly status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'UNKNOWN' | 'ABORTED'
}

/** Action-level execution record associated with an Agent session and Task. */
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
export interface AutoDevAgentContext {
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
  readonly conceptRefs?: readonly string[]
  readonly assumptionRefs?: readonly string[]
  readonly uncertaintyRefs?: readonly string[]
  readonly playbookRefs?: readonly string[]
  readonly knowledgeRefs?: readonly string[]
  /** Bounded summaries and source references actually delivered to this Agent. */
  readonly memoryCards?: readonly string[]
  readonly conceptCards?: readonly string[]
  readonly assumptionCards?: readonly string[]
  readonly uncertaintyCards?: readonly string[]
  readonly playbookCards?: readonly string[]
  readonly knowledgeCards?: readonly string[]
  readonly contextBudget?: { readonly maxChars: number; readonly usedChars: number }
}

/** Normalized finite vocabulary of Agent claims and escalation signals. */
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

/** JSON-safe recursive value retained from an unrecognized Provider signal. */
export type AgentJsonValue = null | boolean | number | string | AgentJsonValue[] | AgentJsonObject
/** JSON-safe object payload retained for forward-compatible signal handling. */
export interface AgentJsonObject {
  readonly [key: string]: AgentJsonValue
}

/** Host-attributed signal bound to one active protocol task and sequence slot. */
export interface AgentSignalEnvelope {
  readonly protocolVersion: typeof AGENT_PROTOCOL_VERSION
  readonly id: string
  readonly taskId: string
  readonly runId: string
  readonly planVersionId: string
  readonly nodeId: string
  readonly attempt: number
  readonly provider: string
  readonly sequence: number
  readonly signal: AgentSignal
  readonly createdAt: string
}

/** Active task identity used to validate an untrusted signal envelope. */
export interface AgentSignalEnvelopeExpectation {
  readonly taskId: string
  readonly runId: string
  readonly planVersionId: string
  readonly nodeId: string
  readonly attempt: number
  readonly provider: string
  readonly sequence: number
}

/** Declared task, workspace, signal, and cancellation capabilities of an adapter. */
export interface AgentCapabilities {
  readonly traits: readonly string[]
  readonly taskKinds: readonly AgentTaskKind[]
  readonly workspace: 'isolated' | 'shared' | 'external'
  readonly supportsCancellation: boolean
  readonly supportsSignals: boolean
}

/** Safe Provider adapter metadata suitable for catalogs and Remote responses. */
export interface AgentAdapterInfo {
  readonly name: string
  readonly kind: string
  readonly capabilities: AgentCapabilities
  readonly available: boolean
}

/** Provider-reported outcome before Host signal normalization and attribution. */
export interface AgentResult {
  readonly provider: string
  readonly status: 'completed' | 'error' | 'aborted' | 'unknown'
  readonly output: string
  readonly diagnostic?: string
  readonly artifactIds?: readonly string[]
  readonly signals?: readonly AgentSignalInput[]
}

/** Agent result with every signal normalized and bound to its active task. */
export type AgentExecutionResult = Omit<AgentResult, 'signals'> & {
  readonly signals: readonly AgentSignalEnvelope[]
}

/** Normalized task and bounded context passed to one registered adapter. */
export interface AgentAdapterRequest {
  readonly task: AgentTask
  readonly context: AutoDevAgentContext
  readonly signal: AbortSignal
  readonly parentAgent?: unknown
  readonly emitSignal: (signal: AgentSignalInput) => void
}

/** Provider-neutral implementation of one supported Agent Protocol transport. */
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

  /** Register an adapter and return a disposer guarded against stale removal.
   * @param adapter - Adapter implementation and declared capabilities.
   * @returns A disposer that removes this exact registration.
   * @throws TypeError for an empty name or Error for a duplicate registration.
   */
  register(adapter: AgentAdapter): () => void {
    if (adapter.name.trim() === '') throw new TypeError('Agent adapter name must be non-empty')
    if (this.adapters.has(adapter.name)) throw new Error(`Agent adapter "${adapter.name}" is already registered`)
    this.adapters.set(adapter.name, adapter)
    return () => {
      if (this.adapters.get(adapter.name) === adapter) this.adapters.delete(adapter.name)
    }
  }

  /** Read a registered adapter by its exact name.
   * @param name - Provider adapter identity.
   * @returns The adapter, or `undefined` when it is not registered.
   */
  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name)
  }

  /** Return detached metadata for all currently registered adapters.
   * @returns Provider names, kinds, capabilities, and current registration availability.
   */
  list(): readonly AgentAdapterInfo[] {
    return [...this.adapters.values()].map(adapter => ({
      name: adapter.name,
      kind: adapter.kind,
      capabilities: adapter.capabilities,
      available: true,
    }))
  }

  /** Validate task identity and capabilities, execute, then normalize untrusted results.
   * @param adapterOrName - Adapter instance or registered adapter name.
   * @param request - Task, scoped context, cancellation signal, and parent identity.
   * @returns Bounded result with Host-attributed, ordered signal envelopes.
   * @throws Error when the version, context, capabilities, or adapter availability is invalid.
   */
  async execute(
    adapterOrName: AgentAdapter | string,
    request: Omit<AgentAdapterRequest, 'emitSignal'>,
  ): Promise<AgentExecutionResult> {
    const adapter = typeof adapterOrName === 'string' ? this.adapters.get(adapterOrName) : adapterOrName
    if (adapter === undefined) throw new Error(`no Agent Protocol adapter named "${String(adapterOrName)}"`)
    if (request.task.protocolVersion !== AGENT_PROTOCOL_VERSION) {
      throw new Error(`unsupported Agent Protocol version ${request.task.protocolVersion}`)
    }
    validateTaskContext(request.task, request.context)
    if (!adapter.capabilities.taskKinds.includes(request.task.kind)) {
      throw new Error(`Agent adapter ${adapter.name} does not support task kind ${request.task.kind}`)
    }
    if (request.signal.aborted) throw new Error('Agent Protocol request was aborted before execution')
    if (adapter.isAvailable !== undefined && !await adapter.isAvailable()) {
      throw new Error(`Agent adapter ${adapter.name} is unavailable`)
    }

    const emitted: AgentSignalInput[] = []
    const result = await adapter.execute({
      ...request,
      emitSignal: (signal) => { if (emitted.length < MAX_AGENT_SIGNALS) emitted.push(signal) },
    })
    const normalizedResult = normalizeResult(adapter.name, result)
    const normalized: AgentResult = request.signal.aborted && normalizedResult.status !== 'aborted'
      ? { ...normalizedResult, status: 'unknown', diagnostic: 'cancellation was requested but the provider did not confirm termination; workspace outcome is unknown' }
      : normalizedResult
    const rawSignals = adapter.capabilities.supportsSignals
      ? [...emitted, ...(normalized.signals ?? [])].slice(0, MAX_AGENT_SIGNALS)
      : []
    const signals = rawSignals.map((signal, index) => ({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      id: protocolId(),
      taskId: request.task.id,
      runId: request.task.runId,
      planVersionId: request.task.planVersionId,
      nodeId: request.task.nodeId,
      attempt: request.task.attempt,
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
  const raw: Record<string, unknown> = isRecord(result) ? result : {}
  const status = raw.status === 'completed' || raw.status === 'error' || raw.status === 'aborted' || raw.status === 'unknown'
    ? raw.status
    : 'unknown'
  const output = typeof raw.output === 'string' ? raw.output : String(raw.output ?? '')
  return {
    // The registered adapter identity is authoritative; a child process or
    // model response must not be able to attribute its output to another route.
    provider,
    status,
    output: output.length <= MAX_AGENT_OUTPUT ? output : `${output.slice(0, MAX_AGENT_OUTPUT)}\n[Agent output truncated by protocol limit]`,
    ...(raw.diagnostic === undefined ? {} : { diagnostic: String(raw.diagnostic).slice(0, MAX_SIGNAL_TEXT) }),
    ...(Array.isArray(raw.artifactIds) ? { artifactIds: raw.artifactIds.slice(0, 128).filter((item): item is string => typeof item === 'string').map(item => item.slice(0, 256)) } : {}),
    ...(Array.isArray(raw.signals) ? { signals: raw.signals.slice(0, 128) as AgentSignalInput[] } : {}),
  }
}

/** Validate an untrusted envelope against the exact active task identity.
 * @param value - Untrusted object received from a Provider or persisted input.
 * @param expected - Current task, provider, attempt, and sequence identity.
 * @returns True only when all bounded identity, timestamp, and signal fields match.
 */
export function isValidAgentSignalEnvelope(value: unknown, expected: AgentSignalEnvelopeExpectation): value is AgentSignalEnvelope {
  if (!isRecord(value)) return false
  const boundedText = (item: unknown, max = 256): item is string => typeof item === 'string' && item.trim() !== '' && item.length <= max
  if (value.protocolVersion !== AGENT_PROTOCOL_VERSION
    || !boundedText(value.id)
    || value.taskId !== expected.taskId || !boundedText(value.taskId)
    || value.runId !== expected.runId || !boundedText(value.runId)
    || value.planVersionId !== expected.planVersionId || !boundedText(value.planVersionId)
    || value.nodeId !== expected.nodeId || !boundedText(value.nodeId)
    || value.provider !== expected.provider || !boundedText(value.provider)
    || !Number.isSafeInteger(value.attempt) || value.attempt !== expected.attempt || value.attempt < 1
    || !Number.isSafeInteger(value.sequence) || value.sequence !== expected.sequence || value.sequence < 1
    || !boundedText(value.createdAt, 64) || !Number.isFinite(Date.parse(value.createdAt))) return false
  return isRecord(value.signal) && boundedText(value.signal.type)
}

const SIGNAL_TEXT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  PlanProposed: ['summary', 'planFingerprint'],
  AssumptionRaised: ['statement'],
  SemanticUncertainty: ['subject', 'reason'],
  PlaybookMatched: ['playbookId', 'playbookVersion'],
  PlaybookMismatch: ['playbookId', 'reason'],
  EvidenceProduced: ['evidenceId', 'summary'],
  ExecutionBlocked: ['reason'],
  ReplanRequested: ['reason'],
  HumanDecisionRequired: ['question', 'risk'],
  KnowledgeCandidate: ['subject', 'summary'],
  VerificationFailed: ['checkId', 'reason'],
  UnexpectedSideEffect: ['description', 'path'],
  UnknownSignal: ['name'],
}
const SIGNAL_ARRAY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  AssumptionRaised: ['conflictsWith'],
  SemanticUncertainty: ['alternatives', 'assumptionIds'],
  HumanDecisionRequired: ['options'],
}
const SIGNAL_ENUM_FIELDS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  PlaybookMatched: { fit: ['MATCH', 'PARTIAL'] },
  EvidenceProduced: { status: ['PASS', 'FAIL', 'WARN', 'UNKNOWN'] },
  UnexpectedSideEffect: { severity: ['low', 'medium', 'high'] },
}
const REQUIRED_SIGNAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  AssumptionRaised: ['statement'],
  SemanticUncertainty: ['subject', 'reason'],
  PlaybookMatched: ['playbookId'],
  PlaybookMismatch: ['playbookId'],
  ExecutionBlocked: ['reason'],
  ReplanRequested: ['reason'],
  HumanDecisionRequired: ['question'],
  VerificationFailed: ['reason'],
  UnknownSignal: ['name'],
}
const ALTERNATIVE_SIGNAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  KnowledgeCandidate: ['subject', 'summary'],
  UnexpectedSideEffect: ['description', 'path'],
}
const MAX_SIGNAL_TEXT = 4096
const MAX_SIGNAL_ARRAY = 32
const MAX_AGENT_OUTPUT = 128 * 1024
const MAX_AGENT_SIGNALS = 128

/** Normalize future/foreign signals without letting them break the Run.
 * @param value - Untrusted signal supplied by an adapter.
 * @returns A bounded known signal, or a JSON-safe `UnknownSignal` representation.
 */
export function normalizeSignal(value: AgentSignalInput): AgentSignal {
  if (!isRecord(value) || typeof value.type !== 'string' || value.type.trim() === '') {
    return { type: 'UnknownSignal', name: 'invalid', payload: toJsonObject({ value }) }
  }
  const raw = value as unknown as Record<string, unknown>
  const type = raw.type as string
  const textFields = SIGNAL_TEXT_FIELDS[type]
  if (textFields === undefined) return unknownSignal(type, raw)
  if (
    !validTextFields(raw, textFields) ||
    !validArrayFields(raw, SIGNAL_ARRAY_FIELDS[type] ?? []) ||
    !validEnumFields(raw, SIGNAL_ENUM_FIELDS[type] ?? {})
  ) {
    return unknownSignal(type, raw)
  }
  const required = REQUIRED_SIGNAL_FIELDS[type] ?? []
  if (required.length > 0 && !required.every(key => typeof raw[key] === 'string' && (raw[key] as string).trim() !== '')) {
    return unknownSignal(type, raw)
  }
  const alternatives = ALTERNATIVE_SIGNAL_FIELDS[type] ?? []
  if (alternatives.length > 0 && !alternatives.some(key => typeof raw[key] === 'string' && (raw[key] as string).trim() !== '')) {
    return unknownSignal(type, raw)
  }
  if ((type === 'AssumptionRaised' || type === 'KnowledgeCandidate') && !validConfidence(raw)) return unknownSignal(type, raw)
  if (type === 'ExecutionBlocked' && raw.recoverable !== undefined && typeof raw.recoverable !== 'boolean') return unknownSignal(type, raw)
  if (type === 'UnknownSignal' && !isRecord(raw.payload)) return unknownSignal(type, raw)

  const output: Record<string, unknown> = { type }
  for (const key of textFields) {
    if (raw[key] !== undefined) output[key] = (raw[key] as string).trim().slice(0, MAX_SIGNAL_TEXT)
  }
  for (const key of SIGNAL_ARRAY_FIELDS[type] ?? []) {
    if (raw[key] !== undefined) output[key] = (raw[key] as string[]).slice(0, MAX_SIGNAL_ARRAY).map(item => item.trim().slice(0, 512))
  }
  for (const key of Object.keys(SIGNAL_ENUM_FIELDS[type] ?? {})) {
    if (raw[key] !== undefined) output[key] = raw[key]
  }
  if (raw.confidence !== undefined) output.confidence = raw.confidence
  if (raw.recoverable !== undefined) output.recoverable = raw.recoverable
  if (type === 'UnknownSignal') output.payload = toJsonObject(raw.payload)
  return output as AgentSignal
}

function validateTaskContext(task: AgentTask, context: AutoDevAgentContext): void {
  for (const [name, value] of Object.entries({
    taskId: task.id, runId: task.runId, planVersionId: task.planVersionId, nodeId: task.nodeId,
    instruction: task.instruction, workspacePath: task.workspacePath,
  })) {
    if (typeof value !== 'string' || value.trim() === '' || value.length > 32_768) throw new TypeError(`Agent Protocol ${name} must be a non-empty bounded string`)
  }
  if (!Number.isSafeInteger(task.attempt) || task.attempt < 1) throw new TypeError('Agent Protocol attempt must be a positive safe integer')
  if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length > 64 || task.acceptanceCriteria.some(item => typeof item !== 'string' || item.trim() === '' || item.length > MAX_SIGNAL_TEXT)) {
    throw new TypeError('Agent Protocol acceptanceCriteria must contain at most 64 non-empty bounded strings')
  }
  if (
    context.runId !== task.runId ||
    context.planVersionId !== task.planVersionId ||
    context.nodeId !== task.nodeId ||
    context.attempt !== task.attempt ||
    context.workspacePath !== task.workspacePath
  ) {
    throw new Error('Agent Protocol Task and Context identities do not match')
  }
  if (typeof context.projectKey !== 'string' || context.projectKey.trim() === '' || typeof context.repoRoot !== 'string' || context.repoRoot.trim() === '' || typeof context.baseCommit !== 'string' || context.baseCommit.trim() === '') {
    throw new TypeError('Agent Protocol Context requires project, repository and baseline identities')
  }
  const referenceGroups = [
    ['evidenceIds', context.evidenceIds],
    ['memoryRefs', context.memoryRefs],
    ['conceptRefs', context.conceptRefs],
    ['assumptionRefs', context.assumptionRefs],
    ['uncertaintyRefs', context.uncertaintyRefs],
    ['playbookRefs', context.playbookRefs],
    ['knowledgeRefs', context.knowledgeRefs],
  ] as const
  for (const [name, references] of referenceGroups) {
    if (references !== undefined && (!Array.isArray(references) || references.length > 32
      || references.some(reference => typeof reference !== 'string' || reference.trim() === '' || reference.length > 512))) {
      throw new TypeError(`Agent Protocol Context ${name} must contain at most 32 bounded identifiers`)
    }
  }
  const cardGroups = [
    ['memoryCards', context.memoryCards],
    ['conceptCards', context.conceptCards],
    ['assumptionCards', context.assumptionCards],
    ['uncertaintyCards', context.uncertaintyCards],
    ['playbookCards', context.playbookCards],
    ['knowledgeCards', context.knowledgeCards],
  ] as const
  let cardChars = 0
  for (const [name, cards] of cardGroups) {
    if (cards === undefined) continue
    if (!Array.isArray(cards) || cards.length > 32 || cards.some(card => typeof card !== 'string')) {
      throw new TypeError(`Agent Protocol Context ${name} must contain at most 32 text cards`)
    }
    cardChars += cards.reduce((sum, card, index) => sum + card.length + (index === 0 ? 0 : 1), 0)
  }
  if (cardChars > MAX_AGENT_CONTEXT_CHARS) {
    throw new RangeError(`Agent Protocol Context cards exceed ${MAX_AGENT_CONTEXT_CHARS} characters`)
  }
  if (context.contextBudget !== undefined) {
    const { maxChars, usedChars } = context.contextBudget
    if (!Number.isSafeInteger(maxChars) || maxChars < 0 || maxChars > MAX_AGENT_CONTEXT_CHARS
      || !Number.isSafeInteger(usedChars) || usedChars < 0 || usedChars > maxChars || usedChars !== cardChars) {
      throw new TypeError('Agent Protocol Context budget does not match its bounded cards')
    }
  }
}

function unknownSignal(name: string, value: unknown): AgentSignal {
  return { type: 'UnknownSignal', name: name.slice(0, 256), payload: toJsonObject(value) }
}

function validTextFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(key => value[key] === undefined || (typeof value[key] === 'string' && (value[key] as string).trim() !== ''))
}

function validArrayFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(key => value[key] === undefined || (Array.isArray(value[key]) && value[key].length <= MAX_SIGNAL_ARRAY && value[key].every(item => typeof item === 'string' && item.trim() !== '' && item.length <= 512)))
}

function validEnumFields(value: Record<string, unknown>, fields: Readonly<Record<string, readonly string[]>>): boolean {
  return Object.entries(fields).every(([key, values]) => value[key] === undefined || (typeof value[key] === 'string' && values.includes(value[key] as string)))
}

function validConfidence(value: Record<string, unknown>): boolean {
  return value.confidence === undefined || (typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1)
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
