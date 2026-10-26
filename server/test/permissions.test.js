import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLE, ROLE_VALUES, canAccessPage, canRead, canWrite, isManager } from '../../shared/permissions.js';

test('shared role policy keeps administrative and scheduling access separate', () => {
  assert.deepEqual(ROLE_VALUES, ['Administrator', 'Scheduler', 'Instructor', 'Student / Schedule Viewer']);
  assert.equal(isManager(ROLE.ADMIN), true);
  assert.equal(isManager(ROLE.SCHEDULER), true);
  assert.equal(canRead(ROLE.SCHEDULER, 'users'), false);
  assert.equal(canWrite(ROLE.SCHEDULER, 'users'), false);
  assert.equal(canWrite(ROLE.ADMIN, 'users'), true);
  assert.equal(canWrite(ROLE.SCHEDULER, 'schedules'), true);
  assert.equal(canWrite(ROLE.INSTRUCTOR, 'schedules'), false);
});

test('instructors and students receive only their intended page and API capabilities', () => {
  assert.equal(canAccessPage(ROLE.INSTRUCTOR, 'requests'), true);
  assert.equal(canRead(ROLE.INSTRUCTOR, 'requests'), true);
  assert.equal(canWrite(ROLE.INSTRUCTOR, 'requests:create'), true);
  assert.equal(canWrite(ROLE.INSTRUCTOR, 'requests:cancel'), true);
  assert.equal(canWrite(ROLE.INSTRUCTOR, 'requests'), false);
  assert.equal(canRead(ROLE.INSTRUCTOR, 'reports'), false);
  assert.equal(canRead(ROLE.STUDENT, 'schedules'), true);
  assert.equal(canRead(ROLE.STUDENT, 'rooms'), true);
  assert.equal(canWrite(ROLE.STUDENT, 'schedules'), false);
  assert.equal(canRead(ROLE.STUDENT, 'requests'), false);
  assert.equal(canAccessPage(ROLE.STUDENT, 'courses'), false);
  assert.equal(canAccessPage('Unrecognized role', 'dashboard'), false);
});
