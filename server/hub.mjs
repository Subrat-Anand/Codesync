// Realtime hub: one authoritative Y.Doc per room, WebSocket transport, and
// server-side enforcement of who may write.
//
// Wire format (single WebSocket per client):
//   binary frames  -> Yjs protocol. byte 0: 0 = sync, 1 = awareness (y-protocols)
//   text frames    -> JSON control messages (see README "WebSocket events")
//
// Subprotocol auth: the client opens the socket with
//   protocols = ['codesync.v1', <session token>]
// so the token never appears in URLs or access logs.
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync.js';
import * as awarenessProtocol from 'y-protocols/awareness.js';
import * as encoding from 'lib0/encoding.js';
import * as decoding from 'lib0/decoding.js';
import { WebSocketServer } from 'ws';
import { HttpError } from './errors.mjs';
import { canEdit } from './permissions.mjs';
import { sanitizeAwarenessState } from './sanitize.mjs';
import { getLanguage, starterFor } from '../shared/languages.mjs';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const SUBPROTOCOL = 'codesync.v1';
const SAVE_DEBOUNCE_MS = 800;
const HEARTBEAT_MS = 30_000;

export const CLOSE = {
  UNAUTHORIZED: 4001,
  FORBIDDEN: 4003,
  NOT_FOUND: 4004,
  RATE_LIMITED: 4008,
  FULL_REPLACED: 4009,
};

