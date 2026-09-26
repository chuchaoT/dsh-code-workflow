/** Model-facing AutoDev tools. Promotion and gate resolution remain explicit calls. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AutoDevConfig, AutoDevMode, AutoDevSnapshot, BuildDriverId } from './contracts.ts'
import { AutoDevRuntime } from './runtime.ts'

const JSON_OUTPUT = {
  schema: { type: 'json' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) ?? 'null' }],
}

export const name = 'autodev-tools'
export const inject = ['tools']

export function apply(ctx: Context, config: AutoDevConfig = {}): void {
  const runtime = new AutoDevRuntime(ctx, config)
  const disposers = [
    ctx.tools.register(createTool(runtime)),
    ctx.tools.register(runTool(runtime)),
    ctx.tools.register(statusTool(runtime)),
    ctx.tools.register(listTool(runtime)),
    ctx.tools.register(promoteTool(runtime)),
    ctx.tools.register(gateTool(runtime)),
    ctx.tools.register(cancelTool(runtime)),
    ctx.tools.register(memorySearchTool(runtime)),
    ctx.tools.register(memoryDetailTool(runtime)),
    ctx.tools.register(semanticStateTool(runtime)),
    ctx.tools.register(resolveUncertaintyTool(runtime)),
    ctx.tools.register(resolveAssumptionTool(runtime)),
    ctx.tools.register(conceptsTool(runtime)),
    ctx.tools.register(conceptDetailTool(runtime)),
    ctx.tools.register(conceptHistoryTool(runtime)),
    ctx.tools.register(observeConceptTool(runtime)),
    ctx.tools.register(correctConceptTool(runtime)),
    ctx.tools.register(playbooksTool(runtime)),
    ctx.tools.register(playbookDetailTool(runtime)),
    ctx.tools.register(knowledgeTool(runtime)),
    ctx.tools.register(knowledgeSearchTool(runtime)),
    ctx.tools.register(knowledgeDetailTool(runtime)),
    ctx.tools.register(knowledgeRegressionCasesTool(runtime)),
    ctx.tools.register(createKnowledgeRegressionTool(runtime)),
    ctx.tools.register(runKnowledgeRegressionSuiteTool(runtime)),
    ctx.tools.register(compactKnowledgeTool(runtime)),
    ctx.tools.register(restoreKnowledgeCompactionTool(runtime)),
    ctx.tools.register(promoteKnowledgeTool(runtime)),
  ]
  ctx.effect(() => async () => {
    for (const dispose of disposers.reverse()) dispose()
    await runtime.dispose()
    runtime.store.close()
  }, 'autodev tools and state')
}

function createTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_create',
    description: 'Create a resumable AutoDev DRAFT run for a clean local Git repository. This only creates the immutable Plan; the exact Plan version must be explicitly approved in AutoDev before autodev_run can start.',
    parameters: {
      repo_path: { type: 'string', required: true, description: 'Absolute path to the target Git repository.' },
      request: { type: 'string', required: true, description: 'The software change to implement.' },
      mode: { type: 'string', enum: ['AUTO', 'EXPLORE', 'IMPACT', 'DEV', 'DEBUG', 'DATABASE', 'REFACTOR', 'TEST', 'REVIEW', 'RELEASE'], description: 'Optional explicit engineering mode. AUTO or omission enables intent classification; an explicitly selected mode always wins.' },
      acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Optional explicit acceptance checks.' },
      build_driver: { type: 'string', enum: ['maven', 'gradle', 'node', 'pytest'], description: 'Optional explicit Build/Test driver. Select one for a greenfield repository when project files will be generated inside the isolated Worktree; auto-detection requires root project markers.' },
      goal_id: { type: 'string', description: 'Optional existing DSH Goal id; Goal remains distinct from this execution Run.' },
      scope: {
        type: 'object',
        description: 'Optional project dimensions used to isolate module-, branch-, language-, and version-specific knowledge.',
        properties: {
          module: { type: 'string' },
          branch: { type: 'string' },
          language: { type: 'string' },
          projectVersion: { type: 'string' },
          schemaVersion: { type: 'string' },
          techStackVersion: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return await runtime.create({
        repoPath: args.repo_path,
        request: args.request,
        ...(args.mode === undefined ? {} : { mode: args.mode as AutoDevMode | 'AUTO' }),
        ...(args.acceptance_criteria === undefined ? {} : { acceptanceCriteria: args.acceptance_criteria }),
        ...(args.build_driver === undefined ? {} : { buildDriver: args.build_driver as BuildDriverId }),
        ...(args.goal_id === undefined ? {} : { goalId: args.goal_id }),
        ...(args.scope === undefined ? {} : { scope: args.scope }),
      }, exec.signal, exec.agent) as never
    },
    presentCall: args => ({ card: 'generic', title: 'Create AutoDev run', kind: 'other', rawInput: args.repo_path }),
  })
}

function runTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_run',
    description: 'Execute an explicitly approved AutoDev Plan in its dedicated Git Worktree. Replan creates a new DRAFT version that must be approved again. The implementation step uses the selected loaded Harness Coding Agent Provider; Build/Test use the project driver frozen into the Plan (Maven, Gradle, Node, or pytest). If anything is uncertain, the tool opens a Human Gate and retains the Worktree.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact run id returned by autodev_create.' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) { return await runtime.run(args.run_id, exec.agent, exec.signal) as never },
    presentCall: args => ({ card: 'generic', title: 'Run AutoDev plan', kind: 'other', rawInput: args.run_id }),
  })
}

function statusTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_status',
    description: 'Read the complete AutoDev snapshot: Run status, immutable Plan, node attempts, Candidate, Build/Test/Jev evidence, route decisions and Human Gates.',
    parameters: { run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' } },
    output: JSON_OUTPUT,
    execute(args) { return Promise.resolve(runtime.snapshot(args.run_id)) as never },
    presentCall: args => ({ card: 'generic', title: 'Read AutoDev status', kind: 'read', rawInput: args.run_id }),
  })
}

function listTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_routes',
    description: 'List Coding Agent Providers currently registered in Harness and their AutoDev availability. Use this before creating a run when route configuration may need adjustment.',
    parameters: {},
    output: JSON_OUTPUT,
    execute() { return Promise.resolve({ providers: runtime.listProviders(), routes: runtime.router.listRoutes() }) as never },
    presentCall: () => ({ card: 'generic', title: 'List AutoDev Providers', kind: 'read' }),
  })
}

function promoteTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_promote',
    description: 'Explicitly apply a verified AutoDev candidate patch to the original repository. This changes the user working tree and must only be called after the user has confirmed the Diff and verification evidence. For NEEDS_INTERVENTION, use autodev_resolve_gate with action promote so the Host can verify the Gate authorization.',
    parameters: { run_id: { type: 'string', required: true, description: 'Exact run id in VERIFY. For a Human Gate, use autodev_resolve_gate with action promote.' } },
    output: JSON_OUTPUT,
    async execute(args, exec) { return await runtime.promote(args.run_id, exec.signal) as never },
    presentCall: args => ({ card: 'generic', title: 'Promote AutoDev candidate', kind: 'other', rawInput: args.run_id }),
  })
}

function gateTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_resolve_gate',
    description: 'Resolve an open AutoDev Human Gate with an explicit bounded action: retry, rework, replan, promote, abandon, or cancel. The action must be one of the options shown by autodev_status.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact run id.' },
      action: { type: 'string', required: true, enum: ['retry', 'rework', 'replan', 'promote', 'abandon', 'cancel'], description: 'One action allowed by the open gate.' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return await runtime.resolveGate(args.run_id, args.action, exec.agent, exec.signal) as never
    },
    presentCall: args => ({ card: 'generic', title: 'Resolve AutoDev Human Gate', kind: 'other', rawInput: `${args.run_id}: ${args.action}` }),
  })
}

function cancelTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_cancel',
    description: 'Cancel an AutoDev run and retain its Worktree and artifacts for inspection. This does not modify the original repository.',
    parameters: { run_id: { type: 'string', required: true, description: 'Exact run id.' } },
    output: JSON_OUTPUT,
    async execute(args) { return await runtime.cancel(args.run_id) as never },
    presentCall: args => ({ card: 'generic', title: 'Cancel AutoDev run', kind: 'other', rawInput: args.run_id }),
  })
}

function memorySearchTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_memory_search',
    description: 'Search only the project-scoped AutoDev memory for a run. Results are bounded summaries; use autodev_memory_detail for one selected memory.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact AutoDev run id that supplies the project scope.' },
      query: { type: 'string', required: true, description: 'Short search query.' },
      limit: { type: 'number', description: 'Maximum number of results, bounded by the Host.' },
      max_chars: { type: 'number', description: 'Maximum content characters per result, bounded by the Host.' },
    },
    output: JSON_OUTPUT,
    execute(args) {
      const request = {
        runId: args.run_id,
        query: args.query,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.max_chars === undefined ? {} : { maxChars: args.max_chars }),
      }
      return Promise.resolve(runtime.remoteMemorySearch(request)) as never
    },
    presentCall: args => ({ card: 'generic', title: 'Search AutoDev project memory', kind: 'read', rawInput: args.query }),
  })
}

function memoryDetailTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_memory_detail',
    description: 'Read one project-memory record after a bounded memory search. The Host rejects cross-project ids.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' },
      memory_id: { type: 'string', required: true, description: 'Memory id returned by autodev_memory_search.' },
    },
    output: JSON_OUTPUT,
    execute(args) { return Promise.resolve(runtime.remoteMemoryDetail({ runId: args.run_id, memoryId: args.memory_id })) as never },
    presentCall: args => ({ card: 'generic', title: 'Read AutoDev memory detail', kind: 'read', rawInput: args.memory_id }),
  })
}

function semanticStateTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_semantic_state',
    description: 'Read assumptions and open semantic uncertainties for one AutoDev run. Uncertainty is distinct from execution failure.',
    parameters: { run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' } },
    output: JSON_OUTPUT,
    execute(args) { return Promise.resolve(runtime.remoteSemanticState(args.run_id)) as never },
    presentCall: args => ({ card: 'generic', title: 'Read AutoDev semantic state', kind: 'read', rawInput: args.run_id }),
  })
}

function resolveUncertaintyTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_resolve_uncertainty',
    description: 'Apply an explicit human semantic decision to one open uncertainty. This records the resolution and returns the authoritative run snapshot.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' },
      uncertainty_id: { type: 'string', required: true, description: 'Open uncertainty id from autodev_status or autodev_semantic_state.' },
      status: { type: 'string', required: true, enum: ['RESOLVED', 'DISMISSED'], description: 'Human resolution outcome.' },
      resolution: { type: 'string', required: true, description: 'Concise human explanation of the semantic decision.' },
    },
    output: JSON_OUTPUT,
    execute(args) {
      return Promise.resolve(runtime.remoteResolveUncertainty({
        runId: args.run_id,
        uncertaintyId: args.uncertainty_id,
        status: args.status,
        resolution: args.resolution,
      })) as never
    },
    presentCall: args => ({ card: 'generic', title: 'Resolve AutoDev semantic uncertainty', kind: 'other', rawInput: args.uncertainty_id }),
  })
}

function resolveAssumptionTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_resolve_assumption',
    description: 'Apply an explicit decision to a Runtime assumption and retain the supporting explanation in project history.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' },
      assumption_id: { type: 'string', required: true, description: 'Assumption id.' },
      status: { type: 'string', required: true, enum: ['CONFIRMED', 'INVALIDATED', 'UNKNOWN'], description: 'Human resolution outcome.' },
      resolution: { type: 'string', required: true, description: 'Concise explanation.' },
      evidence_ids: { type: 'array', items: { type: 'string' }, description: 'Optional Evidence ids from this exact Run and scope that support the decision.' },
    },
    output: JSON_OUTPUT,
    execute(args) {
      return Promise.resolve(runtime.remoteResolveAssumption({
        runId: args.run_id,
        assumptionId: args.assumption_id,
        status: args.status,
        resolution: args.resolution,
        ...(args.evidence_ids === undefined ? {} : { evidenceIds: args.evidence_ids }),
      })) as never
    },
    presentCall: args => ({ card: 'generic', title: 'Resolve AutoDev assumption', kind: 'other', rawInput: args.assumption_id }),
  })
}

function conceptsTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_concepts',
    description: 'List business concepts matched within the current run project. Concepts are semantic identities, not implementation guesses.',
    parameters: { run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' } },
    output: JSON_OUTPUT,
    execute(args) { return Promise.resolve(runtime.remoteConcepts(args.run_id)) as never },
    presentCall: args => ({ card: 'generic', title: 'Read AutoDev business concepts', kind: 'read', rawInput: args.run_id }),
  })
}

function conceptDetailTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_concept_detail',
    description: 'Read one project-scoped business concept after a bounded concept lookup.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' },
      concept_id: { type: 'string', required: true, description: 'Business concept id.' },
    },
    output: JSON_OUTPUT,
    execute(args) { return Promise.resolve(runtime.remoteConceptDetail({ runId: args.run_id, conceptId: args.concept_id })) as never },
    presentCall: args => ({ card: 'generic', title: 'Read AutoDev concept detail', kind: 'read', rawInput: args.concept_id }),
  })
}

function conceptHistoryTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_concept_history',
    description: 'Read the scoped observation and human-correction history for a Business Concept without replacing older interpretations.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' },
      concept_id: { type: 'string', required: true, description: 'Concept id returned by scoped concept search.' },
    },
    output: JSON_OUTPUT,
    execute(args) { return Promise.resolve(runtime.remoteConceptHistory({ runId: args.run_id, conceptId: args.concept_id })) as never },
    presentCall: args => ({ card: 'generic', title: 'Read Business Concept history', kind: 'read', rawInput: args.concept_id }),
  })
}

function observeConceptTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_observe_concept',
    description: 'Record a project-scoped candidate Business Concept observation. This creates a candidate only; it does not establish a rule.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' },
      key: { type: 'string', required: true, description: 'Stable concept key such as VOID or REFUND.' },
      name: { type: 'string', required: true, description: 'Human-readable name.' },
      definition: { type: 'string', required: true, description: 'Current candidate definition.' },
      target: { type: 'string', required: true, description: 'Business object affected.' },
      effect: { type: 'string', required: true, description: 'Business effect.' },
      evidence_summary: { type: 'string', required: true, description: 'What was observed.' },
      evidence_ids: { type: 'array', items: { type: 'string' }, description: 'Optional supporting Evidence ids.' },
      confidence: { type: 'number', description: 'Bounded candidate confidence.' },
    },
    output: JSON_OUTPUT,
    execute(args) {
      return Promise.resolve(runtime.remoteObserveConcept({
        runId: args.run_id,
        key: args.key,
        name: args.name,
        definition: args.definition,
        target: args.target,
        effect: args.effect,
        evidenceSummary: args.evidence_summary,
        ...(args.evidence_ids === undefined ? {} : { evidenceIds: args.evidence_ids }),
        ...(args.confidence === undefined ? {} : { confidence: args.confidence }),
      })) as never
    },
    presentCall: args => ({ card: 'generic', title: 'Observe AutoDev business concept', kind: 'other', rawInput: args.key }),
  })
}

function correctConceptTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_correct_concept',
    description: 'Record an explicit human Business Concept correction. Human input has the highest confidence and establishes the corrected concept version.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' },
      key: { type: 'string', required: true, description: 'Stable concept key.' },
      name: { type: 'string', required: true, description: 'Corrected name.' },
      definition: { type: 'string', required: true, description: 'Corrected definition.' },
      target: { type: 'string', required: true, description: 'Corrected target.' },
      effect: { type: 'string', required: true, description: 'Corrected effect.' },
      evidence_summary: { type: 'string', required: true, description: 'Human explanation or evidence summary.' },
      resolution: { type: 'string', required: true, description: 'Why this correction overrides the candidate interpretation.' },
      evidence_ids: { type: 'array', items: { type: 'string' }, description: 'Optional supporting Evidence ids.' },
    },
    output: JSON_OUTPUT,
    execute(args) {
      return Promise.resolve(runtime.remoteCorrectConcept({
        runId: args.run_id,
        key: args.key,
        name: args.name,
        definition: args.definition,
        target: args.target,
        effect: args.effect,
        evidenceSummary: args.evidence_summary,
        resolution: args.resolution,
        ...(args.evidence_ids === undefined ? {} : { evidenceIds: args.evidence_ids }),
      })) as never
    },
    presentCall: args => ({ card: 'generic', title: 'Correct AutoDev business concept', kind: 'other', rawInput: args.key }),
  })
}

function playbooksTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_playbooks',
    description: 'List advisory Playbooks available to the current project. A Playbook can inform planning but never proves completion or mutates a plan by itself.',
    parameters: { run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' } },
    output: JSON_OUTPUT,
    execute(args) { return Promise.resolve(runtime.remotePlaybooks(args.run_id)) as never },
    presentCall: args => ({ card: 'generic', title: 'Read AutoDev playbooks', kind: 'read', rawInput: args.run_id }),
  })
}

function playbookDetailTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_playbook_detail',
    description: 'Read one advisory Playbook in full only when the summary is insufficient or the task is high risk. The result does not change the Plan.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' },
      playbook_id: { type: 'string', required: true, description: 'Playbook id from autodev_playbooks.' },
      reason: { type: 'string', required: true, description: 'Why full Playbook detail is needed now.' },
    },
    output: JSON_OUTPUT,
    execute(args) { return Promise.resolve(runtime.remotePlaybookDetail({ runId: args.run_id, playbookId: args.playbook_id })) as never },
    presentCall: args => ({ card: 'generic', title: 'Read AutoDev playbook detail', kind: 'read', rawInput: args.playbook_id }),
  })
}

function knowledgeTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_knowledge',
    description: 'List project-scoped knowledge candidates and established knowledge. Candidates remain untrusted until evidence-backed promotion.',
    parameters: { run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' } },
    output: JSON_OUTPUT,
    execute(args) { return Promise.resolve(runtime.remoteKnowledge(args.run_id)) as never },
    presentCall: args => ({ card: 'generic', title: 'Read AutoDev knowledge', kind: 'read', rawInput: args.run_id }),
  })
}

function knowledgeSearchTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_knowledge_search',
    description: 'Search project-scoped knowledge with bounded hot/warm/cold retrieval. Candidates are advisory and are not verified facts until evidence-backed promotion.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact AutoDev run id; supplies the project scope.' },
      query: { type: 'string', required: true, description: 'The specific concept or implementation question to search.' },
      limit: { type: 'number', description: 'Maximum records to return (bounded by the Host).' },
      max_chars: { type: 'number', description: 'Maximum statement/content characters per record (bounded by the Host).' },
    },
    output: JSON_OUTPUT,
    execute(args) {
      return Promise.resolve(runtime.remoteKnowledgeSearch({
        runId: args.run_id, query: args.query,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.max_chars === undefined ? {} : { maxChars: args.max_chars }),
      })) as never
    },
    presentCall: args => ({ card: 'generic', title: 'Search scoped AutoDev knowledge', kind: 'read', rawInput: args.query }),
  })
}

function knowledgeDetailTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_knowledge_detail',
    description: 'Read one project-scoped knowledge record with source references and lifecycle counters.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' },
      knowledge_id: { type: 'string', required: true, description: 'Knowledge id from autodev_knowledge.' },
    },
    output: JSON_OUTPUT,
    execute(args) {
      return Promise.resolve(runtime.remoteKnowledgeDetail({
        runId: args.run_id,
        knowledgeId: args.knowledge_id,
      })) as never
    },
    presentCall: args => ({ card: 'generic', title: 'Read AutoDev knowledge detail', kind: 'read', rawInput: args.knowledge_id }),
  })
}

function knowledgeRegressionCasesTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_knowledge_regression_cases',
    description: 'List the regression cases applicable to one Run scope. A scoped knowledge promotion requires a fresh passing suite.',
    parameters: { run_id: { type: 'string', required: true, description: 'Exact AutoDev run id that supplies the project scope.' } },
    output: JSON_OUTPUT,
    execute(args) { return Promise.resolve(runtime.remoteKnowledgeRegressionCases(args.run_id)) as never },
    presentCall: args => ({ card: 'generic', title: 'List scoped knowledge regression cases', kind: 'read', rawInput: args.run_id }),
  })
}

function createKnowledgeRegressionTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_knowledge_regression_create',
    description: 'Create a regression case at the current Run scope, with required and optional forbidden knowledge statements.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' },
      name: { type: 'string', required: true, description: 'Short regression case name.' },
      query: { type: 'string', required: true, description: 'Query represented by this case.' },
      expected_statements: { type: 'array', required: true, items: { type: 'string' }, description: 'Statements that must be available.' },
      forbidden_statements: { type: 'array', items: { type: 'string' }, description: 'Statements that must not be available in this scope.' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return await runtime.remoteCreateKnowledgeRegression({
        runId: args.run_id, operationId: exec.callId, name: args.name, query: args.query, expectedStatements: args.expected_statements,
        ...(args.forbidden_statements === undefined ? {} : { forbiddenStatements: args.forbidden_statements }),
      }) as never
    },
    presentCall: args => ({ card: 'generic', title: 'Create knowledge regression case', kind: 'other', rawInput: args.name }),
  })
}

function runKnowledgeRegressionSuiteTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_knowledge_regression_run',
    description: 'Run every regression case applicable to the Run scope and return the authoritative results and aggregate PASS/FAIL/UNKNOWN suite status.',
    parameters: { run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' } },
    output: JSON_OUTPUT,
    async execute(args, exec) { return await runtime.remoteRunKnowledgeRegressionSuite(args.run_id, exec.callId) as never },
    presentCall: args => ({ card: 'generic', title: 'Run knowledge regression suite', kind: 'other', rawInput: args.run_id }),
  })
}

function compactKnowledgeTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_knowledge_compact',
    description: 'Run explicit project-scoped knowledge compaction. It deduplicates and deprecates records while preserving source references and never turns candidates into established knowledge.',
    parameters: { run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' } },
    output: JSON_OUTPUT,
    execute(args, exec) { return Promise.resolve(runtime.remoteCompactKnowledge(args.run_id, exec.callId)) as never },
    presentCall: args => ({ card: 'generic', title: 'Compact AutoDev knowledge', kind: 'other', rawInput: args.run_id }),
  })
}

function restoreKnowledgeCompactionTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_knowledge_restore_compaction',
    description: 'Restore a knowledge compaction report only when every affected record still has the version written by that compaction; newer edits are never overwritten.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact AutoDev run id used to enforce project scope.' },
      report_id: { type: 'string', required: true, description: 'Compaction report id from the scoped snapshot.' },
    },
    output: JSON_OUTPUT,
    execute(args) {
      return Promise.resolve(
        runtime.remoteRestoreKnowledgeCompaction({ runId: args.run_id, reportId: args.report_id }),
      ) as never
    },
    presentCall: args => ({ card: 'generic', title: 'Restore AutoDev knowledge compaction', kind: 'other', rawInput: args.report_id }),
  })
}

function promoteKnowledgeTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_knowledge_promote',
    description: 'Explicitly promote one scoped knowledge candidate after the caller supplies real passing Evidence ids and a fresh passing regression case.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact AutoDev run id used for project scope and audit.' },
      knowledge_id: { type: 'string', required: true, description: 'Knowledge candidate id.' },
      evidence_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Evidence ids that support this promotion.' },
      regression_case_id: { type: 'string', required: true, description: 'Regression case at exactly the candidate scope; the latest result must be PASS and include the current knowledge versions.' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      return await runtime.remotePromoteKnowledge({
        runId: args.run_id,
        knowledgeId: args.knowledge_id,
        evidenceIds: args.evidence_ids,
        regressionCaseId: args.regression_case_id,
      }) as never
    },
    presentCall: args => ({ card: 'generic', title: 'Promote AutoDev knowledge', kind: 'other', rawInput: args.knowledge_id }),
  })
}

/** Format the concise run identity and status shown by AutoDev tools.
 * @param snapshot Current AutoDev workspace snapshot.
 * @returns Run identifier followed by its lifecycle status.
 */
export function snapshotText(snapshot: AutoDevSnapshot): string {
  return `${snapshot.run.id} ${snapshot.run.status}`
}
