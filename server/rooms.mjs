// Room + participant business rules. This is the single place where role and
// permission changes are authorised. Transport layers (REST, WebSocket) only
// call into this service, and emit 'change' events are used to push state.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { signToken, verifyToken } from './auth.mjs';
import { badRequest, conflict, forbidden, notFound, unauthorized } from './errors.mjs';
import { canEdit, isAdmin, describe } from './permissions.mjs';
import { DEFAULT_LANGUAGE, getLanguage } from '../shared/languages.mjs';

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const ID_LENGTH = 8;
const ID_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

export const COLORS = [
  '#4f9cf9', '#f2994a', '#27ae60', '#bb6bd9', '#eb5757', '#2dc3c3',
  '#e2b93b', '#f06292', '#8d6e63', '#7e8cf2', '#5fb85f', '#ff8a65',
];

export const JOIN_MODES = ['open', 'approval'];

export const ADMIN_ACTIONS = [
  'approve', 'deny', 'remove', 'promote', 'demote',
  'grantEdit', 'revokeEdit', 'grantPresenter', 'revokePresenter',
  'transferControl', 'setPresentation', 'setJoinMode',
];

export function generateRoomId() {
  let id = '';
  for (let i = 0; i < ID_LENGTH; i += 1) id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return id;
}

