'use strict';
// Renders one call for the owner: HTML email, plain-text email and an SMS alert.
// Email HTML uses inline styles and tables only, because many mail clients strip <style>.
// Every value from the call is escaped; transcripts are untrusted input.

const { formatDateTime, formatDuration } = require('./time');

const COLORS = { emergency: '#b3261e', urgent: '#a85400', routine: '#2e6b4f' };
const LABELS = { emergency: 'EMERGENCY', urgent: 'URGENT', routine: 'ROUTINE' };

function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) links are rendered as links; anything else is shown as text. */
function safeUrl(url) {
  return /^https?:\/\/[^\s"'<>]+$/i.test(String(url || '')) ? String(url) : '';
}

function telHref(e164) {
  return /^\+\d{8,15}$/.test(e164 || '') ? `tel:${e164}` : '';
}

const notGiven = (v) => (v ? v : 'Not given');

/** Rows shown in both the per-call email and the text version. A trailing * marks AI-extracted values. */
function detailRows(call) {
  const ai = new Set(call.aiFields || []);
  const mark = (key, v) => (v && ai.has(key) ? `${v} *` : notGiven(v));
  return [
    ['Caller', mark('name', call.name)],
    ['Callback number', mark('callbackNumber', call.callbackNumber)],
    ['Caller ID', call.callerIdPretty || 'Withheld'],
    ['Address', mark('address', call.address)],
    ['Problem', mark('problem', call.problem)],
    ['Best time to call back', call.preferredCallback || 'Not said'],
    ['Why this urgency', call.reasonLine],
  ];
}

function subjectFor(call, cfg) {
  const who = call.name || call.callbackNumber || 'unknown caller';
  const what = call.problem ? `: ${call.problem.slice(0, 60)}${call.problem.length > 60 ? '...' : ''}` : '';
  return `[${LABELS[call.level]}] After-hours call from ${who}${what} (${cfg.businessName})`;
}

function renderCallReport(call, cfg) {
  const tz = cfg.timezone;
  const color = COLORS[call.level];
  const when = `${formatDateTime(call.startedAt || call.endedAt, tz)} · ${formatDuration(call.durationSeconds)} on the line`;
  const rows = detailRows(call);
  const tel = telHref(call.callbackE164);
  const rec = safeUrl(call.recordingUrl);

  const rowHtml = rows
    .map(
      ([k, v], i) =>
        `<tr style="background:${i % 2 ? '#ffffff' : '#f4f6f8'}"><td style="padding:8px 10px;color:#55606c;font-size:13px;width:34%;vertical-align:top">${escapeHtml(k)}</td>` +
        `<td style="padding:8px 10px;color:#17202a;font-size:14px;vertical-align:top">${k === 'Callback number' && tel ? `<a href="${escapeHtml(tel)}" style="color:#17202a">${escapeHtml(v)}</a>` : escapeHtml(v)}</td></tr>`
    )
    .join('');
  const transcriptHtml = (call.turns || [])
    .map(
      (t) =>
        `<tr><td style="padding:3px 10px 3px 0;vertical-align:top;font-size:12px;font-weight:bold;white-space:nowrap;color:${t.speaker === 'caller' ? '#6b3a1f' : '#17202a'}">${t.speaker === 'caller' ? 'Caller' : t.speaker === 'assistant' ? 'Assistant' : 'Unknown'}</td>` +
        `<td style="padding:3px 0;font-size:13px;color:#2b3640">${escapeHtml(t.text)}</td></tr>`
    )
    .join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subjectFor(call, cfg))}</title></head>
