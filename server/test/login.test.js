import test from 'node:test';
import assert from 'node:assert/strict';
import { loginIdentifierQuery, normalizeLoginIdentifier, resolveActiveLoginMatch, validLoginInput } from '../src/login.js';

test('trims login identifiers and normalizes email lookup case', () => {
  const identifier = normalizeLoginIdentifier('  Admin@School.EDU  ');
  assert.equal(identifier, 'Admin@School.EDU');
  assert.deepEqual(loginIdentifierQuery(identifier), { $or: [{ username: 'Admin@School.EDU' }, { email: 'admin@school.edu' }] });
});

test('username lookup remains case-sensitive', () => {
  assert.deepEqual(loginIdentifierQuery('Teacher01'), { $or: [{ username: 'Teacher01' }, { email: 'teacher01' }] });
});

test('only one active matching account can resolve', () => {
  const active = { username: 'admin', status: 'Active' };
  assert.equal(resolveActiveLoginMatch([active]), active);
  assert.equal(resolveActiveLoginMatch([]), null);
  assert.equal(resolveActiveLoginMatch([active, { username: 'other', status: 'Active' }]), null);
  assert.equal(resolveActiveLoginMatch([{ username: 'old', status: 'Inactive' }]), null);
});

test('rejects missing, non-string, and oversized credentials', () => {
  assert.equal(validLoginInput('', 'secret'), false);
  assert.equal(validLoginInput('name', ''), false);
  assert.equal(validLoginInput(null, 'secret'), false);
  assert.equal(validLoginInput('x'.repeat(321), 'secret'), false);
  assert.equal(validLoginInput('name', 'secret'), true);
});
