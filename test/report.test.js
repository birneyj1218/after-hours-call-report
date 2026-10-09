'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderCallReport, renderSms, escapeHtml, safeUrl, toAscii } = require('../src/report');
const { finishCall } = require('../src/pipeline');
const { normalizeCall } = require('../src/normalize');
const { example, cfg, canned, record } = require('./helpers');

const emergency = () => finishCall(normalizeCall(example('01')), canned('call-demo-0001-burning-panel'), cfg());

test('call report: subject, level banner, details and tel link', () => {
  const { email, call } = emergency();
  assert.match(email.subject, /^\[EMERGENCY\] After-hours call from Maria Okafor: /);
  assert.match(email.subject, /\(Cavern Electrical\)$/);
  assert.match(email.html, /EMERGENCY<\/b> &nbsp; Call the customer back now\./);
  assert.match(email.html, /href="tel:\+16125550142"/);
  assert.match(email.html, /418 Larkspur Lane, Ridgeview/);
  assert.match(email.html, /Fri, Jan 16, 10:14 PM CST/);
  assert.match(email.text, /^After-hours call - Cavern Electrical/);
  assert.match(email.text, /Callback number: \(612\) 555-0142/);
  assert.match(email.text, /Transcript:\nAssistant: Thanks for calling/);
  assert.equal(call.level, 'emergency');
});

test('everything from the call is HTML-escaped', () => {
  const r = record(['<script>alert(1)</script> my outlet <b>sparked</b>'], { recordingUrl: 'javascript:alert(1)' });
  r.fields.name = '"><img src=x onerror=alert(1)>';
  const { email } = finishCall(r, null, cfg({ llmEnabled: false }));
  assert.doesNotMatch(email.html, /<script>|<img|<b>sparked/);
  assert.match(email.html, /&lt;script&gt;/);
  assert.doesNotMatch(email.html, /javascript:/, 'non-http links are not rendered');
});

test('AI-extracted values are marked for checking', () => {
  const out = finishCall(normalizeCall(example('05')), canned('call-demo-0005-basement-flooding'), cfg());
  assert.match(out.email.text, /Caller: Lena Brandt \*/);
  assert.match(out.email.text, /\* Taken from the transcript by the AI summary/);
  const plain = emergency();
  assert.doesNotMatch(plain.email.text, /\* Taken from/);
});

test('SMS is short, ASCII and actionable', () => {
  const { sms } = emergency();
  assert.ok(sms.length <= 320, `length ${sms.length}`);
  assert.match(sms, /^EMERGENCY after-hours call, Cavern Electrical\n/);
  assert.match(sms, /Maria Okafor \(612\) 555-0142/);
  assert.match(sms, /Call back now\./);
  assert.match(sms, /^[\x20-\x7E\n]+$/);
});

test('SMS truncates a long problem but keeps the call-back line', () => {
  const out = emergency();
  const long = { ...out.call, problem: 'sparks '.repeat(200) };
  const sms = renderSms(long, cfg());
  assert.ok(sms.length <= 320);
  assert.match(sms, /\.\.\.\nCall back now\. Full report by email\.$/);
  assert.ok(renderSms(long, cfg(), 160).length <= 160);
});

test('helpers', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(safeUrl('https://recordings.example.com/a.wav'), 'https://recordings.example.com/a.wav');
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('https://x.example.com/"onmouseover'), '');
  assert.equal(toAscii('It’s “hot” — really…'), `It's "hot" - really...`);
});

test('per-call report renders without a transcript or recording', () => {
  const out = emergency();
  const r = renderCallReport({ ...out.call, turns: [], recordingUrl: '' }, cfg());
  assert.doesNotMatch(r.html, /Transcript|Listen to the recording/);
});
