'use strict';
// The structured summary the LLM must return, and a small validator for it.
// Anything that fails validation is discarded and the report falls back to a summary
// built from the call data, so a bad model answer can never break the owner's report.

const SUMMARY_FIELDS = {
  caller_name: { type: 'string', nullable: true, max: 120, description: "Caller's name as they said it, or null" },
  callback_number: { type: 'string', nullable: true, max: 40, description: 'Callback number the caller gave, digits as spoken, or null' },
  service_address: { type: 'string', nullable: true, max: 300, description: 'Address for the job, or null' },
  problem: { type: 'string', required: true, max: 500, description: 'The problem in one or two plain sentences' },
  urgency: { type: 'string', required: true, enum: ['emergency', 'urgent', 'routine'], description: 'emergency = danger to people or property now' },
  urgency_reason: { type: 'string', required: true, max: 300, description: 'Why, quoting what the caller said' },
  emergency_signals: { type: 'array', items: 'string', maxItems: 10, description: 'Short phrases from the call that suggest danger' },
  preferred_callback: { type: 'string', nullable: true, max: 120, description: 'When the caller asked to be called back, or null' },
  summary: { type: 'string', required: true, max: 800, description: 'Three sentences at most, facts only' },
};

/** JSON Schema version of SUMMARY_FIELDS, for providers that accept response_format json_schema. */
function jsonSchema() {
  const properties = {};
  for (const [k, f] of Object.entries(SUMMARY_FIELDS)) {
    const p = { description: f.description };
    if (f.type === 'array') Object.assign(p, { type: 'array', items: { type: f.items } });
    else Object.assign(p, { type: f.nullable ? ['string', 'null'] : 'string' });
    if (f.enum) p.enum = f.enum;
    properties[k] = p;
  }
  return { type: 'object', additionalProperties: false, required: Object.keys(SUMMARY_FIELDS), properties };
}

const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Validate and tidy a candidate summary object.
 * Returns { ok, errors: string[], value } where value has only known keys, trimmed strings
 * cut to their max length, and nulls for empty optional fields.
 */
function validateSummary(obj) {
  const errors = [];
  const value = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, errors: ['summary is not an object'], value: null };
  for (const [k, f] of Object.entries(SUMMARY_FIELDS)) {
    let v = obj[k];
    if (f.type === 'array') {
      if (v === undefined || v === null) v = [];
      if (!Array.isArray(v)) {
        errors.push(`${k} must be an array`);
        continue;
      }
      value[k] = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => collapse(x).slice(0, 120)).slice(0, f.maxItems);
      continue;
    }
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
      if (f.required) errors.push(`${k} is required`);
      else value[k] = null;
      continue;
    }
    if (typeof v !== 'string') {
      errors.push(`${k} must be a string`);
      continue;
    }
    v = collapse(v);
    if (f.enum) {
      v = v.toLowerCase();
      if (!f.enum.includes(v)) {
        errors.push(`${k} must be one of ${f.enum.join(', ')}`);
        continue;
      }
    }
    value[k] = f.max ? v.slice(0, f.max) : v;
  }
  return { ok: errors.length === 0, errors, value: errors.length ? null : value };
}

module.exports = { SUMMARY_FIELDS, jsonSchema, validateSummary };
