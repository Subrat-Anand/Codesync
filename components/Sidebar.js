'use client';

import { useState } from 'react';

function Badge({ kind, children }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

function Person({ person, youId, youAreAdmin, typing, adminCount, onAction }) {
  const [open, setOpen] = useState(false);
  const isYou = person.userId === youId;
  const isAdmin = person.role === 'admin';
  const act = (action, extra) => {
    setOpen(false);
    onAction(action, { userId: person.userId, ...extra });
  };

  return (
    <li className={`person ${person.online ? '' : 'offline'}`}>
      <div className="person-row">
        <span className="dot" style={{ background: person.color }} title={person.online ? 'Online' : 'Offline'} />
        <span className="person-name">
          {person.name}
          {isYou && <em> (you)</em>}
        </span>
        {typing[person.userId] && <span className="typing" aria-label="typing">typing…</span>}
        {isAdmin && <Badge kind="admin">Admin</Badge>}
        {!isAdmin && person.isPresenter && <Badge kind="present">Presenter</Badge>}
        {!isAdmin && person.canEdit && <Badge kind="edit">Can edit</Badge>}
        {youAreAdmin && (
          <button className="icon-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`Actions for ${person.name}`}>
            ⋯
          </button>
        )}
      </div>

      {youAreAdmin && open && (
        <div className="person-actions">
          {!isAdmin && (
            <>
              {person.canEdit
                ? <button onClick={() => act('revokeEdit')} title="Takes away normal editing access. Presenter status is not changed.">Revoke editing</button>
                : <button onClick={() => act('grantEdit')} title="Lets them edit while presentation mode is off.">Allow editing</button>}
              {person.isPresenter
                ? <button onClick={() => act('revokePresenter')} title="Editing access is not changed.">Remove presenter</button>
                : <button onClick={() => act('grantPresenter')} title="Lets them edit while presentation mode is on.">Make presenter</button>}
              <button onClick={() => act('transferControl')}>Give sole control</button>
              <button onClick={() => act('promote')}>Make admin</button>
              <button className="danger" onClick={() => act('remove')}>Remove from room</button>
            </>
          )}
          {isAdmin && adminCount > 1 && <button onClick={() => act('demote')}>Remove admin role</button>}
          {isAdmin && adminCount <= 1 && <span className="hint">Last admin — promote someone else first.</span>}
        </div>
      )}
    </li>
  );
}

export default function Sidebar({ view, typing, onAction }) {
  const approved = view.participants.filter((p) => p.status === 'approved');
  const adminCount = approved.filter((p) => p.role === 'admin').length;
  const online = approved.filter((p) => p.online).length;

  return (
    <section className="panel">
      <h3>
        Participants <span className="count">{online} online · {approved.length} total</span>
      </h3>
      <ul className="people">
        {approved.map((p) => (
          <Person
            key={p.userId}
            person={p}
            youId={view.you.userId}
            youAreAdmin={view.you.isAdmin}
            typing={typing}
            adminCount={adminCount}
            onAction={onAction}
          />
        ))}
      </ul>
    </section>
  );
}
