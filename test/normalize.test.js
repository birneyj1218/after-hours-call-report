'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCall, toE164, prettyPhone, parseTranscriptText } = require('../src/normalize');
const { example } = require('./helpers');

test('Vapi end-of-call report becomes a flat record', () => {
  const r = normalizeCall(example('01'));
  assert.equal(r.kind, 'call');
  assert.equal(r.provider, 'vapi');
  assert.equal(r.callId, 'call-demo-0001-burning-panel');
  assert.equal(r.callerId, '+16125550142');
  assert.equal(r.fields.name, 'Maria Okafor');
  assert.equal(r.fields.address, '418 Larkspur Lane, Ridgeview');
  assert.equal(r.fields.urgency, 'emergency');
  assert.deepEqual(r.fields.emergencySignals, ['burning smell', 'panel warm']);
  assert.ok(r.durationSeconds > 30);
  assert.equal(r.rolesKnown, true);
  assert.equal(r.turns[0].speaker, 'assistant');
  assert.equal(r.turns[1].speaker, 'caller');
  assert.ok(!r.turns.some((t) => /system prompt/.test(t.text)), 'system messages are dropped');
  assert.match(r.transcriptText, /^Assistant: Thanks for calling Cavern Electrical/);
  assert.match(r.recordingUrl, /^https:\/\/recordings\.example\.com\//);
});

test('other Vapi server messages are ignored', () => {
  const r = normalizeCall(example('06'));
  assert.equal(r.kind, 'ignore');
  assert.match(r.reason, /status-update/);
});

test('generic call.ended shape is supported', () => {
  const r = normalizeCall(example('03'));
  assert.equal(r.provider, 'generic');
  assert.equal(r.callId, 'call-demo-0003-kitchen-outlets');
  assert.equal(r.callerId, '+16125550181');
  assert.equal(r.fields.preferredCallback, 'Monday after 9 am');
  assert.equal(r.durationSeconds, 109);
  assert.equal(r.turns.filter((t) => t.speaker === 'caller').length, 4);
});

test('n8n webhook item ({ headers, body }) is unwrapped', () => {
  const r = normalizeCall({ headers: {}, query: {}, body: example('01') });
  assert.equal(r.callId, 'call-demo-0001-burning-panel');
});

test('falls back to the transcript string when messages are missing', () => {
  const body = example('01');
  delete body.message.artifact.messages;
  const r = normalizeCall(body);
  assert.ok(r.turns.length > 5);
  assert.equal(r.turns[1].speaker, 'caller');
  assert.equal(r.rolesKnown, true);
});

test('tool-call arguments fill fields the structured data lacks', () => {
  const body = example('05');
  body.message.artifact.messages.push({ role: 'tool_calls', toolCalls: [{ id: 't1', function: { name: 'dispatch_oncall', arguments: JSON.stringify({ customer_name: 'Lena Brandt', service_address: '31 Quarry Ridge Drive' }) } }] });
  const r = normalizeCall(body);
  assert.equal(r.fields.name, 'Lena Brandt');
  assert.equal(r.fields.address, '31 Quarry Ridge Drive');
});

test('reports without a call id, and junk, are ignored', () => {
  assert.equal(normalizeCall({ message: { type: 'end-of-call-report' } }).kind, 'ignore');
  assert.equal(normalizeCall({ event: 'call.ended' }).kind, 'ignore');
  assert.equal(normalizeCall(null).kind, 'ignore');
  assert.equal(normalizeCall('text').kind, 'ignore');
  assert.equal(normalizeCall({ hello: 'world' }).kind, 'ignore');
});

test('phone helpers', () => {
  assert.equal(toE164('612-555-0142'), '+16125550142');
  assert.equal(toE164('1 (612) 555-0142'), '+16125550142');
  assert.equal(toE164('+44 20 7946 0018'), '+442079460018');
  assert.equal(toE164('555'), '');
  assert.equal(toE164(''), '');
  assert.equal(prettyPhone('+16125550142'), '(612) 555-0142');
  assert.equal(prettyPhone('ext 12'), 'ext 12');
});

test('transcript text parser keeps unknown speakers as unknown', () => {
  const t = parseTranscriptText('AI: Hello\nUser: Hi there\nsomething odd\n\nCaller: bye');
  assert.deepEqual(t.map((x) => x.speaker), ['assistant', 'caller', '', 'caller']);
});
