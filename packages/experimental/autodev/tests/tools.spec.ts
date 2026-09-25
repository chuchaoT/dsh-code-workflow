import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as AutoDevTools from '../src/tools.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-autodev-tools-'))
  roots.push(root)
  return root
}

describe('AutoDev DSH Tool Runtime composition', () => {
  it('registers and executes scoped knowledge regression tools through the DSH registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(
      { name: AutoDevTools.name, inject: AutoDevTools.inject, apply: AutoDevTools.apply },
      { dataRoot: tempRoot() },
    )
    try {
      const names = ctx.tools.schemas().map(schema => schema.name)
      expect(names).toContain('autodev_knowledge_search')
      expect(names).toContain('autodev_knowledge_regression_cases')
      expect(names).toContain('autodev_knowledge_regression_create')
      expect(names).toContain('autodev_knowledge_regression_run')
      expect(names).toContain('autodev_knowledge_restore_compaction')
      expect(names).toContain('autodev_knowledge_promote')
      expect(names).toContain('autodev_concept_history')
      const createSchema = ctx.tools.schemas().find(schema => schema.name === 'autodev_create')
      expect(JSON.stringify(createSchema)).toContain('"AUTO"')
      expect(JSON.stringify(createSchema)).toContain('"DEBUG"')

      const now = new Date().toISOString()
      const runId = 'tool-composition-run'
      const scope = { projectKey: 'tool-composition-project', module: 'web', branch: 'main' }
      ctx.autodev.store.createRun({
        schemaVersion: 1, id: runId, repoPath: scope.projectKey, request: 'exercise scoped knowledge tools', acceptanceCriteria: [],
        status: 'DRAFT', baseCommit: 'fixture-base', repoRoot: scope.projectKey, projectKey: scope.projectKey, scope,
        attempt: 0, createdAt: now, updatedAt: now,
      })
      ctx.autodev.knowledge.candidate({ scope, kind: 'rule', statement: 'scoped tools see only this module rule' })

      const knowledgeHits = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('knowledge-search'),
        name: 'autodev_knowledge_search',
        arguments: { run_id: runId, query: 'module rule', limit: 5, max_chars: 80 },
      })
      expect(JSON.stringify(knowledgeHits)).toContain('scoped tools see only this module rule')

      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('knowledge-case-create'),
        name: 'autodev_knowledge_regression_create',
        arguments: { run_id: runId, name: 'module rule', query: 'module rule', expected_statements: ['scoped tools see only this module rule'] },
      })
      expect(ctx.autodev.snapshot(runId).regressionCases).toHaveLength(1)
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('knowledge-case-create'),
        name: 'autodev_knowledge_regression_create',
        arguments: { run_id: runId, name: 'module rule', query: 'module rule', expected_statements: ['scoped tools see only this module rule'] },
      })
      expect(ctx.autodev.snapshot(runId).regressionCases).toHaveLength(1)
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('knowledge-case-create-revised'),
        name: 'autodev_knowledge_regression_create',
        arguments: { run_id: runId, name: 'module rule revised', query: 'module rule', expected_statements: ['scoped tools see only this module rule'] },
      })
      expect(ctx.autodev.snapshot(runId).regressionCases).toHaveLength(2)

      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('knowledge-suite-run'),
        name: 'autodev_knowledge_regression_run',
        arguments: { run_id: runId },
      })
      expect(ctx.autodev.snapshot(runId).regressionSuites[0]?.status).toBe('PASS')
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('knowledge-suite-run'),
        name: 'autodev_knowledge_regression_run',
        arguments: { run_id: runId },
      })
      expect(ctx.autodev.snapshot(runId).regressionSuites).toHaveLength(1)
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('knowledge-suite-rerun'),
        name: 'autodev_knowledge_regression_run',
        arguments: { run_id: runId },
      })
      expect(ctx.autodev.snapshot(runId).regressionSuites).toHaveLength(2)

      const concept = ctx.autodev.concepts.observe({
        scope, key: 'refund', name: 'Refund', definition: 'Payment reversal', target: 'captured payment', effect: 'reverse balance', evidenceSummary: 'candidate observation',
      }).concept
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('concept-history-read'),
        name: 'autodev_concept_history',
        arguments: { run_id: runId, concept_id: concept.id },
      })
      expect(ctx.autodev.snapshot(runId).conceptObservations.some(item => item.conceptId === concept.id)).toBe(true)

      ctx.autodev.knowledge.candidate({ scope, kind: 'rule', statement: 'restore through the DSH tool registry' })
      ctx.autodev.knowledge.candidate({ scope, kind: 'rule', statement: 'restore through the DSH tool registry', content: 'duplicate fixture' })
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('knowledge-compaction'),
        name: 'autodev_knowledge_compact',
        arguments: { run_id: runId },
      })
      const report = ctx.autodev.snapshot(runId).compactions[0]
      if (report === undefined) throw new Error('Knowledge compaction tool did not create a report')
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('knowledge-compaction'),
        name: 'autodev_knowledge_compact',
        arguments: { run_id: runId },
      })
      expect(ctx.autodev.snapshot(runId).compactions).toHaveLength(1)
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('knowledge-compaction-new-operation'),
        name: 'autodev_knowledge_compact',
        arguments: { run_id: runId },
      })
      expect(ctx.autodev.snapshot(runId).compactions).toHaveLength(2)
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('knowledge-compaction-restore'),
        name: 'autodev_knowledge_restore_compaction',
        arguments: { run_id: runId, report_id: report.id },
      })
      expect(ctx.autodev.store.getCompaction(report.id)?.restoredAt).toBeDefined()
    } finally {
      await fiber.dispose()
    }
  })
})
