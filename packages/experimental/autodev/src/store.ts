/** Durable AutoDev state and content-addressed local artifacts. */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ArtifactRef,
  ActionIntent,
  Assumption,
  AutoDevSnapshot,
  BusinessConcept,
  CandidateRevision,
  ConceptObservation,
  Evidence,
  HumanGate,
  JevDecision,
  KnowledgeCandidate,
  KnowledgeCompactionReport,
  KnowledgeRegressionCase,
  KnowledgeRegressionResult,
  Playbook,
  PlaybookFit,
  ProjectMemory,
  SemanticUncertainty,
  SideEffectRecord,
  NodeExecution,
  PlanVersion,
  RouteDecision,
  Run,
  VerificationCheck,
  VerificationReport,
  VerificationResult,
} from './contracts.ts'
import type { AgentSignalEnvelope } from './protocol.ts'

type RecordKind =
  | 'run' | 'plan' | 'node' | 'candidate' | 'evidence' | 'route' | 'jev' | 'gate' | 'artifact' | 'signal'
  | 'verification-check' | 'verification-result' | 'verification'
  | 'memory' | 'assumption' | 'uncertainty' | 'concept' | 'concept-observation'
  | 'playbook' | 'playbook-fit' | 'knowledge' | 'compaction' | 'regression-case' | 'regression-result'
  | 'action-intent' | 'side-effect'

/** Resolve a stable default that follows the user's active Harness home. */
export function defaultDataRoot(): string {
  const dshHome = process.env.DSH_HOME
  return resolve(dshHome ?? join(homedir(), '.dsh'), 'autodev')
}

/** A small synchronous SQLite repository; the Host calls it from serialized state transitions. */
export class AutoDevStore {
  readonly root: string
  readonly dbPath: string
  readonly artifactsRoot: string
  private readonly db: DatabaseSync

