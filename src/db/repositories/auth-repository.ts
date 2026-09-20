import type { Database } from '../database.js';

export class AuthRepository {
  public constructor(private readonly database: Database) {}

  public getCredentials(): string | null {
    const row = this.database
      .requireConnection()
      .prepare('SELECT value_json FROM wa_auth_creds WHERE singleton = 1')
      .get() as { value_json: string } | undefined;
    return row?.value_json ?? null;
  }

  public saveCredentials(valueJson: string): void {
    this.database.immediateTransaction(() => {
      this.database.requireConnection().prepare(
        `INSERT INTO wa_auth_creds(singleton, value_json, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ).run(valueJson, new Date().toISOString());
    });
  }

  public getKeys(category: string, ids: readonly string[]): Record<string, string> {
    if (!ids.length) return {};
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.database
      .requireConnection()
      .prepare(
        `SELECT key_id, value_json FROM wa_auth_keys
         WHERE category = ? AND key_id IN (${placeholders})`,
      )
      .all(category, ...ids) as { key_id: string; value_json: string }[];
    return Object.fromEntries(rows.map((row) => [row.key_id, row.value_json]));
  }

  public setKeys(updates: Readonly<Record<string, Readonly<Record<string, string | null>>>>): void {
    this.database.immediateTransaction(() => {
      const db = this.database.requireConnection();
      const upsert = db.prepare(
        `INSERT INTO wa_auth_keys(category, key_id, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(category, key_id) DO UPDATE SET
           value_json = excluded.value_json, updated_at = excluded.updated_at`,
      );
      const remove = db.prepare('DELETE FROM wa_auth_keys WHERE category = ? AND key_id = ?');
      const now = new Date().toISOString();
      for (const [category, values] of Object.entries(updates)) {
        for (const [id, value] of Object.entries(values)) {
          if (value === null) remove.run(category, id);
          else upsert.run(category, id, value, now);
        }
      }
    });
  }

  public hasCredentials(): boolean {
    const stored = this.getCredentials();
    if (!stored) return false;
    try {
      const credentials = JSON.parse(stored) as {
        registered?: unknown;
        me?: unknown;
        account?: unknown;
      };
      // Baileys 7 RC may retain registered=false after a successful protocol
      // restart even though the paired identity and account are present.
      return credentials.registered === true || Boolean(credentials.me && credentials.account);
    } catch {
      return false;
    }
  }

  public clear(): void {
    this.database.immediateTransaction(() => {
      const db = this.database.requireConnection();
      db.prepare('DELETE FROM wa_auth_keys').run();
      db.prepare('DELETE FROM wa_auth_creds').run();
    });
  }
}
