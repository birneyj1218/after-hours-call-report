'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDigest, groupByNight, emptyState, ensureState, checkAndMarkSeen, rememberCall, afterDigestSent } = require('../src/digest');
const { nightKey, nightLabel, formatTime } = require('../src/time');
const { cfg } = require('./helpers');

const entry = (callId, endedAt, level = 'routine', extra = {}) => ({
  callId, startedAt: endedAt, endedAt, level, name: `Caller ${callId}`, callbackNumber: '(612) 555-0110', callbackE164: '+16125550110',
  callerIdPretty: '', address: '1 Test Street', problem: `Problem ${callId}`, preferredCallback: '', reasonLine: 'reason', nextStep: 'Call back.', summary: '', alertedBySms: false, ...extra,
});

test('calls after midnight belong to the previous evening (business time zone)', () => {
  const tz = 'America/Chicago';
  assert.equal(nightKey('2026-01-17T04:14:00Z', tz), '2026-01-16'); // Fri 10:14 PM
  assert.equal(nightKey('2026-01-17T11:48:00Z', tz), '2026-01-16'); // Sat 5:48 AM
  assert.equal(nightKey('2026-01-17T23:30:00Z', tz), '2026-01-17'); // Sat 5:30 PM
  assert.equal(nightLabel('2026-01-16'), 'Friday night, January 16');
  assert.equal(nightKey('2026-03-01T06:00:00Z', tz), '2026-02-28'); // month boundary
  assert.equal(nightKey('2026-01-01T07:00:00Z', tz), '2025-12-31'); // year boundary
});

test('the time zone changes which night a call lands in', () => {
  const at = '2026-01-17T17:30:00Z'; // 11:30 AM Chicago, 12:30 PM New York
  assert.equal(nightKey(at, 'America/Chicago'), '2026-01-16');
  assert.equal(nightKey(at, 'America/New_York'), '2026-01-17');
});

test('DST changes are handled by the zone, not a fixed offset', () => {
  const tz = 'America/Chicago'; // DST starts 2026-03-08 02:00 local
  assert.equal(formatTime('2026-03-08T07:30:00Z', tz), '1:30 AM'); // CST, UTC-6
  assert.equal(formatTime('2026-03-08T08:30:00Z', tz), '3:30 AM'); // CDT, UTC-5
  assert.equal(nightKey('2026-03-08T08:30:00Z', tz), '2026-03-07');
  assert.equal(formatTime('2026-11-01T06:30:00Z', tz), '1:30 AM'); // first 1:30 (CDT)
  assert.equal(formatTime('2026-11-01T07:30:00Z', tz), '1:30 AM'); // second 1:30 (CST)
});

test('grouping: nights in order, emergencies first, then by time', () => {
  const groups = groupByNight([
    entry('b', '2026-01-18T05:00:00Z', 'routine'), // Sat night
    entry('c', '2026-01-17T05:00:00Z', 'routine'), // Fri night 11 PM
    entry('d', '2026-01-17T09:00:00Z', 'emergency'), // Fri night 3 AM
    entry('e', '2026-01-17T04:00:00Z', 'urgent'), // Fri night 10 PM
    entry('f', '2026-01-17T03:00:00Z', 'emergency'), // Fri night 9 PM
  ], 'America/Chicago');
  assert.deepEqual(groups.map((g) => g.label), ['Friday night, January 16', 'Saturday night, January 17']);
  assert.deepEqual(groups[0].calls.map((c) => c.callId), ['f', 'd', 'e', 'c']);
  assert.deepEqual(groups[0].counts, { emergency: 2, urgent: 1, routine: 1 });
});

test('digest email: subject counts, sections, escaping, text version', () => {
  const d = buildDigest([
    entry('1', '2026-01-17T04:00:00Z', 'emergency', { alertedBySms: true }),
    entry('2', '2026-01-17T06:00:00Z', 'routine', { name: '<b>Bold</b>' }),
    entry('3', '2026-01-17T07:00:00Z', 'urgent'),
  ], { cfg: cfg(), now: '2026-01-17T13:00:00Z', since: '2026-01-16T23:00:00Z' });
  assert.equal(d.subject, 'Morning call report: 3 after-hours calls (1 emergency, 1 urgent) - Cavern Electrical');
  assert.equal(d.total, 3);
  assert.deepEqual(d.reportedIds, ['1', '2', '3']);
  assert.match(d.html, /Friday night, January 16/);
  assert.match(d.html, /Calls since Fri, Jan 16, 5:00 PM CST/);
  assert.match(d.html, /owner was texted/);
  assert.match(d.html, /&lt;b&gt;Bold&lt;\/b&gt;/);
  assert.ok(d.html.indexOf('EMERGENCY') < d.html.indexOf('URGENT') && d.html.indexOf('URGENT') < d.html.indexOf('ROUTINE'));
  assert.match(d.text, /== Friday night, January 16 \(3 calls\)/);
  assert.match(d.text, /\[EMERGENCY\] 10:00 PM  Caller 1/);
});

test('calls that end after the digest time wait for the next one', () => {
  const d = buildDigest([entry('1', '2026-01-17T12:00:00Z'), entry('2', '2026-01-17T13:05:00Z')], { cfg: cfg(), now: '2026-01-17T13:00:00Z' });
  assert.deepEqual(d.reportedIds, ['1']);
  assert.equal(d.subject, 'Morning call report: 1 after-hours call - Cavern Electrical');
});

test('empty night still produces a clear email', () => {
  const d = buildDigest([], { cfg: cfg(), now: '2026-01-17T13:00:00Z' });
  assert.equal(d.subject, 'Morning call report: no after-hours calls (Cavern Electrical)');
  assert.match(d.text, /Nobody called the after-hours line/);
});

test('state: dedup, remember, clear after the digest', () => {
  const s = emptyState();
  assert.equal(checkAndMarkSeen(s, 'a', '2026-01-10T00:00:00Z'), false);
  assert.equal(checkAndMarkSeen(s, 'a', '2026-01-10T00:01:00Z'), true);
  checkAndMarkSeen(s, 'b', '2026-01-17T04:00:00Z');
  rememberCall(s, entry('a', '2026-01-17T04:00:00Z'));
  rememberCall(s, entry('a', '2026-01-17T04:00:00Z', 'urgent')); // replaced, not duplicated
  rememberCall(s, entry('late', '2026-01-17T13:30:00Z'));
  assert.equal(s.calls.length, 2);
  afterDigestSent(s, '2026-01-17T13:00:00Z', ['a']);
  assert.deepEqual(s.calls.map((c) => c.callId), ['late']);
  assert.equal(s.lastDigestAt, '2026-01-17T13:00:00.000Z');
  assert.deepEqual(Object.keys(s.seen), ['b'], 'ids older than 7 days are forgotten');
});

test('ensureState repairs an empty or broken static-data object', () => {
  const s = ensureState({ calls: 'x', seen: null });
  assert.deepEqual(s, { calls: [], seen: {}, lastDigestAt: '' });
});
