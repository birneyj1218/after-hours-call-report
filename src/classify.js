'use strict';
// Emergency classifier. Rules run first and always; the LLM and the voice agent's own
// urgency field can only raise the level, never lower it. If the LLM is down or returns
// junk, the rules result stands on its own.
//
// Rules look only at what the caller said (plus the problem the agent wrote down), so an
// assistant question like "Do you smell gas?" does not trigger anything by itself. A
// simple negation check skips matches like "no smoke" or "I don't smell gas".

const LEVELS = ['routine', 'urgent', 'emergency'];
const rank = (level) => Math.max(0, LEVELS.indexOf(level));

// Each rule: id, level, label shown to the owner, patterns (matched on lowercased text).
const RULES = [
  {
    id: 'gas_smell',
    level: 'emergency',
    label: 'Gas smell',
    patterns: [/\bsmell(?:s|ing|ed)? (?:of |like )?(?:natural )?gas\b/, /\bgas (?:smell|leak|odou?r)\b/, /\brotten eggs?\b/],
  },
  {
    id: 'burning_or_smoke',
    level: 'emergency',
    label: 'Burning smell, smoke or fire',
    patterns: [
      /\bburning smell\b/,
      /\bsmell(?:s|ing|ed)? (?:like )?(?:something |plastic |wires? )?burning\b/,
      /\bsmoke\b(?! (?:detectors?|alarms?))/,
      /\bsmoking\b/,
      /\bfire\b(?! (?:alarms?|place|pit|wood))/,
      /\bflames?\b/,
      /\bscorch(?:ed|ing|marks?)?\b/,
      /\bmelt(?:ed|ing)\b/,
    ],
  },
  {
    id: 'sparking',
    level: 'emergency',
    label: 'Sparking or arcing',
    patterns: [/\bspark(?:s|ing|ed)?\b/, /\barc(?:s|ing|ed)\b/],
  },
  {
    id: 'shock',
    level: 'emergency',
    label: 'Someone got a shock',
    patterns: [/\b(?:got|get|getting|been|was) (?:a )?(?:shock|shocked|zapped)\b/, /\belectrocut/],
  },
  {
    id: 'water_electrical',
    level: 'emergency',
    label: 'Flooding or water near electrical',
    patterns: [
      /\bflood(?:ing|ed|s)?\b/,
      /\bwater (?:is )?(?:in|on|near|around|into|coming into|dripping (?:in|on|into)) (?:the |my |our )?(?:electrical )?(?:panel|breaker box|breakers|outlets?|fuse box|wiring|meter|light fixtures?)\b/,
    ],
  },
  {
    id: 'downed_line',
    level: 'emergency',
    label: 'Power line down',
    patterns: [/\b(?:power |electric(?:al)? |service )?lines? (?:is |are )?(?:down|on the ground)\b/, /\bwires? (?:is |are )?(?:down|on the ground|hanging)\b/, /\bdowned (?:power )?lines?\b/],
  },
  {
    id: 'hot_equipment',
    level: 'emergency',
    label: 'Outlet, panel or breaker hot to the touch',
    patterns: [/\b(?:outlet|panel|breaker|switch|plug|cord|meter|receptacle)s? (?:is |are |feels? |getting |got )?(?:really |very |super )?hot\b/, /\bhot to the touch\b/],
  },
  {
    id: 'no_power',
    level: 'urgent',
    label: 'Power out',
    patterns: [/\bno power\b/, /\bpower(?: is| went| has gone)? (?:out|off|down)\b/, /\blost (?:all )?power\b/, /\bno electricity\b/, /\b(?:half|part|most) of (?:the|my|our) (?:house|home|place)\b/],
  },
  {
    id: 'breaker_tripping',
    level: 'urgent',
    label: 'Breaker keeps tripping',
    patterns: [/\bkeeps? (?:tripping|popping|blowing)\b/, /\bwon't (?:stay on|reset)\b/],
  },
  {
    id: 'no_heat',
    level: 'urgent',
    label: 'No heat',
    patterns: [/\bno heat\b/, /\bheat(?:er|ing)? (?:isn't|is not|stopped|quit|won't|doesn't|went out|is out)\b/, /\bfurnace (?:is out|stopped|quit|won't|isn't|went out)\b/],
  },
  {
    id: 'asked_for_tonight',
    level: 'urgent',
    label: 'Caller asked for help tonight',
    patterns: [/\btonight\b/, /\bright (?:now|away)\b/, /\basap\b/, /\bas soon as possible\b/, /\bemergency\b/],
  },
];

const FREEZING_WORDS = [/\bfreezing\b/, /\bbelow (?:zero|freezing)\b/, /\bpipes? (?:are |might |could |will )?(?:freez|froze)/, /\bsub-?zero\b/];
const VULNERABLE_WORDS = [/\belderly\b/, /\bbab(?:y|ies)\b/, /\binfant\b/, /\bnewborn\b/, /\boxygen\b/, /\bmedical (?:equipment|device)\b/, /\bdialysis\b/, /\bc-?pap\b/, /\bventilator\b/, /\bwheelchair\b/, /\bhospice\b/];
const MEDICAL_POWER_WORDS = [/\boxygen\b/, /\bmedical (?:equipment|device)\b/, /\bdialysis\b/, /\bc-?pap\b/, /\bventilator\b/, /\binsulin\b/];

const NEGATION = /\b(?:no|not|never|without|nothing|none|don't|dont|doesn't|doesnt|didn't|didnt|isn't|isnt|aren't|wasn't|haven't|hasn't|cannot|can't)\b/;

/** True if the match at `index` is preceded, within the same clause and 4 words, by a negation. */
function negated(text, index) {
  const before = text.slice(0, index);
  const clause = before.split(/[.,;!?]|\bbut\b|\band\b/).pop();
  const words = clause.trim().split(/\s+/).filter(Boolean).slice(-4).join(' ');
  return NEGATION.test(words);
}

function findPositive(text, patterns) {
  for (const re of patterns) {
    const g = new RegExp(re.source, 'g');
    let m;
    while ((m = g.exec(text))) {
      if (!negated(text, m.index)) return m[0];
      if (m[0].length === 0) g.lastIndex += 1;
    }
  }
  return '';
}

/** Lowest temperature the caller mentioned ("it's 8 degrees", "-5°"), or null. */
function statedTemperature(text) {
  const temps = [...text.matchAll(/(-?\d{1,3})\s*(?:degrees?|°)/g)].map((m) => Number(m[1]));
  return temps.length ? Math.min(...temps) : null;
}

/** Text the rules look at: the caller's turns (all turns if roles are unknown) plus the noted problem. */
function callerText(record) {
  const turns = record.turns || [];
  const own = record.rolesKnown ? turns.filter((t) => t.speaker === 'caller') : turns;
  return [...own.map((t) => t.text), (record.fields || {}).problem || ''].join('. ').toLowerCase().replace(/[’‘]/g, "'");
}

/**
 * Rules-only classification. Returns { level, reasons: [{ id, label, evidence }], source: 'rules' }.
 */
function classifyByRules(record, { freezingTempF = 40 } = {}) {
  const text = callerText(record);
  const reasons = [];
  const hits = {};
  for (const rule of RULES) {
    const evidence = findPositive(text, rule.patterns);
    if (evidence) {
      hits[rule.id] = evidence;
      reasons.push({ id: rule.id, level: rule.level, label: rule.label, evidence });
    }
  }

  // Combination rules: no heat in freezing weather or with someone vulnerable at home;
  // no power with medical equipment that needs it.
  if (hits.no_heat) {
    const temp = statedTemperature(text);
    const freezing = findPositive(text, FREEZING_WORDS) || (temp !== null && temp <= freezingTempF ? `${temp} degrees` : '');
    const vulnerable = findPositive(text, VULNERABLE_WORDS);
    if (freezing || vulnerable) {
      reasons.push({
        id: 'no_heat_freezing',
        level: 'emergency',
        label: freezing ? 'No heat in freezing weather' : 'No heat with a vulnerable person at home',
        evidence: [hits.no_heat, freezing || vulnerable].join(' + '),
      });
    }
  }
  if (hits.no_power) {
    const medical = findPositive(text, MEDICAL_POWER_WORDS);
    if (medical) {
      reasons.push({ id: 'no_power_medical', level: 'emergency', label: 'No power with medical equipment at home', evidence: `${hits.no_power} + ${medical}` });
    }
  }

  reasons.sort((a, b) => rank(b.level) - rank(a.level));
  const level = reasons.reduce((lvl, r) => (rank(r.level) > rank(lvl) ? r.level : lvl), 'routine');
  return { level, reasons, source: 'rules' };
}

/**
 * Combine the rules result with optional opinions from the voice agent's structured data
 * and from the LLM summary. Highest level wins; the rules result is never lowered.
 */
function combine(rules, { agentUrgency = '', llm = null } = {}) {
  let level = rules.level;
  const reasons = [...rules.reasons];
  const sources = ['rules'];
  const agent = String(agentUrgency || '').toLowerCase();
  if (LEVELS.includes(agent)) {
    sources.push('voice agent');
    if (rank(agent) > rank(level)) {
      level = agent;
      reasons.unshift({ id: 'voice_agent', level: agent, label: 'The voice agent marked this call ' + agent, evidence: '' });
    }
  }
  if (llm && LEVELS.includes(llm.urgency)) {
    sources.push('AI summary');
    if (rank(llm.urgency) > rank(level)) {
      level = llm.urgency;
      reasons.unshift({ id: 'llm', level: llm.urgency, label: llm.urgency_reason || 'The AI summary marked this call ' + llm.urgency, evidence: (llm.emergency_signals || []).join(', ') });
    }
  }
  return { level, reasons, sources };
}

/** One line for the owner: "Burning smell, smoke or fire ("smell something burning")". */
function reasonLine(classification) {
  const top = classification.reasons.filter((r) => r.level === classification.level);
  if (!top.length) return 'No emergency signs in what the caller said.';
  return top
    .slice(0, 3)
    .map((r) => (r.evidence ? `${r.label} ("${r.evidence}")` : r.label))
    .join('; ');
}

module.exports = { LEVELS, RULES, classifyByRules, combine, reasonLine, negated, statedTemperature, rank };
