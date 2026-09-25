import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ArtifactRef, Evidence, KnowledgeCandidate, Run } from '../src/contracts.ts'
import { AutoDevStore } from '../src/store.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-autodev-migrations-${label}-`))
  roots.push(root)
  return root
}

interface VersionOneFixture {
  readonly run: Run
  readonly evidence: Evidence
  readonly knowledge: KnowledgeCandidate
  readonly artifact: ArtifactRef
  readonly artifactBytes: Buffer
}

function createVersionOneDatabase(root: string): VersionOneFixture {
  mkdirSync(root, { recursive: true })
  const database = new DatabaseSync(join(root, 'autodev.sqlite'))
  const now = new Date().toISOString()
  const artifactBytes = Buffer.from('legacy test output\n', 'utf8')
  const artifactSha256 = createHash('sha256').update(artifactBytes).digest('hex')
  const artifactPath = join(root, 'runs', 'legacy-run', 'artifacts', `${artifactSha256.slice(0, 16)}-test-output.txt`)
  const projectKey = 'legacy-project'
  mkdirSync(join(root, 'runs', 'legacy-run', 'artifacts'), { recursive: true })
  writeFileSync(artifactPath, artifactBytes)

  const run: Run = {
    schemaVersion: 1,
    id: 'legacy-run',
    repoPath: 'C:/legacy/repo',
    request: 'preserve the Alpha.2 project state',
    acceptanceCriteria: ['existing Run, Evidence, Knowledge, and Artifact remain readable'],
    status: 'CANCELLED',
    baseCommit: 'legacy-base-commit',
    repoRoot: 'C:/legacy/repo',
    projectKey,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
  }
  const evidence: Evidence = {
    id: 'legacy-evidence',
    runId: run.id,
    type: 'TEST',
    status: 'PASS',
    summary: 'legacy test evidence',
    artifactId: `${run.id}:${artifactSha256}`,
    source: 'command',
    createdAt: now,
  }
  const knowledge: KnowledgeCandidate = {
    id: 'legacy-knowledge',
    scope: { projectKey },
    kind: 'rule',
    statement: 'Keep legacy project knowledge available after upgrade',
    content: 'This record was persisted by the pre-migration store.',
    status: 'ESTABLISHED',
    confidence: 0.95,
    version: 1,
    sourceRefs: [{ sourceType: 'evidence', sourceId: evidence.id, runId: run.id, evidenceIds: [evidence.id] }],
    evidenceIds: [evidence.id],
    relatedMemoryIds: [],
    createdAt: now,
    updatedAt: now,
  }
  const artifact: ArtifactRef = {
    id: `${run.id}:${artifactSha256}`,
    runId: run.id,
    kind: 'test-output',
    path: artifactPath,
    sha256: artifactSha256,
    bytes: artifactBytes.byteLength,
    createdAt: now,
  }

  try {
    database.exec(`
      CREATE TABLE autodev_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE autodev_records (
        kind TEXT NOT NULL, id TEXT NOT NULL, run_id TEXT, value TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (kind, id)
      ) STRICT;
      CREATE INDEX autodev_records_run_idx ON autodev_records (run_id, kind, updated_at);
      CREATE TABLE autodev_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
        type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO autodev_meta (key, value) VALUES ('schema', '1');
    `)
    const insertRecord = database.prepare('INSERT INTO autodev_records VALUES (?, ?, ?, ?, ?, ?)')
    insertRecord.run('run', run.id, run.repoPath, JSON.stringify(run), run.createdAt, run.updatedAt)
    insertRecord.run('evidence', evidence.id, evidence.runId, JSON.stringify(evidence), evidence.createdAt, evidence.createdAt)
    insertRecord.run('knowledge', knowledge.id, knowledge.scope.projectKey, JSON.stringify(knowledge), knowledge.createdAt, knowledge.updatedAt)
    insertRecord.run('artifact', artifact.id, artifact.runId, JSON.stringify(artifact), artifact.createdAt, artifact.createdAt)

    const insertEvent = database.prepare('INSERT INTO autodev_events (run_id, type, payload, created_at) VALUES (?, ?, ?, ?)')
    insertEvent.run(run.id, 'run/created', JSON.stringify(run), run.createdAt)
    insertEvent.run(run.id, 'evidence/created', JSON.stringify(evidence), evidence.createdAt)
    insertEvent.run(knowledge.scope.projectKey, 'knowledge/updated', JSON.stringify(knowledge), knowledge.updatedAt)
    insertEvent.run(run.id, 'artifact/written', JSON.stringify(artifact), artifact.createdAt)
  } finally {
    database.close()
  }
  return { run, evidence, knowledge, artifact, artifactBytes }
}

