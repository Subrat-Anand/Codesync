// Pure helpers that make awareness (cursor/presence) payloads trustworthy.
// Clients may only publish cursor/selection/typing info; identity always comes
// from the server's own participant record, so nobody can impersonate an Admin
// or another participant. People who cannot edit publish no cursor, selection
// or typing info at all: where a read-only viewer clicks is nobody's business.

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_REL_POS_JSON = 512;

function cleanRelativePosition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    if (JSON.stringify(value).length > MAX_REL_POS_JSON) return null;
  } catch {
    return null;
  }
  return value;
}

/**
 * @param {unknown} state raw awareness state sent by a client (or null = leave)
 * @param {{userId: string, name: string, color: string}} identity authoritative identity
 * @param {{showCursor?: boolean}} [opts] showCursor=false for people who cannot edit
 */
export function sanitizeAwarenessState(state, identity, { showCursor = true } = {}) {
  if (state === null) return null;
  if (typeof state !== 'object' || Array.isArray(state)) return undefined;
  const out = {
    user: {
      id: identity.userId,
      name: identity.name,
      color: COLOR_RE.test(identity.color) ? identity.color : '#888888',
    },
  };
  if (!showCursor) return out;
  if (state.cursor && typeof state.cursor === 'object') {
    const anchor = cleanRelativePosition(state.cursor.anchor);
    const head = cleanRelativePosition(state.cursor.head);
    if (anchor && head) out.cursor = { anchor, head };
  }
  if (typeof state.typing === 'number' && Number.isFinite(state.typing)) {
    out.typing = Math.floor(state.typing);
  }
  return out;
}
