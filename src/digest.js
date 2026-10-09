'use strict';
// The morning digest: every call since the last digest, grouped by night (in the
// business's time zone) and by urgency, as one email. Also the small amount of state the
// workflow keeps between runs (n8n workflow static data): calls waiting for the digest,
// call ids already seen (to drop provider retries), and when the last digest went out.

const { nightKey, nightLabel, formatTime, formatDateTime, formatLongDate } = require('./time');
const { escapeHtml, telHref, COLORS, LABELS } = require('./report');

const ORDER = { emergency: 0, urgent: 1, routine: 2 };
const SEEN_DAYS = 7;
const MAX_STORED = 500;

function emptyState() {
  return { calls: [], seen: {}, lastDigestAt: '' };
}

/** Make sure a (possibly empty) static-data object has the expected shape. Mutates and returns it. */
function ensureState(state) {
  if (!Array.isArray(state.calls)) state.calls = [];
  if (!state.seen || typeof state.seen !== 'object') state.seen = {};
  if (typeof state.lastDigestAt !== 'string') state.lastDigestAt = '';
  return state;
}

/** Records the call id; returns true if it was already seen (a webhook retry). */
function checkAndMarkSeen(state, callId, now) {
  ensureState(state);
  if (state.seen[callId]) return true;
  state.seen[callId] = new Date(now).toISOString();
  return false;
}

function rememberCall(state, entry) {
  ensureState(state);
  state.calls = state.calls.filter((c) => c.callId !== entry.callId);
  state.calls.push(entry);
  if (state.calls.length > MAX_STORED) state.calls = state.calls.slice(-MAX_STORED);
}

/** After the digest email went out: drop reported calls, record the time, forget old ids. */
function afterDigestSent(state, now, reportedIds) {
  ensureState(state);
  const ids = new Set(reportedIds);
  state.calls = state.calls.filter((c) => !ids.has(c.callId));
  state.lastDigestAt = new Date(now).toISOString();
  const cutoff = Date.parse(now) - SEEN_DAYS * 86400000;
  for (const [id, at] of Object.entries(state.seen)) if (Date.parse(at) < cutoff) delete state.seen[id];
}

const byLevelThenTime = (a, b) => ORDER[a.level] - ORDER[b.level] || Date.parse(a.endedAt) - Date.parse(b.endedAt);

/** Group entries by night (newest night last), each night's calls emergency-first. */
function groupByNight(entries, tz, cutoverHour = 12) {
  const nights = new Map();
  for (const e of entries) {
    const key = nightKey(e.endedAt || e.startedAt, tz, cutoverHour);
    if (!nights.has(key)) nights.set(key, []);
    nights.get(key).push(e);
  }
  return [...nights.keys()].sort().map((key) => {
    const calls = nights.get(key).sort(byLevelThenTime);
    return { key, label: nightLabel(key), calls, counts: countLevels(calls) };
  });
}

