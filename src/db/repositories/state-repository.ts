import type { Database } from '../database.js';

export class StateRepository {
  public constructor(private readonly database: Database) {}

  public get(key: string): string | null {
    const row = this.database
      .requireConnection()
      .prepare('SELECT value FROM app_state WHERE key = ?')
      .get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  public set(key: string, value: string | null): void {
    this.database.requireConnection().prepare(
      `INSERT INTO app_state(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value, new Date().toISOString());
  }

  public remove(key: string): void {
    this.database.requireConnection().prepare('DELETE FROM app_state WHERE key = ?').run(key);
  }
}
