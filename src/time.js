'use strict';
// Time helpers in the business's time zone. Uses Intl only (no libraries), so they
// behave the same in Node and inside an n8n Code node, and they are DST-safe because
// every conversion goes through the IANA zone rather than a fixed offset.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  const d = new Date(String(value || ''));
  return d;
}

function isValidDate(value) {
  return value !== undefined && value !== null && value !== '' && !Number.isNaN(toDate(value).getTime());
}

/** Wall-clock parts of an instant in `tz`. */
function localParts(value, tz) {
  const d = toDate(value);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
}

const pad = (n) => String(n).padStart(2, '0');
// ICU versions differ on the space before AM/PM (U+202F vs a plain space); normalize it
// so output is identical on every Node version.
const spaces = (s) => s.replace(/[\u202f\u00a0]/g, ' ');

/** "2026-01-16" for a calendar date (UTC-based arithmetic, no time zone involved). */
function ymd(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Which night a call belongs to, as the date the evening started ("2026-01-16" for a
 * call at 11 pm Friday or 3 am Saturday). Calls before `cutoverHour` local time count
 * toward the previous evening.
 */
function nightKey(value, tz, cutoverHour = 12) {
  const p = localParts(value, tz);
  return p.hour < cutoverHour ? ymd(p.year, p.month, p.day - 1) : ymd(p.year, p.month, p.day);
}

/** "Friday night, January 16" for a nightKey. */
function nightLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[date.getUTCDay()]} night, ${MONTHS[m - 1]} ${d}`;
}

/** "11:42 PM" in the business zone. */
function formatTime(value, tz) {
  return spaces(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(toDate(value)));
}

/** "Sat, Jan 17, 11:42 PM CST" in the business zone. */
function formatDateTime(value, tz) {
  return spaces(new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(toDate(value)));
}

/** "Saturday, January 17" in the business zone. */
function formatLongDate(value, tz) {
  return spaces(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(toDate(value)));
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

module.exports = { isValidDate, localParts, nightKey, nightLabel, formatTime, formatDateTime, formatLongDate, formatDuration };
