// Yjs <-> WebSocket provider for CodeSync.
// - one socket carries binary Yjs frames and JSON control frames
// - automatic reconnect with backoff; a fresh sync handshake on every connect
//   restores anything missed while offline and (if still permitted) uploads
//   edits made while offline
// - the server decides what is accepted; this class never enforces permissions
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync.js';
import * as awarenessProtocol from 'y-protocols/awareness.js';
import * as encoding from 'lib0/encoding.js';
import * as decoding from 'lib0/decoding.js';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const SUBPROTOCOL = 'codesync.v1';
const FATAL_CODES = new Set([4001, 4003, 4004]);

export class CollabProvider {
  /**
   * @param {{roomId: string, token: string, doc: Y.Doc, awareness: awarenessProtocol.Awareness, url?: string}} opts
   */
  constructor({ roomId, token, doc, awareness, url }) {
    this.roomId = roomId;
    this.token = token;
    this.doc = doc;
    this.awareness = awareness;
    this.url = url || `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/${roomId}`;
    this.ws = null;
    this.status = 'disconnected';
    this.synced = false;
    this.destroyed = false;
    this.attempts = 0;
    this.retryTimer = null;
    this.listeners = new Map();

    this.onDocUpdate = (update, origin) => {
      if (origin === this) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.#sendBinary(encoding.toUint8Array(enc));
    };
    this.onAwarenessUpdate = ({ added, updated, removed }, origin) => {
      if (origin !== 'local') return;
      this.#sendAwareness(added.concat(updated, removed));
    };
    this.onOnline = () => {
      if (this.status !== 'connected') this.#connectNow();
    };

    doc.on('update', this.onDocUpdate);
    awareness.on('update', this.onAwarenessUpdate);
    window.addEventListener('online', this.onOnline);
    this.#connectNow();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  #emit(event, payload) {
    this.listeners.get(event)?.forEach((fn) => fn(payload));
  }

  #setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.#emit('status', status);
  }

  #connectNow() {
    if (this.destroyed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(this.retryTimer);
    this.#setStatus('connecting');

    const ws = new WebSocket(this.url, [SUBPROTOCOL, this.token]);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.#setStatus('connected');
      // Sync handshake: tell the server what we have; it answers with what we lack.
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, this.doc);
      this.#sendBinary(encoding.toUint8Array(enc));
      if (this.awareness.getLocalState() !== null) this.#sendAwareness([this.doc.clientID]);
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      if (typeof event.data === 'string') {
        try {
          this.#emit('message', JSON.parse(event.data));
        } catch {
          /* ignore malformed control frame */
        }
        return;
      }
      this.#onBinary(new Uint8Array(event.data));
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.synced = false;
      // Forget remote cursors; the server re-sends them after reconnecting.
      const remote = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
      if (remote.length) awarenessProtocol.removeAwarenessStates(this.awareness, remote, this);
      this.#setStatus('disconnected');
      if (this.destroyed) return;
      if (FATAL_CODES.has(event.code)) {
        this.#emit('fatal', event.code);
        return;
      }
      this.#scheduleReconnect();
    };

    ws.onerror = () => {
      /* onclose follows */
    };
  }

  #scheduleReconnect() {
    const delay = Math.min(10_000, 500 * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
    this.attempts += 1;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.#connectNow(), delay);
  }

  #onBinary(message) {
    const decoder = decoding.createDecoder(message);
    const type = decoding.readVarUint(decoder);
    if (type === MSG_SYNC) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MSG_SYNC);
      const sub = syncProtocol.readSyncMessage(decoder, reply, this.doc, this);
      if (sub === syncProtocol.messageYjsSyncStep2 && !this.synced) {
        this.synced = true;
        this.#emit('synced', true);
      }
      if (encoding.length(reply) > 1) this.#sendBinary(encoding.toUint8Array(reply));
    } else if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    }
  }

  #sendBinary(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  #sendAwareness(clientIds) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clientIds));
    this.#sendBinary(encoding.toUint8Array(enc));
  }

  /** Sends a JSON control message. Returns false if the socket is not open. */
  send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.retryTimer);
    window.removeEventListener('online', this.onOnline);
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'local');
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.listeners.clear();
  }
}
