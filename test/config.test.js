'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fromEnv, atLeast, DEFAULTS, ENV_MAP } = require('../src/config');

test('defaults are the fictional demo business', () => {
  const c = fromEnv({});
  assert.equal(c.businessName, 'Cavern Electrical');
  assert.equal(c.timezone, 'America/Chicago');
  assert.match(c.ownerEmail, /@example\.com$/);
});

test('env values are read and typed', () => {
  const c = fromEnv({ BUSINESS_NAME: ' Test Co ', LLM_ENABLED: 'false', FREEZING_TEMP_F: '35', SEND_EMPTY_DIGEST: 'no', LLM_BASE_URL: 'https://llm.example.com/v1/', NIGHT_CUTOVER_HOUR: 'abc' });
  assert.equal(c.businessName, 'Test Co');
  assert.equal(c.llmEnabled, false);
  assert.equal(c.freezingTempF, 35);
  assert.equal(c.sendEmptyDigest, false);
  assert.equal(c.llmBaseUrl, 'https://llm.example.com/v1');
  assert.equal(c.nightCutoverHour, DEFAULTS.nightCutoverHour);
});

test('empty env values keep the default; bad choices fall back safely', () => {
  assert.equal(fromEnv({ BUSINESS_NAME: '' }).businessName, 'Cavern Electrical');
  assert.equal(fromEnv({ SMS_ALERT_LEVEL: 'sometimes' }).smsAlertLevel, 'emergency');
  assert.equal(fromEnv({ EMAIL_EACH_CALL: 'x' }).emailEachCall, 'emergency');
});

test('an invalid time zone is an error, not a silent UTC', () => {
  assert.throws(() => fromEnv({ BUSINESS_TIMEZONE: 'Mars/Olympus' }), /not a valid IANA time zone/);
});

test('every env var maps to a known setting', () => {
  for (const key of Object.values(ENV_MAP)) assert.ok(key in DEFAULTS, key);
});

test('atLeast', () => {
  assert.equal(atLeast('emergency', 'urgent'), true);
  assert.equal(atLeast('routine', 'urgent'), false);
  assert.equal(atLeast('routine', 'all'), true);
  assert.equal(atLeast('emergency', 'none'), false);
});
