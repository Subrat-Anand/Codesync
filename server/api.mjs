// REST API. Every response is JSON. Errors have the shape
//   { "error": { "code": "...", "message": "..." } }
import { HttpError, badRequest, notFound } from './errors.mjs';
import { bearerToken } from './auth.mjs';
import { createRateLimiter } from './ratelimit.mjs';
import { isValidRoomId, normalizeRoomId } from './rooms.mjs';
import { LANGUAGES } from '../shared/languages.mjs';

const MAX_BODY_BYTES = 16 * 1024;

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Request body is too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw badRequest('invalid_json', 'Request body must be a JSON object');
  }
}

/**
 * @param {{rooms: import('./rooms.mjs').RoomService, hub: import('./hub.mjs').Hub, trustProxy?: boolean}} deps
 * @returns {(req, res) => Promise<boolean>} resolves true when the request was an API request
 */
export function createApiHandler({ rooms, hub, trustProxy = false, now = () => Date.now() }) {
  const createLimiter = createRateLimiter({ windowMs: 60_000, max: 10, now });
  const joinLimiter = createRateLimiter({ windowMs: 60_000, max: 30, now });
  const adminLimiter = createRateLimiter({ windowMs: 10_000, max: 40, now });

  const clientIp = (req) => {
    if (trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || 'unknown';
  };
  const limit = (limiter, key) => {
    if (!limiter.take(key)) throw new HttpError(429, 'rate_limited', 'Too many requests, slow down');
  };

  const roomIdFrom = (raw) => {
    const id = normalizeRoomId(raw);
    if (!isValidRoomId(id)) throw notFound('Room not found');
    return id;
  };

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const method = req.method;
    const ip = clientIp(req);

    if (method === 'GET' && pathname === '/api/health') return send(res, 200, { ok: true });
    if (method === 'GET' && pathname === '/api/languages') {
      return send(res, 200, { languages: LANGUAGES.map(({ id, label, monaco }) => ({ id, label, monaco })) });
    }

    if (method === 'POST' && pathname === '/api/rooms') {
      limit(createLimiter, ip);
      const body = await readJson(req);
      const { room, participant, token } = rooms.createRoom({
        roomName: body.roomName,
        displayName: body.displayName,
        joinMode: body.joinMode,
      });
      return send(res, 201, { roomId: room.id, token, you: { userId: participant.userId, role: participant.role } });
    }

    const m = /^\/api\/rooms\/([^/]+)(?:\/(join|me|admin|leave))?$/.exec(pathname);
    if (!m) throw notFound('Unknown API route');
    const roomId = roomIdFrom(decodeURIComponent(m[1]));
    const sub = m[2];

    if (!sub && method === 'GET') return send(res, 200, rooms.getPublicRoom(roomId));

    if (sub === 'join' && method === 'POST') {
      limit(joinLimiter, ip);
      const body = await readJson(req);
      const result = rooms.join(roomId, { displayName: body.displayName, token: bearerToken(req), rejoin: body.rejoin === true });
      return send(res, 200, {
        status: result.status,
        token: result.token,
        you: { userId: result.participant.userId, role: result.participant.role },
      });
    }

    if (sub === 'leave' && method === 'POST') {
      const { participant } = rooms.authenticate(roomId, bearerToken(req));
      const { kept } = rooms.leave(roomId, participant.userId);
      return send(res, 200, { ok: true, kept });
    }

    if (sub === 'me' && method === 'GET') {
      const { participant } = rooms.authenticate(roomId, bearerToken(req));
      if (participant.status !== 'approved') {
        return send(res, 200, { status: participant.status, you: { userId: participant.userId, name: participant.name } });
      }
      return send(res, 200, {
        status: 'approved',
        state: rooms.buildState(roomId, participant.userId, hub.onlineUserIds(roomId)),
      });
    }

    if (sub === 'admin' && method === 'POST') {
      const { participant } = rooms.authenticate(roomId, bearerToken(req));
      limit(adminLimiter, `${roomId}:${participant.userId}`);
      const body = await readJson(req);
      rooms.adminAction(roomId, participant.userId, String(body.action), { userId: body.userId, value: body.value });
      return send(res, 200, { ok: true });
    }

    throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
  }

  return async function handle(req, res) {
    const path = (req.url || '').split('?')[0];
    if (!path.startsWith('/api/')) return false;
    try {
      await route(req, res);
    } catch (err) {
      if (res.headersSent) return true;
      if (err instanceof HttpError) {
        send(res, err.status, { error: { code: err.code, message: err.message } });
      } else {
        console.error('[api] unexpected error', err);
        send(res, 500, { error: { code: 'internal', message: 'Internal server error' } });
      }
    }
    return true;
  };
}
