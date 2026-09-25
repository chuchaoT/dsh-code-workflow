/** Portable, verified snapshots of AutoDev's durable database and Run artifacts. */

import { createHash } from 'node:crypto'
import { constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ArtifactRef, AutoDevBackupFile, AutoDevBackupManifest } from './contracts.ts'
import { AUTODEV_STORE_SCHEMA_VERSION } from './migrations.ts'
import type { AutoDevStore } from './store.ts'

interface ArtifactRow {
  readonly id: string
  readonly value: string
}

interface Digest {
  readonly bytes: number
  readonly sha256: string
}

const MANIFEST_FILE = 'manifest.json'
const DATABASE_FILE = 'autodev.sqlite'
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u

/**
 * Create a point-in-time database snapshot plus every Artifact referenced by
 * that snapshot. The completed directory is published by a same-volume rename;
 * an existing destination or any overlap with the live data root is rejected.
 * Worktrees and original repositories are intentionally not copied.
 *
 * @param store Open AutoDev Store to snapshot.
 * @param destinationPath New directory path outside the Store root.
 * @param signal Optional cancellation signal checked between I/O phases before atomic publication.
 * @returns The manifest written into the completed backup directory.
 */
export async function createAutoDevBackup(
  store: AutoDevStore,
  destinationPath: string,
  signal?: AbortSignal,
): Promise<AutoDevBackupManifest> {
  signal?.throwIfAborted()
  const { destination, parent } = resolveNewSibling(destinationPath, 'backup')
  const sourceRoot = realDirectory(store.root, 'AutoDev data root')
  if (pathsOverlap(sourceRoot, destination)) throw new Error('AutoDev backup destination must be outside the live data root')
  if (pathEntryExists(destination)) throw new Error(`AutoDev backup destination already exists: ${destination}`)

  const artifactsRoot = realDirectory(store.artifactsRoot, 'AutoDev artifact root')
  const tempPrefix = `.autodev-backup-${basename(destination)}-`
  const temporary = mkdtempSync(join(parent, tempPrefix))
  try {
    const databasePath = join(temporary, DATABASE_FILE)
    store.createDatabaseSnapshot(databasePath)
    signal?.throwIfAborted()
    const database = new DatabaseSync(databasePath)
    let artifactRows: readonly ArtifactRow[]
    let schemaVersion: number
    try {
      schemaVersion = assertDatabaseIntegrity(database)
      artifactRows = database.prepare('SELECT id, value FROM autodev_records WHERE kind = ? ORDER BY id').all('artifact') as unknown as ArtifactRow[]
    } finally {
      database.close()
    }
    if (schemaVersion !== AUTODEV_STORE_SCHEMA_VERSION) throw new Error(`unsupported AutoDev database schema ${schemaVersion}`)

    const files: AutoDevBackupFile[] = []
    const artifactPaths = new Map<string, string>()
    for (const row of artifactRows) {
      signal?.throwIfAborted()
      const artifact = parseArtifactRef(row.value, row.id)
      const sourceFile = validateSourceArtifact(artifact, artifactsRoot)
      const relativePath = artifactBackupPath(artifact, sourceFile, artifactsRoot)
      const destinationFile = resolveManifestPath(temporary, relativePath)
      mkdirSync(dirname(destinationFile), { recursive: true })
      copyFileSync(sourceFile, destinationFile, constants.COPYFILE_EXCL)
      const digest = await digestFile(destinationFile, signal)
      if (digest.bytes !== artifact.bytes || digest.sha256 !== artifact.sha256) {
        throw new Error(`Artifact ${artifact.id} failed integrity verification while backing up`)
      }
      files.push({ path: relativePath, ...digest })
      artifactPaths.set(artifact.id, relativePath)
    }

    rebaseArtifactPaths(databasePath, artifactPaths, relativePath => relativePath)
    const databaseDigest = await digestFile(databasePath, signal)
    files.push({ path: DATABASE_FILE, ...databaseDigest })
    files.sort((a, b) => a.path.localeCompare(b.path))
    const manifest: AutoDevBackupManifest = {
      formatVersion: 1,
      databaseSchemaVersion: AUTODEV_STORE_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      included: ['sqlite', 'run-artifacts'],
      excluded: ['git-worktrees'],
      files,
    }
    signal?.throwIfAborted()
    writeFileSync(join(temporary, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    signal?.throwIfAborted()
    if (pathEntryExists(destination)) throw new Error(`AutoDev backup destination appeared during backup: ${destination}`)
    renameSync(temporary, destination)
    return manifest
  } catch (error: unknown) {
    removeOwnedTemporary(temporary, parent, tempPrefix)
    throw error
  }
}

/**
 * Restore a verified snapshot into a brand-new data root. Existing destinations
 * are never overwritten. Artifact records are rebased to the new root; Git
 * Worktrees remain external and are not recreated by this operation.
 *
 * @param backupPath Existing, verified AutoDev backup directory.
 * @param targetDataRoot New, nonexistent AutoDev data root.
 * @param signal Optional cancellation signal checked between I/O phases before atomic publication.
 * @returns The manifest that was verified and restored.
 */
export async function restoreAutoDevBackup(
  backupPath: string,
  targetDataRoot: string,
  signal?: AbortSignal,
): Promise<AutoDevBackupManifest> {
  signal?.throwIfAborted()
  const sourceRoot = realDirectory(backupPath, 'AutoDev backup source')
  const { destination, parent } = resolveNewSibling(targetDataRoot, 'restore target')
  if (pathsOverlap(sourceRoot, destination)) throw new Error('AutoDev restore target must not overlap the backup source')
  if (pathEntryExists(destination)) throw new Error(`AutoDev restore target already exists: ${destination}`)

  const manifest = readManifest(sourceRoot)
  const manifestEntries = new Map(manifest.files.map(file => [file.path, file]))
  const actualPaths = listBackupFiles(sourceRoot).filter(path => path !== MANIFEST_FILE).sort()
  const expectedPaths = [...manifestEntries.keys()].sort()
  if (!sameStrings(actualPaths, expectedPaths)) throw new Error('AutoDev backup files do not match its manifest')
  for (const entry of manifest.files) {
    signal?.throwIfAborted()
    const sourceFile = resolveManifestPath(sourceRoot, entry.path)
    const actual = await digestFile(sourceFile, signal)
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      throw new Error(`AutoDev backup file failed integrity verification: ${entry.path}`)
    }
  }

  const backupDbPath = resolveManifestPath(sourceRoot, DATABASE_FILE)
  const backupDatabase = new DatabaseSync(backupDbPath, { readOnly: true })
  let artifactRows: readonly ArtifactRow[]
  try {
    const schemaVersion = assertDatabaseIntegrity(backupDatabase)
    if (schemaVersion !== manifest.databaseSchemaVersion) throw new Error('AutoDev backup schema version does not match its manifest')
    artifactRows = backupDatabase.prepare('SELECT id, value FROM autodev_records WHERE kind = ? ORDER BY id').all('artifact') as unknown as ArtifactRow[]
  } finally {
    backupDatabase.close()
  }
  const artifactPaths = validateBackupArtifactRows(artifactRows, manifestEntries)

  const tempPrefix = `.autodev-restore-${basename(destination)}-`
  const temporary = mkdtempSync(join(parent, tempPrefix))
  try {
    for (const entry of manifest.files) {
      signal?.throwIfAborted()
      const sourceFile = resolveManifestPath(sourceRoot, entry.path)
      const destinationFile = resolveManifestPath(temporary, entry.path)
      mkdirSync(dirname(destinationFile), { recursive: true })
      copyFileSync(sourceFile, destinationFile, constants.COPYFILE_EXCL)
      const copied = await digestFile(destinationFile, signal)
      if (copied.bytes !== entry.bytes || copied.sha256 !== entry.sha256) {
        throw new Error(`AutoDev backup file changed during restore: ${entry.path}`)
      }
    }

    const restoredDbPath = join(temporary, DATABASE_FILE)
    const restoredDatabase = new DatabaseSync(restoredDbPath)
    try {
      restoredDatabase.exec('BEGIN IMMEDIATE')
      try {
        for (const [artifactId, relativePath] of artifactPaths) {
          const finalPath = resolveManifestPath(destination, relativePath)
          const row = restoredDatabase.prepare('SELECT value FROM autodev_records WHERE kind = ? AND id = ?').get('artifact', artifactId) as { value?: string } | undefined
          if (row?.value === undefined) throw new Error(`AutoDev backup lost Artifact ${artifactId} during restore`)
          const artifact = parseArtifactRef(row.value, artifactId)
          restoredDatabase.prepare('UPDATE autodev_records SET value = ? WHERE kind = ? AND id = ?')
            .run(JSON.stringify({ ...artifact, path: finalPath }), 'artifact', artifactId)
        }
        restoredDatabase.exec('COMMIT')
      } catch (error: unknown) {
        restoredDatabase.exec('ROLLBACK')
        throw error
      }
      const schemaVersion = assertDatabaseIntegrity(restoredDatabase)
      if (schemaVersion !== AUTODEV_STORE_SCHEMA_VERSION) {
        throw new Error(`unsupported AutoDev database schema ${schemaVersion}`)
      }
    } finally {
      restoredDatabase.close()
    }

    if (pathEntryExists(destination)) throw new Error(`AutoDev restore target appeared during restore: ${destination}`)
    signal?.throwIfAborted()
    renameSync(temporary, destination)
    return manifest
  } catch (error: unknown) {
    removeOwnedTemporary(temporary, parent, tempPrefix)
    throw error
  }
}

function readManifest(root: string): AutoDevBackupManifest {
  const path = join(root, MANIFEST_FILE)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('AutoDev backup manifest must be a regular file')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error: unknown) {
    throw new Error(`AutoDev backup manifest is invalid JSON: ${errorMessage(error)}`)
  }
  if (!isRecord(parsed) || parsed.formatVersion !== 1
    || parsed.databaseSchemaVersion !== AUTODEV_STORE_SCHEMA_VERSION
    || typeof parsed.createdAt !== 'string'
    || !sameStrings(parsed.included, ['sqlite', 'run-artifacts'])
    || !sameStrings(parsed.excluded, ['git-worktrees'])
    || !Array.isArray(parsed.files)) {
    throw new Error('AutoDev backup manifest has an unsupported format or scope')
  }
  const files: AutoDevBackupFile[] = []
  const seen = new Set<string>()
  for (const value of parsed.files) {
    if (!isRecord(value) || typeof value.path !== 'string' || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0
      || typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
      throw new Error('AutoDev backup manifest contains an invalid file entry')
    }
    validateManifestFilePath(value.path)
    if (seen.has(value.path)) throw new Error(`AutoDev backup manifest repeats file ${value.path}`)
    seen.add(value.path)
    files.push({ path: value.path, bytes: value.bytes as number, sha256: value.sha256 })
  }
  if (!seen.has(DATABASE_FILE) || files.some(file => file.path !== DATABASE_FILE && !isArtifactBackupPath(file.path))) {
    throw new Error('AutoDev backup manifest must contain one database and only Run artifacts')
  }
  return {
    formatVersion: 1,
    databaseSchemaVersion: AUTODEV_STORE_SCHEMA_VERSION,
    createdAt: parsed.createdAt,
    included: ['sqlite', 'run-artifacts'],
    excluded: ['git-worktrees'],
    files,
  }
}