<body style="margin:0;padding:16px;background:#ffffff;font-family:Helvetica,Arial,sans-serif;color:#17202a">
<div style="max-width:640px;margin:0 auto">
<table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:2px solid #17202a"><tr>
<td style="font-size:20px;font-weight:bold;padding-bottom:8px">After-hours call</td>
<td style="text-align:right;font-size:13px;color:#55606c;padding-bottom:8px"><b>${escapeHtml(cfg.businessName)}</b><br>answered by the automated assistant</td></tr></table>
<p style="font-size:13px;color:#55606c;margin:8px 0 12px">${escapeHtml(when)}</p>
<div style="background:${color};color:#ffffff;padding:12px 14px;font-size:15px;margin-bottom:14px"><b>${LABELS[call.level]}</b> &nbsp; ${escapeHtml(call.nextStep)}</div>
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rowHtml}</table>
<h3 style="font-size:15px;margin:18px 0 6px">Summary</h3>
<p style="font-size:14px;line-height:1.5;margin:0">${escapeHtml(call.summary)}</p>
${rec ? `<p style="font-size:14px;margin:12px 0 0"><a href="${escapeHtml(rec)}" style="color:#2e6b4f;font-weight:bold">Listen to the recording</a> <span style="font-size:12px;color:#55606c">(provider links can expire; copy the file if you need to keep it)</span></p>` : ''}
${transcriptHtml ? `<h3 style="font-size:15px;margin:18px 0 6px">Transcript</h3><table cellpadding="0" cellspacing="0">${transcriptHtml}</table>` : ''}
<p style="font-size:11px;color:#55606c;border-top:1px solid #d8dde3;margin-top:18px;padding-top:8px">${(call.aiFields || []).length ? '* Taken from the transcript by the AI summary. Check it on the callback.<br>' : ''}Summary: ${escapeHtml(call.summarySource)}. Urgency checked by: ${escapeHtml((call.classificationSources || ['rules']).join(', '))}. Call ${escapeHtml(call.callId)}.${cfg.reportFootnote ? `<br>${escapeHtml(cfg.reportFootnote)}` : ''}</p>
</div></body></html>`;

  const text = [
    `After-hours call - ${cfg.businessName}`,
    when,
    '',
    `${LABELS[call.level]}: ${call.nextStep}`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    `Summary: ${call.summary}`,
    rec ? `Recording: ${rec}` : '',
    '',
    (call.turns || []).length ? 'Transcript:' : '',
    ...(call.turns || []).map((t) => `${t.speaker === 'caller' ? 'Caller' : t.speaker === 'assistant' ? 'Assistant' : 'Unknown'}: ${t.text}`),
    '',
    (call.aiFields || []).length ? '* Taken from the transcript by the AI summary. Check it on the callback.' : '',
    `Call ${call.callId}`,
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n')
    .trim();

  return { subject: subjectFor(call, cfg), html, text };
}

/** Plain ASCII, so the text stays in the cheaper GSM-7 encoding. */
function toAscii(s) {
  return String(s || '')
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E\n]/g, '');
}

/** SMS alert to the owner, at most `max` characters (default 320, about two segments). */
function renderSms(call, cfg, max = 320) {
  const tz = cfg.timezone;
  const head = `${LABELS[call.level]} after-hours call, ${cfg.businessName}`;
  const who = `${call.name || 'Unknown caller'} ${call.callbackNumber || call.callerIdPretty || ''}`.trim();
  const lines = [head, `${formatDateTime(call.endedAt || call.startedAt, tz)}: ${who}`];
  if (call.address) lines.push(call.address);
  const tail = call.level === 'emergency' ? 'Call back now. Full report by email.' : 'Full report by email.';
  const fixed = toAscii([...lines, '', tail].join('\n'));
  const room = max - fixed.length - 2;
  let problem = toAscii(call.problem || call.reasonLine || '');
  if (problem.length > room) problem = room > 4 ? problem.slice(0, room - 3).trimEnd() + '...' : '';
  const out = toAscii([...lines, problem, tail].filter(Boolean).join('\n'));
  return out.length > max ? out.slice(0, max) : out;
}

module.exports = { COLORS, LABELS, escapeHtml, safeUrl, renderCallReport, renderSms, toAscii, telHref };