  constructor(root: string = defaultDataRoot()) {
    this.root = resolve(root)
    this.dbPath = join(this.root, 'autodev.sqlite')
    this.artifactsRoot = join(this.root, 'runs')
    mkdirSync(this.root, { recursive: true })
    mkdirSync(this.artifactsRoot, { recursive: true })
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autodev_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS autodev_records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        run_id TEXT,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS autodev_records_run_idx
        ON autodev_records (run_id, kind, updated_at);
      CREATE TABLE IF NOT EXISTS autodev_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `)
    const version = this.db.prepare('SELECT value FROM autodev_meta WHERE key = ?').get('schema') as { value?: string } | undefined
    if (version === undefined) {
      this.db.prepare('INSERT INTO autodev_meta (key, value) VALUES (?, ?)').run('schema', '1')
    } else if (version.value !== '1') {
      throw new Error(`unsupported AutoDev database schema ${String(version.value)}`)
    }
  }

  close(): void {
    this.db.close()
  }

  createRun(run: Run): void {
    this.put('run', run.id, run.repoPath, run)
    this.event(run.id, 'run/created', run)
  }

  getRun(id: string): Run | undefined {
    return this.get<Run>('run', id)
  }

  listRuns(): Run[] {
    return this.list<Run>('run').sort((a: Run, b: Run) => b.updatedAt.localeCompare(a.updatedAt))
  }

  updateRun(id: string, update: (run: Run) => Run): Run {
    return this.transaction(() => {
      const current = this.getRun(id)
      if (current === undefined) throw new Error(`AutoDev run ${id} does not exist`)
      const next = update(current)
      this.put('run', id, next.repoPath, next)
      this.event(id, 'run/updated', { before: current, after: next })
      return next
    })
  }

  createPlan(plan: PlanVersion): void {
    this.put('plan', plan.id, plan.runId, plan)
    this.event(plan.runId, 'plan/created', plan)
  }

  getPlan(id: string): PlanVersion | undefined {
    return this.get<PlanVersion>('plan', id)
  }

  listPlans(runId: string): PlanVersion[] {
    return this.list<PlanVersion>('plan', runId).sort((a: PlanVersion, b: PlanVersion) => a.version - b.version)
  }

  createNode(node: NodeExecution): void {
    this.put('node', node.id, node.runId, node)
  }

  saveNode(node: NodeExecution): void {
    this.put('node', node.id, node.runId, node)
    this.event(node.runId, 'node/updated', node)
  }

  getNode(id: string): NodeExecution | undefined {
    return this.get<NodeExecution>('node', id)
  }

  listNodes(runId: string): NodeExecution[] {
    return this.list<NodeExecution>('node', runId).sort((a: NodeExecution, b: NodeExecution) => a.id.localeCompare(b.id))
  }

  saveCandidate(candidate: CandidateRevision): void {
    this.put('candidate', candidate.id, candidate.runId, candidate)
    this.event(candidate.runId, 'candidate/sealed', candidate)
  }

  getCandidate(id: string): CandidateRevision | undefined {
    return this.get<CandidateRevision>('candidate', id)
  }

  getArtifact(id: string): ArtifactRef | undefined {
    return this.get<ArtifactRef>('artifact', id)
  }

  listCandidates(runId: string): CandidateRevision[] {
    return this.list<CandidateRevision>('candidate', runId)
  }

  saveEvidence(evidence: Evidence): void {
    this.put('evidence', evidence.id, evidence.runId, evidence)
    this.event(evidence.runId, 'evidence/created', evidence)
  }

  listEvidence(runId: string): Evidence[] {
    return this.list<Evidence>('evidence', runId)
  }

  saveRouteDecision(decision: RouteDecision): void {
    this.put('route', decision.id, decision.runId ?? '', decision)
    if (decision.runId !== undefined) this.event(decision.runId, 'route/decided', decision)
  }

  saveJevDecision(decision: JevDecision): void {
    this.put('jev', decision.id, decision.runId ?? '', decision)
    if (decision.runId !== undefined) this.event(decision.runId, 'jev/decided', decision)
  }

  listDecisions(runId: string): (RouteDecision | JevDecision)[] {
    return [
      ...this.list<RouteDecision>('route', runId),
      ...this.list<JevDecision>('jev', runId),
    ].sort((a: RouteDecision | JevDecision, b: RouteDecision | JevDecision) => a.createdAt.localeCompare(b.createdAt))
  }

  saveGate(gate: HumanGate): void {
    this.put('gate', gate.id, gate.runId, gate)
    this.event(gate.runId, 'gate/updated', gate)
  }

  getGate(id: string): HumanGate | undefined {
    return this.get<HumanGate>('gate', id)
  }

  listGates(runId: string): HumanGate[] {
    return this.list<HumanGate>('gate', runId).sort((a: HumanGate, b: HumanGate) => a.createdAt.localeCompare(b.createdAt))
  }

  saveAgentSignal(signal: AgentSignalEnvelope): void {
    this.put('signal', signal.id, signal.runId, signal)
    this.event(signal.runId, 'agent/signal', signal)
  }

  listAgentSignals(runId: string): AgentSignalEnvelope[] {
    return this.list<AgentSignalEnvelope>('signal', runId).sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt))
  }

  saveVerificationCheck(check: VerificationCheck): void {
    this.put('verification-check', check.id, check.runId, check)
  }

  listVerificationChecks(runId: string): VerificationCheck[] {
    return this.list<VerificationCheck>('verification-check', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  saveVerificationResult(result: VerificationResult): void {
    this.put('verification-result', result.id, result.runId, result)
    this.event(result.runId, 'verification/result', result)
  }

  listVerificationResults(runId: string): VerificationResult[] {
    return this.list<VerificationResult>('verification-result', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  saveVerificationReport(report: VerificationReport): void {
    this.put('verification', report.id, report.runId, report)
    this.event(report.runId, 'verification/report', report)
  }

  listVerificationReports(runId: string): VerificationReport[] {
    return this.list<VerificationReport>('verification', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  saveMemory(memory: ProjectMemory): void {
    this.put('memory', memory.id, memory.scope.projectKey, memory)
    this.eventForScope(memory.scope.projectKey, 'memory/updated', memory)
  }

  getMemory(id: string): ProjectMemory | undefined {
    return this.get<ProjectMemory>('memory', id)
  }

  listMemories(projectKey?: string): ProjectMemory[] {
    return this.list<ProjectMemory>('memory', projectKey).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  saveAssumption(assumption: Assumption): void {
    this.put('assumption', assumption.id, assumption.runId ?? assumption.scope.projectKey, assumption)
    this.eventForScope(assumption.runId ?? assumption.scope.projectKey, 'assumption/updated', assumption)
  }

  getAssumption(id: string): Assumption | undefined {
    return this.get<Assumption>('assumption', id)
  }

  listAssumptions(runId?: string): Assumption[] {
    return this.list<Assumption>('assumption', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  saveUncertainty(uncertainty: SemanticUncertainty): void {
    this.put('uncertainty', uncertainty.id, uncertainty.runId, uncertainty)
    this.event(uncertainty.runId, 'uncertainty/updated', uncertainty)
  }

  getUncertainty(id: string): SemanticUncertainty | undefined {
    return this.get<SemanticUncertainty>('uncertainty', id)
  }

  listUncertainties(runId?: string): SemanticUncertainty[] {
    return this.list<SemanticUncertainty>('uncertainty', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  saveConcept(concept: BusinessConcept): void {
    this.put('concept', concept.id, concept.scope.projectKey, concept)
    this.eventForScope(concept.scope.projectKey, 'concept/updated', concept)
  }

  getConcept(id: string): BusinessConcept | undefined {
    return this.get<BusinessConcept>('concept', id)
  }

  listConcepts(projectKey?: string): BusinessConcept[] {
    return this.list<BusinessConcept>('concept', projectKey).sort((a, b) => a.key.localeCompare(b.key) || b.version - a.version)
  }

  saveConceptObservation(observation: ConceptObservation): void {
    this.put('concept-observation', observation.id, observation.scope.projectKey, observation)
    this.eventForScope(observation.scope.projectKey, 'concept/observed', observation)
  }

  listConceptObservations(projectKey?: string): ConceptObservation[] {
    return this.list<ConceptObservation>('concept-observation', projectKey).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  savePlaybook(playbook: Playbook): void {
    this.put('playbook', playbook.id, playbook.scope?.projectKey ?? '', playbook)
    this.eventForScope(playbook.scope?.projectKey ?? '', 'playbook/updated', playbook)
  }

  getPlaybook(id: string): Playbook | undefined {
    return this.get<Playbook>('playbook', id)
  }

  listPlaybooks(projectKey?: string): Playbook[] {
    const values = this.list<Playbook>('playbook')
    return values
      .filter(item => item.scope === undefined || projectKey === undefined || item.scope.projectKey === projectKey)
      .sort((a, b) => a.key.localeCompare(b.key) || b.version - a.version)
  }

  savePlaybookFit(fit: PlaybookFit): void {
    this.put('playbook-fit', fit.id, fit.runId ?? '', fit)
    if (fit.runId !== undefined) this.event(fit.runId, 'playbook/fit', fit)
  }

  listPlaybookFits(runId?: string): PlaybookFit[] {
    return this.list<PlaybookFit>('playbook-fit', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  saveKnowledge(candidate: KnowledgeCandidate): void {
    this.put('knowledge', candidate.id, candidate.scope.projectKey, candidate)
    this.eventForScope(candidate.scope.projectKey, 'knowledge/updated', candidate)
  }

  getKnowledge(id: string): KnowledgeCandidate | undefined {
    return this.get<KnowledgeCandidate>('knowledge', id)
  }

  listKnowledge(projectKey?: string): KnowledgeCandidate[] {
    return this.list<KnowledgeCandidate>('knowledge', projectKey).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  saveCompaction(report: KnowledgeCompactionReport): void {
    this.put('compaction', report.id, report.scope.projectKey, report)
    this.eventForScope(report.scope.projectKey, 'knowledge/compacted', report)
  }

  listCompactions(projectKey?: string): KnowledgeCompactionReport[] {
    return this.list<KnowledgeCompactionReport>('compaction', projectKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  saveRegressionCase(testCase: KnowledgeRegressionCase): void {
    this.put('regression-case', testCase.id, testCase.scope.projectKey, testCase)
    this.eventForScope(testCase.scope.projectKey, 'knowledge/regression-case', testCase)
  }

  getRegressionCase(id: string): KnowledgeRegressionCase | undefined {
    return this.get<KnowledgeRegressionCase>('regression-case', id)
  }

  listRegressionCases(projectKey?: string): KnowledgeRegressionCase[] {
    return this.list<KnowledgeRegressionCase>('regression-case', projectKey).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  saveRegressionResult(result: KnowledgeRegressionResult): void {
    this.put('regression-result', result.id, result.caseId, result)
    const testCase = this.getRegressionCase(result.caseId)
    if (testCase !== undefined) this.eventForScope(testCase.scope.projectKey, 'knowledge/regression-result', result)
  }

  listRegressionResults(caseId?: string): KnowledgeRegressionResult[] {
    return this.list<KnowledgeRegressionResult>('regression-result', caseId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  saveActionIntent(intent: ActionIntent): void {
    this.put('action-intent', intent.id, intent.runId, intent)
    this.event(intent.runId, 'action/updated', intent)
  }

  getActionIntent(id: string): ActionIntent | undefined {
    return this.get<ActionIntent>('action-intent', id)
  }

  listActionIntents(runId?: string): ActionIntent[] {
    return this.list<ActionIntent>('action-intent', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  saveSideEffect(effect: SideEffectRecord): void {
    this.put('side-effect', effect.id, effect.runId, effect)
    this.event(effect.runId, 'side-effect/updated', effect)
  }

  getSideEffect(id: string): SideEffectRecord | undefined {
    return this.get<SideEffectRecord>('side-effect', id)
  }

  listSideEffects(runId?: string): SideEffectRecord[] {
    return this.list<SideEffectRecord>('side-effect', runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Write an artifact below the run's private directory and return its digest. */
  writeArtifact(runId: string, kind: string, content: string | Uint8Array, extension: string = '.txt'): ArtifactRef {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const safeKind = kind.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'artifact'
    const safeExtension = extension.startsWith('.') ? extension.replace(/[^a-zA-Z0-9.]/g, '') : `.${extension}`
    const runDir = join(this.artifactsRoot, runId, 'artifacts')
    mkdirSync(runDir, { recursive: true })
    const path = join(runDir, `${sha256.slice(0, 16)}-${safeKind}${safeExtension}`)
    writeFileSync(path, bytes, { flag: 'w' })
    const artifact: ArtifactRef = {
      id: `${runId}:${sha256}`,
      runId,
      kind,
      path,
      sha256,
      bytes: bytes.byteLength,
      createdAt: new Date().toISOString(),
    }
    this.put('artifact', artifact.id, runId, artifact)
    this.event(runId, 'artifact/written', artifact)
    return artifact
  }

  readArtifact(artifact: ArtifactRef): Buffer {
    const root = resolve(this.artifactsRoot, artifact.runId)
    const target = resolve(artifact.path)
    const prefix = root.endsWith(sep) ? root : root + sep
    if (target !== root && !target.startsWith(prefix)) throw new Error('artifact path escapes its run directory')
    return readFileSync(target)
  }

  snapshot(runId: string): AutoDevSnapshot {
    const run = this.getRun(runId)
    if (run === undefined) throw new Error(`AutoDev run ${runId} does not exist`)
    const plans = this.listPlans(runId)
    const plan = run.activePlanId === undefined
      ? plans.at(-1)
      : this.getPlan(run.activePlanId)
    const candidate = run.candidateId === undefined ? undefined : this.getCandidate(run.candidateId)
    return {
      run,
      ...(plan === undefined ? {} : { plan }),
      nodes: this.listNodes(runId),
      ...(candidate === undefined ? {} : { candidate }),
      evidence: this.listEvidence(runId),
      decisions: this.listDecisions(runId),
      gates: this.listGates(runId),
      signals: this.listAgentSignals(runId),
      verificationChecks: this.listVerificationChecks(runId),
      verificationResults: this.listVerificationResults(runId),
      verifications: this.listVerificationReports(runId),
      memories: this.listMemories(run.projectKey ?? run.repoRoot),
      assumptions: this.listAssumptions(runId),
      uncertainties: this.listUncertainties(runId),
      concepts: this.listConcepts(run.projectKey ?? run.repoRoot),
      playbooks: this.listPlaybooks(run.projectKey ?? run.repoRoot),
      playbookFits: this.listPlaybookFits(runId),
      knowledge: this.listKnowledge(run.projectKey ?? run.repoRoot),
      compactions: this.listCompactions(run.projectKey ?? run.repoRoot),
      regressionResults: this.listRegressionCases(run.projectKey ?? run.repoRoot).flatMap(item => this.listRegressionResults(item.id)),
      actionIntents: this.listActionIntents(runId),
      sideEffects: this.listSideEffects(runId),
    }
  }

  events(runId: string): readonly { seq: number; type: string; payload: unknown; createdAt: string }[] {
    const rows = this.db.prepare(
      'SELECT seq, type, payload, created_at AS createdAt FROM autodev_events WHERE run_id = ? ORDER BY seq',
    ).all(runId) as { seq: number; type: string; payload: string; createdAt: string }[]
    return rows.map(row => ({ seq: row.seq, type: row.type, payload: parse(row.payload), createdAt: row.createdAt }))
  }

  private event(runId: string, type: string, payload: unknown): void {
    this.db.prepare(
      'INSERT INTO autodev_events (run_id, type, payload, created_at) VALUES (?, ?, ?, ?)',
    ).run(runId, type, JSON.stringify(payload), new Date().toISOString())
  }

  private eventForScope(scope: string, type: string, payload: unknown): void {
    if (scope !== '') this.event(scope, type, payload)
  }

  private put(kind: RecordKind, id: string, runId: string, value: unknown): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO autodev_records (kind, id, run_id, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, id) DO UPDATE SET value = excluded.value, run_id = excluded.run_id, updated_at = excluded.updated_at
    `).run(kind, id, runId || null, JSON.stringify(value), now, now)
  }

  private get<T>(kind: RecordKind, id: string): T | undefined {
    const row = this.db.prepare(
      'SELECT value FROM autodev_records WHERE kind = ? AND id = ?',
    ).get(kind, id) as { value?: string } | undefined
    return row?.value === undefined ? undefined : parse<T>(row.value)
  }

  private list<T>(kind: RecordKind, runId?: string): T[] {
    const rows = runId === undefined
      ? this.db.prepare('SELECT value FROM autodev_records WHERE kind = ?').all(kind)
      : this.db.prepare('SELECT value FROM autodev_records WHERE kind = ? AND run_id = ?').all(kind, runId)
    return (rows as { value: string }[]).map(row => parse<T>(row.value))
  }

  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      this.db.exec('COMMIT')
      return result
    } catch (error: unknown) {
      try { this.db.exec('ROLLBACK') } catch { /* preserve the original failure */ }
      throw error
    }
  }
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T
}
