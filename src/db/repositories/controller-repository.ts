import type { Database } from '../database.js';

export class ControllerRepository {
  public constructor(private readonly database: Database) {}

  public hasProcessed(messageId: string): boolean {
    return Boolean(
      this.database
        .requireConnection()
        .prepare('SELECT 1 FROM controller_messages WHERE message_id = ?')
        .get(messageId),
    );
  }

  public markProcessed(messageId: string, commandHash: string, receivedAt: string): boolean {
    const result = this.database
      .requireConnection()
      .prepare(
        `INSERT OR IGNORE INTO controller_messages(message_id, received_at, command_hash)
         VALUES (?, ?, ?)`,
      )
      .run(messageId, receivedAt, commandHash);
    return result.changes === 1;
  }
}
