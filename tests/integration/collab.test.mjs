// End-to-end test over real HTTP + WebSocket: permissions are enforced by the
// server regardless of what a client sends. Requires `npm install` first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync.js';
import * as awarenessProtocol from 'y-protocols/awareness.js';
import * as encoding from 'lib0/encoding.js';
import * as decoding from 'lib0/decoding.js';
import { loadConfig } from '../../server/config.mjs';
import { createApp } from '../../server/app.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app;
let base;
let dir;
const runs = [];

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesync-it-'));
  const config = loadConfig({ CODESYNC_DB: path.join(dir, 't.db'), PORT: '0', HOST: '127.0.0.1' });
  config.limits.runCooldownMs = 0;
  const executor = {
    async execute(input) {
      runs.push(input);
      return { ok: true, stage: 'run', stdout: 'hi\n', stderr: '', exitCode: 0, timeMs: 1 };
    },
  };
  app = createApp({ config, executor });
  const addr = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function api(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

/** Minimal client speaking the same protocol as lib/provider.js. */
function connect(roomId, token) {
  const doc = new Y.Doc();
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${roomId}`, ['codesync.v1', token]);
  ws.binaryType = 'arraybuffer';
  const awareness = new awarenessProtocol.Awareness(doc);
  const c = { doc, ws, awareness, text: doc.getText('code'), messages: [], closed: null };
  doc.on('update', (u, origin) => {
    if (origin === 'remote' || ws.readyState !== 1) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, u);
    ws.send(encoding.toUint8Array(enc));
  });
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return c.messages.push(JSON.parse(data.toString()));
    const decoder = decoding.createDecoder(new Uint8Array(data));
    const kind = decoding.readVarUint(decoder);
    if (kind === 1) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), 'remote');
      return undefined;
    }
    if (kind !== 0) return undefined;
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, 0);
    syncProtocol.readSyncMessage(decoder, reply, doc, 'remote');
    if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
    return undefined;
  });
  ws.on('close', (code) => { c.closed = code; awareness.destroy(); }); // stop its timers so the test process can exit
  c.ready = new Promise((resolve) => ws.once('open', resolve));
  return c;
}

async function setup() {
  const created = await api('POST', '/api/rooms', { body: { roomName: 'IT', displayName: 'Ada', joinMode: 'approval' } });
  assert.equal(created.status, 201);
  const { roomId, token: adminToken } = created.json;
  const joined = await api('POST', `/api/rooms/${roomId}/join`, { body: { displayName: 'Bob' } });
  assert.equal(joined.json.status, 'pending');
  const me = await api('GET', `/api/rooms/${roomId}/me`, { token: adminToken });
  const bob = me.json.state.participants.find((p) => p.name === 'Bob');
  return { roomId, adminToken, bobToken: joined.json.token, bobId: bob.userId };
}

test('pending users cannot open the realtime channel; approved read-only users cannot write', async () => {
  const { roomId, adminToken, bobToken, bobId } = await setup();

  const pending = connect(roomId, bobToken);
  await sleep(300);
  assert.ok([4001, 4003].includes(pending.closed), `pending socket closed with ${pending.closed}`);

  await api('POST', `/api/rooms/${roomId}/admin`, { token: adminToken, body: { action: 'approve', userId: bobId } });
  const admin = connect(roomId, adminToken);
  const bob = connect(roomId, bobToken);
  await Promise.all([admin.ready, bob.ready]);
  await sleep(300);
  assert.equal(bob.text.toString(), admin.text.toString(), 'late joiner receives current code');

  // Read-only Bob tries to type: server must reject and keep its copy intact.
  bob.text.insert(0, 'HACKED ');
  await sleep(400);
  assert.ok(!app.hub.getCode(roomId).includes('HACKED'));
  assert.ok(!admin.text.toString().includes('HACKED'));

  // Admin edits propagate to Bob instantly.
  admin.text.insert(0, 'ADMIN ');
  await sleep(300);
  assert.ok(bob.text.toString().startsWith('ADMIN '));

  admin.ws.close();
  bob.ws.close();
});

test('grant, revoke and presentation mode take effect immediately on the server', async () => {
  const { roomId, adminToken, bobToken, bobId } = await setup();
  const act = (action, extra = {}) =>
    api('POST', `/api/rooms/${roomId}/admin`, { token: adminToken, body: { action, userId: bobId, ...extra } });
  await act('approve');
  const bob = connect(roomId, bobToken);
  await bob.ready;
  await sleep(200);

  await act('grantEdit');
  await sleep(100);
  bob.text.insert(0, 'BOB1 ');
  await sleep(300);
  assert.ok(app.hub.getCode(roomId).includes('BOB1'));

  await act('setPresentation', { value: true }); // granted-but-not-presenter -> read-only
  await sleep(100);
  bob.text.insert(0, 'BOB2 ');
  await sleep(300);
  assert.ok(!app.hub.getCode(roomId).includes('BOB2'));

  await act('grantPresenter');
  await sleep(100);
  bob.text.insert(0, 'BOB3 ');
  await sleep(300);
  assert.ok(app.hub.getCode(roomId).includes('BOB3'));

  await act('revokeEdit');
  await sleep(100);
  bob.text.insert(0, 'BOB4 ');
  await sleep(300);
  assert.ok(!app.hub.getCode(roomId).includes('BOB4'));
  bob.ws.close();
});

test('non-admins cannot use admin actions; only editors can run code', async () => {
  const { roomId, adminToken, bobToken, bobId } = await setup();
  await api('POST', `/api/rooms/${roomId}/admin`, { token: adminToken, body: { action: 'approve', userId: bobId } });

  const denied = await api('POST', `/api/rooms/${roomId}/admin`, {
    token: bobToken, body: { action: 'promote', userId: bobId },
  });
  assert.equal(denied.status, 403);

  const bob = connect(roomId, bobToken);
  await bob.ready;
  bob.ws.send(JSON.stringify({ type: 'run', stdin: '' }));
  await sleep(300);
  assert.equal(runs.length, 0, 'read-only user must not trigger execution');
  assert.ok(bob.messages.some((m) => m.type === 'error'));

  const admin = connect(roomId, adminToken);
  await admin.ready;
  admin.ws.send(JSON.stringify({ type: 'run', stdin: '' }));
  await sleep(400);
  assert.equal(runs.length, 1);
  assert.ok(bob.messages.some((m) => m.type === 'run:result'), 'everyone sees the run result');
  admin.ws.close();
  bob.ws.close();
});

test('state survives reconnect and server-side persistence', async () => {
  const { roomId, adminToken } = await setup();
  const a = connect(roomId, adminToken);
  await a.ready;
  await sleep(200);
  a.text.insert(0, 'PERSIST ');
  await sleep(300);
  a.ws.close();
  await sleep(300);

  const b = connect(roomId, adminToken);
  await b.ready;
  await sleep(300);
  assert.ok(b.text.toString().includes('PERSIST'));
  b.ws.close();
});

test('late joiners and returning users receive the latest run output', async () => {
  const { roomId, adminToken, bobToken, bobId } = await setup();
  await api('POST', `/api/rooms/${roomId}/admin`, { token: adminToken, body: { action: 'approve', userId: bobId } });

  const admin = connect(roomId, adminToken);
  await admin.ready;
  admin.ws.send(JSON.stringify({ type: 'run', stdin: '' }));
  await sleep(400);
  assert.ok(admin.messages.some((m) => m.type === 'run:result'));

  const late = connect(roomId, bobToken); // joins after the run happened
  await late.ready;
  await sleep(300);
  const last = late.messages.find((m) => m.type === 'run:last');
  assert.ok(last, 'late joiner gets the previous output');
  assert.equal(last.result.stdout, 'hi\n');

  // Leaving and coming back keeps the output too.
  late.ws.close();
  await sleep(200);
  const again = connect(roomId, bobToken);
  await again.ready;
  await sleep(300);
  assert.ok(again.messages.some((m) => m.type === 'run:last'));
  admin.ws.close();
  again.ws.close();
});

const fakeCursor = { anchor: { type: { client: 1, clock: 1 }, tname: null, item: null, assoc: 0 }, head: { type: { client: 1, clock: 1 }, tname: null, item: null, assoc: 0 } };
function publishAwareness(c, state) {
  c.awareness.setLocalState(state);
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 1);
  encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(c.awareness, [c.doc.clientID]));
  c.ws.send(encoding.toUint8Array(enc));
}
const cursorOf = (viewer, other) => viewer.awareness.getStates().get(other.doc.clientID)?.cursor;

test('only people who can edit show their cursor to others', async () => {
  const { roomId, adminToken, bobToken, bobId } = await setup();
  const act = (action) => api('POST', `/api/rooms/${roomId}/admin`, { token: adminToken, body: { action, userId: bobId } });
  await act('approve');
  const admin = connect(roomId, adminToken);
  const bob = connect(roomId, bobToken);
  await Promise.all([admin.ready, bob.ready]);
  await sleep(200);

  publishAwareness(bob, { cursor: fakeCursor, typing: 1 }); // read-only viewer clicks in the editor
  await sleep(300);
  assert.equal(cursorOf(admin, bob), undefined, 'a read-only cursor must not reach the admin');

  publishAwareness(admin, { cursor: fakeCursor });
  await sleep(300);
  assert.ok(cursorOf(bob, admin), 'viewers do see the cursor of someone who can edit');

  await act('grantEdit');
  await sleep(150);
  publishAwareness(bob, { cursor: fakeCursor });
  await sleep(300);
  assert.ok(cursorOf(admin, bob), 'once allowed to edit, the cursor is shown');

  await act('revokeEdit');
  await sleep(300);
  assert.equal(cursorOf(admin, bob), undefined, 'revoking editing hides the cursor again');
  admin.ws.close();
  bob.ws.close();
});
