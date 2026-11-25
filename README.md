# CodeSync

Real-time collaborative coding rooms. Monaco editor + Yjs, a single Node server (Next.js UI, REST API and WebSocket on one port), SQLite persistence (`node:sqlite`, so Node ≥ 22.13), and sandboxed code execution through a Piston-compatible API.

## Run it

```bash
npm install            # also copies Monaco's assets into public/ (postinstall)
npm run dev            # http://localhost:3000
# production
npm run build && npm start
```

Tests:

```bash
npm test                    # unit tests, no dependencies needed
npm run test:integration    # real HTTP + WebSocket + Yjs; needs npm install
```

Copy `.env.example` to `.env` to configure the port, database file, secret, allowed origins and `PISTON_URL`.

### Code execution backend

Two modes, chosen with `CODESYNC_EXECUTOR` (default: `local` for `npm run dev`, `piston` for `npm start`):

- `local` runs code on your own computer with a time limit, output cap, scrubbed environment and temp directory. It is **not a sandbox**: use it only with people you trust. It needs the language tools installed locally (node, python, gcc, g++, javac/java, go, ruby, php; Rust and C# need Piston).
- `piston` is the sandboxed option described below.

User code is never executed in this process. The server forwards it to a Piston-compatible service (`POST {PISTON_URL}/execute`). Self-host Piston, e.g. `docker run -p 2000:2000 --privileged ghcr.io/engineer-man/piston`, then install language runtimes into it and point `PISTON_URL` at it. Without it, Run reports "Could not reach the execution service" and nothing else breaks.

Limits (`server/config.mjs`): 3 s run / 10 s compile timeout, 256 MB memory, 64 K chars of output, 16 K chars stdin, 200 K chars of code, 2 s per-room cooldown, 4 concurrent runs, one run at a time per room.

Languages: JavaScript, TypeScript, Python, Java, C, C++, Go, Rust, C#, Ruby, PHP (`shared/languages.mjs`).

## Permission model

| Who | Can edit / run / change language |
| --- | --- |
| Admin | always |
| Participant, normal mode | only if the admin granted edit (`grantEdit`) |
| Participant, presentation mode | only if selected as presenter (`grantPresenter`); edit access is paused meanwhile |
| Pending / denied / removed | cannot read or connect |

Cursors, selections and typing indicators are shown only for people who can edit right now. The server drops them from everyone else's awareness updates and removes them when access is revoked.

Edit access and presenter status are independent switches: changing one never changes the other. (`transferControl` sets both for one person.)

The rules live in `server/permissions.mjs` and are applied in three places, all server-side: the REST admin endpoint, the WebSocket Yjs write gate (`server/hub.mjs`, `#onBinary`), and run / language messages. The hub re-reads the participant from SQLite on every room change, so a revoke applies before the next incoming message is processed. The editor's read-only state in the UI is only a mirror of this.

Identity: the server signs an HS256 session token when a user creates or joins a room. It is sent as a Bearer header for REST and as a WebSocket subprotocol (`['codesync.v1', token]`), so it never appears in URLs. User ids, names and colours in cursors are always overwritten by the server (`server/sanitize.mjs`), so cursors cannot be spoofed.

Rooms have a join mode: `approval` (new users are `pending` until an admin approves) or `open`. Multiple admins are supported; the last admin cannot be demoted.

## REST API

All bodies are JSON. Errors: `{ "error": { "code", "message" } }`.

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/health` | – | liveness |
| `GET /api/languages` | – | supported languages |
| `POST /api/rooms` `{roomName, displayName, joinMode}` | – (rate limited) | create room; creator becomes admin. Returns `{roomId, token, you}` |
| `GET /api/rooms/:id` | – | public info (name, join mode) |
| `POST /api/rooms/:id/join` `{displayName, rejoin?}` | optional Bearer to resume; with `rejoin: true` a denied/removed person becomes `pending` again | returns `{status: approved\|pending, token, you}` |
| `GET /api/rooms/:id/me` | Bearer | own status; full room state once approved (reconnect / refresh restore) |
| `POST /api/rooms/:id/leave` | Bearer | leave the room. Returns `{kept}`. The last admin can leave only if nobody else is in the room (identity kept so they can return) |
| `POST /api/rooms/:id/admin` `{action, userId?, value?}` | Bearer, admin | admin actions below |

Admin actions: `approve`, `deny`, `remove`, `promote`, `demote`, `grantEdit`, `revokeEdit`, `grantPresenter`, `revokePresenter`, `transferControl` (exactly one non-admin gets control), `setPresentation` (`value` boolean), `setJoinMode` (`value` `open`/`approval`).

## WebSocket protocol

Endpoint `ws(s)://host/ws/:roomId`, subprotocols `codesync.v1` and the session token.

Binary frames use the Yjs protocol; byte 0 is `0` for sync and `1` for awareness (cursors, selections, typing). Text frames are JSON:

| Direction | Message |
| --- | --- |
| client → server | `{type:"language", language}`, `{type:"run", stdin}` |
| server → client | `{type:"state", …room state…}` (sent on every join/leave/permission change) |
| | `{type:"language", language, by}` |
| | `{type:"run:start", by, language}`, `{type:"run:result", by, language, result}`; `{type:"run:last", …}` (same shape as `run:result`) is sent on connect with the room's latest output, which is stored in SQLite (`last_runs`) |
| | `{type:"notice", code:"read_only", message}`, `{type:"error", code, message}` |
| | `{type:"kicked"}` |

Close codes: `4001` unauthorized, `4003` forbidden/removed, `4004` room not found, `4008` rate limited. The client does not retry on these; any other close triggers reconnect with backoff and a fresh Yjs sync, so offline edits merge.

Run result: `{ok, stage: "compile"|"run"|"internal", stdout, stderr, compileOutput?, exitCode, signal, limitExceeded, timeMs, truncated}`.

## Database (SQLite)

`meta(key,value)`; `rooms(id, name, join_mode, presentation, language, creator_id, doc_state BLOB, created_at, updated_at)`; `participants(room_id, user_id, name, color, role, can_edit, is_presenter, status, joined_at, last_seen)`. `doc_state` is the encoded Yjs document, debounced (0.8 s) and flushed when the last user leaves, which is what restores a room after a restart or a late join.

## Layout

```
server.mjs            entry: Next + API + WS on one port
server/               app, api, hub (Yjs/WS), rooms, permissions, store, executor, auth, sanitize
shared/languages.mjs  language table used by client and server
lib/                  Yjs provider, Monaco binding, API client, session storage
components/, app/     UI (room gate, workspace, sidebar, admin panel, editor, console)
tests/unit|integration
```
