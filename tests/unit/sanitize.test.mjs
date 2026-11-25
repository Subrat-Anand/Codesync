import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAwarenessState } from '../../server/sanitize.mjs';

const identity = { userId: 'real-user', name: 'Real Name', color: '#4f9cf9' };

test('identity always comes from the server, never from the client', () => {
  const s = sanitizeAwarenessState(
    { user: { id: 'admin-user', name: 'Totally The Admin', color: '#000000' }, role: 'admin', canEdit: true },
    identity,
  );
  assert.deepEqual(s.user, { id: 'real-user', name: 'Real Name', color: '#4f9cf9' });
  assert.equal(s.role, undefined);
  assert.equal(s.canEdit, undefined);
});

test('keeps well-formed cursor and typing info, drops everything else', () => {
  const rel = { type: { client: 1, clock: 2 }, tname: null, item: null, assoc: 0 };
  const s = sanitizeAwarenessState({ cursor: { anchor: rel, head: rel }, typing: 1234.9, evil: '<script>' }, identity);
  assert.deepEqual(s.cursor, { anchor: rel, head: rel });
  assert.equal(s.typing, 1234);
  assert.equal(s.evil, undefined);
});

test('rejects oversized or malformed cursors', () => {
  const huge = { blob: 'x'.repeat(2000) };
  assert.equal(sanitizeAwarenessState({ cursor: { anchor: huge, head: huge } }, identity).cursor, undefined);
  assert.equal(sanitizeAwarenessState({ cursor: { anchor: 'x', head: [] } }, identity).cursor, undefined);
});

test('null means leave; non-objects are ignored', () => {
  assert.equal(sanitizeAwarenessState(null, identity), null);
  assert.equal(sanitizeAwarenessState('str', identity), undefined);
  assert.equal(sanitizeAwarenessState([], identity), undefined);
});

test('falls back to a neutral colour if the stored colour is not a hex value', () => {
  const s = sanitizeAwarenessState({}, { ...identity, color: 'red; background:url(x)' });
  assert.equal(s.user.color, '#888888');
});

test('people who cannot edit never publish a cursor, selection or typing indicator', () => {
  const rel = { type: { client: 1, clock: 2 }, tname: null, item: null, assoc: 0 };
  const s = sanitizeAwarenessState({ cursor: { anchor: rel, head: rel }, typing: 99 }, identity, { showCursor: false });
  assert.deepEqual(s, { user: { id: 'real-user', name: 'Real Name', color: '#4f9cf9' } });
});
