import type { AutoDevMode, BuildDriverId, PlanNode } from './contracts.ts'

/** Stable catalog of AutoDev work modes. Workflow state remains a separate Run lifecycle. */
export const AUTODEV_MODES: readonly AutoDevMode[] = [
  'EXPLORE', 'IMPACT', 'DEV', 'DEBUG', 'DATABASE', 'REFACTOR', 'TEST', 'REVIEW', 'RELEASE',
]

/** Engineering strategy metadata consumed by planning and UI code. */
export interface AutoDevModeDefinition {
  readonly mode: AutoDevMode
  readonly readOnly: boolean
  readonly instruction: string
}

/** Mode registry is deliberately policy-only: build/test/profile choice is an execution-environment concern. */
export const AUTODEV_MODE_REGISTRY: Readonly<Record<AutoDevMode, AutoDevModeDefinition>> = {
  EXPLORE: { mode: 'EXPLORE', readOnly: true, instruction: 'Explore the repository and explain its structure and relevant behavior. Do not modify files.' },
  IMPACT: { mode: 'IMPACT', readOnly: true, instruction: 'Trace the change impact across modules, persistence, APIs, messages, caches, and tests. Do not modify files.' },
  DEV: { mode: 'DEV', readOnly: false, instruction: 'Implement the requested product change, then validate and review it.' },
  DEBUG: { mode: 'DEBUG', readOnly: false, instruction: 'Reproduce and isolate the reported defect, explain its root cause, implement a focused fix, and validate regression behavior.' },
  DATABASE: { mode: 'DATABASE', readOnly: false, instruction: 'Treat schema, migration, compatibility, and rollback behavior as first-class requirements.' },
  REFACTOR: { mode: 'REFACTOR', readOnly: false, instruction: 'Refactor while preserving externally observable behavior; add or run regression checks.' },
  TEST: { mode: 'TEST', readOnly: false, instruction: 'Add or improve tests for the requested behavior and run the most relevant regression checks.' },
  REVIEW: { mode: 'REVIEW', readOnly: true, instruction: 'Review the current repository for concrete defects and report findings with file and line references. Do not modify files.' },
  RELEASE: { mode: 'RELEASE', readOnly: true, instruction: 'Assess release readiness, compatibility, tests, changelog, and remaining risks. Do not modify files.' },
}

/** Resolve explicit mode selection before applying deterministic request classification. */
export function resolveAutoDevMode(requested: AutoDevMode | 'AUTO' | undefined, request: string): { readonly mode: AutoDevMode; readonly source: 'explicit' | 'auto' } {
  if (requested !== undefined && requested !== 'AUTO') {
    if (!AUTODEV_MODES.includes(requested)) throw new TypeError(`unsupported AutoDev mode: ${requested}`)
    return { mode: requested, source: 'explicit' }
  }
  return { mode: classifyAutoDevMode(request), source: 'auto' }
}

/** Conservative, deterministic intent classifier; ambiguous engineering requests default to DEV. */
export function classifyAutoDevMode(request: string): AutoDevMode {
  const value = request.toLocaleLowerCase()
  if (hasAny(value, ['release', '发布', '上线', '发版', 'changelog'])) return 'RELEASE'
  if (hasAny(value, ['review', '审查', '评审', '代码检查'])) return 'REVIEW'
  if (hasAny(value, ['影响分析', 'impact analysis', '依赖分析', '调用链'])) return 'IMPACT'
  if (hasAny(value, ['explore', '探索', '梳理', '了解项目'])) return 'EXPLORE'
  if (hasAny(value, ['数据库', 'migration', '迁移脚本', 'schema', '建表', '字段'])) return 'DATABASE'
  if (hasAny(value, ['重构', 'refactor'])) return 'REFACTOR'
  if (hasAny(value, ['bug', '错误', '异常', '崩溃', '故障', '定位', 'debug', '偶发'])) return 'DEBUG'
  if (hasAny(value, ['测试', 'test only', '补测试', '回归验证'])) return 'TEST'
  return 'DEV'
}

/** Make a mode-specific immutable Plan graph, omitting Build/Test when no deterministic driver exists. */
export function createModePlanNodes(mode: AutoDevMode, buildDriverId?: BuildDriverId): readonly PlanNode[] {
  if (AUTODEV_MODE_REGISTRY[mode].readOnly) {
    const kind = mode === 'EXPLORE' ? 'analyze' : mode === 'IMPACT' ? 'impact' : mode === 'RELEASE' ? 'release' : 'review'
    return [{
      id: kind,
      kind,
      description: AUTODEV_MODE_REGISTRY[mode].instruction,
      dependencies: [],
      expectedOutputs: [mode === 'REVIEW' ? 'review findings' : 'analysis report'],
      routeName: 'review',
    }]
  }
  const nodes: PlanNode[] = [{
    id: 'implement', kind: 'implement',
    description: `${mode} — ${AUTODEV_MODE_REGISTRY[mode].instruction}`,
    dependencies: [], expectedOutputs: ['source diff'], routeName: 'implement',
  }]
  if (buildDriverId !== undefined) {
    nodes.push({ id: 'build', kind: 'build', description: `Run ${buildDriverId} build and capture immutable evidence`, dependencies: ['implement'], expectedOutputs: ['BUILD PASS'] })
    nodes.push({ id: 'test', kind: 'test', description: `Run ${buildDriverId} tests and capture immutable evidence`, dependencies: ['build'], expectedOutputs: ['TEST PASS'] })
  }
  return nodes
}

/** Returns true for modes whose contract forbids candidate edits. */
export function isReadOnlyMode(mode: AutoDevMode): boolean {
  return AUTODEV_MODE_REGISTRY[mode].readOnly
}

/** Format a route-safe mode task instruction with the original user request preserved verbatim. */
export function modeTaskInstruction(mode: AutoDevMode, request: string): string {
  const responseContract = mode === 'REVIEW'
    ? '\nReturn strict JSON only: {"verdict":"PASS"|"NEEDS_CHANGES","findings":[{"severity":"low"|"medium"|"high"|"critical","file":"...","line":1,"message":"..."}]}. Use PASS only when findings is empty.'
    : ''
  return `[AutoDev mode: ${mode}]\n${AUTODEV_MODE_REGISTRY[mode].instruction}${responseContract}\n\nUser request:\n${request}`
}

function hasAny(value: string, terms: readonly string[]): boolean {
  return terms.some(term => value.includes(term))
}
