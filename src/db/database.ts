import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import BetterSqlite3, { type Database as SqliteDatabase } from 'better-sqlite3';

import { migrations } from './migrations/index.js';

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
}

export class MigrationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export class Database {
  private connection: SqliteDatabase | null = null;

  public constructor(public readonly path: string) {}

  public open(): void {
    if (this.connection) return;
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const connection = new BetterSqlite3(this.path, { timeout: 5000 });
    connection.pragma('foreign_keys = ON');
    connection.pragma('busy_timeout = 5000');
    if (this.path !== ':memory:') {
      connection.pragma('journal_mode = WAL');
      connection.pragma('synchronous = FULL');
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // Windows and some mounted filesystems do not expose POSIX permissions.
      }
    }
    this.connection = connection;
  }

  public migrate(): void {
    const db = this.requireConnection();
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const applied = new Map(
      (db.prepare('SELECT version, name, checksum FROM schema_migrations').all() as AppliedMigrationRow[])
        .map((row) => [row.version, row]),
    );
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const existing = applied.get(migration.version);
      if (existing) {
        if (existing.name !== migration.name || existing.checksum !== checksum) {
          throw new MigrationError(`Migration ${migration.version} was changed after it was applied`);
        }
        continue;
      }
      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare(
          'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
        ).run(migration.version, migration.name, checksum, new Date().toISOString());
      })();
    }
  }

  public close(): void {
    this.connection?.close();
    this.connection = null;
  }

  public requireConnection(): SqliteDatabase {
    if (!this.connection) throw new Error('Database is not open');
    return this.connection;
  }

  public transaction<T>(operation: () => T): T {
    return this.requireConnection().transaction(operation)();
  }

  public immediateTransaction<T>(operation: () => T): T {
    const db = this.requireConnection();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  public getJournalMode(): string {
    const row = this.requireConnection().pragma('journal_mode', { simple: true });
    return String(row).toLowerCase();
  }

  public getSchemaVersion(): number {
    const row = this.requireConnection()
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
      .get() as { version: number };
    return row.version;
  }
}
