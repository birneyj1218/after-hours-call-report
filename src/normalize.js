'use strict';
// Turns a voice provider's end-of-call webhook into one flat call record.
//
// Supported shapes:
//   - Vapi "end-of-call-report" server message ({ message: { type, call, artifact, analysis, ... } }).
//     Every other Vapi server message (status-update, transcript, ...) is ignored, so the
//     assistant's server URL can receive all messages safely.
//   - A generic shape for any other provider, or for your own glue code:
//     { event: "call.ended", call_id, started_at, ended_at, from, transcript, recording_url, fields: {...} }
//
// The adapter is the only provider-specific code; everything downstream reads the record.

const { isValidDate } = require('./time');

const clean = (v) => (v === undefined || v === null ? '' : String(v).replace(/\s+/g, ' ').trim());
const digits = (s) => clean(s).replace(/\D/g, '');

/** US-centric E.164: 10 digits get +1; 11 starting with 1 get +. Anything else is returned as-is or ''. */
function toE164(s) {
  const raw = clean(s);
  if (!raw) return '';
  const d = digits(raw);
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  if (raw.startsWith('+') && d.length >= 8 && d.length <= 15) return `+${d}`;
  return '';
}

/** "(612) 555-0142" for US numbers, otherwise the input. */
function prettyPhone(s) {
  let d = digits(s);
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : clean(s);
}

const pick = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) if (clean(obj[k])) return clean(obj[k]);
  return '';
};

const NAME_KEYS = ['caller_name', 'callerName', 'customer_name', 'customerName', 'name', 'full_name'];
const PHONE_KEYS = ['callback_number', 'callbackNumber', 'phone', 'phone_number', 'phoneNumber', 'customer_phone'];
const ADDRESS_KEYS = ['service_address', 'serviceAddress', 'address', 'location'];
const PROBLEM_KEYS = ['problem', 'issue', 'description', 'reason', 'service'];
const URGENCY_KEYS = ['urgency', 'priority', 'severity'];
const CALLBACK_KEYS = ['preferred_callback', 'preferredCallback', 'callback_time', 'best_time'];

function asList(v) {
  if (Array.isArray(v)) return v.map(clean).filter(Boolean);
  return clean(v) ? clean(v).split(/\s*[,;]\s*/).filter(Boolean) : [];
}

function fieldsFrom(src) {
  return {
    name: pick(src, NAME_KEYS),
    callbackNumber: pick(src, PHONE_KEYS),
    address: pick(src, ADDRESS_KEYS),
    problem: pick(src, PROBLEM_KEYS),
    urgency: pick(src, URGENCY_KEYS).toLowerCase(),
    preferredCallback: pick(src, CALLBACK_KEYS),
    emergencySignals: asList(src && (src.emergency_signals || src.emergencySignals)),
  };
}

/** Earlier sources win, later ones fill gaps. */
function mergeFields(...list) {
  const out = { name: '', callbackNumber: '', address: '', problem: '', urgency: '', preferredCallback: '', emergencySignals: [] };
  for (const f of list) {
    for (const k of Object.keys(out)) {
      if (k === 'emergencySignals') out[k] = [...new Set([...out[k], ...(f[k] || [])])];
      else if (!out[k] && f[k]) out[k] = f[k];
    }
  }
  return out;
}

const ASSISTANT_ROLES = /^(ai|assistant|bot|agent|front ?desk)$/i;
const CALLER_ROLES = /^(user|customer|caller|human)$/i;

function speakerOf(role) {
  if (ASSISTANT_ROLES.test(clean(role))) return 'assistant';
  if (CALLER_ROLES.test(clean(role))) return 'caller';
  return '';
}

/** "AI: hello\nUser: hi" -> turns. Lines without a known speaker are kept with speaker ''. */
function parseTranscriptText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([A-Za-z ]{2,12}):\s*(.*)$/);
      const speaker = m ? speakerOf(m[1]) : '';
      return speaker ? { speaker, text: clean(m[2]) } : { speaker: '', text: clean(line) };
    })
    .filter((t) => t.text);
}

function toolCallArgs(messages) {
  const args = [];
  for (const msg of messages || []) {
    for (const tc of msg.toolCalls || msg.tool_calls || []) {
      let a = (tc.function || {}).arguments || {};
      if (typeof a === 'string') {
        try {
          a = JSON.parse(a);
        } catch {
          a = {};
        }
      }
      if (a && typeof a === 'object') args.push(a);
    }
  }
  return args;
}

