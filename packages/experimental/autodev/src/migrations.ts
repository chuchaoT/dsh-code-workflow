/** Ordered, transactional SQLite migrations for AutoDev durable state. */

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

interface StoreMigration {
  readonly version: number
  readonly name: string
  readonly sql: string
  readonly checksum: string
}

const INITIAL_SCHEMA_SQL = `
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
`

const MIGRATION_HISTORY_SQL = `
  CREATE TABLE IF NOT EXISTS autodev_schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  ) STRICT;
`

const MIGRATIONS: readonly StoreMigration[] = [
  migration(1, 'initial-record-store', INITIAL_SCHEMA_SQL),
  migration(2, 'transactional-migration-history', MIGRATION_HISTORY_SQL),
]

/** Current version of the AutoDev SQLite store schema (not Run serialization). */
const latestMigration = MIGRATIONS.at(-1)
if (latestMigration === undefined) throw new Error('AutoDev store migrations must not be empty')

export const AUTODEV_STORE_SCHEMA_VERSION = latestMigration.version

/**
 * Upgrade an AutoDev SQLite database to the current schema without discarding
 * existing records. Each migration re-reads the version under an immediate
 * transaction so concurrent Hosts cannot apply the same migration twice.
 * @param database Open AutoDev SQLite database.
 */
export function migrateAutoDevDatabase(database: DatabaseSync): void {
  while (true) {
    database.exec('BEGIN IMMEDIATE')
    try {
      const currentVersion = readSchemaVersion(database)
      if (currentVersion > AUTODEV_STORE_SCHEMA_VERSION) {
        throw new Error(`AutoDev database schema ${currentVersion} is newer than supported schema ${AUTODEV_STORE_SCHEMA_VERSION}`)
      }
      validateMigrationHistory(database, currentVersion)
      if (currentVersion === AUTODEV_STORE_SCHEMA_VERSION) {
        database.exec('COMMIT')
        return
      }

      const nextMigration = MIGRATIONS.find(item => item.version === currentVersion + 1)
      if (nextMigration === undefined) throw new Error(`AutoDev database has no migration from schema ${currentVersion}`)
      database.exec(nextMigration.sql)
      writeSchemaVersion(database, nextMigration.version)
      recordAvailableMigrations(database, nextMigration.version)
      database.exec('COMMIT')
    } catch (error: unknown) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // Preserve the migration failure if SQLite already rolled back the transaction.
      }
      throw error
    }
  }
}

function migration(version: number, name: string, sql: string): StoreMigration {
  return { version, name, sql, checksum: createHash('sha256').update(sql).digest('hex') }
}

function readSchemaVersion(database: DatabaseSync): number {
  if (!tableExists(database, 'autodev_meta')) return 0
  const row = database.prepare('SELECT value FROM autodev_meta WHERE key = ?').get('schema') as { value?: string } | undefined
  if (row === undefined) return 0
  const version = Number(row.value)
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('AutoDev database schema version is invalid')
  return version
}

function writeSchemaVersion(database: DatabaseSync, version: number): void {
  database.prepare(`
    INSERT INTO autodev_meta (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run('schema', String(version))
}

function recordAvailableMigrations(database: DatabaseSync, throughVersion: number): void {
  if (!tableExists(database, 'autodev_schema_migrations')) return
  const recordedAt = new Date().toISOString()
  const insert = database.prepare(`
    INSERT INTO autodev_schema_migrations (version, name, checksum, recorded_at)
    VALUES (?, ?, ?, ?)
  `)
  for (const item of MIGRATIONS) {
    if (item.version <= throughVersion && !migrationRecorded(database, item.version)) {
      insert.run(item.version, item.name, item.checksum, recordedAt)
    }
  }
}

function validateMigrationHistory(database: DatabaseSync, currentVersion: number): void {
  const hasHistory = tableExists(database, 'autodev_schema_migrations')
  if (!hasHistory) {
    if (currentVersion >= 2) throw new Error('AutoDev migration history is missing from a migrated database')
    return
  }

  const rows = database.prepare('SELECT version, name, checksum FROM autodev_schema_migrations ORDER BY version').all() as {
    version: number
    name: string
    checksum: string
  }[]
  const expected = MIGRATIONS.filter(item => item.version <= currentVersion)
  if (rows.length !== expected.length) throw new Error('AutoDev migration history does not match its schema version')
  for (const [index, item] of expected.entries()) {
    const row = rows[index]
    if (row?.version !== item.version || row.name !== item.name || row.checksum !== item.checksum) {
      throw new Error(`AutoDev migration history is invalid at schema ${item.version}`)
    }
  }
}

function migrationRecorded(database: DatabaseSync, version: number): boolean {
  return database.prepare('SELECT 1 AS present FROM autodev_schema_migrations WHERE version = ?').get(version) !== undefined
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return database.prepare('SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ?').get('table', name) !== undefined
}
