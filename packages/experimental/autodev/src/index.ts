/** External DeepSeek Harness Bundle entry for AutoDev. */

import type { Context } from '@deepseek-ai/cordis'
import type { AutoDevConfig } from './contracts.ts'
import { apply as applyTools } from './tools.ts'

export const name = 'autodev'
export const inject = ['tools']

export function apply(ctx: Context, config: AutoDevConfig = {}): void {
  applyTools(ctx, config)
}

export { AutoDevRuntime } from './runtime.ts'
export { AutoDevStore } from './store.ts'
export { GitManager } from './git.ts'
export { HarnessCommandExecutor } from './command.ts'
export { DecisionCoordinator, HttpJevProvider, StaticDecisionProvider, JevUnavailableError } from './jev.ts'
export { ProviderRouter, commandProvider } from './router.ts'
export { AgentProtocol, normalizeSignal, AGENT_PROTOCOL_VERSION } from './protocol.ts'
export { defaultVerificationChecks, evaluateVerification } from './verification.ts'
export { SemanticService } from './semantics.ts'
export { ProjectMemoryService } from './memory.ts'
export { BusinessConceptService } from './concepts.ts'
export { PlaybookService } from './playbook.ts'
export { KnowledgeService } from './knowledge.ts'
export { SideEffectService, idempotencyKey } from './side-effects.ts'
export type * from './contracts.ts'
export type * from './command.ts'
export type * from './protocol.ts'
export type { VerificationEvaluation, VerificationEvidenceType } from './verification.ts'
export type * from './router.ts'
export type * from './semantics.ts'
export type * from './memory.ts'
export type * from './concepts.ts'
export type * from './playbook.ts'
export type * from './knowledge.ts'
export type * from './side-effects.ts'
