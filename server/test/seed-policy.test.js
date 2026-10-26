import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSeedAllowed } from '../src/seed-policy.js';

test('demo credentials are refused in production regardless of database location', () => {
  assert.equal(demoSeedAllowed('production', 'mongodb://127.0.0.1:27017/campus_scheduler'), false);
  assert.equal(demoSeedAllowed('Production', 'mongodb://localhost/campus_scheduler'), false);
});

test('development and test environments can seed only loopback databases', () => {
  assert.equal(demoSeedAllowed('development', 'mongodb://127.0.0.1:27017/campus_scheduler'), true);
  assert.equal(demoSeedAllowed('development', 'mongodb+srv://example.invalid/campus'), false);
  assert.equal(demoSeedAllowed('test', 'mongodb://127.0.0.1:27017/campus_scheduler_test'), true);
});

test('an unset environment is accepted only for a loopback MongoDB URI', () => {
  assert.equal(demoSeedAllowed(undefined, 'mongodb://127.0.0.1:27017/campus_scheduler'), true);
  assert.equal(demoSeedAllowed('', 'mongodb://localhost:27017/campus_scheduler'), true);
  assert.equal(demoSeedAllowed(undefined, 'mongodb+srv://cluster.example.invalid/campus'), false);
});
