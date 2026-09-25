/** Jev decision provider, static fallback and bounded question templates. */

import { createHash } from 'node:crypto'
import type {
  DecisionAnswer,
  DecisionPurpose,
  DecisionRequest,
  DecisionResult,
  JevConfig,
  JevQuestion,
} from './contracts.ts'

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const DEFAULT_MODEL = 'system-one'
const DEFAULT_QUESTION_SET = 'autodev.v1'

/** Jev could not supply a valid answer under the configured retry and policy rules. */
export class JevUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'JevUnavailableError'
  }
}

/** Transport-independent contract for a provider of typed Jev decisions. */
export interface DecisionProvider {
  evaluate(request: DecisionRequest): Promise<DecisionResult>
}

/** Deterministic provider used for offline runs and contract tests. */
export class StaticDecisionProvider implements DecisionProvider {
  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    const answers: DecisionAnswer[] = request.questions.map((question) => {
      if (question.type === 'choice') {
        return {
          questionId: question.id,
          kind: 'choice',
          value: question.choices?.[0] ?? 'human',
          probability: 1,
        }
      }
      if (question.type === 'score') {
        return {
          questionId: question.id,
          kind: 'score',
          value: question.max ?? 0,
          probability: 1,
        }
      }
      return { questionId: question.id, kind: 'noul', value: null, probability: 1 }
    })
    return { source: 'static', modelVersion: 'static-v1', answers }
  }
}

/** TypeSafe System One HTTP adapter. It sends only the bounded DecisionState. */
export class HttpJevProvider implements DecisionProvider {
  constructor(private readonly config: JevConfig) {}

  async evaluate(request: DecisionRequest): Promise<DecisionResult> {
    const endpoint = this.config.endpoint ?? DEFAULT_ENDPOINT
    const apiKeyEnv = this.config.apiKeyEnv ?? 'TYPESAFE_API_KEY'
    const apiKey = process.env[apiKeyEnv]
    if (apiKey === undefined || apiKey.trim() === '') {
      throw new JevUnavailableError(`Jev credential ${apiKeyEnv} is not configured`)
    }
    const timeout = this.config.timeoutMs === undefined ? undefined : AbortSignal.timeout(this.config.timeoutMs)
    const signal = combineSignals(request.signal, timeout)
    let lastError: unknown
    const retries = clampInteger(this.config.retryCount ?? 1, 0, 5)
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        signal?.throwIfAborted()
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: this.config.model ?? DEFAULT_MODEL,
            state: sanitizeState(request.state, this.config.sendPaths === true),
            questions: request.questions,
          }),
          ...(signal === undefined ? {} : { signal }),
        })
        const text = await response.text()
        if (!response.ok) throw new Error(`Jev HTTP ${response.status}: ${text.slice(0, 400)}`)
        return parseJevResponse(JSON.parse(text) as unknown, request.questions, this.config.model)
      } catch (error: unknown) {
        if (signal?.aborted) throw error
        lastError = error
        if (attempt < retries) await delay(100 * (attempt + 1), request.signal)
      }
    }
    throw new JevUnavailableError('Jev request failed after retries', { cause: lastError })
  }
}

/** Optional Jev transport and deterministic fallback providers for the coordinator. */
export interface DecisionCoordinatorOptions {
  readonly config?: JevConfig
  readonly provider?: DecisionProvider
  readonly staticProvider?: DecisionProvider
}

/** Applies the required/advisory/off policy around a real or static provider. */
export class DecisionCoordinator {
  /** Resolved mode, confidence, endpoint, and data-sharing configuration. */
  readonly config: Required<Pick<JevConfig, 'mode' | 'questionSetVersion'>> & JevConfig
  private readonly providers: { readonly id: string; readonly provider: DecisionProvider; readonly priority: number }[]
  private readonly staticProvider: DecisionProvider

  constructor(options: DecisionCoordinatorOptions = {}) {
    const config = options.config ?? {}
    this.config = {
      ...config,
      mode: config.mode ?? 'advisory',
      questionSetVersion: config.questionSetVersion ?? DEFAULT_QUESTION_SET,
    }
    this.providers = [{ id: 'jev-http', provider: options.provider ?? new HttpJevProvider(this.config), priority: 0 }]
    this.staticProvider = options.staticProvider ?? new StaticDecisionProvider()
  }

