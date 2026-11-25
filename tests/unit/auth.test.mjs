import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, bearerToken } from '../../server/auth.mjs';

const SECRET = 'test-secret';

test('signs and verifies a token', () => {
  const t = signToken(SECRET, { sub: 'u1', rid: 'ROOM' }, 60);
  const p = verifyToken(SECRET, t);
  assert.equal(p.sub, 'u1');
  assert.equal(p.rid, 'ROOM');
});

test('rejects wrong secret, tampered payload, garbage and expired tokens', () => {
  const t = signToken(SECRET, { sub: 'u1', rid: 'ROOM' }, 60);
  assert.equal(verifyToken('other', t), null);

  const [h, , s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', rid: 'ROOM', exp: 9999999999 })).toString('base64url');
  assert.equal(verifyToken(SECRET, `${h}.${forged}.${s}`), null);

  assert.equal(verifyToken(SECRET, 'not-a-token'), null);
  assert.equal(verifyToken(SECRET, ''), null);
  assert.equal(verifyToken(SECRET, undefined), null);

  const old = signToken(SECRET, { sub: 'u1' }, 10, Date.now() - 60_000);
  assert.equal(verifyToken(SECRET, old), null);
});

test('rejects tokens that claim alg none', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: 'u1', exp: 9999999999 })).toString('base64url');
  assert.equal(verifyToken(SECRET, `${header}.${body}.`), null);
});

test('parses bearer header', () => {
  assert.equal(bearerToken({ headers: { authorization: 'Bearer abc.def.ghi' } }), 'abc.def.ghi');
  assert.equal(bearerToken({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(bearerToken({ headers: {} }), null);
});
