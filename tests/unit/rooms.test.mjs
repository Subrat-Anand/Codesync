import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../../server/store.mjs';
import { RoomService, cleanName, generateRoomId, isValidRoomId, normalizeRoomId } from '../../server/rooms.mjs';
import { HttpError } from '../../server/errors.mjs';
import { loadConfig } from '../../server/config.mjs';

function setup() {
  const store = openStore(':memory:');
  const config = loadConfig({});
  const rooms = new RoomService(store, { secret: 's3cret', limits: config.limits });
  const events = [];
  rooms.on('change', (roomId, info) => events.push({ roomId, ...info }));
  return { store, rooms, events };
}

const throwsHttp = (fn, status, code) =>
  assert.throws(fn, (err) => err instanceof HttpError && err.status === status && (!code || err.code === code));

function roomWith(rooms, joinMode = 'open') {
  const created = rooms.createRoom({ roomName: 'Demo', displayName: 'Alice', joinMode });
  const roomId = created.room.id;
  const bob = rooms.join(roomId, { displayName: 'Bob' });
  const carol = rooms.join(roomId, { displayName: 'Carol' });
  return {
    roomId,
    alice: created.participant.userId,
    bob: bob.participant.userId,
    carol: carol.participant.userId,
    tokens: { alice: created.token, bob: bob.token, carol: carol.token },
  };
}

test('room ids are unambiguous 8-char codes and input is normalised', () => {
  for (let i = 0; i < 200; i += 1) assert.ok(isValidRoomId(generateRoomId()));
  assert.equal(normalizeRoomId('abcd-2345 '), 'ABCD2345');
  assert.equal(isValidRoomId('ABCD0O1I'), false);
});

test('names are sanitised', () => {
  assert.equal(cleanName('  Al\n\tice   Smith  '), 'Al ice Smith');
  assert.equal(cleanName('x'.repeat(100)).length, 32);
  throwsHttp(() => cleanName('   '), 400, 'invalid_name');
});

test('creator becomes admin and can edit; others start read-only', () => {
  const { rooms } = setup();
  const { roomId, alice, bob } = roomWith(rooms);
  const a = rooms.buildState(roomId, alice);
  const b = rooms.buildState(roomId, bob);
  assert.equal(a.you.role, 'admin');
  assert.equal(a.you.canEdit, true);
  assert.equal(b.you.role, 'participant');
  assert.equal(b.you.canEdit, false);
});

test('approval mode: joiners are pending, cannot authenticate as approved, and are only visible to admins', () => {
  const { rooms } = setup();
  const { roomId, alice, bob, tokens } = roomWith(rooms, 'approval');
  assert.equal(rooms.store.getParticipant(roomId, bob).status, 'pending');
  throwsHttp(() => rooms.authenticateApproved(roomId, tokens.bob), 403);

  assert.ok(rooms.buildState(roomId, alice).participants.some((p) => p.userId === bob && p.status === 'pending'));

  rooms.adminAction(roomId, alice, 'approve', { userId: bob });
  assert.doesNotThrow(() => rooms.authenticateApproved(roomId, tokens.bob));
  const bobView = rooms.buildState(roomId, bob);
  assert.ok(!bobView.participants.some((p) => p.status === 'pending'), 'non-admins never see pending requests');
});

test('denied participants cannot rejoin with their token', () => {
  const { rooms } = setup();
  const { roomId, alice, bob, tokens } = roomWith(rooms, 'approval');
  rooms.adminAction(roomId, alice, 'deny', { userId: bob });
  const again = rooms.join(roomId, { displayName: 'Bob', token: tokens.bob });
  assert.equal(again.status, 'denied');
  throwsHttp(() => rooms.authenticateApproved(roomId, tokens.bob), 403);
});

test('open mode approves immediately; returning token keeps identity', () => {
  const { rooms } = setup();
  const { roomId, bob, tokens } = roomWith(rooms, 'open');
  assert.equal(rooms.store.getParticipant(roomId, bob).status, 'approved');
  const again = rooms.join(roomId, { token: tokens.bob });
  assert.equal(again.participant.userId, bob);
});

test('tokens are bound to a single room', () => {
  const { rooms } = setup();
  const one = roomWith(rooms);
  const two = roomWith(rooms);
  throwsHttp(() => rooms.authenticate(two.roomId, one.tokens.alice), 401);
});

