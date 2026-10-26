import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, readTimePreference, timePreferenceKey } from './time-format.js';

test('formats canonical times as 24-hour or 12-hour without changing stored values', () => {
  const examples = [
    ['07:00', '7:00 AM'], ['08:30', '8:30 AM'], ['12:00', '12:00 PM'],
    ['13:15', '1:15 PM'], ['17:45', '5:45 PM'], ['00:00', '12:00 AM'],
    ['23:30', '11:30 PM'],
  ];
  for (const [stored, display] of examples) {
    assert.equal(formatTime(stored), stored);
    assert.equal(formatTime(stored, '12h'), display);
  }
});

test('leaves malformed or out-of-range time strings unchanged', () => {
  for (const value of ['8:00', '24:00', '12:60', '', null]) {
    assert.equal(formatTime(value, '12h'), value ?? '');
  }
});

test('stores format preference per account and defaults to 24-hour', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const first = { _id: 'user-one', email: 'one@example.test' };
  const second = { _id: 'user-two', email: 'two@example.test' };
  assert.equal(readTimePreference(first, storage), '24h');
  storage.setItem(timePreferenceKey(first), '12h');
  assert.equal(readTimePreference(first, storage), '12h');
  assert.equal(readTimePreference(second, storage), '24h');
});
