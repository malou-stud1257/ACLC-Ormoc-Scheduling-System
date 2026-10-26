import test from 'node:test';
import assert from 'node:assert/strict';
import { overlaps, validTimeRange, dayOf } from '../src/scheduling.js';

test('overlapping ranges conflict but back-to-back classes are allowed', () => {
  assert.equal(overlaps('09:00', '10:00', '09:30', '10:30'), true);
  assert.equal(overlaps('09:00', '10:00', '10:00', '11:00'), false);
});

test('validates 24-hour time ranges and requires a later end', () => {
  assert.equal(validTimeRange('08:00', '09:00'), true);
  assert.equal(validTimeRange('08:00', '08:00'), false);
  assert.equal(validTimeRange('24:00', '25:00'), false);
  assert.equal(validTimeRange('9am', '10am'), false);
});

test('derives the weekday consistently from a one-time reservation date', () => {
  assert.equal(dayOf('2026-10-22'), 'Thursday');
  assert.equal(dayOf('2026-10-21'), 'Wednesday');
});