function countLevels(calls) {
  const counts = { emergency: 0, urgent: 0, routine: 0 };
  for (const c of calls) counts[c.level] = (counts[c.level] || 0) + 1;
  return counts;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function digestSubject(counts, total, cfg) {
  if (!total) return `Morning call report: no after-hours calls (${cfg.businessName})`;
  const flags = [counts.emergency && `${counts.emergency} emergency`, counts.urgent && `${counts.urgent} urgent`].filter(Boolean);
  return `Morning call report: ${plural(total, 'after-hours call', 'after-hours calls')}${flags.length ? ` (${flags.join(', ')})` : ''} - ${cfg.businessName}`;
}

function callCardHtml(c, tz) {
  const color = COLORS[c.level];
  const tel = telHref(c.callbackE164);
  const phone = c.callbackNumber || c.callerIdPretty || 'No number';
  return `<tr><td style="padding:0 0 10px 0"><table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #d8dde3;border-left:5px solid ${color}">
<tr><td style="padding:10px 12px">
<div style="font-size:12px;color:#55606c"><b style="color:${color}">${LABELS[c.level]}</b> &middot; ${escapeHtml(formatTime(c.endedAt || c.startedAt, tz))}${c.alertedBySms ? ' &middot; owner was texted' : ''}</div>
<div style="font-size:16px;font-weight:bold;margin:4px 0 2px;color:#17202a">${escapeHtml(c.name || 'Unknown caller')} &middot; ${tel ? `<a href="${escapeHtml(tel)}" style="color:#17202a">${escapeHtml(phone)}</a>` : escapeHtml(phone)}</div>
<div style="font-size:13px;color:#55606c">${escapeHtml(c.address || 'No address given')}</div>
<div style="font-size:14px;margin:8px 0 4px;color:#17202a">${escapeHtml(c.problem || 'Problem not recorded')}</div>
${c.level !== 'routine' ? `<div style="font-size:12px;color:#55606c">Why: ${escapeHtml(c.reasonLine)}</div>` : ''}
<div style="font-size:13px;margin-top:6px;color:#17202a"><b>Next:</b> ${escapeHtml(c.nextStep)}</div>
</td></tr></table></td></tr>`;
}

/**
 * Build the digest email from stored entries.
 * Options: cfg (business config), now (ISO or Date), since (ISO of the last digest, optional).
 */
function buildDigest(entries, { cfg, now, since = '' }) {
  const tz = cfg.timezone;
  const nowIso = new Date(now).toISOString();
  const due = entries.filter((e) => Date.parse(e.endedAt || e.startedAt) <= Date.parse(nowIso));
  const nights = groupByNight(due, tz, cfg.nightCutoverHour);
  const counts = countLevels(due);
  const total = due.length;
  const subject = digestSubject(counts, total, cfg);
  const period = since ? `Calls since ${formatDateTime(since, tz)}` : 'Calls not yet reported';

  const summaryLine = total
    ? `${plural(total, 'call', 'calls')}: ${counts.emergency} emergency, ${counts.urgent} urgent, ${counts.routine} routine.`
    : 'Nobody called the after-hours line.';

  const nightsHtml = nights
    .map(
      (n) => `<h2 style="font-size:16px;margin:20px 0 8px;color:#17202a">${escapeHtml(n.label)} <span style="font-weight:normal;color:#55606c;font-size:13px">(${plural(n.calls.length, 'call', 'calls')})</span></h2>
<table width="100%" cellpadding="0" cellspacing="0">${n.calls.map((c) => callCardHtml(c, tz)).join('')}</table>`
    )
    .join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:16px;background:#ffffff;font-family:Helvetica,Arial,sans-serif;color:#17202a">
<div style="max-width:640px;margin:0 auto">
<table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:2px solid #17202a"><tr>
<td style="font-size:20px;font-weight:bold;padding-bottom:8px">Morning call report</td>
<td style="text-align:right;font-size:13px;color:#55606c;padding-bottom:8px"><b>${escapeHtml(cfg.businessName)}</b><br>${escapeHtml(formatLongDate(nowIso, tz))}</td></tr></table>
<p style="font-size:13px;color:#55606c;margin:8px 0 4px">${escapeHtml(period)}</p>
<p style="font-size:15px;margin:4px 0 8px"><b>${escapeHtml(summaryLine)}</b></p>
${counts.emergency ? `<p style="font-size:13px;margin:0 0 8px;color:${COLORS.emergency}">Emergencies are listed first in each night. The owner was texted at the time if SMS alerts are on.</p>` : ''}
${nightsHtml}
<p style="font-size:11px;color:#55606c;border-top:1px solid #d8dde3;margin-top:18px;padding-top:8px">Each call also has its own record in the CRM with the full transcript.${cfg.reportFootnote ? `<br>${escapeHtml(cfg.reportFootnote)}` : ''}</p>
</div></body></html>`;

  const text = [
    `Morning call report - ${cfg.businessName}`,
    formatLongDate(nowIso, tz),
    period,
    '',
    summaryLine,
    ...nights.flatMap((n) => [
      '',
      `== ${n.label} (${plural(n.calls.length, 'call', 'calls')})`,
      ...n.calls.flatMap((c) => [
        '',
        `[${LABELS[c.level]}] ${formatTime(c.endedAt || c.startedAt, tz)}  ${c.name || 'Unknown caller'}  ${c.callbackNumber || c.callerIdPretty || 'No number'}`,
        `  ${c.address || 'No address given'}`,
        `  ${c.problem || 'Problem not recorded'}`,
        ...(c.level !== 'routine' ? [`  Why: ${c.reasonLine}`] : []),
        `  Next: ${c.nextStep}`,
      ]),
    ]),
  ].join('\n');

  return { subject, html, text, total, counts, nights, reportedIds: due.map((e) => e.callId) };
}

module.exports = { emptyState, ensureState, checkAndMarkSeen, rememberCall, afterDigestSent, groupByNight, buildDigest, digestSubject };