function finish(record) {
  const turns = record.turns;
  record.rolesKnown = turns.length > 0 && turns.every((t) => t.speaker);
  record.transcriptText = turns.map((t) => `${t.speaker === 'assistant' ? 'Assistant' : t.speaker === 'caller' ? 'Caller' : 'Unknown'}: ${t.text}`).join('\n');
  if (!record.durationSeconds && isValidDate(record.startedAt) && isValidDate(record.endedAt)) {
    record.durationSeconds = Math.max(0, Math.round((Date.parse(record.endedAt) - Date.parse(record.startedAt)) / 1000));
  }
  if (!isValidDate(record.endedAt)) record.endedAt = isValidDate(record.startedAt) ? record.startedAt : '';
  return record;
}

function fromVapi(m) {
  const call = m.call || {};
  const artifact = m.artifact || call.artifact || {};
  const analysis = m.analysis || call.analysis || {};
  const messages = artifact.messages || m.messages || [];

  let turns = messages
    .filter((x) => x && typeof x.message === 'string' && speakerOf(x.role))
    .map((x) => ({ speaker: speakerOf(x.role), text: clean(x.message) }))
    .filter((t) => t.text);
  if (!turns.length) turns = parseTranscriptText(artifact.transcript || m.transcript || call.transcript);

  const structured = analysis.structuredData || {};
  const tools = toolCallArgs(messages).map(fieldsFrom);

  return finish({
    kind: 'call',
    provider: 'vapi',
    callId: clean(call.id || m.callId),
    startedAt: clean(m.startedAt || call.startedAt),
    endedAt: clean(m.endedAt || call.endedAt),
    durationSeconds: Math.round(Number(m.durationSeconds) || 0),
    callerId: toE164((m.customer || call.customer || {}).number),
    endedReason: clean(m.endedReason || call.endedReason),
    turns,
    fields: mergeFields(fieldsFrom(structured), ...tools),
    agentSummary: clean(analysis.summary || m.summary),
    recordingUrl: clean(artifact.recordingUrl || m.recordingUrl || call.recordingUrl),
  });
}

function fromGeneric(b) {
  let turns = [];
  if (Array.isArray(b.transcript)) {
    turns = b.transcript
      .map((t) => ({ speaker: speakerOf(t.speaker || t.role), text: clean(t.text || t.message) }))
      .filter((t) => t.text);
  } else {
    turns = parseTranscriptText(b.transcript);
  }
  return finish({
    kind: 'call',
    provider: clean(b.provider) || 'generic',
    callId: clean(b.call_id || b.callId || b.id),
    startedAt: clean(b.started_at || b.startedAt),
    endedAt: clean(b.ended_at || b.endedAt),
    durationSeconds: Math.round(Number(b.duration_seconds || b.durationSeconds) || 0),
    callerId: toE164(b.from || b.caller_id || b.callerId),
    endedReason: clean(b.ended_reason || b.endedReason),
    turns,
    fields: mergeFields(fieldsFrom(b.fields || {})),
    agentSummary: clean(b.summary),
    recordingUrl: clean(b.recording_url || b.recordingUrl),
  });
}

const GENERIC_EVENTS = /^(call[._-]?ended|end[._-]?of[._-]?call|call[._-]?completed)$/i;

/**
 * Normalize a webhook body. Returns { kind: 'call', ... } or { kind: 'ignore', reason }.
 * Accepts the raw body or an n8n webhook item ({ body: ... }).
 */
function normalizeCall(input) {
  if (!input || typeof input !== 'object') return { kind: 'ignore', reason: 'empty or non-JSON body' };
  const body = input.body && typeof input.body === 'object' && !input.message && !input.event ? input.body : input;

  if (body.message && typeof body.message === 'object') {
    const type = clean(body.message.type);
    if (type !== 'end-of-call-report') return { kind: 'ignore', reason: `Vapi message "${type || 'unknown'}" is not an end-of-call report` };
    const rec = fromVapi(body.message);
    return rec.callId ? rec : { kind: 'ignore', reason: 'end-of-call report without a call id' };
  }
  if (GENERIC_EVENTS.test(clean(body.event))) {
    const rec = fromGeneric(body);
    return rec.callId ? rec : { kind: 'ignore', reason: 'call.ended event without call_id' };
  }
  return { kind: 'ignore', reason: `unrecognised payload (event "${clean(body.event) || 'none'}")` };
}

module.exports = { normalizeCall, toE164, prettyPhone, digits, parseTranscriptText };