test('non-admins cannot perform any admin action (enforced server-side)', () => {
  const { rooms } = setup();
  const { roomId, bob, carol } = roomWith(rooms);
  for (const action of ['grantEdit', 'revokeEdit', 'promote', 'remove', 'transferControl', 'grantPresenter']) {
    throwsHttp(() => rooms.adminAction(roomId, bob, action, { userId: carol }), 403);
  }
  throwsHttp(() => rooms.adminAction(roomId, bob, 'setPresentation', { value: true }), 403);
  throwsHttp(() => rooms.adminAction(roomId, bob, 'setJoinMode', { value: 'open' }), 403);
  assert.equal(rooms.buildState(roomId, carol).you.canEdit, false);
});

test('grant and revoke editing take effect and emit change events', () => {
  const { rooms, events } = setup();
  const { roomId, alice, bob } = roomWith(rooms);
  events.length = 0;

  rooms.adminAction(roomId, alice, 'grantEdit', { userId: bob });
  assert.equal(rooms.buildState(roomId, bob).you.canEdit, true);
  assert.equal(events.at(-1).kind, 'admin');

  rooms.adminAction(roomId, alice, 'revokeEdit', { userId: bob });
  assert.equal(rooms.buildState(roomId, bob).you.canEdit, false);
});

test('presentation mode: only admins and presenters edit; disabling restores granted editors', () => {
  const { rooms } = setup();
  const { roomId, alice, bob, carol } = roomWith(rooms);
  rooms.adminAction(roomId, alice, 'grantEdit', { userId: bob });
  rooms.adminAction(roomId, alice, 'grantPresenter', { userId: carol });

  rooms.adminAction(roomId, alice, 'setPresentation', { value: true });
  assert.equal(rooms.buildState(roomId, alice).you.canEdit, true);
  assert.equal(rooms.buildState(roomId, bob).you.canEdit, false, 'granted editor is read-only while presenting');
  assert.equal(rooms.buildState(roomId, carol).you.canEdit, true, 'presenter keeps edit access');
  assert.equal(rooms.buildState(roomId, bob).room.presentationMode, true);

  rooms.adminAction(roomId, alice, 'setPresentation', { value: false });
  assert.equal(rooms.buildState(roomId, bob).you.canEdit, true);
});

test('transferControl leaves exactly one non-admin editor', () => {
  const { rooms } = setup();
  const { roomId, alice, bob, carol } = roomWith(rooms);
  rooms.adminAction(roomId, alice, 'grantEdit', { userId: bob });
  rooms.adminAction(roomId, alice, 'transferControl', { userId: carol });
  assert.equal(rooms.buildState(roomId, bob).you.canEdit, false);
  assert.equal(rooms.buildState(roomId, carol).you.canEdit, true);
  assert.equal(rooms.buildState(roomId, alice).you.canEdit, true);
});

test('multiple admins: promote, demote, and the last admin cannot be demoted', () => {
  const { rooms } = setup();
  const { roomId, alice, bob } = roomWith(rooms);
  rooms.adminAction(roomId, alice, 'promote', { userId: bob });
  assert.equal(rooms.buildState(roomId, bob).you.isAdmin, true);
  assert.equal(rooms.buildState(roomId, bob).you.canEdit, true);

  // new admin can manage the room
  rooms.adminAction(roomId, bob, 'setPresentation', { value: true });

  rooms.adminAction(roomId, bob, 'demote', { userId: alice });
  assert.equal(rooms.buildState(roomId, alice).you.isAdmin, false);
  assert.equal(rooms.buildState(roomId, alice).you.canEdit, false);

  throwsHttp(() => rooms.adminAction(roomId, bob, 'demote', { userId: bob }), 409, 'last_admin');
});

test('admins cannot be revoked or removed without demoting first', () => {
  const { rooms } = setup();
  const { roomId, alice, bob } = roomWith(rooms);
  rooms.adminAction(roomId, alice, 'promote', { userId: bob });
  throwsHttp(() => rooms.adminAction(roomId, alice, 'revokeEdit', { userId: bob }), 409, 'target_is_admin');
  throwsHttp(() => rooms.adminAction(roomId, alice, 'remove', { userId: bob }), 409, 'target_is_admin');
});

