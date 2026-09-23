/** Model-facing AutoDev tools. Promotion and gate resolution remain explicit calls. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AutoDevConfig, AutoDevSnapshot } from './contracts.ts'
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
    ctx.tools.register(observeConceptTool(runtime)),
    ctx.tools.register(correctConceptTool(runtime)),
    ctx.tools.register(playbooksTool(runtime)),
    ctx.tools.register(playbookDetailTool(runtime)),
    ctx.tools.register(knowledgeTool(runtime)),
    ctx.tools.register(knowledgeDetailTool(runtime)),
    ctx.tools.register(compactKnowledgeTool(runtime)),
    ctx.tools.register(promoteKnowledgeTool(runtime)),
  ]
  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) dispose()
    runtime.store.close()
  }, 'autodev tools and state')
}

function createTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_create',
    description: 'Create a resumable AutoDev run for a clean local Git repository. This only creates and validates the immutable plan; call autodev_run after the user has reviewed or accepted the plan.',
    parameters: {
      repo_path: { type: 'string', required: true, description: 'Absolute path to the target Git repository.' },
      request: { type: 'string', required: true, description: 'The software change to implement.' },
      acceptance_criteria: { type: 'array', items: { type: 'string' }, description: 'Optional explicit acceptance checks.' },
      goal_id: { type: 'string', description: 'Optional existing DSH Goal id; Goal remains distinct from this execution Run.' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return await runtime.create({
        repoPath: args.repo_path,
        request: args.request,
        ...(args.acceptance_criteria === undefined ? {} : { acceptanceCriteria: args.acceptance_criteria }),
        ...(args.goal_id === undefined ? {} : { goalId: args.goal_id }),
      }, exec.signal) as never
    },
    presentCall: args => ({ card: 'generic', title: 'Create AutoDev run', kind: 'other', rawInput: args.repo_path }),
  })
}

function runTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_run',
    description: 'Execute the current AutoDev plan in its dedicated Git Worktree. The implementation step uses the selected loaded Harness Coding Agent Provider; build and tests are deterministic Maven activities. If anything is uncertain, the tool opens a Human Gate and retains the Worktree.',
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
    description: 'Explicitly apply a verified AutoDev candidate patch to the original repository. This changes the user working tree and must only be called after the user has confirmed the Diff and verification evidence.',
    parameters: { run_id: { type: 'string', required: true, description: 'Exact run id in VERIFY or an explicitly approved Human Gate.' } },
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
    },
    output: JSON_OUTPUT,
    execute(args) {
      return Promise.resolve(runtime.remoteResolveAssumption({
        runId: args.run_id,
        assumptionId: args.assumption_id,
        status: args.status,
        resolution: args.resolution,
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
    description: 'Record an explicit human Business Concept correction. Human provenance has the highest confidence and establishes the corrected concept version.',
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

function knowledgeDetailTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_knowledge_detail',
    description: 'Read one project-scoped knowledge record with provenance and lifecycle counters.',
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

function compactKnowledgeTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_knowledge_compact',
    description: 'Run explicit project-scoped knowledge compaction. It deduplicates and deprecates records while preserving provenance and never turns candidates into established knowledge.',
    parameters: { run_id: { type: 'string', required: true, description: 'Exact AutoDev run id.' } },
    output: JSON_OUTPUT,
    execute(args) { return Promise.resolve(runtime.remoteCompactKnowledge(args.run_id)) as never },
    presentCall: args => ({ card: 'generic', title: 'Compact AutoDev knowledge', kind: 'other', rawInput: args.run_id }),
  })
}

function promoteKnowledgeTool(runtime: AutoDevRuntime) {
  return defineTool({
    name: 'autodev_knowledge_promote',
    description: 'Explicitly promote one project knowledge candidate after the caller supplies concrete Evidence ids and, optionally, a passing regression case.',
    parameters: {
      run_id: { type: 'string', required: true, description: 'Exact AutoDev run id used for project scope and audit.' },
      knowledge_id: { type: 'string', required: true, description: 'Knowledge candidate id.' },
      evidence_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Evidence ids that support this promotion.' },
      regression_case_id: { type: 'string', description: 'Optional regression case whose latest result must be PASS.' },
    },
    output: JSON_OUTPUT,
    async execute(args) {
      return await runtime.remotePromoteKnowledge({
        runId: args.run_id,
        knowledgeId: args.knowledge_id,
        evidenceIds: args.evidence_ids,
        ...(args.regression_case_id === undefined ? {} : { regressionCaseId: args.regression_case_id }),
      }) as never
    },
    presentCall: args => ({ card: 'generic', title: 'Promote AutoDev knowledge', kind: 'other', rawInput: args.knowledge_id }),
  })
}

export function snapshotText(snapshot: AutoDevSnapshot): string {
  return `${snapshot.run.id} ${snapshot.run.status}`
}
