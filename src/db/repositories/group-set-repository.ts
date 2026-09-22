import type { Database as SqliteDatabase } from 'better-sqlite3';

import type { GroupSet, GroupSetMember, MembershipChange } from '../../domain/group-sets.js';
import type { Destination } from '../../domain/groups.js';
import type { Database } from '../database.js';
import { insertAudit } from './helpers.js';

interface GroupSetRow {
  id: number;
  name: string;
  member_count: number;
  created_at: string;
  updated_at: string;
}

interface MemberRow {
  destination_jid: string;
  member_created_at: string;
  jid: string | null;
  subject: string | null;
  description: string | null;
  owner_jid: string | null;
  participant_count: number | null;
  addressing_mode: string | null;
  alias: string | null;
  enabled: number | null;
  can_send: number | null;
  destination_created_at: string | null;
  destination_updated_at: string | null;
  last_refreshed_at: string | null;
}

function selectSet(db: SqliteDatabase, name: string): GroupSetRow | undefined {
  return db
    .prepare(
      `SELECT gs.*, COUNT(gsm.destination_jid) AS member_count
       FROM group_sets gs
       LEFT JOIN group_set_members gsm ON gsm.group_set_id = gs.id
       WHERE gs.name = ? COLLATE NOCASE
       GROUP BY gs.id`,
    )
    .get(name) as GroupSetRow | undefined;
}

function toGroupSet(row: GroupSetRow): GroupSet {
  return {
    id: row.id,
    name: row.name,
    memberCount: row.member_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDestination(row: MemberRow): Destination | null {
  if (!row.jid || row.subject === null || row.enabled === null || row.can_send === null) return null;
  return {
    jid: row.jid,
    subject: row.subject,
    description: row.description,
    ownerJid: row.owner_jid,
    participantCount: row.participant_count,
    addressingMode: row.addressing_mode,
    alias: row.alias,
    enabled: row.enabled === 1,
    canSend: row.can_send === 1,
    createdAt: row.destination_created_at!,
    updatedAt: row.destination_updated_at!,
    lastRefreshedAt: row.last_refreshed_at!,
  };
}

export class GroupSetRepository {
  public constructor(private readonly database: Database) {}

  public create(name: string, actor = 'self-controller'): GroupSet | null {
    const now = new Date().toISOString();
    return this.database.immediateTransaction(() => {
      const db = this.database.requireConnection();
      const result = db
        .prepare('INSERT OR IGNORE INTO group_sets(name, created_at, updated_at) VALUES (?, ?, ?)')
        .run(name, now, now);
      if (result.changes === 0) return null;
      insertAudit(db, 'group_set_created', {
        actor,
        entityType: 'group_set',
        entityId: name,
        now,
      });
      return toGroupSet(selectSet(db, name)!);
    });
  }

  public get(name: string): GroupSet | null {
    const row = selectSet(this.database.requireConnection(), name);
    return row ? toGroupSet(row) : null;
  }

  public list(): GroupSet[] {
    const rows = this.database
      .requireConnection()
      .prepare(
        `SELECT gs.*, COUNT(gsm.destination_jid) AS member_count
         FROM group_sets gs
         LEFT JOIN group_set_members gsm ON gsm.group_set_id = gs.id
         GROUP BY gs.id
         ORDER BY gs.name COLLATE NOCASE`,
      )
      .all() as GroupSetRow[];
    return rows.map(toGroupSet);
  }

  public members(name: string): GroupSetMember[] | null {
    const set = this.get(name);
    if (!set) return null;
    const rows = this.database
      .requireConnection()
      .prepare(
        `SELECT gsm.destination_jid, gsm.created_at AS member_created_at,
           d.jid, d.subject, d.description, d.owner_jid, d.participant_count,
           d.addressing_mode, d.alias, d.enabled, d.can_send,
           d.created_at AS destination_created_at,
           d.updated_at AS destination_updated_at, d.last_refreshed_at
         FROM group_set_members gsm
         LEFT JOIN destinations d ON d.jid = gsm.destination_jid
         WHERE gsm.group_set_id = ?
         ORDER BY COALESCE(d.alias, d.subject, gsm.destination_jid) COLLATE NOCASE`,
      )
      .all(set.id) as MemberRow[];
    return rows.map((row) => ({
      jid: row.destination_jid,
      createdAt: row.member_created_at,
      destination: toDestination(row),
    }));
  }

  public addMembers(name: string, jids: readonly string[], actor = 'self-controller'): MembershipChange | null {
    const now = new Date().toISOString();
    return this.database.immediateTransaction(() => {
      const db = this.database.requireConnection();
      const set = selectSet(db, name);
      if (!set) return null;
      const insert = db.prepare(
        'INSERT OR IGNORE INTO group_set_members(group_set_id, destination_jid, created_at) VALUES (?, ?, ?)',
      );
      let changed = 0;
      for (const jid of jids) changed += insert.run(set.id, jid, now).changes;
      db.prepare('UPDATE group_sets SET updated_at = ? WHERE id = ?').run(now, set.id);
      insertAudit(db, 'group_set_members_added', {
        actor,
        entityType: 'group_set',
        entityId: set.name,
        details: { requested: jids.length, added: changed },
        now,
      });
      return { changed, unchanged: jids.length - changed };
    });
  }

  public removeMembers(
    name: string,
    jids: readonly string[],
    actor = 'self-controller',
  ): MembershipChange | null {
    const now = new Date().toISOString();
    return this.database.immediateTransaction(() => {
      const db = this.database.requireConnection();
      const set = selectSet(db, name);
      if (!set) return null;
      const remove = db.prepare(
        'DELETE FROM group_set_members WHERE group_set_id = ? AND destination_jid = ?',
      );
      let changed = 0;
      for (const jid of jids) changed += remove.run(set.id, jid).changes;
      db.prepare('UPDATE group_sets SET updated_at = ? WHERE id = ?').run(now, set.id);
      insertAudit(db, 'group_set_members_removed', {
        actor,
        entityType: 'group_set',
        entityId: set.name,
        details: { requested: jids.length, removed: changed },
        now,
      });
      return { changed, unchanged: jids.length - changed };
    });
  }

  public delete(name: string, actor = 'self-controller'): boolean {
    const now = new Date().toISOString();
    return this.database.immediateTransaction(() => {
      const db = this.database.requireConnection();
      const set = selectSet(db, name);
      if (!set) return false;
      db.prepare('DELETE FROM group_sets WHERE id = ?').run(set.id);
      insertAudit(db, 'group_set_deleted', {
        actor,
        entityType: 'group_set',
        entityId: set.name,
        details: { members: set.member_count },
        now,
      });
      return true;
    });
  }
}