test('removed participants lose access and edit rights', () => {
  const { rooms } = setup();
  const { roomId, alice, bob, tokens } = roomWith(rooms);
  rooms.adminAction(roomId, alice, 'grantEdit', { userId: bob });
  rooms.adminAction(roomId, alice, 'remove', { userId: bob });
  throwsHttp(() => rooms.authenticateApproved(roomId, tokens.bob), 403);
  const p = rooms.store.getParticipant(roomId, bob);
  assert.equal(p.canEdit, false);
  assert.equal(p.status, 'removed');
});

test('language changes require edit permission and a supported language', () => {
  const { rooms } = setup();
  const { roomId, alice, bob } = roomWith(rooms);
  throwsHttp(() => rooms.setLanguage(roomId, bob, 'python'), 403);
  rooms.adminAction(roomId, alice, 'grantEdit', { userId: bob });
  assert.equal(rooms.setLanguage(roomId, bob, 'python'), 'python');
  assert.equal(rooms.buildState(roomId, alice).room.language, 'python');
  throwsHttp(() => rooms.setLanguage(roomId, bob, 'brainfuck'), 400, 'invalid_language');
});

test('validates admin action inputs', () => {
  const { rooms } = setup();
  const { roomId, alice } = roomWith(rooms);
  throwsHttp(() => rooms.adminAction(roomId, alice, 'launchMissiles', {}), 400, 'invalid_action');
  throwsHttp(() => rooms.adminAction(roomId, alice, 'setPresentation', { value: 'yes' }), 400, 'invalid_value');
  throwsHttp(() => rooms.adminAction(roomId, alice, 'setJoinMode', { value: 'public' }), 400, 'invalid_value');
  throwsHttp(() => rooms.adminAction(roomId, alice, 'grantEdit', {}), 400, 'missing_user');
  throwsHttp(() => rooms.adminAction(roomId, alice, 'grantEdit', { userId: 'nobody' }), 404);
});

test('room capacity is enforced', () => {
  const store = openStore(':memory:');
  const limits = { ...loadConfig({}).limits, maxParticipantsPerRoom: 2 };
  const rooms = new RoomService(store, { secret: 's', limits });
  const { room } = rooms.createRoom({ roomName: 'r', displayName: 'A', joinMode: 'open' });
  rooms.join(room.id, { displayName: 'B' });
  throwsHttp(() => rooms.join(room.id, { displayName: 'C' }), 409, 'room_full');
});