function assertDatabaseIntegrity(database: DatabaseSync): number {
  const result = database.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined
  if (result === undefined || Object.values(result)[0] !== 'ok') throw new Error('AutoDev database failed SQLite integrity_check')
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all()
  if (foreignKeys.length > 0) throw new Error('AutoDev database failed SQLite foreign_key_check')
  const schema = database.prepare('SELECT value FROM autodev_meta WHERE key = ?').get('schema') as { value?: string } | undefined
  const version = Number(schema?.value)
  if (!Number.isInteger(version) || version < 1) throw new Error('AutoDev database schema version is missing or invalid')
  if (version !== AUTODEV_STORE_SCHEMA_VERSION) throw new Error(`unsupported AutoDev database schema ${version}`)
  return version
}

function parseArtifactRef(json: string, recordId: string): ArtifactRef {
  let value: unknown
  try {
    value = JSON.parse(json) as unknown
  } catch (error: unknown) {
    throw new Error(`Artifact record ${recordId} is invalid JSON: ${errorMessage(error)}`)
  }
  if (!isRecord(value) || typeof value.id !== 'string' || value.id !== recordId
    || typeof value.runId !== 'string' || !RUN_ID_PATTERN.test(value.runId)
    || typeof value.kind !== 'string' || typeof value.path !== 'string'
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0
    || typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)
    || typeof value.createdAt !== 'string') {
    throw new Error(`Artifact record ${recordId} has invalid metadata`)
  }
  return value as unknown as ArtifactRef
}

