// Pure permission rules. Every enforcement point on the server goes through
// these functions; the frontend only mirrors them for display.
//
//   Admin                      -> can always edit and manage the room
//   Participant, normal mode   -> can edit only if explicitly granted (canEdit)
//   Participant, presentation  -> can edit only if selected as presenter
//
// canEdit and isPresenter are independent switches: presenting never grants
// normal-mode editing and revoking one never touches the other.
//   everyone else              -> read-only

export function isApproved(p) {
  return !!p && p.status === 'approved';
}

export function isAdmin(p) {
  return isApproved(p) && p.role === 'admin';
}

export function canEdit(room, p) {
  if (!isApproved(p)) return false;
  if (p.role === 'admin') return true;
  return room.presentation ? !!p.isPresenter : !!p.canEdit;
}

export const canRun = canEdit;
export const canChangeLanguage = canEdit;
export const canManageRoom = isAdmin;

export function describe(room, p) {
  return {
    isAdmin: isAdmin(p),
    canEdit: canEdit(room, p),
    canRun: canRun(room, p),
    canManage: canManageRoom(p),
  };
}
