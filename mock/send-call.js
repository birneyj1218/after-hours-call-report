#!/usr/bin/env node
'use strict';
/**
 * Fake voice provider: POSTs sample end-of-call webhooks to your n8n workflow, the way
 * Vapi would when a call ends.
 *
 *   node mock/send-call.js <webhook-url> [file.json ...]
 *
 * With no files it sends everything in examples/calls/. The header named by
 * VOICE_WEBHOOK_HEADER (default X-Vapi-Secret) carries VOICE_WEBHOOK_SECRET, matching the
 * Header Auth credential on the n8n webhook node.
 */
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

async function main() {
  const [url, ...files] = process.argv.slice(2);
  if (!url) {
    console.error('usage: node mock/send-call.js <webhook-url> [file.json ...]');
    process.exit(2);
  }
  const dir = path.join(__dirname, '..', 'examples', 'calls');
  const list = files.length ? files : readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f));
  const header = process.env.VOICE_WEBHOOK_HEADER || 'X-Vapi-Secret';
  const secret = process.env.VOICE_WEBHOOK_SECRET || '';
  for (const file of list) {
    const body = readFileSync(file, 'utf8');
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { [header]: secret } : {}) }, body });
    console.log(`${res.status} ${path.basename(file)}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
