'use strict';
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { fromEnv } = require('../src/config');

const ROOT = path.join(__dirname, '..');
const CANNED = JSON.parse(readFileSync(path.join(ROOT, 'mock', 'llm-replies.json'), 'utf8'));

function example(prefix) {
  const dir = path.join(ROOT, 'examples', 'calls');
  const file = readdirSync(dir).find((f) => f.startsWith(prefix));
  if (!file) throw new Error(`no example starting with ${prefix}`);
  return JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
}

/** Test config: defaults (Cavern Electrical, America/Chicago) plus overrides. */
const cfg = (overrides = {}) => fromEnv({}, overrides);

/** OpenAI-style response wrapping a summary object (or raw string content). */
function llmResponse(content) {
  return { choices: [{ index: 0, message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } }] };
}

const canned = (callId) => llmResponse(CANNED[callId]);

/** Minimal call record for classifier and report tests. */
function record(callerLines, extra = {}) {
  const turns = callerLines.flatMap((text) => [
    { speaker: 'assistant', text: 'Go ahead.' },
    { speaker: 'caller', text },
  ]);
  return {
    kind: 'call',
    provider: 'test',
    callId: 'call-test-1',
    startedAt: '2026-01-17T04:00:00Z',
    endedAt: '2026-01-17T04:02:00Z',
    durationSeconds: 120,
    callerId: '+16125550111',
    endedReason: '',
    turns,
    rolesKnown: true,
    transcriptText: turns.map((t) => `${t.speaker === 'caller' ? 'Caller' : 'Assistant'}: ${t.text}`).join('\n'),
    fields: { name: '', callbackNumber: '', address: '', problem: '', urgency: '', preferredCallback: '', emergencySignals: [] },
    agentSummary: '',
    recordingUrl: '',
    ...extra,
  };
}

module.exports = { ROOT, CANNED, example, cfg, llmResponse, canned, record };
