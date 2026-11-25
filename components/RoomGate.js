'use client';

// Decides what the visitor sees before the workspace: join form, waiting for
// approval, denied/removed screens, or the live workspace itself.
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '../lib/api';
import { session } from '../lib/session';
import Workspace from './Workspace';

const normalizeId = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function Screen({ title, children }) {
  return (
    <main className="gate">
      <div className="card gate-card">
        <h2>{title}</h2>
        {children}
      </div>
    </main>
  );
}

export default function RoomGate({ rawRoomId }) {
  const roomId = normalizeId(rawRoomId);
  const router = useRouter();
  const leaving = useRef(false);
  const [phase, setPhase] = useState('loading');
  const [info, setInfo] = useState(null);
  const [token, setToken] = useState(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const resolve = useCallback(
    async (tok) => {
      try {
        const me = await api(`/api/rooms/${roomId}/me`, { token: tok });
        setToken(tok);
        setPhase(me.status === 'approved' ? 'ready' : me.status);
      } catch (err) {
        if (err.status === 401) {
          session.clearToken(roomId);
          setToken(null);
          setPhase('needName');
        } else if (err.status === 404) {
          setPhase('notfound');
        } else {
          setError(err.message);
          setPhase('error');
        }
      }
    },
    [roomId],
  );

  useEffect(() => {
    let cancelled = false;
    setName(session.getName());
    (async () => {
      if (roomId.length !== 8) {
        setPhase('notfound');
        return;
      }
      try {
        const room = await api(`/api/rooms/${roomId}`);
        if (cancelled) return;
        setInfo(room);
      } catch (err) {
        if (cancelled) return;
        if (err.status === 404) setPhase('notfound');
        else {
          setError(err.message);
          setPhase('error');
        }
        return;
      }
      const saved = session.getToken(roomId);
      if (saved) await resolve(saved);
      else if (!cancelled) setPhase('needName');
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, resolve]);

  // While waiting for approval, poll until the admin decides.
  useEffect(() => {
    if (phase !== 'pending' || !token) return undefined;
    const timer = setInterval(() => resolve(token), 2000);
    return () => clearInterval(timer);
  }, [phase, token, resolve]);

  async function submitJoin(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api(`/api/rooms/${roomId}/join`, { method: 'POST', body: { displayName: name } });
      session.setToken(roomId, r.token);
      session.setName(name);
      setToken(r.token);
      setPhase(r.status === 'approved' ? 'ready' : r.status);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Leaving tells the server (so the admin's lists update), forgets this
  // browser's identity for the room and returns to the start page.
  const leaveRoom = useCallback(async () => {
    leaving.current = true;
    let kept = false;
    try {
      ({ kept } = await api(`/api/rooms/${roomId}/leave`, { method: 'POST', token }));
    } catch (err) {
      // Already gone / token no longer valid: nothing left to leave.
      if (err.status !== 401 && err.status !== 404) {
        leaving.current = false;
        throw err;
      }
    }
    // kept: a lone admin keeps their identity so they can return to the room.
    if (!kept) session.clearToken(roomId);
    router.push('/');
  }, [roomId, token, router]);

  async function requestAgain() {
    setBusy(true);
    setError('');
    try {
      const r = await api(`/api/rooms/${roomId}/join`, { method: 'POST', token, body: { rejoin: true } });
      setPhase(r.status === 'approved' ? 'ready' : r.status);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function leaveFromGate() {
    try {
      await leaveRoom();
    } catch (err) {
      setError(err.message);
    }
  }

  const onFatal = useCallback(
    (code) => {
      if (leaving.current) return;
      if (code === 4001) {
        session.clearToken(roomId);
        setToken(null);
        setPhase('needName');
      } else if (code === 4004) setPhase('notfound');
      else resolve(session.getToken(roomId)); // 4003: re-check why (removed / denied)
    },
    [roomId, resolve],
  );

  if (phase === 'loading') return <Screen title="Loading room…"><p className="hint">One moment.</p></Screen>;

  if (phase === 'notfound') {
    return (
      <Screen title="Room not found">
        <p className="hint">Check the room ID and try again.</p>
        <Link className="btn" href="/">Back to start</Link>
      </Screen>
    );
  }

  if (phase === 'error') {
    return (
      <Screen title="Something went wrong">
        <p className="error">{error}</p>
        <button className="btn" onClick={() => window.location.reload()}>Retry</button>
      </Screen>
    );
  }

  if (phase === 'needName') {
    return (
      <Screen title={`Join “${info?.name ?? 'room'}”`}>
        <form onSubmit={submitJoin}>
          <label>
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required autoFocus placeholder="Ada Lovelace" />
          </label>
          <p className="hint">
            {info?.joinMode === 'approval'
              ? 'This room requires the Admin to approve you. You will join as read-only.'
              : 'You will join as read-only until the Admin gives you edit access.'}
          </p>
          {error && <p className="error">{error}</p>}
          <button className="btn primary wide" disabled={busy}>{busy ? 'Joining…' : info?.joinMode === 'approval' ? 'Request to join' : 'Join room'}</button>
        </form>
      </Screen>
    );
  }

  if (phase === 'pending') {
    return (
      <Screen title="Waiting for approval">
        <p className="hint"><span className="spinner" /> The room Admin has been notified. This page continues automatically once you are approved.</p>
        {error && <p className="error">{error}</p>}
        <button className="btn" onClick={leaveFromGate}>Cancel request</button>
      </Screen>
    );
  }

  if (phase === 'denied' || phase === 'removed') {
    return (
      <Screen title={phase === 'denied' ? 'Request declined' : 'You were removed from this room'}>
        <p className="hint">You can ask the room Admin to let you in again.</p>
        {error && <p className="error">{error}</p>}
        <button className="btn primary wide" disabled={busy} onClick={requestAgain}>
          {busy ? 'Sending…' : 'Request to join again'}
        </button>
        <button className="btn wide" onClick={leaveFromGate}>Leave</button>
      </Screen>
    );
  }

  return <Workspace roomId={roomId} token={token} onFatal={onFatal} onLeave={leaveRoom} />;
}
