'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createMockServer } = require('../mock/server');
const adapters = require('../src/adapters');
const { prepareCall } = require('../src/pipeline');
const { parseSummaryResponse } = require('../src/llm');
const { example, cfg } = require('./helpers');

let server;
let base;
let c;
const log = async () => (await fetch(`${base}/_log`)).json();

before(async () => {
  server = createMockServer({ quiet: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  c = cfg({ llmBaseUrl: `${base}/v1`, emailApiUrl: `${base}/emails`, smsBaseUrl: base, crmWebhookUrl: `${base}/crm/calls`, llmTimeoutMs: 2000 });
});
after(() => server.close());

test('LLM: canned reply for a known call parses and validates', async () => {
  const prep = prepareCall(example('01'), c);
  const res = await adapters.callLlm(c, prep.llmRequest, 'k');
  const parsed = parseSummaryResponse(res);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary.urgency, 'emergency');
});

test('LLM: unknown call gets the heuristic mock reply, which also validates', async () => {
  const body = example('04');
  body.message.call.id = 'call-not-canned';
  const res = await adapters.callLlm(c, prepareCall(body, c).llmRequest, 'k');
  const parsed = parseSummaryResponse(res);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary.callback_number, '612-555-0123');
});

test('LLM: a 500 comes back as { error }, never a throw', async () => {
  await fetch(`${base}/_fail`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1, path: '/v1/chat/completions' }) });
  const res = await adapters.callLlm(c, { model: 'x', messages: [] }, 'k');
  assert.deepEqual(res, { error: { message: 'HTTP 500' } });
});

test('LLM: unreachable server is an error, not a crash', async () => {
  const res = await adapters.callLlm({ ...c, llmBaseUrl: 'http://127.0.0.1:9/v1', llmTimeoutMs: 500 }, {}, 'k');
  assert.ok(res.error);
});

test('SMS: Twilio-style form post with Basic auth', async () => {
  const r = await adapters.sendSms(c, { to: '+16125550100', body: 'hello' }, 'token');
  assert.equal(r.ok, true);
  assert.equal(r.status, 201);
  const sms = (await log()).find((e) => e.kind === 'sms');
  assert.deepEqual(sms.body, { To: '+16125550100', From: '+16125550199', Body: 'hello' });
  assert.equal(sms.auth, true);
});

test('email: JSON body with from, to, subject, html, text', async () => {
  const r = await adapters.sendEmail(c, { to: 'owner@example.com', subject: 'S', html: '<p>h</p>', text: 't' }, 'k');
  assert.equal(r.ok, true);
  const email = (await log()).find((e) => e.kind === 'email');
  assert.deepEqual(email.body, { from: 'Cavern Electrical <after-hours@example.com>', to: ['owner@example.com'], subject: 'S', html: '<p>h</p>', text: 't' });
});

test('CRM: same external_id twice is recognised as a duplicate', async () => {
  const one = await adapters.logToCrm(c, { external_id: 'after-hours:x' }, 'k');
  const two = await adapters.logToCrm(c, { external_id: 'after-hours:x' }, 'k');
  assert.equal(one.data.duplicate, false);
  assert.equal(two.data.duplicate, true);
  assert.equal(one.data.id, two.data.id);
});
