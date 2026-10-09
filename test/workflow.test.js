'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { runWorkflow } = require('./n8n-sim');
const { text: built } = require('../scripts/build-workflow');
const { example, CANNED, ROOT } = require('./helpers');

const FILE = path.join(ROOT, 'n8n', 'after-hours-call-report.json');
const raw = readFileSync(FILE, 'utf8');
const wf = JSON.parse(raw);
const names = new Set(wf.nodes.map((n) => n.name));
const WEBHOOK = 'Call ended (voice webhook)';
const SCHEDULE = 'Every morning at 7';
const ENV = { SMS_BASE_URL: 'https://sms.test', SMS_ACCOUNT_SID: 'ACtest', LLM_BASE_URL: 'https://llm.test/v1', EMAIL_API_URL: 'https://email.test/send', CRM_WEBHOOK_URL: 'https://crm.test/calls' };

/** Fake providers: LLM answers from the canned replies; `fail` lists node names that return 500. */
function providers({ fail = [] } = {}) {
  return async (req) => {
    if (fail.includes(req.node)) return { status: 500, body: {} };
    if (req.node === 'LLM: summarize call') {
      const facts = JSON.parse(req.body.messages[1].content.split('\n')[1]);
      return { status: 200, body: { choices: [{ message: { content: JSON.stringify(CANNED[facts.call_id]) } }] } };
    }
    return { status: 200, body: { id: 'ok' } };
  };
}
const nodesCalled = (res) => res.requests.map((r) => r.node);

test('committed workflow matches the generator (src/ and n8n/ are in sync)', () => {
  assert.equal(raw, built, 'run `npm run build:workflow`');
});

test('structure: unique names, valid connections, everything connected', () => {
  assert.equal(names.size, wf.nodes.length);
  for (const [from, { main }] of Object.entries(wf.connections)) {
    assert.ok(names.has(from), `unknown source ${from}`);
    for (const out of main) for (const c of out) assert.ok(names.has(c.node), `${from} -> unknown ${c.node}`);
  }
  const targets = new Set(Object.values(wf.connections).flatMap(({ main }) => main.flat().map((c) => c.node)));
  for (const n of wf.nodes) {
    if (/webhook$|scheduleTrigger$|stickyNote$/.test(n.type)) continue;
    assert.ok(targets.has(n.name), `${n.name} has no input`);
  }
});

