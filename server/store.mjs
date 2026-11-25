// SQLite persistence using Node's built-in node:sqlite (Node >= 22.13), so no
// native dependency has to be compiled.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const ROOM_COLUMNS = { joinMode: 'join_mode', presentation: 'presentation', language: 'language', name: 'name' };
const PARTICIPANT_COLUMNS = {
  name: 'name',
  role: 'role',
  canEdit: 'can_edit',
  isPresenter: 'is_presenter',
  status: 'status',
  lastSeen: 'last_seen',
};

const toBool = (v) => v === 1 || v === true;
const fromBool = (v) => (v ? 1 : 0);

function mapRoom(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    joinMode: r.join_mode,
    presentation: toBool(r.presentation),
    language: r.language,
    creatorId: r.creator_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapParticipant(p) {
  if (!p) return null;
  return {
    roomId: p.room_id,
    userId: p.user_id,
    name: p.name,
    color: p.color,
    role: p.role,
    canEdit: toBool(p.can_edit),
    isPresenter: toBool(p.is_presenter),
    status: p.status,
    joinedAt: p.joined_at,
    lastSeen: p.last_seen,
  };
}

export function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      join_mode TEXT NOT NULL CHECK (join_mode IN ('open','approval')),
      presentation INTEGER NOT NULL DEFAULT 0,
      language TEXT NOT NULL DEFAULT 'javascript',
      creator_id TEXT NOT NULL,
      doc_state BLOB,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS participants (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','participant')),
      can_edit INTEGER NOT NULL DEFAULT 0,
      is_presenter INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','removed')),
      joined_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_id);
    CREATE TABLE IF NOT EXISTS last_runs (
      room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const q = {
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    insertRoom: db.prepare(
      'INSERT INTO rooms(id, name, join_mode, presentation, language, creator_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)',
    ),
    getRoom: db.prepare('SELECT id, name, join_mode, presentation, language, creator_id, created_at, updated_at FROM rooms WHERE id = ?'),
    saveDoc: db.prepare('UPDATE rooms SET doc_state = ?, updated_at = ? WHERE id = ?'),
    loadDoc: db.prepare('SELECT doc_state FROM rooms WHERE id = ?'),
    insertParticipant: db.prepare(
      'INSERT INTO participants(room_id, user_id, name, color, role, can_edit, is_presenter, status, joined_at, last_seen) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ),
    getParticipant: db.prepare('SELECT * FROM participants WHERE room_id = ? AND user_id = ?'),
    listParticipants: db.prepare('SELECT * FROM participants WHERE room_id = ? ORDER BY joined_at ASC, user_id ASC'),
    countByStatus: db.prepare('SELECT COUNT(*) AS n FROM participants WHERE room_id = ? AND status = ?'),
    saveLastRun: db.prepare('INSERT INTO last_runs(room_id, data, updated_at) VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'),
    loadLastRun: db.prepare('SELECT data FROM last_runs WHERE room_id = ?'),
    countAdmins: db.prepare("SELECT COUNT(*) AS n FROM participants WHERE room_id = ? AND role = 'admin' AND status = 'approved'"),
  };

  function updateColumns(table, keyClause, keyArgs, columns, fields) {
    const sets = [];
    const values = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = columns[k];
      if (!col) throw new Error(`Unknown column: ${k}`);
      sets.push(`${col} = ?`);
      values.push(typeof v === 'boolean' ? fromBool(v) : v);
    }
    if (!sets.length) return;
    db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${keyClause}`).run(...values, ...keyArgs);
  }

  return {
    db,
    getMeta: (key) => q.getMeta.get(key)?.value ?? null,
    setMeta: (key, value) => void q.setMeta.run(key, value),

    insertRoom(room) {
      const now = Date.now();
      q.insertRoom.run(room.id, room.name, room.joinMode, fromBool(room.presentation), room.language, room.creatorId, now, now);
    },
    getRoom: (id) => mapRoom(q.getRoom.get(id)),
    updateRoom(id, fields) {
      updateColumns('rooms', 'id = ?', [id], ROOM_COLUMNS, fields);
      db.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').run(Date.now(), id);
    },
    /** The most recent run output of a room, so late joiners and returning users see it. */
    saveLastRun(roomId, run) {
      q.saveLastRun.run(roomId, JSON.stringify(run), Date.now());
    },
    loadLastRun(roomId) {
      const row = q.loadLastRun.get(roomId);
      if (!row) return null;
      try { return JSON.parse(row.data); } catch { return null; }
    },
    saveDocState(id, bytes) {
      q.saveDoc.run(bytes, Date.now(), id);
    },
    loadDocState(id) {
      const row = q.loadDoc.get(id);
      return row?.doc_state ? new Uint8Array(row.doc_state) : null;
    },

    insertParticipant(p) {
      const now = Date.now();
      q.insertParticipant.run(
        p.roomId, p.userId, p.name, p.color, p.role,
        fromBool(p.canEdit), fromBool(p.isPresenter), p.status, now, now,
      );
    },
    getParticipant: (roomId, userId) => mapParticipant(q.getParticipant.get(roomId, userId)),
    listParticipants: (roomId) => q.listParticipants.all(roomId).map(mapParticipant),
    countParticipants: (roomId, status) => q.countByStatus.get(roomId, status).n,
    countAdmins: (roomId) => q.countAdmins.get(roomId).n,
    updateParticipant(roomId, userId, fields) {
      updateColumns('participants', 'room_id = ? AND user_id = ?', [roomId, userId], PARTICIPANT_COLUMNS, fields);
    },

    /** Runs fn inside a transaction; rolls back if it throws. */
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close() {
      db.close();
    },
  };
}
