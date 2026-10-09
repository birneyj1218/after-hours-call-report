'use strict';
// The whole per-call flow as two pure functions, used by the n8n workflow (pasted into
// Code nodes), by the demo, and by the tests:
//
//   prepareCall(webhookBody, cfg)              -> { skip, reason } or { record, llmRequest }
//   finishCall(record, llmResponse, cfg)       -> report, SMS, CRM payload, digest entry
//
// The HTTP calls in between (LLM, email, SMS, CRM) happen in n8n or in src/adapters.js.

const { normalizeCall, toE164, prettyPhone, digits } = require('./normalize');
const { classifyByRules, combine, reasonLine } = require('./classify');
const { buildSummaryRequest, parseSummaryResponse } = require('./llm');
const { renderCallReport, renderSms } = require('./report');
const { atLeast } = require('./config');

function prepareCall(body, cfg) {
  const record = normalizeCall(body);
  if (record.kind !== 'call') return { skip: true, reason: record.reason };
  return { skip: false, record, llmRequest: cfg.llmEnabled ? buildSummaryRequest(record, cfg) : null };
}

const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9]{2,}/g) || [];

/** Guard against invented details: most words of an LLM-extracted value must be in the transcript. */
function appearsInTranscript(value, transcript) {
  const w = words(value);
  if (!w.length) return false;
  const t = new Set(words(transcript));
  return w.filter((x) => t.has(x)).length / w.length >= 0.6;
}

/** An LLM-extracted phone number is kept only if its last 7 digits were actually said. */
function phoneInTranscript(value, transcript) {
  const d = digits(value);
  return d.length >= 7 && digits(transcript).includes(d.slice(-7));
}

const NEXT_STEP = {
  emergency: 'Call the customer back now.',
  urgent: 'Call back first thing this morning.',
  routine: 'Call back during business hours to schedule.',
};

function fallbackSummary(call) {
  const parts = [`${call.name || 'A caller'} called the after-hours line.`];
  if (call.problem) parts.push(`Problem: ${call.problem.replace(/\.$/, '')}.`);
  if (call.address) parts.push(`Address: ${call.address}.`);
  if (call.preferredCallback) parts.push(`Asked to be called back ${call.preferredCallback.replace(/\.$/, '')}.`);
  return parts.join(' ');
}

function crmPayload(call, cfg) {
  return {
    external_id: `after-hours:${call.callId}`,
    source: 'after-hours-voice',
    business: cfg.businessName,
    title: `[${call.level.toUpperCase()}] ${call.name || 'Unknown caller'}: ${(call.problem || 'after-hours call').slice(0, 80)}`,
    priority: { emergency: 'high', urgent: 'normal', routine: 'low' }[call.level],
    urgency: call.level,
    status: 'new',
    contact: { name: call.name || null, phone: call.callbackE164 || null, caller_id: call.callerId || null },
    service_address: call.address || null,
    description: `${call.summary}\n\nUrgency: ${call.level} - ${call.reasonLine}\nNext step: ${call.nextStep}`,
    occurred_at: call.endedAt || call.startedAt,
    duration_seconds: call.durationSeconds,
    recording_url: call.recordingUrl || null,
    transcript: call.transcriptText,
  };
}

function digestEntry(call, notify) {
  const keep = ['callId', 'startedAt', 'endedAt', 'level', 'name', 'callbackNumber', 'callbackE164', 'callerIdPretty', 'address', 'problem', 'preferredCallback', 'reasonLine', 'nextStep', 'summary'];
  const entry = Object.fromEntries(keep.map((k) => [k, call[k] === undefined ? '' : call[k]]));
  entry.alertedBySms = Boolean(notify.sms);
  return entry;
}

/**
 * Classify, summarize and render one call. `llmResponse` is the raw /chat/completions
 * response, an { error } object, or null when the LLM is off or was not called.
 */
function finishCall(record, llmResponse, cfg) {
  const rules = classifyByRules(record, cfg);
  const parsed = cfg.llmEnabled ? parseSummaryResponse(llmResponse) : { ok: false, error: 'LLM turned off' };
  const llm = parsed.ok ? parsed.summary : null;
  const classification = combine(rules, { agentUrgency: record.fields.urgency, llm });

  const f = record.fields;
  const aiFields = [];
  const fromAi = (key, current, candidate, check) => {
    if (current) return current;
    if (candidate && check(candidate, record.transcriptText)) {
      aiFields.push(key);
      return candidate;
    }
    return '';
  };
  const firstCallerTurn = (record.turns.find((t) => t.speaker === 'caller') || {}).text || '';

  const name = fromAi('name', f.name, llm && llm.caller_name, appearsInTranscript);
  const spoken = fromAi('callbackNumber', f.callbackNumber, llm && llm.callback_number, phoneInTranscript);
  const callbackE164 = toE164(spoken) || record.callerId;
  const address = fromAi('address', f.address, llm && llm.service_address, appearsInTranscript);
  let problem = f.problem;
  if (!problem && llm && llm.problem) {
    problem = llm.problem;
    aiFields.push('problem');
  }
  if (!problem) problem = firstCallerTurn.slice(0, 200);
  const preferredCallback = f.preferredCallback || (llm && llm.preferred_callback) || '';

  const call = {
    callId: record.callId,
    provider: record.provider,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationSeconds: record.durationSeconds,
    callerId: record.callerId,
    callerIdPretty: record.callerId ? prettyPhone(record.callerId) : '',
    level: classification.level,
    reasons: classification.reasons,
    reasonLine: reasonLine(classification),
    classificationSources: classification.sources,
    name,
    callbackNumber: callbackE164 ? prettyPhone(callbackE164) : spoken,
    callbackE164,
    address,
    problem,
    preferredCallback,
    nextStep: NEXT_STEP[classification.level] + (preferredCallback ? ` They asked for: ${preferredCallback.replace(/\.$/, '')}.` : ''),
    aiFields,
    recordingUrl: record.recordingUrl,
    turns: record.turns,
    transcriptText: record.transcriptText,
    llmError: parsed.ok ? '' : parsed.error,
  };
  if (llm) {
    call.summary = llm.summary;
    call.summarySource = 'written by the AI summary';
  } else if (record.agentSummary) {
    call.summary = record.agentSummary;
    call.summarySource = `from the voice provider (AI summary unavailable: ${parsed.error})`;
  } else {
    call.summary = fallbackSummary(call);
    call.summarySource = `built from the call data (AI summary unavailable: ${parsed.error})`;
  }

  const notify = {
    sms: Boolean(cfg.ownerSmsNumber) && atLeast(call.level, cfg.smsAlertLevel),
    email: Boolean(cfg.ownerEmail) && atLeast(call.level, cfg.emailEachCall),
  };

  return {
    call,
    notify,
    email: renderCallReport(call, cfg),
    sms: notify.sms ? renderSms(call, cfg) : null,
    crm: crmPayload(call, cfg),
    digestEntry: digestEntry(call, notify),
  };
}

module.exports = { prepareCall, finishCall, appearsInTranscript, phoneInTranscript, fallbackSummary };