test('document state persists in the database', () => {
  const { rooms, store } = setup();
  const { roomId } = roomWith(rooms);
  assert.equal(store.loadDocState(roomId), null);
  store.saveDocState(roomId, new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual([...store.loadDocState(roomId)], [1, 2, 3, 4]);
});

test('failed admin actions roll back (no partial writes)', () => {
  const { rooms, store } = setup();
  const { roomId, alice, bob } = roomWith(rooms);
  rooms.adminAction(roomId, alice, 'grantEdit', { userId: bob });
  assert.throws(() => rooms.adminAction(roomId, alice, 'demote', { userId: alice }));
  assert.equal(store.getParticipant(roomId, bob).canEdit, true);
  assert.equal(store.getParticipant(roomId, alice).role, 'admin');
});

test('denied or removed people can ask again; the admin sees a fresh pending request', () => {
  const { rooms, events } = setup();
  const { roomId, alice, bob, tokens } = roomWith(rooms, 'approval');
  rooms.adminAction(roomId, alice, 'deny', { userId: bob });

  // Merely reconnecting does not re-request.
  assert.equal(rooms.join(roomId, { token: tokens.bob }).status, 'denied');
  assert.equal(rooms.buildState(roomId, alice).participants.some((p) => p.userId === bob && p.status === 'pending'), false);

  events.length = 0;
  assert.equal(rooms.join(roomId, { token: tokens.bob, rejoin: true }).status, 'pending');
  assert.ok(events.some((e) => e.kind === 'join' && e.userId === bob), 'admins are notified');
  const pending = rooms.buildState(roomId, alice).participants.filter((p) => p.status === 'pending');
  assert.ok(pending.some((p) => p.userId === bob), 'bob is listed as pending for the admin');

  rooms.adminAction(roomId, alice, 'approve', { userId: bob });
  rooms.adminAction(roomId, alice, 'grantEdit', { userId: bob });
  rooms.adminAction(roomId, alice, 'remove', { userId: bob });

  // Removed in an OPEN room: still needs approval again, and edit rights are gone.
  rooms.adminAction(roomId, alice, 'setJoinMode', { value: 'open' });
  assert.equal(rooms.join(roomId, { token: tokens.bob, rejoin: true }).status, 'pending');
  assert.equal(rooms.store.getParticipant(roomId, bob).canEdit, false);
});

test('a rejoin flag cannot upgrade an approved or unknown participant', () => {
  const { rooms } = setup();
  const { roomId, bob, tokens } = roomWith(rooms, 'open');
  assert.equal(rooms.join(roomId, { token: tokens.bob, rejoin: true }).status, 'approved');
  assert.equal(rooms.store.getParticipant(roomId, bob).status, 'approved');
});

test('leaving: participants may leave, the last admin may not', () => {
  const { rooms, events } = setup();
  const { roomId, alice, bob, tokens } = roomWith(rooms, 'open');
  rooms.adminAction(roomId, alice, 'grantEdit', { userId: bob });

  rooms.leave(roomId, bob);
  assert.equal(rooms.store.getParticipant(roomId, bob).status, 'removed');
  assert.equal(rooms.store.getParticipant(roomId, bob).canEdit, false);
  assert.ok(events.some((e) => e.kind === 'leave' && e.userId === bob));
  throwsHttp(() => rooms.authenticateApproved(roomId, tokens.bob), 403);
  assert.equal(rooms.buildState(roomId, alice).participants.some((p) => p.userId === bob && p.status === 'approved'), false);

  throwsHttp(() => rooms.leave(roomId, alice), 409, 'last_admin');
  rooms.adminAction(roomId, alice, 'promote', { userId: roomWithCarol(rooms, roomId) });
  rooms.leave(roomId, alice);
  assert.equal(rooms.store.getParticipant(roomId, alice).status, 'removed');
});

function roomWithCarol(rooms, roomId) {
  return rooms.store.listParticipants(roomId).find((p) => p.name === 'Carol').userId;
}

test('pending requests can be cancelled by leaving', () => {
  const { rooms } = setup();
  const { roomId, alice, bob } = roomWith(rooms, 'approval');
  rooms.leave(roomId, bob);
  assert.equal(rooms.buildState(roomId, alice).participants.some((p) => p.userId === bob && p.status === 'pending'), false);
});

test('a lone admin can walk away and keeps their identity; the output of the last run is stored per room', () => {
  const { rooms, store } = setup();
  const created = rooms.createRoom({ roomName: 'Solo', displayName: 'Alice', joinMode: 'open' });
  const roomId = created.room.id;
  const alice = created.participant.userId;
  assert.deepEqual(rooms.leave(roomId, alice), { kept: true });
  assert.equal(store.getParticipant(roomId, alice).status, 'approved');
  assert.equal(store.getParticipant(roomId, alice).role, 'admin');

  assert.equal(store.loadLastRun(roomId), null);
  store.saveLastRun(roomId, { by: 'Alice', language: 'JavaScript', result: { ok: true, stdout: 'hi\n' } });
  store.saveLastRun(roomId, { by: 'Alice', language: 'JavaScript', result: { ok: true, stdout: 'second\n' } });
  assert.equal(store.loadLastRun(roomId).result.stdout, 'second\n');
});

test('granting or revoking editing never changes presenter status, and vice versa', () => {
  const { rooms, store } = setup();
  const { roomId, alice, bob } = roomWith(rooms, 'open');
  const get = () => store.getParticipant(roomId, bob);

  rooms.adminAction(roomId, alice, 'grantPresenter', { userId: bob });
  assert.deepEqual([get().canEdit, get().isPresenter], [false, true]);
  assert.equal(rooms.buildState(roomId, bob).you.canEdit, false, 'presenter alone is read-only in normal mode');

  rooms.adminAction(roomId, alice, 'grantEdit', { userId: bob });
  rooms.adminAction(roomId, alice, 'revokeEdit', { userId: bob });
  assert.deepEqual([get().canEdit, get().isPresenter], [false, true], 'revoking editing keeps presenter');

  rooms.adminAction(roomId, alice, 'grantEdit', { userId: bob });
  rooms.adminAction(roomId, alice, 'revokePresenter', { userId: bob });
  assert.deepEqual([get().canEdit, get().isPresenter], [true, false], 'removing presenter keeps editing access');
});
