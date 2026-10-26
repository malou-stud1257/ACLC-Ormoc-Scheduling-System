export const overlaps = (a, b, c, d) => a < d && b > c;
export const validTimeRange = (start, end) => /^([01]\d|2[0-3]):[0-5]\d$/.test(start || '') && /^([01]\d|2[0-3]):[0-5]\d$/.test(end || '') && start < end;
export const dayOf = date => new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
export const validDateOnly = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};
export function weekdayOccursBetween(start, end, weekday) {
  if (!start || !end || start > end) return false;
  const target = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(weekday);
  if (target < 0) return false;
  const date = new Date(`${start}T12:00:00Z`);
  const offset = (target - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10) <= end;
}