describe('AutoDev SQLite migrations', () => {
  it('initializes a fresh database and records immutable migration signatures exactly once', () => {
    const root = tempRoot('fresh')
    const store = new AutoDevStore(root)
    try {
      const database = new DatabaseSync(join(root, 'autodev.sqlite'), { readOnly: true })
      try {
        expect(database.prepare('SELECT value FROM autodev_meta WHERE key = ?').get('schema')).toEqual({ value: '2' })
        const history = database.prepare('SELECT version, name, checksum FROM autodev_schema_migrations ORDER BY version').all() as {
          version: number
          name: string
          checksum: string
        }[]
        expect(history.map(row => [row.version, row.name])).toEqual([
          [1, 'initial-record-store'],
          [2, 'transactional-migration-history'],
        ])
        expect(history.every(row => /^[a-f0-9]{64}$/u.test(row.checksum))).toBe(true)
      } finally {
        database.close()
      }
    } finally {
      store.close()
    }

    const reopened = new AutoDevStore(root)
    try {
      const database = new DatabaseSync(join(root, 'autodev.sqlite'), { readOnly: true })
      try {
        expect(database.prepare('SELECT count(*) AS count FROM autodev_schema_migrations').get()).toEqual({ count: 2 })
      } finally {
        database.close()
      }
    } finally {
      reopened.close()
    }
  })

  it('upgrades an existing v1 database without changing its records or events', () => {
    const root = tempRoot('legacy-v1')
    const legacy = createVersionOneDatabase(root)
    const store = new AutoDevStore(root)
    try {
      expect(store.getRun(legacy.run.id)).toEqual(legacy.run)
      expect(store.getEvidence(legacy.evidence.id)).toEqual(legacy.evidence)
      expect(store.getKnowledge(legacy.knowledge.id)).toEqual(legacy.knowledge)
      expect(store.getArtifact(legacy.artifact.id)).toEqual(legacy.artifact)
      expect(store.readArtifact(legacy.artifact)).toEqual(legacy.artifactBytes)
      const events = store.events('legacy-run')
      expect(events.map(event => event.type)).toEqual(['run/created', 'evidence/created', 'artifact/written'])
      expect(store.events(legacy.knowledge.scope.projectKey).map(event => event.type)).toEqual(['knowledge/updated'])
      const database = new DatabaseSync(join(root, 'autodev.sqlite'), { readOnly: true })
      try {
        expect(database.prepare('SELECT value FROM autodev_meta WHERE key = ?').get('schema')).toEqual({ value: '2' })
        expect(database.prepare('SELECT count(*) AS count FROM autodev_records').get()).toEqual({ count: 4 })
        expect(database.prepare('SELECT count(*) AS count FROM autodev_events').get()).toEqual({ count: 4 })
        expect(database.prepare('SELECT version FROM autodev_schema_migrations ORDER BY version').all())
          .toEqual([{ version: 1 }, { version: 2 }])
      } finally {
        database.close()
      }
    } finally {
      store.close()
    }
  })

  it('rolls a failed migration back atomically and permits a later retry', () => {
    const root = tempRoot('rollback')
    const legacy = createVersionOneDatabase(root)
    const database = new DatabaseSync(join(root, 'autodev.sqlite'))
    database.exec(`
      CREATE TRIGGER reject_schema_upgrade BEFORE UPDATE OF value ON autodev_meta
      WHEN OLD.key = 'schema' AND NEW.value = '2'
      BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;
    `)
    database.close()

    expect(() => new AutoDevStore(root)).toThrow(/injected migration failure/u)
    const unchanged = new DatabaseSync(join(root, 'autodev.sqlite'))
    try {
      expect(unchanged.prepare('SELECT value FROM autodev_meta WHERE key = ?').get('schema')).toEqual({ value: '1' })
      expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get('autodev_schema_migrations')).toBeUndefined()
      expect(unchanged.prepare('SELECT count(*) AS count FROM autodev_records').get()).toEqual({ count: 4 })
      unchanged.exec('DROP TRIGGER reject_schema_upgrade')
    } finally {
      unchanged.close()
    }

    const recovered = new AutoDevStore(root)
    try {
      expect(recovered.getRun('legacy-run')?.request).toBe('preserve the Alpha.2 project state')
      expect(recovered.getEvidence('legacy-evidence')?.status).toBe('PASS')
      expect(recovered.getKnowledge('legacy-knowledge')?.status).toBe('ESTABLISHED')
      const recoveredArtifact = recovered.getArtifact(legacy.artifact.id)
      expect(recoveredArtifact).toEqual(legacy.artifact)
      expect(recovered.readArtifact(recoveredArtifact!).toString('utf8')).toBe(legacy.artifactBytes.toString('utf8'))
      const check = new DatabaseSync(join(root, 'autodev.sqlite'), { readOnly: true })
      try {
        expect(check.prepare('SELECT value FROM autodev_meta WHERE key = ?').get('schema')).toEqual({ value: '2' })
      } finally {
        check.close()
      }
    } finally {
      recovered.close()
    }
  })

  it('serializes concurrent process startup while upgrading one shared v1 database', { timeout: 90_000 }, async () => {
    const root = tempRoot('concurrent')
    const stateRoot = join(root, 'state')
    const workerRoot = join(root, 'workers')
    mkdirSync(workerRoot)
    createVersionOneDatabase(stateRoot)

    const workers = 8
    const startPath = join(workerRoot, 'start')
    const fixturePath = fileURLToPath(new URL('./fixtures/autodev-migration-open.ts', import.meta.url))
    const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const children: ReturnType<typeof spawn>[] = []
    const exits: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>[] = []
    try {
      for (let index = 0; index < workers; index++) {
        const readyPath = join(workerRoot, `ready-${index}`)
        const resultPath = join(workerRoot, `result-${index}.txt`)
        const failurePath = join(workerRoot, `failure-${index}.txt`)
        const child = spawn(process.execPath, [
          '--import', 'tsx/esm', fixturePath, stateRoot, String(index), readyPath, startPath, resultPath, failurePath,
        ], {
          cwd: workspaceRoot,
          env: { ...process.env, TSX_TSCONFIG_PATH: join(workspaceRoot, 'tsconfig.json') },
          stdio: 'ignore',
          windowsHide: true,
        })
        children.push(child)
        exits.push(new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal }))
        }))
      }

      const readyPaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `ready-${index}`))
      const resultPaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `result-${index}.txt`))
      const failurePaths = Array.from({ length: workers }, (_, index) => join(workerRoot, `failure-${index}.txt`))
      const readyDeadline = Date.now() + 60_000
      while (!readyPaths.every(existsSync)) {
        const failure = failurePaths.find(existsSync)
        if (failure !== undefined) throw new Error(`migration worker failed before barrier: ${readFileSync(failure, 'utf8')}`)
        if (Date.now() >= readyDeadline) throw new Error('migration workers did not reach the start barrier')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      writeFileSync(startPath, 'go')

      const resultDeadline = Date.now() + 60_000
      while (!resultPaths.every(existsSync)) {
        const failure = failurePaths.find(existsSync)
        if (failure !== undefined) throw new Error(`migration worker failed: ${readFileSync(failure, 'utf8')}`)
        if (Date.now() >= resultDeadline) throw new Error('concurrent migration workers did not finish')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(await Promise.all(exits)).toEqual(Array.from({ length: workers }, () => ({ code: 0, signal: null })))
      expect(resultPaths.map(path => readFileSync(path, 'utf8'))).toEqual(Array.from({ length: workers }, () => 'opened'))

      const check = new DatabaseSync(join(stateRoot, 'autodev.sqlite'), { readOnly: true })
      try {
        expect(check.prepare('SELECT value FROM autodev_meta WHERE key = ?').get('schema')).toEqual({ value: '2' })
        expect(check.prepare('SELECT count(*) AS count FROM autodev_schema_migrations').get()).toEqual({ count: 2 })
        expect(check.prepare('SELECT count(*) AS count FROM autodev_records').get()).toEqual({ count: 4 })
      } finally {
        check.close()
      }
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill()
      await Promise.allSettled(exits)
    }
  })

  it('rejects a database created by a newer AutoDev build without downgrading it', () => {
    const root = tempRoot('future-schema')
    createVersionOneDatabase(root)
    const database = new DatabaseSync(join(root, 'autodev.sqlite'))
    database.prepare('UPDATE autodev_meta SET value = ? WHERE key = ?').run('99', 'schema')
    database.close()

    expect(() => new AutoDevStore(root)).toThrow(/newer than supported schema/u)
    const check = new DatabaseSync(join(root, 'autodev.sqlite'), { readOnly: true })
    try {
      expect(check.prepare('SELECT value FROM autodev_meta WHERE key = ?').get('schema')).toEqual({ value: '99' })
    } finally {
      check.close()
    }
  })
})