export class Hub {
  /**
   * @param {{store: any, rooms: import('./rooms.mjs').RoomService, executor: any, limits: object,
   *          allowedOrigins?: string[], log?: Function}} deps
   */
  constructor({ store, rooms, executor, limits, allowedOrigins = [], log = () => {} }) {
    this.store = store;
    this.rooms = rooms;
    this.executor = executor;
    this.limits = limits;
    this.allowedOrigins = allowedOrigins;
    this.log = log;
    /** @type {Map<string, any>} */
    this.runtimes = new Map();
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: limits.wsMaxPayload,
      handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    });
    this.heartbeat = setInterval(() => this.#heartbeat(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
    this.rooms.on('change', (roomId, info) => this.#onRoomChange(roomId, info));
  }

  // ------------------------------------------------------------- upgrade

  handleUpgrade(req, socket, head) {
    const reject = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const match = /^\/ws\/([A-Za-z0-9]{1,16})$/.exec(url.pathname);
      if (!match) return reject(404, 'Not Found');
      if (!this.#originAllowed(req)) return reject(403, 'Forbidden');

      const offered = String(req.headers['sec-websocket-protocol'] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!offered.includes(SUBPROTOCOL)) return reject(400, 'Bad Request');
      const token = offered.find((p) => p !== SUBPROTOCOL);

      const roomId = match[1].toUpperCase();
      let participant = null;
      let failure = null;
      try {
        if (!token) throw new HttpError(401, 'unauthorized', 'Authentication required');
        ({ participant } = this.rooms.authenticateApproved(roomId, token));
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        failure = err;
      }

      // Complete the handshake even on auth failure and close with an
      // application code, so browsers (which cannot read HTTP status of a
      // failed upgrade) can tell "do not retry" apart from a network blip.
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        if (failure) {
          const code = failure.status === 404 ? CLOSE.NOT_FOUND : failure.status === 403 ? CLOSE.FORBIDDEN : CLOSE.UNAUTHORIZED;
          ws.close(code, failure.code);
          return;
        }
        this.#attach(ws, roomId, participant.userId);
      });
    } catch (err) {
      this.log('ws upgrade failed', err);
      return reject(500, 'Internal Server Error');
    }
    return undefined;
  }

  #originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients (tests, tools) — token still required
    if (this.allowedOrigins.includes(origin)) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ runtimes

  #getRuntime(roomId) {
    let rt = this.runtimes.get(roomId);
    if (rt) return rt;

    const doc = new Y.Doc();
    const saved = this.store.loadDocState(roomId);
    if (saved) {
      Y.applyUpdate(doc, saved, 'load');
    } else {
      const room = this.store.getRoom(roomId);
      doc.getText('code').insert(0, starterFor(room?.language));
    }
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);

    rt = {
      roomId,
      doc,
      text: doc.getText('code'),
      awareness,
      conns: new Set(),
      clientOwners: new Map(),
      saveTimer: null,
      dirty: !saved,
      running: false,
      runMeta: null,
      lastRun: this.store.loadLastRun(roomId),
      lastRunAt: 0,
    };

    doc.on('update', (update, origin) => {
      rt.dirty = true;
      this.#scheduleSave(rt);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const conn of rt.conns) if (conn !== origin) this.#sendBinary(conn, msg);
    });

    awareness.on('update', ({ added, updated, removed }) => {
      const changed = added.concat(updated, removed);
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const conn of rt.conns) this.#sendBinary(conn, msg);
    });

    this.runtimes.set(roomId, rt);
    if (rt.dirty) this.#flush(rt);
    return rt;
  }

  #scheduleSave(rt) {
    if (rt.saveTimer) return;
    rt.saveTimer = setTimeout(() => {
      rt.saveTimer = null;
      this.#flush(rt);
    }, SAVE_DEBOUNCE_MS);
    rt.saveTimer.unref?.();
  }

  #flush(rt) {
    if (rt.saveTimer) {
      clearTimeout(rt.saveTimer);
      rt.saveTimer = null;
    }
    if (!rt.dirty) return;
    try {
      this.store.saveDocState(rt.roomId, Y.encodeStateAsUpdate(rt.doc));
      rt.dirty = false;
    } catch (err) {
      this.log('failed to persist room', rt.roomId, err);
    }
  }

  #maybeEvict(rt) {
    if (rt.conns.size > 0) return;
    this.#flush(rt);
    rt.awareness.destroy();
    rt.doc.destroy();
    this.runtimes.delete(rt.roomId);
  }

  /** Returns the current document text (loads the room if needed). */
  getCode(roomId) {
    const rt = this.#getRuntime(roomId);
    const code = rt.text.toString();
    this.#maybeEvict(rt);
    return code;
  }

  onlineUserIds(roomId) {
    const rt = this.runtimes.get(roomId);
    return new Set(rt ? [...rt.conns].map((c) => c.userId) : []);
  }

  // ------------------------------------------------------- connection life

  #attach(ws, roomId, userId) {
    const rt = this.#getRuntime(roomId);
    const conn = {
      ws, rt, userId, clientIds: new Set(), alive: true,
      canEdit: false, windowStart: Date.now(), windowCount: 0, lastNoticeAt: 0,
    };
    this.#refreshConn(conn);
    rt.conns.add(conn);

    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (data, isBinary) => this.#onMessage(conn, data, isBinary));
    ws.on('close', () => this.#detach(conn));
    ws.on('error', (err) => this.log('ws error', err?.message));

    // Ask the client for its state (it replies with what we're missing) and
    // push ours: the standard Yjs sync handshake.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, rt.doc);
    this.#sendBinary(conn, encoding.toUint8Array(enc));

    const states = rt.awareness.getStates();
    if (states.size > 0) {
      const aenc = encoding.createEncoder();
      encoding.writeVarUint(aenc, MSG_AWARENESS);
      encoding.writeVarUint8Array(aenc, awarenessProtocol.encodeAwarenessUpdate(rt.awareness, [...states.keys()]));
      this.#sendBinary(conn, encoding.toUint8Array(aenc));
    }

    // Output belongs to the room, not to one browser: late joiners and people
    // who left and came back see the latest run (or the one still in progress).
    if (rt.running && rt.runMeta) this.#sendJson(conn, { type: 'run:start', ...rt.runMeta });
    else if (rt.lastRun) this.#sendJson(conn, { type: 'run:last', ...rt.lastRun });

    this.#broadcastState(rt); // presence changed for everyone
  }

  #detach(conn) {
    const { rt } = conn;
    if (!rt.conns.delete(conn)) return;
    if (conn.clientIds.size) {
      awarenessProtocol.removeAwarenessStates(rt.awareness, [...conn.clientIds], null);
      for (const id of conn.clientIds) rt.clientOwners.delete(id);
    }
    this.#broadcastState(rt);
    this.#flush(rt);
    this.#maybeEvict(rt);
  }

  #heartbeat() {
    for (const rt of this.runtimes.values()) {
      for (const conn of rt.conns) {
        if (!conn.alive) {
          conn.ws.terminate();
        } else {
          conn.alive = false;
          try { conn.ws.ping(); } catch { /* socket closing */ }
        }
      }
    }
  }

  /** Re-reads the participant from the database; the DB is the source of truth. */
  #refreshConn(conn) {
    const room = this.store.getRoom(conn.rt.roomId);
    const participant = this.store.getParticipant(conn.rt.roomId, conn.userId);
    if (!room || !participant || participant.status !== 'approved') return false;
    conn.canEdit = canEdit(room, participant);
    return true;
  }

  #onRoomChange(roomId, info) {
    const rt = this.runtimes.get(roomId);
    if (!rt) return;
    // Permissions are recomputed synchronously, before any further incoming
    // message can be processed, so a revoke takes effect immediately.
    for (const conn of [...rt.conns]) {
      if (!this.#refreshConn(conn)) {
        this.#sendJson(conn, { type: 'kicked' });
        conn.ws.close(CLOSE.FORBIDDEN, 'removed');
        rt.conns.delete(conn);
        if (conn.clientIds.size) {
          awarenessProtocol.removeAwarenessStates(rt.awareness, [...conn.clientIds], null);
          for (const id of conn.clientIds) rt.clientOwners.delete(id);
        }
      }
    }
    this.#hideCursorsOfReaders(rt);
    this.#broadcastState(rt);
    if (info?.kind === 'language') {
      const room = this.store.getRoom(roomId);
      const by = this.store.getParticipant(roomId, info.userId);
      for (const conn of rt.conns) {
        this.#sendJson(conn, { type: 'language', language: room.language, by: by?.name ?? null });
      }
    }
    this.#maybeEvict(rt);
  }

  #broadcastState(rt) {
    const online = new Set([...rt.conns].map((c) => c.userId));
    for (const conn of rt.conns) {
      try {
        this.#sendJson(conn, { type: 'state', ...this.rooms.buildState(rt.roomId, conn.userId, online) });
      } catch (err) {
        this.log('state build failed', err?.message);
      }
    }
  }

  // -------------------------------------------------------------- messages

  #onMessage(conn, data, isBinary) {
    const now = Date.now();
    if (now - conn.windowStart >= 1000) {
      conn.windowStart = now;
      conn.windowCount = 0;
    }
    conn.windowCount += 1;
    if (conn.windowCount > this.limits.wsMessagesPerSecond) {
      conn.ws.close(CLOSE.RATE_LIMITED, 'rate limited');
      return;
    }
    try {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
        this.#onBinary(conn, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      } else {
        this.#onText(conn, data.toString());
      }
    } catch (err) {
      this.log('message handling failed', err?.message);
    }
  }

  #onBinary(conn, message) {
    const { rt } = conn;
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);

    if (type === MSG_SYNC) {
      const sub = decoding.readVarUint(decoder);
      if (sub === syncProtocol.messageYjsSyncStep1) {
        // Reading is always allowed for approved participants.
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncStep1(decoder, enc, rt.doc);
        this.#sendBinary(conn, encoding.toUint8Array(enc));
        return;
      }
      if (sub === syncProtocol.messageYjsSyncStep2 || sub === syncProtocol.messageYjsUpdate) {
        // THE write gate. Reads the live permission flag maintained from the
        // database; whatever the client UI claims is irrelevant.
        if (!conn.canEdit) {
          // Step 2 is the automatic reply to our handshake, not a user edit:
          // drop it silently and only warn about real update messages.
          if (sub === syncProtocol.messageYjsUpdate) {
            this.#notice(conn, 'read_only', 'You have read-only access; your change was rejected.');
          }
          return;
        }
        syncProtocol.readSyncStep2(decoder, rt.doc, conn);
        this.#enforceSizeLimit(rt);
      }
      return;
    }

    if (type === MSG_AWARENESS) {
      this.#onAwareness(conn, decoding.readVarUint8Array(decoder));
    }
  }

  #onAwareness(conn, update) {
    const { rt } = conn;
    const decoder = decoding.createDecoder(update);
    const count = decoding.readVarUint(decoder);
    if (count > 4) return;
    const participant = this.store.getParticipant(rt.roomId, conn.userId);
    if (!participant) return;

    const entries = [];
    for (let i = 0; i < count; i += 1) {
      const clientId = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const raw = decoding.readVarString(decoder);

      // A connection may only ever speak for one awareness client id, and may
      // not take over an id owned by a different user. The same user
      // reconnecting (new socket, same Y client id) may take over their own id.
      const owner = rt.clientOwners.get(clientId);
      if (owner !== conn) {
        if (owner && owner.userId !== conn.userId) continue;
        if (!owner && conn.clientIds.size >= 1) continue;
        if (owner) owner.clientIds.delete(clientId);
        rt.clientOwners.set(clientId, conn);
        conn.clientIds.add(clientId);
      }
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      // Only people who can edit right now may show a cursor/selection/typing.
      const state = sanitizeAwarenessState(parsed, participant, { showCursor: conn.canEdit });
      if (state === undefined) continue;
      entries.push({ clientId, clock, state });
    }
    this.#applyAwareness(rt, entries, conn);
  }

  #applyAwareness(rt, entries, origin) {
    if (!entries.length) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, entries.length);
    for (const e of entries) {
      encoding.writeVarUint(enc, e.clientId);
      encoding.writeVarUint(enc, e.clock);
      encoding.writeVarString(enc, JSON.stringify(e.state));
    }
    awarenessProtocol.applyAwarenessUpdate(rt.awareness, encoding.toUint8Array(enc), origin);
  }

  /**
   * When someone loses the right to edit (revoked, presentation mode turned
   * on, demoted) any cursor/selection/typing they were already showing is
   * removed for everyone, even if their client never cleans it up itself.
   */
  #hideCursorsOfReaders(rt) {
    const entries = [];
    for (const conn of rt.conns) {
      if (conn.canEdit) continue;
      for (const clientId of conn.clientIds) {
        const state = rt.awareness.getStates().get(clientId);
        if (!state || (state.cursor === undefined && state.typing === undefined)) continue;
        const { cursor, typing, ...rest } = state;
        entries.push({ clientId, clock: (rt.awareness.meta.get(clientId)?.clock ?? 0) + 1, state: rest });
      }
    }
    this.#applyAwareness(rt, entries, null);
  }

  #enforceSizeLimit(rt) {
    const over = rt.text.length - this.limits.maxCodeChars;
    if (over > 0) {
      rt.doc.transact(() => rt.text.delete(this.limits.maxCodeChars, over), 'size-limit');
    }
  }

  #onText(conn, raw) {
    if (raw.length > 16_384) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'language') {
      try {
        this.rooms.setLanguage(conn.rt.roomId, conn.userId, String(msg.language));
      } catch (err) {
        this.#sendError(conn, err);
      }
      return;
    }
    if (msg.type === 'run') {
      this.#run(conn, typeof msg.stdin === 'string' ? msg.stdin : '').catch((err) => {
        this.log('run failed', err?.message);
        this.#sendError(conn, err);
      });
    }
  }

  async #run(conn, stdin) {
    const { rt } = conn;
    if (!conn.canEdit) throw new HttpError(403, 'forbidden', 'Only people who can edit may run code');
    if (rt.running) throw new HttpError(409, 'busy', 'A run is already in progress');
    const wait = rt.lastRunAt + this.limits.runCooldownMs - Date.now();
    if (wait > 0) throw new HttpError(429, 'cooldown', `Please wait ${Math.ceil(wait / 1000)}s before running again`);

    const room = this.store.getRoom(rt.roomId);
    const participant = this.store.getParticipant(rt.roomId, conn.userId);
    const language = getLanguage(room.language);
    const code = rt.text.toString(); // authoritative server copy, not client-supplied

    rt.running = true;
    rt.lastRunAt = Date.now();
    const meta = { by: participant.name, language: language.label };
    rt.runMeta = meta;
    this.#broadcastJson(rt, { type: 'run:start', ...meta });
    try {
      const result = await this.executor.execute({ language: room.language, code, stdin });
      rt.lastRun = { ...meta, result };
      try { this.store.saveLastRun(rt.roomId, rt.lastRun); } catch (err) { this.log('failed to save run output', err?.message); }
      this.#broadcastJson(rt, { type: 'run:result', ...meta, result });
    } finally {
      rt.running = false;
      rt.runMeta = null;
      rt.lastRunAt = Date.now();
    }
  }

  // --------------------------------------------------------------- sending

  #sendBinary(conn, data) {
    if (conn.ws.readyState === 1) conn.ws.send(data, { binary: true });
  }

  #sendJson(conn, obj) {
    if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(obj));
  }

  #broadcastJson(rt, obj) {
    for (const conn of rt.conns) this.#sendJson(conn, obj);
  }

  #notice(conn, code, message) {
    const now = Date.now();
    if (now - conn.lastNoticeAt < 2000) return;
    conn.lastNoticeAt = now;
    this.#sendJson(conn, { type: 'notice', code, message });
  }

  #sendError(conn, err) {
    const known = err instanceof HttpError;
    this.#sendJson(conn, {
      type: 'error',
      code: known ? err.code : 'internal',
      message: known ? err.message : 'Something went wrong',
    });
  }

  // --------------------------------------------------------------- shutdown

  async shutdown() {
    clearInterval(this.heartbeat);
    for (const rt of this.runtimes.values()) {
      this.#flush(rt);
      for (const conn of rt.conns) conn.ws.close(1001, 'server shutting down');
      rt.awareness.destroy();
      rt.doc.destroy();
    }
    this.runtimes.clear();
    await new Promise((resolve) => this.wss.close(() => resolve()));
  }
}
