'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareCall, finishCall, appearsInTranscript, phoneInTranscript } = require('../src/pipeline');
const { example, cfg, canned, llmResponse, CANNED } = require('./helpers');

const run = (prefix, llm, overrides) => {
  const c = cfg(overrides);
  const prep = prepareCall(example(prefix), c);
  return finishCall(prep.record, llm, c);
};

test('prepareCall skips non-reports and builds an LLM request only when enabled', () => {
  assert.equal(prepareCall(example('06'), cfg()).skip, true);
  assert.ok(prepareCall(example('01'), cfg()).llmRequest);
  assert.equal(prepareCall(example('01'), cfg({ llmEnabled: false })).llmRequest, null);
});

test('emergency call: SMS + email + CRM payload', () => {
  const out = run('01', canned('call-demo-0001-burning-panel'));
  assert.equal(out.call.level, 'emergency');
  assert.deepEqual(out.notify, { sms: true, email: true });
  assert.equal(out.call.summarySource, 'written by the AI summary');
  assert.equal(out.crm.external_id, 'after-hours:call-demo-0001-burning-panel');
  assert.equal(out.crm.priority, 'high');
  assert.equal(out.crm.contact.phone, '+16125550142');
  assert.match(out.crm.transcript, /Caller: Maria Okafor\./);
  assert.equal(out.digestEntry.alertedBySms, true);
  assert.equal(out.digestEntry.turns, undefined, 'the digest store keeps no transcript');
});

test('rules catch what the voice agent under-rated (no heat, 6 degrees, newborn)', () => {
  const out = run('02', canned('call-demo-0002-no-heat'));
  assert.equal(out.call.level, 'emergency');
  assert.match(out.call.reasonLine, /No heat in freezing weather/);
  assert.deepEqual(out.call.aiFields, ['address']);
  assert.equal(out.call.address, '77 Juniper Court, unit B');
});

test('LLM down: rules still decide and the owner still gets the alert', () => {
  const out = run('01', { error: { message: 'Request failed with status code 503' } });
  assert.equal(out.call.level, 'emergency');
  assert.equal(out.notify.sms, true);
  assert.match(out.call.summarySource, /^built from the call data \(AI summary unavailable: LLM call failed/);
  assert.match(out.call.summary, /^Maria Okafor called the after-hours line\. Problem: Burning plastic smell/);
});

test('LLM returns junk: same fallback', () => {
  const out = run('04', llmResponse('I think this is fine'));
  assert.equal(out.call.level, 'urgent');
  assert.match(out.call.llmError, /not JSON/);
  assert.equal(out.notify.sms, false);
});

test('LLM turned off by config', () => {
  const out = run('03', null, { llmEnabled: false });
  assert.equal(out.call.level, 'routine');
  assert.match(out.call.summarySource, /LLM turned off/);
  assert.equal(out.call.preferredCallback, 'Monday after 9 am');
  assert.match(out.call.nextStep, /They asked for: Monday after 9 am\./);
});

test('voice provider summary is used when the LLM is unavailable', () => {
  const body = example('01');
  body.message.analysis.summary = 'Caller smells burning at the panel.';
  const c = cfg();
  const out = finishCall(prepareCall(body, c).record, null, c);
  assert.equal(out.call.summary, 'Caller smells burning at the panel.');
  assert.match(out.call.summarySource, /^from the voice provider/);
});

test('invented details from the LLM are rejected', () => {
  const fake = { ...CANNED['call-demo-0005-basement-flooding'], caller_name: 'Robert Smith', callback_number: '612-555-0199', service_address: '9 Elm Street' };
  const out = run('05', llmResponse(fake));
  assert.equal(out.call.name, '');
  assert.equal(out.call.callbackNumber, '(612) 555-0159', 'falls back to caller ID');
  assert.equal(out.call.address, '');
  assert.equal(out.call.level, 'emergency');
});

test('values captured by the voice agent win over the LLM', () => {
  const llm = { ...CANNED['call-demo-0001-burning-panel'], caller_name: 'Maria' };
  assert.equal(run('01', llmResponse(llm)).call.name, 'Maria Okafor');
});

test('alert thresholds are configurable', () => {
  const urgent = canned('call-demo-0001-burning-panel');
  assert.deepEqual(run('04', null, { smsAlertLevel: 'urgent', emailEachCall: 'all', llmEnabled: false }).notify, { sms: true, email: true });
  assert.deepEqual(run('01', urgent, { smsAlertLevel: 'none', emailEachCall: 'none' }).notify, { sms: false, email: false });
  assert.equal(run('01', urgent, { ownerSmsNumber: '' }).notify.sms, false);
});

test('transcript checks', () => {
  assert.equal(appearsInTranscript('31 Quarry Ridge Drive', "It's 31 Quarry Ridge Drive."), true);
  assert.equal(appearsInTranscript('9 Elm Street', 'It is 31 Quarry Ridge Drive'), false);
  assert.equal(appearsInTranscript('', 'anything'), false);
  assert.equal(phoneInTranscript('(612) 555-0159', 'This number is fine. 612-555-0159.'), true);
  assert.equal(phoneInTranscript('612-555-0199', 'call me at 612-555-0159'), false);
  assert.equal(phoneInTranscript('0159', '0159'), false);
});
