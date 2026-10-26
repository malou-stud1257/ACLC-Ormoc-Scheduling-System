export const DEFAULT_TIME_FORMAT = '24h';

export function formatTime(value, format = DEFAULT_TIME_FORMAT) {
  if (typeof value !== 'string') return value ?? '';
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return value;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return value;
  if (format !== '12h') return value;

  const suffix = hours < 12 ? 'AM' : 'PM';
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${match[2]} ${suffix}`;
}

export function timePreferenceKey(identity) {
  const accountId = identity?._id || identity?.email;
  return accountId ? `campusTimeFormat:${String(accountId).toLowerCase()}` : null;
}

export function readTimePreference(identity, storage = globalThis.localStorage) {
  const key = timePreferenceKey(identity);
  if (!key || !storage) return DEFAULT_TIME_FORMAT;
  try {
    return storage.getItem(key) === '12h' ? '12h' : DEFAULT_TIME_FORMAT;
  } catch {
    return DEFAULT_TIME_FORMAT;
  }
}
