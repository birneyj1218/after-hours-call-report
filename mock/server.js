#!/usr/bin/env node
'use strict';
/**
 * Mock provider server for local demos and tests. It answers on the same paths as the
 * real services, so going live is only a base-URL change:
 *
 *   POST /v1/chat/completions                      OpenAI-compatible LLM (canned or heuristic JSON summary)
 *   POST /emails                                   email API ({ from, to, subject, html, text })
 *   POST /2010-04-01/Accounts/:sid/Messages.json   Twilio-style SMS (form-encoded)
 *   POST /crm/calls                                CRM / ticket webhook (dedups on external_id)
 *   GET  /_log    POST /_reset                     inspect or clear what was received
 *   POST /_fail   { "count": 1, "path": "/v1/chat/completions" }   make the next N requests fail with 500
 *
 * Nothing is sent anywhere; every request is recorded and printed.
 * Usage: node mock/server.js   (PORT, default 4010; HOST, default 127.0.0.1)
 */
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const CANNED = JSON.parse(readFileSync(path.join(__dirname, 'llm-replies.json'), 'utf8'));

/** Very rough stand-in for a model, used when there is no canned reply for the call id. */
function heuristicSummary(userContent) {
  const facts = (() => {
    try {
      return JSON.parse(userContent.split('\n')[1]);
    } catch {
      return {};
    }
  })();
  const transcript = (userContent.split('<<<')[1] || '').split('>>>')[0];
  const callerLines = transcript.split('\n').filter((l) => l.startsWith('Caller:')).map((l) => l.slice(7).trim());
  const name = (transcript.match(/(?:my name is|this is|name's)\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)/) || [])[1] || null;
  const phone = (transcript.match(/\b\d{3}[-. ]\d{3}[-. ]\d{4}\b/) || [])[0] || null;
  const address = (transcript.match(/\b\d{1,5} [A-Z][a-z]+(?: [A-Z][a-z]+)* (?:Street|St|Lane|Road|Drive|Court|Avenue|Ave|Way)\b/) || [])[0] || null;
  const problem = callerLines[0] || 'Caller did not describe the problem.';
  return {
    caller_name: name,
    callback_number: phone,
    service_address: address,
    problem,
    urgency: 'routine',
    urgency_reason: 'Mock model: no judgement made.',
    emergency_signals: [],
    preferred_callback: null,
    summary: `(Mock summary for ${facts.call_id || 'this call'}) ${problem}`,
  };
}

function createMockServer({ quiet = false } = {}) {
  const log = [];
  const crm = new Map();
  let fail = { count: 0, path: '' };
  let n = 0;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const type = req.headers['content-type'] || '';
      let body = {};
      try {
        body = !raw ? {} : type.includes('x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
      } catch {
        body = { raw };
      }
      const url = new URL(req.url, 'http://localhost');
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      if (url.pathname === '/_log') return send(200, log);
      if (url.pathname === '/_reset') {
        log.length = 0;
        crm.clear();
        fail = { count: 0, path: '' };
        return send(200, { ok: true });
      }
      if (url.pathname === '/_fail') {
        fail = { count: Number(body.count || 1), path: String(body.path || '') };
        return send(200, fail);
      }

      const entry = { at: new Date().toISOString(), method: req.method, path: url.pathname, body, auth: Boolean(req.headers.authorization) };
      if (fail.count > 0 && (!fail.path || fail.path === url.pathname)) {
        fail.count -= 1;
        log.push({ ...entry, kind: 'forced-failure' });
        if (!quiet) console.log(`[mock] ${req.method} ${url.pathname} -> 500 (forced)`);
        return send(500, { error: { message: 'mock forced failure' } });
      }
      n += 1;

      let kind;
      let status = 200;
      let reply;
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        kind = 'llm';
        const user = ((body.messages || []).find((m) => m.role === 'user') || {}).content || '';
        let callId = '';
        try {
          callId = JSON.parse(user.split('\n')[1]).call_id;
        } catch {
          /* no facts line */
        }
        const summary = CANNED[callId] || heuristicSummary(user);
        reply = { id: `chatcmpl-mock-${n}`, object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(summary) }, finish_reason: 'stop' }] };
      } else if (req.method === 'POST' && url.pathname === '/emails') {
        kind = 'email';
        reply = { id: `email-mock-${n}` };
      } else if (req.method === 'POST' && /^\/2010-04-01\/Accounts\/[^/]+\/Messages\.json$/.test(url.pathname)) {
        kind = 'sms';
        status = 201;
        reply = { sid: `SM_mock_${n}`, status: 'queued', to: body.To };
      } else if (req.method === 'POST' && url.pathname === '/crm/calls') {
        kind = 'crm';
        const existing = crm.get(body.external_id);
        reply = existing ? { id: existing, duplicate: true } : { id: `ticket-mock-${n}`, duplicate: false };
        if (!existing) crm.set(body.external_id, reply.id);
      } else {
        return send(404, { error: 'unknown mock route' });
      }
      log.push({ ...entry, kind, reply });
      if (!quiet) {
        const what = kind === 'sms' ? `to ${body.To}` : kind === 'email' ? `"${body.subject}"` : kind === 'crm' ? `${body.external_id}${reply.duplicate ? ' (duplicate)' : ''}` : body.model;
        console.log(`[mock] ${kind.padEnd(5)} ${what}`);
      }
      send(status, reply);
    });
  });
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 4010);
  const host = process.env.HOST || '127.0.0.1';
  createMockServer().listen(port, host, () => console.log(`mock providers on http://${host}:${port} (GET /_log to inspect)`));
}

module.exports = { createMockServer, heuristicSummary };
