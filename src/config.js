'use strict';
// Settings for one business. Everything that differs between deployments comes from
// environment variables (n8n reads them through $env in the Config node; the demo and
// the mock tools read process.env). Secrets never go here: API keys live in n8n
// credentials, referenced by name.

const LEVELS = ['routine', 'urgent', 'emergency'];

const DEFAULTS = {
  businessName: 'Cavern Electrical',
  timezone: 'America/Chicago',
  ownerEmail: 'owner@example.com',
  reportFromEmail: 'after-hours@example.com',
  ownerSmsNumber: '+16125550100',
  // Which calls get an immediate text / email to the owner. Every call is in the morning digest.
  smsAlertLevel: 'emergency', // emergency | urgent | none
  emailEachCall: 'emergency', // all | urgent | emergency | none
  // A stated temperature at or below this (Fahrenheit) plus "no heat" counts as an emergency.
  freezingTempF: 40,
  // Calls that end before this local hour belong to the previous evening's night.
  nightCutoverHour: 12,
  sendEmptyDigest: true,
  llmEnabled: true,
  llmBaseUrl: 'http://localhost:4010/v1',
  llmModel: 'gpt-4o-mini',
  llmTimeoutMs: 20000,
  emailApiUrl: 'http://localhost:4010/emails',
  smsBaseUrl: 'http://localhost:4010',
  smsAccountSid: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  smsFromNumber: '+16125550199',
  crmWebhookUrl: 'http://localhost:4010/crm/calls',
  reportFootnote: '',
};

const ENV_MAP = {
  BUSINESS_NAME: 'businessName',
  BUSINESS_TIMEZONE: 'timezone',
  OWNER_EMAIL: 'ownerEmail',
  REPORT_FROM_EMAIL: 'reportFromEmail',
  OWNER_SMS_NUMBER: 'ownerSmsNumber',
  SMS_ALERT_LEVEL: 'smsAlertLevel',
  EMAIL_EACH_CALL: 'emailEachCall',
  FREEZING_TEMP_F: 'freezingTempF',
  NIGHT_CUTOVER_HOUR: 'nightCutoverHour',
  SEND_EMPTY_DIGEST: 'sendEmptyDigest',
  LLM_ENABLED: 'llmEnabled',
  LLM_BASE_URL: 'llmBaseUrl',
  LLM_MODEL: 'llmModel',
  LLM_TIMEOUT_MS: 'llmTimeoutMs',
  EMAIL_API_URL: 'emailApiUrl',
  SMS_BASE_URL: 'smsBaseUrl',
  SMS_ACCOUNT_SID: 'smsAccountSid',
  SMS_FROM_NUMBER: 'smsFromNumber',
  CRM_WEBHOOK_URL: 'crmWebhookUrl',
  REPORT_FOOTNOTE: 'reportFootnote',
};

function coerce(key, raw) {
  const def = DEFAULTS[key];
  if (typeof def === 'boolean') return !/^(0|false|no|off)$/i.test(String(raw).trim());
  if (typeof def === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  }
  return String(raw).trim();
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Build the config from an env-like object (process.env or n8n's $env). Unknown keys are ignored. */
function fromEnv(env = {}, overrides = {}) {
  const cfg = { ...DEFAULTS };
  for (const [envKey, key] of Object.entries(ENV_MAP)) {
    const v = env[envKey];
    if (v !== undefined && v !== null && String(v).trim() !== '') cfg[key] = coerce(key, v);
  }
  Object.assign(cfg, overrides);
  if (!validTimeZone(cfg.timezone)) throw new Error(`BUSINESS_TIMEZONE "${cfg.timezone}" is not a valid IANA time zone`);
  if (!LEVELS.includes(cfg.smsAlertLevel) && cfg.smsAlertLevel !== 'none') cfg.smsAlertLevel = 'emergency';
  if (!['all', 'none', ...LEVELS].includes(cfg.emailEachCall)) cfg.emailEachCall = 'emergency';
  cfg.llmBaseUrl = String(cfg.llmBaseUrl).replace(/\/+$/, '');
  cfg.smsBaseUrl = String(cfg.smsBaseUrl).replace(/\/+$/, '');
  return cfg;
}

/** True when `level` is at or above `threshold` ("all" matches everything, "none" nothing). */
function atLeast(level, threshold) {
  if (threshold === 'all') return true;
  if (threshold === 'none') return false;
  return LEVELS.indexOf(level) >= LEVELS.indexOf(threshold) && LEVELS.indexOf(threshold) >= 0;
}

module.exports = { DEFAULTS, ENV_MAP, LEVELS, fromEnv, atLeast };