export function normalizeRoomId(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidRoomId(id) {
  return ID_PATTERN.test(id);
}

export function cleanName(raw, label = 'Name') {
  const name = String(raw ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
  if (!name) throw badRequest('invalid_name', `${label} is required`);
  return name;
}

export class RoomService extends EventEmitter {
  /**
   * @param {ReturnType<import('./store.mjs').openStore>} store
   * @param {{secret: string, limits: object}} options
   */
  constructor(store, { secret, limits }) {
    super();
    this.store = store;
    this.secret = secret;
    this.limits = limits;
  }

  // ---------------------------------------------------------------- tokens

  issueToken(roomId, userId) {
    return signToken(this.secret, { sub: userId, rid: roomId }, this.limits.tokenTtlSeconds);
  }

  /** Resolves a token to { room, participant } or throws 401/404. */
  authenticate(roomId, token) {
    const payload = verifyToken(this.secret, token);
    if (!payload || payload.rid !== roomId || typeof payload.sub !== 'string') throw unauthorized();
    const room = this.store.getRoom(roomId);
    if (!room) throw notFound('Room not found');
    const participant = this.store.getParticipant(roomId, payload.sub);
    if (!participant) throw unauthorized();
    return { room, participant };
  }

  /** Like authenticate, but also requires an approved participant. */
  authenticateApproved(roomId, token) {
    const ctx = this.authenticate(roomId, token);
    if (ctx.participant.status !== 'approved') throw forbidden('You are not an approved participant of this room');
    return ctx;
  }

  // ----------------------------------------------------------------- rooms

  getPublicRoom(roomId) {
    const room = this.store.getRoom(roomId);
    if (!room) throw notFound('Room not found');
    return { id: room.id, name: room.name, joinMode: room.joinMode };
  }

  createRoom({ roomName, displayName, joinMode = 'approval' }) {
    const name = cleanName(displayName, 'Display name');
    const title = cleanName(roomName || 'Untitled room', 'Room name');
    if (!JOIN_MODES.includes(joinMode)) throw badRequest('invalid_join_mode', 'joinMode must be "open" or "approval"');

    const userId = crypto.randomUUID();
    let roomId = null;
    this.store.transaction(() => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = generateRoomId();
        if (!this.store.getRoom(candidate)) {
          roomId = candidate;
          break;
        }
      }
      if (!roomId) throw conflict('id_exhausted', 'Could not allocate a room id, please retry');
      this.store.insertRoom({
        id: roomId, name: title, joinMode, presentation: false, language: DEFAULT_LANGUAGE, creatorId: userId,
      });
      this.store.insertParticipant({
        roomId, userId, name, color: COLORS[0], role: 'admin', canEdit: true, isPresenter: false, status: 'approved',
      });
    });
    return {
      room: this.store.getRoom(roomId),
      participant: this.store.getParticipant(roomId, userId),
      token: this.issueToken(roomId, userId),
    };
  }

  /**
   * Join (or re-join with a previously issued token).
   * Returns { status, token, participant } where status is pending|approved|denied|removed.
   */
  join(roomId, { displayName, token, rejoin = false } = {}) {
    const room = this.store.getRoom(roomId);
    if (!room) throw notFound('Room not found');

    // Returning participant: the token proves identity; their status is authoritative.
    const payload = token ? verifyToken(this.secret, token) : null;
    if (payload && payload.rid === roomId) {
      const existing = this.store.getParticipant(roomId, payload.sub);
      if (existing) {
        // A declined or removed person may ask again, but only by explicitly
        // re-requesting. Admin approval is always required, even in open
        // rooms, so removing someone cannot be undone by reconnecting.
        if (rejoin === true && (existing.status === 'denied' || existing.status === 'removed')) {
          if (this.store.countParticipants(roomId, 'pending') >= this.limits.maxPendingPerRoom) {
            throw conflict('too_many_requests', 'Too many pending join requests, try again later');
          }
          this.store.updateParticipant(roomId, existing.userId, {
            status: 'pending', canEdit: false, isPresenter: false, lastSeen: Date.now(),
          });
          this.emit('change', roomId, { kind: 'join', userId: existing.userId });
          return { status: 'pending', token, participant: this.store.getParticipant(roomId, existing.userId) };
        }
        this.store.updateParticipant(roomId, existing.userId, { lastSeen: Date.now() });
        return { status: existing.status, token, participant: existing };
      }
    }

    const name = cleanName(displayName, 'Display name');
    const approvedCount = this.store.countParticipants(roomId, 'approved');
    const pendingCount = this.store.countParticipants(roomId, 'pending');
    if (approvedCount >= this.limits.maxParticipantsPerRoom) throw conflict('room_full', 'This room is full');
    if (room.joinMode === 'approval' && pendingCount >= this.limits.maxPendingPerRoom) {
      throw conflict('too_many_requests', 'Too many pending join requests, try again later');
    }

    const userId = crypto.randomUUID();
    const used = new Set(this.store.listParticipants(roomId).filter((p) => p.status !== 'removed').map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c))
      ?? COLORS[this.store.listParticipants(roomId).length % COLORS.length];
    const status = room.joinMode === 'open' ? 'approved' : 'pending';
    this.store.insertParticipant({
      roomId, userId, name, color, role: 'participant', canEdit: false, isPresenter: false, status,
    });
    this.emit('change', roomId, { kind: 'join', userId });
    return {
      status,
      token: this.issueToken(roomId, userId),
      participant: this.store.getParticipant(roomId, userId),
    };
  }

  /**
   * A participant leaves the room for good (any status). Their record is kept
   * as 'removed' so history is consistent; the client discards its token and
   * joins as a brand-new person if it comes back. The last admin can only walk
   * away (identity kept) when nobody else is in the room; otherwise they must
   * promote someone first. Returns { kept }.
   */
  leave(roomId, userId) {
    const room = this.store.getRoom(roomId);
    if (!room) throw notFound('Room not found');
    const p = this.store.getParticipant(roomId, userId);
    if (!p) throw notFound('Participant not found');
    if (p.status === 'removed') return { kept: false };

    if (isAdmin(p) && this.store.countAdmins(roomId) <= 1) {
      const others = this.store.countParticipants(roomId, 'approved') - 1;
      if (others > 0) {
        throw conflict('last_admin', 'You are the only admin and others are still in the room. Make someone else an admin before leaving.');
      }
      // Alone in the room: the admin just walks away. Their identity is kept so
      // they can come back to the room (and the room is never left without an admin).
      return { kept: true };
    }

    this.store.updateParticipant(roomId, userId, { status: 'removed', canEdit: false, isPresenter: false });
    this.emit('change', roomId, { kind: 'leave', userId });
    return { kept: false };
  }

  // ----------------------------------------------------------------- state

  /** The personalised snapshot a client receives over WebSocket / REST. */
  buildState(roomId, viewerId, onlineIds = new Set()) {
    const room = this.store.getRoom(roomId);
    if (!room) throw notFound('Room not found');
    const all = this.store.listParticipants(roomId);
    const me = all.find((p) => p.userId === viewerId);
    if (!me) throw unauthorized();
    const viewerIsAdmin = isAdmin(me);
    const visible = all.filter((p) => p.status === 'approved' || (viewerIsAdmin && p.status === 'pending'));
    return {
      room: {
        id: room.id,
        name: room.name,
        joinMode: room.joinMode,
        presentationMode: room.presentation,
        language: room.language,
      },
      you: { userId: me.userId, name: me.name, color: me.color, role: me.role, status: me.status, ...describe(room, me) },
      participants: visible.map((p) => ({
        userId: p.userId,
        name: p.name,
        color: p.color,
        role: p.role,
        status: p.status,
        canEdit: p.canEdit,
        isPresenter: p.isPresenter,
        editing: canEdit(room, p),
        online: onlineIds.has(p.userId),
      })),
    };
  }

  // ------------------------------------------------------- language setting

  setLanguage(roomId, actorId, language) {
    const room = this.store.getRoom(roomId);
    if (!room) throw notFound('Room not found');
    const actor = this.store.getParticipant(roomId, actorId);
    if (!canEdit(room, actor)) throw forbidden('Only people who can edit may change the language');
    if (!getLanguage(language)) throw badRequest('invalid_language', 'Unsupported language');
    if (room.language !== language) {
      this.store.updateRoom(roomId, { language });
      this.emit('change', roomId, { kind: 'language', userId: actorId, language });
    }
    return language;
  }

  // ---------------------------------------------------------- admin actions

  /**
   * Applies one admin action. Authorisation is checked here, on the server,
   * against the database state — never against anything the client claims.
   */
  adminAction(roomId, actorId, action, { userId, value } = {}) {
    if (!ADMIN_ACTIONS.includes(action)) throw badRequest('invalid_action', 'Unknown admin action');
    const room = this.store.getRoom(roomId);
    if (!room) throw notFound('Room not found');
    const actor = this.store.getParticipant(roomId, actorId);
    if (!isAdmin(actor)) throw forbidden('Only room admins can do that');

    const requireTarget = (statuses) => {
      if (typeof userId !== 'string') throw badRequest('missing_user', 'userId is required');
      const target = this.store.getParticipant(roomId, userId);
      if (!target) throw notFound('Participant not found');
      if (statuses && !statuses.includes(target.status)) {
        throw conflict('invalid_state', `Participant is ${target.status}`);
      }
      return target;
    };
    const update = (id, fields) => this.store.updateParticipant(roomId, id, fields);

    this.store.transaction(() => {
      switch (action) {
        case 'approve': {
          const t = requireTarget(['pending', 'denied']);
          if (this.store.countParticipants(roomId, 'approved') >= this.limits.maxParticipantsPerRoom) {
            throw conflict('room_full', 'This room is full');
          }
          update(t.userId, { status: 'approved' });
          break;
        }
        case 'deny': {
          const t = requireTarget(['pending']);
          update(t.userId, { status: 'denied' });
          break;
        }
        case 'remove': {
          const t = requireTarget(['approved', 'pending']);
          if (t.role === 'admin') throw conflict('target_is_admin', 'Demote this admin before removing them');
          update(t.userId, { status: 'removed', canEdit: false, isPresenter: false });
          break;
        }
        case 'promote': {
          const t = requireTarget(['approved']);
          update(t.userId, { role: 'admin' });
          break;
        }
        case 'demote': {
          const t = requireTarget(['approved']);
          if (t.role !== 'admin') throw conflict('not_admin', 'Participant is not an admin');
          if (this.store.countAdmins(roomId) <= 1) throw conflict('last_admin', 'A room needs at least one admin');
          update(t.userId, { role: 'participant', canEdit: false, isPresenter: false });
          break;
        }
        case 'grantEdit': {
          const t = requireTarget(['approved']);
          if (t.role === 'admin') throw conflict('target_is_admin', 'Admins can always edit');
          update(t.userId, { canEdit: true });
          break;
        }
        case 'revokeEdit': {
          const t = requireTarget(['approved']);
          if (t.role === 'admin') throw conflict('target_is_admin', 'Admins can always edit; demote them first');
          update(t.userId, { canEdit: false });
          break;
        }
        case 'grantPresenter': {
          const t = requireTarget(['approved']);
          if (t.role === 'admin') throw conflict('target_is_admin', 'Admins can always edit');
          update(t.userId, { isPresenter: true });
          break;
        }
        case 'revokePresenter': {
          const t = requireTarget(['approved']);
          update(t.userId, { isPresenter: false });
          break;
        }
        case 'transferControl': {
          // Exactly one non-admin holds coding control afterwards.
          const t = requireTarget(['approved']);
          for (const p of this.store.listParticipants(roomId)) {
            if (p.role !== 'admin' && (p.canEdit || p.isPresenter)) update(p.userId, { canEdit: false, isPresenter: false });
          }
          if (t.role !== 'admin') update(t.userId, { canEdit: true, isPresenter: true });
          break;
        }
        case 'setPresentation': {
          if (typeof value !== 'boolean') throw badRequest('invalid_value', 'value must be true or false');
          this.store.updateRoom(roomId, { presentation: value });
          break;
        }
        case 'setJoinMode': {
          if (!JOIN_MODES.includes(value)) throw badRequest('invalid_value', 'value must be "open" or "approval"');
          this.store.updateRoom(roomId, { joinMode: value });
          break;
        }
        default:
          throw badRequest('invalid_action', 'Unknown admin action');
      }
    });

    this.emit('change', roomId, { kind: 'admin', action, userId, actorId });
  }
}
