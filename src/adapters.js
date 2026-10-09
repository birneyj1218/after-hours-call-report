'use strict';
// HTTP adapters for running the flow without n8n (the demo uses them against the mock
// server). They mirror the HTTP Request nodes in the workflow: same URLs, same bodies.
// None of them throw on an HTTP or network error; they return { ok: false, error }.
// Requires Node 20+ (global fetch).

async function request(url, { method = 'POST', headers = {}, body, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const raw = await res.text();
    let data = raw;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      /* keep text */
    }
    return res.ok ? { ok: true, status: res.status, data } : { ok: false, status: res.status, error: `HTTP ${res.status}`, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

const json = (obj) => JSON.stringify(obj);
const bearer = (key) => (key ? { Authorization: `Bearer ${key}` } : {});

/** OpenAI-compatible chat completion. Returns the raw response body, or { error } on failure. */
async function callLlm(cfg, requestBody, apiKey) {
  const r = await request(`${cfg.llmBaseUrl}/chat/completions`, {
    headers: { 'Content-Type': 'application/json', ...bearer(apiKey) },
    body: json(requestBody),
    timeoutMs: cfg.llmTimeoutMs,
  });
  return r.ok ? r.data : { error: { message: r.error } };
}

/** Email API with a { from, to, subject, html, text } JSON body (Resend-style; most providers are close). */
function sendEmail(cfg, { to, subject, html, text }, apiKey) {
  return request(cfg.emailApiUrl, {
    headers: { 'Content-Type': 'application/json', ...bearer(apiKey) },
    body: json({ from: `${cfg.businessName} <${cfg.reportFromEmail}>`, to: [to], subject, html, text }),
  });
}

/** Twilio-style SMS (form-encoded, Basic auth with account SID and auth token). */
function sendSms(cfg, { to, body }, authToken) {
  const auth = Buffer.from(`${cfg.smsAccountSid}:${authToken || ''}`).toString('base64');
  return request(`${cfg.smsBaseUrl}/2010-04-01/Accounts/${encodeURIComponent(cfg.smsAccountSid)}/Messages.json`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` },
    body: new URLSearchParams({ To: to, From: cfg.smsFromNumber, Body: body }).toString(),
  });
}

/** Generic CRM / ticket webhook. external_id makes retries safe on the receiving side. */
function logToCrm(cfg, payload, apiKey) {
  return request(cfg.crmWebhookUrl, {
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': payload.external_id, ...bearer(apiKey) },
    body: json(payload),
  });
}

module.exports = { request, callLlm, sendEmail, sendSms, logToCrm };
