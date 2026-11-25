'use client';

// Admin dashboard: room-wide settings and join requests. Everything here is
// also enforced on the server; non-admins never receive this component or the
// pending-request data.

export default function AdminPanel({ view, onAction }) {
  const { room, participants } = view;
  const pending = participants.filter((p) => p.status === 'pending');

  return (
    <section className="panel admin">
      <h3>Admin dashboard</h3>

      <div className="setting">
        <div>
          <strong>Presentation mode</strong>
          <p className="hint">Everyone sees the same workspace live. While on, only admins and presenters can edit; “Can edit” is paused.</p>
        </div>
        <button
          className={`switch ${room.presentationMode ? 'on' : ''}`}
          role="switch"
          aria-checked={room.presentationMode}
          onClick={() => onAction('setPresentation', { value: !room.presentationMode })}
        >
          <span />
        </button>
      </div>

      <div className="setting">
        <div>
          <strong>Joining</strong>
          <p className="hint">{room.joinMode === 'approval' ? 'New people wait for your approval.' : 'Anyone with the ID joins instantly (read-only).'}</p>
        </div>
        <select value={room.joinMode} onChange={(e) => onAction('setJoinMode', { value: e.target.value })}>
          <option value="approval">Approval</option>
          <option value="open">Open</option>
        </select>
      </div>

      <h4>Join requests {pending.length > 0 && <span className="badge badge-warn">{pending.length}</span>}</h4>
      {pending.length === 0 ? (
        <p className="hint">No one is waiting.</p>
      ) : (
        <ul className="requests">
          {pending.map((p) => (
            <li key={p.userId}>
              <span className="dot" style={{ background: p.color }} />
              <span className="person-name">{p.name}</span>
              <button className="btn small primary" onClick={() => onAction('approve', { userId: p.userId })}>Approve</button>
              <button className="btn small" onClick={() => onAction('deny', { userId: p.userId })}>Deny</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
