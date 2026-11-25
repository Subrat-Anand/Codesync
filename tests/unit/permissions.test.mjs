import test from 'node:test';
import assert from 'node:assert/strict';
import { canEdit, isAdmin } from '../../server/permissions.mjs';

const p = (over = {}) => ({ status: 'approved', role: 'participant', canEdit: false, isPresenter: false, ...over });
const normal = { presentation: false };
const presenting = { presentation: true };

test('plain participants are read-only', () => {
  assert.equal(canEdit(normal, p()), false);
  assert.equal(canEdit(presenting, p()), false);
});

test('admins can always edit', () => {
  assert.equal(canEdit(normal, p({ role: 'admin' })), true);
  assert.equal(canEdit(presenting, p({ role: 'admin' })), true);
});

test('granted editors can edit in normal mode but not in presentation mode', () => {
  const granted = p({ canEdit: true });
  assert.equal(canEdit(normal, granted), true);
  assert.equal(canEdit(presenting, granted), false);
});

test('presenter and edit access are independent switches', () => {
  const presenterOnly = p({ isPresenter: true });
  assert.equal(canEdit(normal, presenterOnly), false, 'presenting alone does not allow normal-mode editing');
  assert.equal(canEdit(presenting, presenterOnly), true);
  const editorOnly = p({ canEdit: true });
  assert.equal(canEdit(normal, editorOnly), true);
  assert.equal(canEdit(presenting, editorOnly), false, 'edit access is paused while presenting');
  assert.equal(canEdit(presenting, p({ canEdit: true, isPresenter: true })), true);
});

test('unapproved or removed people never edit, even with flags or admin role', () => {
  for (const status of ['pending', 'denied', 'removed']) {
    assert.equal(canEdit(normal, p({ status, canEdit: true, isPresenter: true, role: 'admin' })), false);
    assert.equal(isAdmin(p({ status, role: 'admin' })), false);
  }
  assert.equal(canEdit(normal, null), false);
});
