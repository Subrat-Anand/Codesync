// Per-room session tokens live in localStorage so a refresh (or a new tab)
// resumes the same participant identity and role.

const tokenKey = (roomId) => `codesync:token:${roomId}`;
const NAME_KEY = 'codesync:name';

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export const session = {
  getToken: (roomId) => safe(() => window.localStorage.getItem(tokenKey(roomId))),
  setToken: (roomId, token) => safe(() => window.localStorage.setItem(tokenKey(roomId), token)),
  clearToken: (roomId) => safe(() => window.localStorage.removeItem(tokenKey(roomId))),
  getName: () => safe(() => window.localStorage.getItem(NAME_KEY)) || '',
  setName: (name) => safe(() => window.localStorage.setItem(NAME_KEY, name)),
};
