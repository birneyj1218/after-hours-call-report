'use strict';
// A small stand-in for the n8n runtime, enough to execute n8n/after-hours-call-report.json
// in tests: Code nodes run their generated jsCode (with $, $input, $json, $env and
// $getWorkflowStaticData), IF nodes and "={{ }}" expressions are evaluated, and every HTTP
// Request goes to a handler the test supplies. It checks the wiring and the generated code;
// it does not replace importing the workflow into a real n8n.

const vm = require('node:vm');

function makeContext(outputs, input, env, staticData) {
  const $ = (name) => ({
    first: () => {
      if (!outputs[name]) throw new Error(`node "${name}" has not run`);
      return outputs[name][0];
    },
    get isExecuted() {
      return Boolean(outputs[name]);
    },
  });
  return {
    $,
    $input: { first: () => input, all: () => [input] },
    $json: input && input.json,
    $env: env,
    $getWorkflowStaticData: () => staticData,
  };
}

function evalExpr(value, ctx) {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const tpl = value.slice(1);
  const run = (expr) => vm.runInNewContext(`(${expr})`, { ...ctx });
  const whole = tpl.match(/^\{\{([\s\S]*)\}\}$/);
  if (whole && !whole[1].includes('}}')) return run(whole[1]);
  return tpl.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => String(run(e)));
}

// Values crossing the vm boundary are plain JSON in n8n too.
const plain = (v) => JSON.parse(JSON.stringify(v));

/**
 * Run the workflow from one trigger.
 *   start:      trigger node name
 *   payload:    webhook body (for the webhook trigger)
 *   env:        object used as $env
 *   staticData: object used as workflow static data (pass the same one across runs)
 *   http:       async (req) => ({ status, body }); req = { node, url, headers, body, credential }
 */
async function runWorkflow(wf, { start, payload, env = {}, staticData = {}, http }) {
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const startNode = byName[start];
  if (!startNode) throw new Error(`no trigger named ${start}`);
  const outputs = {};
  const requests = [];
  const ran = [start];
  outputs[start] = startNode.type.endsWith('.webhook') ? [{ json: { headers: {}, params: {}, query: {}, body: payload } }] : [{ json: { timestamp: new Date().toISOString() } }];
  const queue = [[start, 0]];

  while (queue.length) {
    const [from, idx] = queue.shift();
    const targets = ((wf.connections[from] || {}).main || [])[idx] || [];
    for (const t of targets) {
      const node = byName[t.node];
      if (!node) throw new Error(`connection to missing node ${t.node}`);
      const input = outputs[from][0];
      const ctx = makeContext(outputs, input, env, staticData);
      ran.push(node.name);

      if (node.type === 'n8n-nodes-base.code') {
        const items = vm.runInNewContext(`(() => {\n${node.parameters.jsCode}\n})()`, ctx);
        if (!Array.isArray(items) || !items.length) continue; // n8n: no items, branch stops
        outputs[node.name] = plain(items);
        queue.push([node.name, 0]);
      } else if (node.type === 'n8n-nodes-base.if') {
        const c = node.parameters.conditions.conditions[0];
        outputs[node.name] = [input];
        queue.push([node.name, evalExpr(c.leftValue, ctx) ? 0 : 1]);
      } else if (node.type === 'n8n-nodes-base.httpRequest') {
        const p = node.parameters;
        const headers = Object.fromEntries(((p.headerParameters || {}).parameters || []).map((h) => [h.name, evalExpr(h.value, ctx)]));
        const body = p.contentType === 'form-urlencoded' ? Object.fromEntries(p.bodyParameters.parameters.map((b) => [b.name, evalExpr(b.value, ctx)])) : JSON.parse(evalExpr(p.jsonBody, ctx));
        const req = { node: node.name, method: p.method, url: evalExpr(p.url, ctx), headers, body, credential: Object.values(node.credentials || {})[0] };
        requests.push(req);
        const res = await http(req);
        if (res.status >= 400) {
          if (node.onError !== 'continueRegularOutput') return { outputs, requests, ran, stoppedAt: node.name };
          outputs[node.name] = [{ json: { error: { message: `Request failed with status code ${res.status}` } } }];
        } else {
          outputs[node.name] = [{ json: plain(res.body || {}) }];
        }
        queue.push([node.name, 0]);
      } else {
        throw new Error(`simulator does not support ${node.type} (${node.name})`);
      }
    }
  }
  return { outputs, requests, ran, stoppedAt: null };
}

module.exports = { runWorkflow, evalExpr };