  /** Register an optional Jev/local-model decision provider without replacing existing adapters.
   * Higher priority providers are tried first; a failed or invalid provider falls through to the next.
   */
  registerProvider(id: string, provider: DecisionProvider, priority: number = 0): () => void {
    const normalizedId = id.trim()
    if (normalizedId === '' || normalizedId.length > 128) throw new TypeError('decision provider id must be non-empty and bounded')
    if (!Number.isFinite(priority)) throw new TypeError('decision provider priority must be finite')
    if (this.providers.some(item => item.id === normalizedId)) throw new Error(`decision provider "${normalizedId}" is already registered`)
    const registration = { id: normalizedId, provider, priority }
    this.providers.push(registration)
    this.providers.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    return () => {
      const index = this.providers.indexOf(registration)
      if (index >= 0) this.providers.splice(index, 1)
    }
  }

  /** Evaluate a bounded decision request and apply required/advisory/off policy.
   * @param purpose - Decision category whose confidence policy applies.
   * @param state - Structured state supplied to Jev after path sanitization.
   * @param signal - Cancellation signal for the provider request.
   * @param customQuestions - Optional versioned questions replacing the built-in set.
   * @returns Validated answers, state hash, question-set version, and optional degradation note.
   * @throws JevUnavailableError when required mode cannot obtain an acceptable answer.
   */
  async evaluate(
    purpose: DecisionPurpose,
    state: unknown,
    signal: AbortSignal,
    customQuestions?: readonly JevQuestion[],
  ): Promise<DecisionResult & { readonly stateHash: string; readonly questionSetVersion: string; readonly degraded?: string }> {
    const questions = customQuestions ?? questionsFor(purpose)
    const stateHash = sha256(stableStringify(sanitizeState(state, this.config.sendPaths === true)))
    if (this.config.mode === 'off') {
      const result = await this.staticProvider.evaluate({ purpose, state, questions, signal })
      return { ...result, providerId: result.providerId ?? 'static-offline', stateHash, questionSetVersion: this.config.questionSetVersion }
    }
    const failures: string[] = []
    for (const registration of this.providers) {
      try {
        const result = await registration.provider.evaluate({ purpose, state, questions, signal })
        validateDecisionResult(result, questions)
        const threshold = this.config.minConfidence?.[purpose] ?? 0
        const confidence = decisionConfidence(result)
        if (threshold > 0 && (confidence === undefined || confidence < threshold)) {
          throw new Error(`confidence ${confidence === undefined ? 'missing' : confidence.toFixed(3)} is below ${threshold.toFixed(3)}`)
        }
        return {
          ...result,
          providerId: result.providerId ?? registration.id,
          stateHash,
          questionSetVersion: this.config.questionSetVersion,
        }
      } catch (error: unknown) {
        if (signal.aborted) throw error
        failures.push(`${registration.id}: ${errorMessage(error)}`)
      }
    }
    const failureSummary = failures.join('; ') || 'no decision providers are registered'
    if (this.config.mode === 'required') throw new JevUnavailableError(failureSummary)
    const fallback = await this.staticProvider.evaluate({ purpose, state, questions, signal })
    return {
      ...fallback,
      source: 'fallback',
      providerId: 'static-fallback',
      stateHash,
      questionSetVersion: this.config.questionSetVersion,
      degraded: failureSummary,
    }
  }
}

/** Return the stable, typed question set for one supported decision category.
 * @param purpose - Decision category to ask.
 * @returns The versioned questions associated with that category.
 */
export function questionsFor(purpose: DecisionPurpose): readonly JevQuestion[] {
  switch (purpose) {
    case 'agent-route':
      return [{ id: 'provider', type: 'choice', text: 'Choose one eligible provider.', choices: [] }]
    case 'failure-action':
      return [{ id: 'action', type: 'choice', text: 'Choose a bounded recovery action.', choices: ['retry_same', 'rework', 'replan', 'human', 'stop'] }]
    case 'quality':
      return [
        { id: 'score', type: 'score', text: 'Score evidence quality from 0 to 100.', min: 0, max: 100 },
        { id: 'needs_review', type: 'noul', text: 'Is additional human review required?' },
      ]
    case 'completion':
      return [{ id: 'completion', type: 'choice', text: 'Choose the current completion state.', choices: ['ready_for_verify', 'work_remaining', 'human_review'] }]
  }
}

/** Replace the choice list of the provider-selection question without changing other questions.
 * @param questions - Existing typed question set.
 * @param choices - Eligible Provider names offered to the decision provider.
 * @returns A new question list with only the provider choices replaced.
 */
export function replaceQuestionChoices(questions: readonly JevQuestion[], choices: readonly string[]): readonly JevQuestion[] {
  return questions.map(question => question.id === 'provider' ? { ...question, choices } : question)
}

