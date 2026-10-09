#!/usr/bin/env node
'use strict';
// Replays one night of fictional calls for "Cavern Electrical" through the same code the
// n8n workflow runs, against the mock providers (started in-process on a free port).
// Writes the morning digest to docs/sample-report.html and one emergency call report to
// docs/sample-call-report.html. Output is deterministic: the clock is fixed.
//
//   node scripts/demo.js

const { readFileSync, readdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { createMockServer } = require('../mock/server');
const { fromEnv, prepareCall, finishCall, buildDigest, emptyState, checkAndMarkSeen, rememberCall, afterDigestSent, time, adapters } = require('../src');

const ROOT = path.join(__dirname, '..');
const CALLS = path.join(ROOT, 'examples', 'calls');
const DIGEST_AT = '2026-01-17T13:00:00Z'; // 7:00 AM Saturday in America/Chicago
const LLM_DOWN_FOR = 'call-demo-0004-breaker-tripping'; // show the no-LLM fallback on one call

async function main() {
  const mock = createMockServer({ quiet: true });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${mock.address().port}`;
  const cfg = fromEnv({}, {
    llmBaseUrl: `${base}/v1`,
    emailApiUrl: `${base}/emails`,
    smsBaseUrl: base,
    crmWebhookUrl: `${base}/crm/calls`,
  });
  const tz = cfg.timezone;
  const state = emptyState(); // stands in for n8n workflow static data
  const files = readdirSync(CALLS).filter((f) => f.endsWith('.json')).sort();
  const deliveries = [...files, files[0]]; // the last one simulates the provider retrying a webhook
  let sampleCall = null;

  console.log(`${cfg.businessName}: replaying ${deliveries.length} webhook deliveries (time zone ${tz})\n`);
  for (const file of deliveries) {
    const body = JSON.parse(readFileSync(path.join(CALLS, file), 'utf8'));
    const prep = prepareCall(body, cfg);
    if (prep.skip) {
      console.log(`  ${file.padEnd(34)} ignored: ${prep.reason}`);
      continue;
    }
    const rec = prep.record;
    if (checkAndMarkSeen(state, rec.callId, rec.endedAt)) {
      console.log(`  ${file.padEnd(34)} duplicate delivery of ${rec.callId}: skipped, no second alert`);
      continue;
    }
    if (rec.callId === LLM_DOWN_FOR) await fetch(`${base}/_fail`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1, path: '/v1/chat/completions' }) });
    const llmResponse = prep.llmRequest ? await adapters.callLlm(cfg, prep.llmRequest, 'mock-key') : null;
    const out = finishCall(rec, llmResponse, cfg);
    const c = out.call;

    await adapters.logToCrm(cfg, out.crm, 'mock-key');
    if (out.notify.sms) await adapters.sendSms(cfg, { to: cfg.ownerSmsNumber, body: out.sms }, 'mock-token');
    if (out.notify.email) await adapters.sendEmail(cfg, { to: cfg.ownerEmail, subject: out.email.subject, html: out.email.html, text: out.email.text }, 'mock-key');
    rememberCall(state, out.digestEntry);
    if (!sampleCall && c.level === 'emergency') sampleCall = out;

    const acts = ['CRM', out.notify.sms && 'SMS', out.notify.email && 'email'].filter(Boolean).join(' + ');
    console.log(`  ${file.padEnd(34)} ${time.formatTime(c.endedAt, tz).padStart(8)}  ${c.level.toUpperCase().padEnd(9)} ${(c.name || '?').padEnd(16)} -> ${acts}`);
    console.log(`  ${''.padEnd(34)} why: ${c.reasonLine}`);
    if (c.llmError) console.log(`  ${''.padEnd(34)} AI summary unavailable (${c.llmError}); rules + call data used`);
    if (c.aiFields.length) console.log(`  ${''.padEnd(34)} filled from transcript by the AI: ${c.aiFields.map((f) => (f === 'callbackNumber' ? 'callback number' : f)).join(', ')}`);
  }

  const digest = buildDigest(state.calls, { cfg, now: DIGEST_AT, since: '2026-01-16T23:00:00Z' });
  afterDigestSent(state, DIGEST_AT, digest.reportedIds);
  const sent = await adapters.sendEmail(cfg, { to: cfg.ownerEmail, subject: digest.subject, html: digest.html, text: digest.text }, 'mock-key');

  const log = await (await fetch(`${base}/_log`)).json();
  const count = (k) => log.filter((e) => e.kind === k).length;
  console.log(`\nMorning digest at ${time.formatDateTime(DIGEST_AT, tz)}: "${digest.subject}" (${sent.ok ? 'sent to mock email API' : 'FAILED'})`);
  for (const n of digest.nights) console.log(`  ${n.label}: ${n.counts.emergency} emergency, ${n.counts.urgent} urgent, ${n.counts.routine} routine`);
  console.log(`\nMock providers received: ${count('llm')} LLM, ${count('forced-failure')} forced failure, ${count('sms')} SMS, ${count('email')} emails, ${count('crm')} CRM records`);

  const sms = log.filter((e) => e.kind === 'sms');
  if (sms.length) {
    console.log('\nFirst SMS alert to the owner:\n');
    console.log(sms[0].body.Body.split('\n').map((l) => `  | ${l}`).join('\n'));
  }

  writeFileSync(path.join(ROOT, 'docs', 'sample-report.html'), digest.html + '\n');
  if (sampleCall) writeFileSync(path.join(ROOT, 'docs', 'sample-call-report.html'), sampleCall.email.html + '\n');
  console.log('\nWrote docs/sample-report.html (morning digest) and docs/sample-call-report.html (one emergency call)');
  mock.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
