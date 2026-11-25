// Minimal HS256 JWT implementation on top of node:crypto (no dependency).
import crypto from 'node:crypto';

const b64u = (input) => Buffer.from(input).toString('base64url');

export function signToken(secret, payload, ttlSeconds, now = Date.now()) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const iat = Math.floor(now / 1000);
  const body = b64u(JSON.stringify({ ...payload, iat, exp: iat + ttlSeconds }));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** Returns the payload or null. Never throws. */
export function verifyToken(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${h}.${b}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header?.alg !== 'HS256' || !payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
  return payload;
}

/** Uses the configured secret, else a random one persisted in the database. */
export function loadSecret(store, envSecret) {
  if (envSecret) return envSecret;
  let secret = store.getMeta('jwt_secret');
  if (!secret) {
    secret = crypto.randomBytes(48).toString('hex');
    store.setMeta('jwt_secret', secret);
  }
  return secret;
}

export function bearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  return m ? m[1] : null;
}