/** Find one answer by its stable question identity.
 * @param result - Provider result containing typed answers.
 * @param questionId - Question identity to retrieve.
 * @returns The matching answer, or `undefined` when it was not supplied.
 */
export function answerOf(result: DecisionResult, questionId: string): DecisionAnswer | undefined {
  return result.answers.find(answer => answer.questionId === questionId)
}

function parseJevResponse(value: unknown, questions: readonly JevQuestion[], model?: string): DecisionResult {
  if (!isRecord(value)) throw new Error('Jev response is not an object')
  const rawAnswers = value.answers
  const answers: DecisionAnswer[] = []
  if (Array.isArray(rawAnswers)) {
    for (const [index, question] of questions.entries()) {
      const item = rawAnswers[index]
      if (item !== undefined) answers.push(parseAnswer(question, item))
    }
  } else if (isRecord(rawAnswers)) {
    for (const question of questions) {
      const item = rawAnswers[question.id]
      if (item !== undefined) answers.push(parseAnswer(question, item))
    }
  }
  if (answers.length !== questions.length) throw new Error('Jev response did not answer every question')
  const usage = isRecord(value.usage) ? {
    ...typeof value.usage.inputTokens === 'number' ? { inputTokens: value.usage.inputTokens } : {},
    ...typeof value.usage.outputTokens === 'number' ? { outputTokens: value.usage.outputTokens } : {},
  } : undefined
  return {
    source: 'jev',
    modelVersion: typeof value.model === 'string' ? value.model : model ?? DEFAULT_MODEL,
    answers,
    raw: value,
    ...(usage === undefined ? {} : { usage }),
  }
}

function parseAnswer(question: JevQuestion, value: unknown): DecisionAnswer {
  if (!isRecord(value)) {
    return { questionId: question.id, kind: question.type, value: value as string | number | boolean | null }
  }
  const candidate = 'value' in value ? value.value : 'answer' in value ? value.answer : value.choice ?? value.score ?? value.noul
  const probability = typeof value.probability === 'number'
    ? value.probability
    : typeof value.confidence === 'number' ? value.confidence : undefined
  return {
    questionId: question.id,
    kind: question.type,
    value: candidate as string | number | boolean | null,
    ...(probability === undefined ? {} : { probability }),
  }
}

/** Keep model output inside the finite question contract before policy code sees it. */
function validateDecisionResult(result: DecisionResult, questions: readonly JevQuestion[]): void {
  if (!Array.isArray(result.answers) || result.answers.length !== questions.length) {
    throw new Error('Jev result did not answer every configured question')
  }
  for (const [index, question] of questions.entries()) {
    const answer = result.answers[index]
    if (answer === undefined || answer.questionId !== question.id || answer.kind !== question.type) {
      throw new Error(`Jev answer ${question.id} has an invalid question identity or kind`)
    }
    if (answer.probability !== undefined && (!Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1)) {
      throw new Error(`Jev answer ${question.id} has an invalid probability`)
    }
    if (question.type === 'choice' && (typeof answer.value !== 'string' || !question.choices?.includes(answer.value))) {
      throw new Error(`Jev answer ${question.id} selected a value outside the configured choices`)
    }
    if (question.type === 'score') {
      if (typeof answer.value !== 'number' || !Number.isFinite(answer.value)) {
        throw new Error(`Jev answer ${question.id} is not a finite score`)
      }
      if (question.min !== undefined && answer.value < question.min) throw new Error(`Jev answer ${question.id} is below the minimum`)
      if (question.max !== undefined && answer.value > question.max) throw new Error(`Jev answer ${question.id} is above the maximum`)
    }
    if (question.type === 'noul' && answer.value !== null && typeof answer.value !== 'boolean') {
      throw new Error(`Jev answer ${question.id} must be boolean or null`)
    }
  }
}

function decisionConfidence(result: DecisionResult): number | undefined {
  const probabilities = result.answers.map(answer => answer.probability)
  if (probabilities.some(value => value === undefined)) return undefined
  return Math.min(...probabilities as number[])
}

function sanitizeState(value: unknown, sendPaths: boolean, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value
  if (Array.isArray(value)) return value.slice(0, 30).map(item => sanitizeState(item, sendPaths, depth + 1))
  if (isRecord(value)) {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value).slice(0, 80)) {
      if (!sendPaths && /path|cwd|home|directory/i.test(key)) continue
      if (/key|token|secret|password|credential/i.test(key)) continue
      result[key] = sanitizeState(child, sendPaths, depth + 1)
    }
    return result
  }
  return String(value)
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function combineSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  return AbortSignal.any(active)
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