test('credentials are referenced by name only; no hosts, IPs or secrets are embedded', () => {
  const creds = wf.nodes.filter((n) => n.credentials).flatMap((n) => Object.values(n.credentials));
  assert.ok(creds.length >= 5);
  for (const c of creds) assert.deepEqual(Object.keys(c), ['name']);
  assert.deepEqual([...new Set(creds.map((c) => c.name))].sort(), ['CRM API key', 'Email API key', 'LLM API key', 'SMS account (Twilio)', 'Voice webhook secret']);
  for (const n of wf.nodes.filter((x) => x.type.endsWith('httpRequest'))) assert.match(n.parameters.url, /^=\{\{ \$\('Config( \(digest\))?'\)/, `${n.name} URL must come from config`);
  assert.doesNotMatch(raw, /https?:\/\/(?!localhost)[a-z0-9-]+\.[a-z0-9.-]+/i, 'no hard-coded hosts');
  assert.doesNotMatch(raw, /\b(10|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+/);
  assert.doesNotMatch(raw, /(sk|pk)_(live|test)_|Bearer [A-Za-z0-9]{8}|AC[0-9a-f]{32}/);
});

test('webhook requires header auth and the workflow keeps no successful executions', () => {
  const hook = wf.nodes.find((n) => n.name === WEBHOOK);
  assert.equal(hook.parameters.authentication, 'headerAuth');
  assert.match(hook.parameters.path, /CHANGE-ME/);
  assert.equal(wf.settings.saveDataSuccessExecution, 'none');
  assert.equal(wf.active, false);
});

test('emergency call: LLM, CRM, SMS to the owner, email', async () => {
  const staticData = {};
  const res = await runWorkflow(wf, { start: WEBHOOK, payload: example('01'), env: ENV, staticData, http: providers() });
  assert.deepEqual(nodesCalled(res), ['LLM: summarize call', 'CRM: log call', 'SMS: alert the owner', 'Email: call report']);
  const sms = res.requests[2];
  assert.equal(sms.url, 'https://sms.test/2010-04-01/Accounts/ACtest/Messages.json');
  assert.equal(sms.body.To, '+16125550100');
  assert.match(sms.body.Body, /^EMERGENCY after-hours call, Cavern Electrical/);
  assert.equal(sms.credential.name, 'SMS account (Twilio)');
  assert.equal(res.requests[1].headers['Idempotency-Key'], 'after-hours:call-demo-0001-burning-panel');
  assert.match(res.requests[3].body.subject, /^\[EMERGENCY\]/);
  assert.equal(staticData.calls.length, 1);
});

test('routine call: CRM only, saved for the digest', async () => {
  const staticData = {};
  const res = await runWorkflow(wf, { start: WEBHOOK, payload: example('03'), env: ENV, staticData, http: providers() });
  assert.deepEqual(nodesCalled(res), ['LLM: summarize call', 'CRM: log call']);
  assert.equal(staticData.calls[0].level, 'routine');
});

test('LLM outage: the emergency alert still goes out', async () => {
  const res = await runWorkflow(wf, { start: WEBHOOK, payload: example('05'), env: ENV, staticData: {}, http: providers({ fail: ['LLM: summarize call'] }) });
  assert.deepEqual(nodesCalled(res), ['LLM: summarize call', 'CRM: log call', 'SMS: alert the owner', 'Email: call report']);
  assert.match(res.requests[2].body.Body, /Lena Brandt|\(612\) 555-0159/);
});

test('LLM turned off: no LLM request, same alerts', async () => {
  const res = await runWorkflow(wf, { start: WEBHOOK, payload: example('01'), env: { ...ENV, LLM_ENABLED: 'false' }, staticData: {}, http: providers() });
  assert.deepEqual(nodesCalled(res), ['CRM: log call', 'SMS: alert the owner', 'Email: call report']);
});

test('CRM and SMS failures do not stop the email', async () => {
  const res = await runWorkflow(wf, { start: WEBHOOK, payload: example('01'), env: ENV, staticData: {}, http: providers({ fail: ['CRM: log call', 'SMS: alert the owner'] }) });
  assert.equal(res.stoppedAt, null);
  assert.ok(nodesCalled(res).includes('Email: call report'));
});

test('status updates and duplicate deliveries do nothing', async () => {
  const staticData = {};
  const a = await runWorkflow(wf, { start: WEBHOOK, payload: example('06'), env: ENV, staticData, http: providers() });
  assert.deepEqual(a.requests, []);
  await runWorkflow(wf, { start: WEBHOOK, payload: example('01'), env: ENV, staticData, http: providers() });
  const again = await runWorkflow(wf, { start: WEBHOOK, payload: example('01'), env: ENV, staticData, http: providers() });
  assert.deepEqual(again.requests, [], 'no second SMS for a provider retry');
});

test('morning digest: one email with every stored call, then the store is cleared', async () => {
  const staticData = {};
  for (const p of ['01', '02', '03', '04', '05']) await runWorkflow(wf, { start: WEBHOOK, payload: example(p), env: ENV, staticData, http: providers() });
  assert.equal(staticData.calls.length, 5);
  const res = await runWorkflow(wf, { start: SCHEDULE, env: ENV, staticData, http: providers() });
  assert.deepEqual(nodesCalled(res), ['Email: morning digest']);
  const mail = res.requests[0];
  assert.equal(mail.url, 'https://email.test/send');
  assert.match(mail.body.subject, /^Morning call report: 5 after-hours calls \(3 emergency, 1 urgent\)/);
  assert.match(mail.body.html, /Friday night, January 16/);
  assert.equal(staticData.calls.length, 0);
  assert.ok(staticData.lastDigestAt);
});

test('morning digest: if the email fails, the calls are kept for next time', async () => {
  const staticData = {};
  await runWorkflow(wf, { start: WEBHOOK, payload: example('03'), env: ENV, staticData, http: providers() });
  const res = await runWorkflow(wf, { start: SCHEDULE, env: ENV, staticData, http: providers({ fail: ['Email: morning digest'] }) });
  assert.equal(res.stoppedAt, 'Email: morning digest');
  assert.equal(staticData.calls.length, 1);
});

test('morning digest: empty night is skipped when SEND_EMPTY_DIGEST=false', async () => {
  const quiet = await runWorkflow(wf, { start: SCHEDULE, env: { ...ENV, SEND_EMPTY_DIGEST: 'false' }, staticData: {}, http: providers() });
  assert.deepEqual(quiet.requests, []);
  const loud = await runWorkflow(wf, { start: SCHEDULE, env: ENV, staticData: {}, http: providers() });
  assert.match(loud.requests[0].body.subject, /no after-hours calls/);
});
