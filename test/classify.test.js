'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyByRules, combine, reasonLine, negated, statedTemperature } = require('../src/classify');
const { record } = require('./helpers');

const level = (...lines) => classifyByRules(record(lines)).level;
const ids = (...lines) => classifyByRules(record(lines)).reasons.map((r) => r.id);

test('emergency signals', () => {
  assert.equal(level('I smell gas in the basement'), 'emergency');
  assert.equal(level('There is a rotten egg smell by the furnace'), 'emergency');
  assert.equal(level("It smells like something burning behind the outlet"), 'emergency');
  assert.equal(level('The outlet was sparking when I plugged in the vacuum'), 'emergency');
  assert.equal(level('My son got shocked touching the light switch'), 'emergency');
  assert.equal(level('Water is dripping into the panel from the ceiling'), 'emergency');
  assert.equal(level('The basement is flooding'), 'emergency');
  assert.equal(level('A power line is down in my yard'), 'emergency');
  assert.equal(level('The breaker panel is really hot'), 'emergency');
});

test('urgent but not dangerous', () => {
  assert.equal(level('We lost power in half of the house'), 'urgent');
  assert.equal(level('The breaker keeps tripping'), 'urgent');
  assert.equal(level('Can someone come tonight?'), 'urgent');
  assert.equal(level('Our heat stopped working'), 'urgent');
});

test('routine', () => {
  assert.equal(level('I want a quote for an EV charger'), 'routine');
  assert.equal(level('Two outlets in the kitchen stopped working, Monday is fine'), 'routine');
});

test('negations are not counted', () => {
  assert.equal(level('No sparks, no burning smell, nothing like that'), 'routine');
  assert.equal(level("I don't smell gas or anything"), 'routine');
  assert.equal(level("There's no smoke"), 'routine');
  assert.equal(level("It doesn't need to be tonight"), 'routine');
  // a negation in an earlier clause does not cancel a later signal
  assert.equal(level("No, it's sparking right now"), 'emergency');
  assert.equal(level('No smoke but I can see sparks'), 'emergency');
});

test('smoke detectors and fire alarms alone are not fires', () => {
  assert.equal(level('My smoke detector keeps chirping'), 'routine');
  assert.equal(level('The fire alarm panel shows a trouble light'), 'routine');
});

test('only the caller counts when roles are known', () => {
  const r = record(['Yes I am still here']);
  r.turns.unshift({ speaker: 'assistant', text: 'Do you smell gas or see any sparks?' });
  assert.equal(classifyByRules(r).level, 'routine');
  // with unknown roles every line counts (better to over-alert)
  assert.equal(classifyByRules({ ...r, rolesKnown: false }).level, 'emergency');
});

test('the problem written down by the voice agent is checked too', () => {
  const r = record(['Yes']);
  r.fields.problem = 'Caller reports burning smell at the panel';
  assert.equal(classifyByRules(r).level, 'emergency');
});

test('no heat becomes an emergency in freezing weather or with someone vulnerable', () => {
  assert.equal(level('No heat and it is 6 degrees outside'), 'emergency');
  assert.equal(level('Heat stopped, the pipes might freeze'), 'emergency');
  assert.equal(level('The furnace stopped and we have a newborn'), 'emergency');
  assert.equal(level('No heat, but it is 55 degrees out'), 'urgent');
  assert.ok(ids('No heat and it is freezing').includes('no_heat_freezing'));
  assert.equal(classifyByRules(record(['No heat, it is 45 degrees in here'])).level, 'urgent');
  assert.equal(classifyByRules(record(['No heat, it is 45 degrees in here']), { freezingTempF: 50 }).level, 'emergency');
});

test('no power with medical equipment is an emergency', () => {
  assert.equal(level('We lost power and my dad is on oxygen'), 'emergency');
  assert.equal(level('Power is out, I need my CPAP tonight'), 'emergency');
});

test('combine: highest level wins and rules are never lowered', () => {
  const rules = classifyByRules(record(['I smell gas']));
  assert.equal(combine(rules, { llm: { urgency: 'routine' }, agentUrgency: 'routine' }).level, 'emergency');
  const routine = classifyByRules(record(['Quote for a ceiling fan']));
  const c = combine(routine, { llm: { urgency: 'urgent', urgency_reason: 'Caller sounded worried', emergency_signals: [] } });
  assert.equal(c.level, 'urgent');
  assert.deepEqual(c.sources, ['rules', 'AI summary']);
  assert.equal(combine(routine, { agentUrgency: 'Emergency' }).level, 'emergency');
  assert.equal(combine(routine, { agentUrgency: 'whenever' }).level, 'routine');
  assert.equal(combine(routine, { llm: null }).level, 'routine');
});

test('reason line quotes the evidence', () => {
  assert.match(reasonLine(classifyByRules(record(['I smell gas']))), /Gas smell \("smell gas"\)/);
  assert.equal(reasonLine(classifyByRules(record(['hello']))), 'No emergency signs in what the caller said.');
});

test('helpers', () => {
  assert.equal(negated('there is no smoke', 12), true);
  assert.equal(negated('no. there is smoke', 13), false);
  assert.equal(statedTemperature('it is -5 degrees and 40° inside'), -5);
  assert.equal(statedTemperature('no numbers'), null);
});
