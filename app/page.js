'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../lib/api';
import { session } from '../lib/session';

const normalizeId = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export default function Home() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [roomName, setRoomName] = useState('');
  const [joinMode, setJoinMode] = useState('approval');
  const [joinId, setJoinId] = useState('');
  const [createError, setCreateError] = useState('');
  const [joinError, setJoinError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setDisplayName(session.getName()), []);

  async function createRoom(e) {
    e.preventDefault();
    setBusy(true);
    setCreateError('');
    try {
      const r = await api('/api/rooms', { method: 'POST', body: { displayName, roomName, joinMode } });
      session.setToken(r.roomId, r.token);
      session.setName(displayName);
      router.push(`/room/${r.roomId}`);
    } catch (err) {
      setCreateError(err.message);
      setBusy(false);
    }
  }

  async function joinRoom(e) {
    e.preventDefault();
    setJoinError('');
    const id = normalizeId(joinId);
    if (id.length !== 8) {
      setJoinError('Room IDs have 8 characters, e.g. K7QM-4XPD');
      return;
    }
    try {
      await api(`/api/rooms/${id}`);
      router.push(`/room/${id}`);
    } catch (err) {
      setJoinError(err.status === 404 ? 'No room with that ID' : err.message);
    }
  }

  return (
    <main className="landing">
      <div className="landing-hero">
        <div className="logo">{'</>'}</div>
        <h1>CodeSync</h1>
        <p>Code together in real time. One shared editor, full control over who can type.</p>
      </div>

      <div className="landing-grid">
        <form className="card" onSubmit={createRoom}>
          <h2>Create a room</h2>
          <label>
            Your name
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} required placeholder="Ada Lovelace" />
          </label>
          <label>
            Room name
            <input value={roomName} onChange={(e) => setRoomName(e.target.value)} maxLength={32} placeholder="Interview prep" />
          </label>
          <fieldset>
            <legend>Who can join?</legend>
            <label className="radio">
              <input type="radio" name="mode" checked={joinMode === 'approval'} onChange={() => setJoinMode('approval')} />
              <span><strong>Approval required</strong> — you accept each person</span>
            </label>
            <label className="radio">
              <input type="radio" name="mode" checked={joinMode === 'open'} onChange={() => setJoinMode('open')} />
              <span><strong>Open</strong> — anyone with the room ID joins instantly</span>
            </label>
          </fieldset>
          <p className="hint">You become the room Admin. Everyone else starts read-only until you grant edit access.</p>
          {createError && <p className="error">{createError}</p>}
          <button className="btn primary wide" disabled={busy}>{busy ? 'Creating…' : 'Create room'}</button>
        </form>

        <form className="card" onSubmit={joinRoom}>
          <h2>Join a room</h2>
          <label>
            Room ID
            <input
              value={joinId}
              onChange={(e) => setJoinId(e.target.value)}
              placeholder="K7QM-4XPD"
              className="mono"
              autoCapitalize="characters"
              spellCheck={false}
              required
            />
          </label>
          <p className="hint">Ask the room Admin for the ID or invite link. You will choose a display name on the next screen.</p>
          {joinError && <p className="error">{joinError}</p>}
          <button className="btn wide">Continue</button>
        </form>
      </div>
    </main>
  );
}
