'use client';

// The live IDE: owns the Yjs document + provider for one room and wires
// server-pushed state (roles, permissions, language, run output) into the UI.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness.js';
import { CollabProvider } from '../lib/provider';
import { api } from '../lib/api';
import { LANGUAGES, getLanguage } from '../shared/languages.mjs';
import Sidebar from './Sidebar';
import AdminPanel from './AdminPanel';
import OutputConsole from './OutputConsole';

const EditorPane = dynamic(() => import('./EditorPane'), {
  ssr: false,
  loading: () => <div className="editor-loading">Loading editor…</div>,
});

const STATUS_LABEL = { connecting: 'Connecting…', connected: 'Live', disconnected: 'Reconnecting…' };
const formatId = (id) => `${id.slice(0, 4)}-${id.slice(4)}`;
const sameKeys = (a, b) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k]);
};

export default function Workspace({ roomId, token, onFatal, onLeave }) {
  const [epoch, setEpoch] = useState(0);
  const [collab, setCollab] = useState(null);
  const [view, setView] = useState(null);
  const [status, setStatus] = useState('connecting');
  const [typing, setTyping] = useState({});
  const [run, setRun] = useState({ running: false, result: null, by: null, language: null });
  const [stdin, setStdin] = useState('');
  const [toasts, setToasts] = useState([]);
  const prevCanEdit = useRef(false);
  const onFatalRef = useRef(onFatal);
  onFatalRef.current = onFatal;

  const toast = useCallback((text, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  useEffect(() => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalState({}); // identity is attached by the server
    const provider = new CollabProvider({ roomId, token, doc, awareness });

    const offs = [
      provider.on('status', setStatus),
      provider.on('fatal', (code) => onFatalRef.current?.(code)),
      provider.on('message', (msg) => {
        switch (msg.type) {
          case 'state':
            setView(msg);
            if (prevCanEdit.current && !msg.you.canEdit) {
              // Drop any local, unsynced edits by rebuilding the doc from the server copy.
              toast('Your editing access was removed. The editor is now read-only.', 'warn');
              setEpoch((e) => e + 1);
            } else if (!prevCanEdit.current && msg.you.canEdit && prevCanEdit.seen) {
              toast('You can now edit this room.', 'success');
            }
            prevCanEdit.current = msg.you.canEdit;
            prevCanEdit.seen = true;
            break;
          case 'run:start':
            setRun((r) => ({ ...r, running: true, by: msg.by, language: msg.language }));
            break;
          case 'run:last': // latest room output, sent when joining / returning
          case 'run:result':
            setRun({ running: false, result: msg.result, by: msg.by, language: msg.language });
            break;
          case 'notice':
            toast(msg.message, 'warn');
            break;
          case 'error':
            toast(msg.message, 'error');
            break;
          default:
        }
      }),
    ];

    // Typing indicators: a remote "typing" value changing means they just typed.
    const seen = new Map();
    const onAwareness = () => {
      const now = Date.now();
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === doc.clientID || !state?.user || typeof state.typing !== 'number') return;
        const prev = seen.get(state.user.id);
        if (!prev) seen.set(state.user.id, { value: state.typing, at: 0 });
        else if (prev.value !== state.typing) seen.set(state.user.id, { value: state.typing, at: now });
      });
    };
    awareness.on('change', onAwareness);
    const ticker = setInterval(() => {
      const now = Date.now();
      const active = {};
      seen.forEach((v, userId) => {
        if (now - v.at < 1800) active[userId] = true;
      });
      setTyping((prev) => (sameKeys(prev, active) ? prev : active));
    }, 400);

    setCollab({ doc, awareness, provider });
    return () => {
      clearInterval(ticker);
      awareness.off('change', onAwareness);
      offs.forEach((off) => off());
      provider.destroy();
      doc.destroy();
      setCollab(null);
    };
  }, [roomId, token, epoch, toast]);

  const you = view?.you;
  const room = view?.room;
  const languageSpec = getLanguage(room?.language) || LANGUAGES[0];

  const adminAction = useCallback(
    async (action, extra = {}) => {
      try {
        await api(`/api/rooms/${roomId}/admin`, { method: 'POST', token, body: { action, ...extra } });
      } catch (err) {
        toast(err.message, 'error');
      }
    },
    [roomId, token, toast],
  );

  const changeLanguage = (language) => collab?.provider.send({ type: 'language', language });
  const runCode = () => {
    if (!collab?.provider.send({ type: 'run', stdin })) toast('Not connected', 'error');
  };
  const leave = async () => {
    const alone = (view?.participants ?? []).filter((p) => p.status === 'approved').length <= 1;
    const warning = you?.isAdmin && alone
      ? 'Leave the room? The room is saved and you can come back to it later.'
      : you?.isAdmin
        ? 'Leave this room? You can only leave if another admin exists.'
        : 'Leave this room? You will need to request to join again.';
    if (!window.confirm(warning)) return;
    try {
      await onLeave();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied`, 'success');
    } catch {
      toast('Copy failed — select and copy manually', 'warn');
    }
  };

  const presenters = useMemo(
    () => (view?.participants ?? []).filter((p) => p.editing && p.role !== 'admin').map((p) => p.name),
    [view],
  );

  if (!view || !collab) {
    return (
      <main className="gate">
        <div className="card gate-card">
          <h2>Connecting to room…</h2>
          <p className="hint"><span className="spinner" /> {STATUS_LABEL[status]}</p>
        </div>
      </main>
    );
  }

  let banner = null;
  if (room.presentationMode) {
    banner = you.canEdit
      ? { kind: 'present', text: 'Presentation mode is on — only admins and selected presenters can edit.' }
      : { kind: 'present', text: `Presentation mode — you are viewing live, read-only${presenters.length ? ` (presenting: ${presenters.join(', ')})` : ''}.` };
  } else if (!you.canEdit) {
    banner = { kind: 'readonly', text: 'Read-only — ask a room Admin for edit access.' };
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="logo-sm">{'</>'}</span> CodeSync</div>
        <div className="room-meta">
          <span className="room-name" title={room.name}>{room.name}</span>
          <button className="chip mono" onClick={() => copy(formatId(room.id), 'Room ID')} title="Copy room ID">
            {formatId(room.id)}
          </button>
          <button className="chip" onClick={() => copy(`${window.location.origin}/room/${room.id}`, 'Invite link')}>
            Copy invite link
          </button>
        </div>
        <div className="spacer" />
        <label className="lang">
          <span className="sr-only">Language</span>
          <select
            value={room.language}
            disabled={!you.canEdit}
            onChange={(e) => changeLanguage(e.target.value)}
            title={you.canEdit ? 'Language is shared with everyone in the room' : 'Only people who can edit can change the language'}
          >
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>
        </label>
        <button className="btn run" disabled={!you.canRun || run.running || status !== 'connected'} onClick={runCode}>
          {run.running ? 'Running…' : '▶ Run'}
        </button>
        <span className={`conn conn-${status}`}><i />{STATUS_LABEL[status]}</span>
        <button className="btn leave" onClick={leave}>Leave room</button>
      </header>

      <div className="body">
        <aside className="sidebar">
          <Sidebar view={view} typing={typing} onAction={adminAction} />
          {you.isAdmin && <AdminPanel view={view} onAction={adminAction} />}
        </aside>

        <main className="main">
          {banner && <div className={`banner banner-${banner.kind}`}>{banner.text}</div>}
          <div className="editor-wrap">
            <EditorPane key={collab.doc.guid} collab={collab} canEdit={you.canEdit} language={languageSpec.monaco} />
          </div>
          <OutputConsole run={run} stdin={stdin} setStdin={setStdin} canRun={you.canRun} />
        </main>
      </div>

      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}