function validateSourceArtifact(artifact: ArtifactRef, artifactsRoot: string): string {
  if (!isAbsolute(artifact.path)) throw new Error(`Artifact ${artifact.id} does not have a Host-local path`)
  const source = resolve(artifact.path)
  if (!isWithin(artifactsRoot, source) || source === artifactsRoot) throw new Error(`Artifact ${artifact.id} escapes the AutoDev artifact root`)
  const relativePath = relative(artifactsRoot, source).split(sep)
  if (relativePath.length !== 3 || relativePath[0] !== artifact.runId || relativePath[1] !== 'artifacts' || relativePath[2] === '') {
    throw new Error(`Artifact ${artifact.id} is outside its Run artifact directory`)
  }
  const stat = lstatSync(source)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Artifact ${artifact.id} is not a regular file`)
  if (!isWithin(artifactsRoot, realpathSync(source))) throw new Error(`Artifact ${artifact.id} resolves outside the AutoDev artifact root`)
  return source
}

function artifactBackupPath(artifact: ArtifactRef, source: string, artifactsRoot: string): string {
  const relativePath = relative(artifactsRoot, source).split(sep)
  if (relativePath[0] !== artifact.runId || relativePath.length !== 3) throw new Error(`Artifact ${artifact.id} has an invalid stored path`)
  const path = `runs/${artifact.runId}/artifacts/${relativePath[2]}`
  validateManifestFilePath(path)
  return path
}

function validateBackupArtifactRows(rows: readonly ArtifactRow[], files: ReadonlyMap<string, AutoDevBackupFile>): Map<string, string> {
  const artifactPaths = new Map<string, string>()
  for (const row of rows) {
    const artifact = parseArtifactRef(row.value, row.id)
    validateManifestFilePath(artifact.path)
    if (!isArtifactBackupPath(artifact.path)) throw new Error(`Artifact ${artifact.id} has a non-portable backup path`)
    const file = files.get(artifact.path)
    if (file === undefined || file.bytes !== artifact.bytes || file.sha256 !== artifact.sha256) {
      throw new Error(`Artifact ${artifact.id} does not match the backup manifest`)
    }
    const expectedPath = `runs/${artifact.runId}/artifacts/`
    if (!artifact.path.startsWith(expectedPath) || artifact.path.slice(expectedPath.length).includes('/')) {
      throw new Error(`Artifact ${artifact.id} has a path outside its Run artifact directory`)
    }
    if (artifactPaths.has(artifact.id)) throw new Error(`AutoDev backup repeats Artifact ${artifact.id}`)
    artifactPaths.set(artifact.id, artifact.path)
  }
  const artifactFileCount = [...files.keys()].filter(isArtifactBackupPath).length
  if (artifactPaths.size !== artifactFileCount) throw new Error('AutoDev backup contains unreferenced or missing Run artifacts')
  return artifactPaths
}

function validateManifestFilePath(path: string): void {
  if (path === '' || path.includes('\\') || path.includes(':') || path.startsWith('/') || path.includes('\0')) {
    throw new Error(`AutoDev backup contains an unsafe relative path: ${path}`)
  }
  const parts = path.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new Error(`AutoDev backup contains an unsafe relative path: ${path}`)
}

function isArtifactBackupPath(path: string): boolean {
  const parts = path.split('/')
  return parts.length === 4 && parts[0] === 'runs' && RUN_ID_PATTERN.test(parts[1] ?? '')
    && parts[2] === 'artifacts' && parts[3] !== '' && parts[3] !== '.' && parts[3] !== '..'
}

function resolveManifestPath(root: string, path: string): string {
  validateManifestFilePath(path)
  const target = resolve(root, ...path.split('/'))
  if (!isWithin(resolve(root), target) || target === resolve(root)) {
    throw new Error(`AutoDev backup path escapes its directory: ${path}`)
  }
  return target
}

function rebaseArtifactPaths(
  databasePath: string,
  artifactPaths: ReadonlyMap<string, string>,
  resolvePath: (path: string) => string,
): void {
  const database = new DatabaseSync(databasePath)
  try {
    database.exec('BEGIN IMMEDIATE')
    try {
      for (const [artifactId, artifactPath] of artifactPaths) {
        const row = database.prepare('SELECT value FROM autodev_records WHERE kind = ? AND id = ?').get('artifact', artifactId) as { value?: string } | undefined
        if (row?.value === undefined) throw new Error(`AutoDev database snapshot lost Artifact ${artifactId}`)
        const artifact = parseArtifactRef(row.value, artifactId)
        database.prepare('UPDATE autodev_records SET value = ? WHERE kind = ? AND id = ?')
          .run(JSON.stringify({ ...artifact, path: resolvePath(artifactPath) }), 'artifact', artifactId)
      }
      database.exec('COMMIT')
    } catch (error: unknown) {
      database.exec('ROLLBACK')
      throw error
    }
    assertDatabaseIntegrity(database)
  } finally {
    database.close()
  }
}

async function digestFile(path: string, signal?: AbortSignal): Promise<Digest> {
  const hash = createHash('sha256')
  let bytes = 0
  const stream = createReadStream(path, signal === undefined ? {} : { signal })
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    hash.update(buffer)
    bytes += buffer.byteLength
  }
  return { bytes, sha256: hash.digest('hex') }
}

function listBackupFiles(root: string, directory = root, result: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`AutoDev backup must not contain symbolic links: ${fullPath}`)
    if (entry.isDirectory()) listBackupFiles(root, fullPath, result)
    else if (entry.isFile()) result.push(relative(root, fullPath).split(sep).join('/'))
    else throw new Error(`AutoDev backup contains a non-regular entry: ${fullPath}`)
  }
  return result
}

function resolveNewSibling(path: string, label: string): { readonly destination: string; readonly parent: string } {
  const requested = resolve(path)
  const parentPath = dirname(requested)
  const parent = realDirectory(parentPath, `${label} parent`)
  const destination = join(parent, basename(requested))
  return { destination, parent }
}

function realDirectory(path: string, label: string): string {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${path}`)
  return realpathSync(path)
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left)
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

function removeOwnedTemporary(path: string, parent: string, prefix: string): void {
  const absolute = resolve(path)
  if (dirname(absolute) !== parent || !basename(absolute).startsWith(prefix)) {
    throw new Error(`refusing to remove unowned AutoDev temporary directory: ${absolute}`)
  }
  if (!pathEntryExists(absolute)) return
  const stat = lstatSync(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`refusing to remove unexpected AutoDev temporary entry: ${absolute}`)
  rmSync(absolute, { recursive: true, force: true })
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length
    && expected.every((value, index) => actual[index] === value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
