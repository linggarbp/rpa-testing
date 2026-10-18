/**
 * Unit layer — everything that does not need a browser: the targeting maths, the model/validator,
 * interpolation, control flow, and the per-step resilience that both the CLI and the robot rely on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Engine, interpolate } from '../src/engine.js';
import { parseWorkflow, validateWorkflow, normalizeAction, type FuzzySpec } from '../src/model.js';
import { centerDistance, relationHolds, scoreCandidate, similarity, targetFromStep } from '../src/targeting.js';

// ── Targeting maths ─────────────────────────────────────────────────────────────────────────────

test('similarity is case/space insensitive and rewards containment', () => {
  assert.equal(similarity('Sign In', 'sign in'), 1);
  assert.equal(similarity('Sign in', 'Sign in to continue'), 0.9, 'containment floors at 0.9');
  // A transposition costs two edits in Levenshtein terms, so "Sumbit" lands around 0.67 — still far
  // above an unrelated word, which is the property fuzzy targeting depends on.
  assert.ok(similarity('Submit', 'Sumbit') >= 0.6, String(similarity('Submit', 'Sumbit')));
  assert.ok(similarity('Submit', 'Cancel') < 0.4);
  assert.equal(similarity('', 'anything'), 0);
});

test('a fuzzy candidate is scored, and an exact attribute is a hard gate', () => {
  const spec: FuzzySpec = { tag: 'BUTTON', attributes: { aaname: 'Sign in' }, levels: { aaname: 'fuzzy' } };
  assert.ok(scoreCandidate({ attributes: { aaname: 'Sign in' }, text: '' }, spec) === 1);
  assert.ok(scoreCandidate({ attributes: { aaname: 'Sign in to continue' }, text: '' }, spec) >= 0.9);
  assert.ok(scoreCandidate({ attributes: { aaname: 'Cancel' }, text: '' }, spec) < 0.5);

  const exact: FuzzySpec = { tag: 'BUTTON', attributes: { id: 'submit' }, levels: { id: 'exact' } };
  assert.equal(scoreCandidate({ attributes: { id: 'submit' }, text: '' }, exact), 1);
  assert.equal(scoreCandidate({ attributes: { id: 'submit-2' }, text: '' }, exact), 0, 'exact mismatch zeroes the score');
});

test('anchor relations compare boxes the way a human reads a form', () => {
  const label = { x: 10, y: 100, width: 80, height: 20 };
  const right = { x: 120, y: 100, width: 200, height: 20 };
  const below = { x: 10, y: 140, width: 200, height: 20 };
  const far = { x: 900, y: 700, width: 10, height: 10 };

  assert.equal(relationHolds('right', right, label), true);
  assert.equal(relationHolds('left', right, label), false);
  assert.equal(relationHolds('below', below, label), true);
  assert.equal(relationHolds('near', right, label), true);
  assert.ok(centerDistance(right, label) < centerDistance(far, label));
});

test('targetFromStep speaks both shapes: structured target and Aro selector/selectors', () => {
  assert.deepEqual(targetFromStep({ type: 'web' }), null);
  assert.deepEqual(targetFromStep({ type: 'web', selector: '#a' }), { strict: '#a' });
  assert.deepEqual(
    targetFromStep({ type: 'web', selector: '#a', selectors: ['#b', ''] }),
    { strict: '#a', strictAny: ['#b'] }
  );
  const structured = { strict: 'button', idx: 2 };
  assert.equal(targetFromStep({ type: 'web', target: structured }), structured);
});

// ── Model ───────────────────────────────────────────────────────────────────────────────────────

test('a bare array parses as a workflow; an object keeps its variables', () => {
  assert.equal(parseWorkflow('[{"type":"control","action":"log","message":"hi"}]').steps.length, 1);
  const named = parseWorkflow('{"name":"demo","variables":{"a":1},"steps":[]}');
  assert.equal(named.name, 'demo');
  assert.deepEqual(named.variables, { a: 1 });
  assert.throws(() => parseWorkflow('{not json}'), /not valid JSON/);
});

test('validation names the offending step and refuses unknown actions and shapes', () => {
  const errors = validateWorkflow(parseWorkflow(JSON.stringify([
    { type: 'web', action: 'click' },                     // no target
    { type: 'control', action: 'if' },                    // no condition
    { type: 'control', action: 'foreach', steps: [] },    // no items
    { type: 'quantum', action: 'run' }                    // unknown type
  ])));
  assert.equal(errors.length, 4, errors.join(' | '));
  assert.ok(errors.some((e) => e.includes('needs a selector or a target')));
  assert.ok(errors.some((e) => e.includes('needs a condition')));
  assert.ok(errors.some((e) => e.includes('needs "items"')));
  assert.ok(errors.some((e) => e.includes('unsupported type')));
});

test('action aliases fold into the canonical name (Aro-compatible)', () => {
  assert.equal(normalizeAction('navigate', 'web'), 'goto');
  assert.equal(normalizeAction('fill', 'web'), 'type');
  assert.equal(normalizeAction(undefined, 'api'), 'request');
  assert.equal(normalizeAction('Click', 'web'), 'click');
});

test('interpolation replaces ${name} and {{name}}, and blanks an unknown one', () => {
  assert.equal(interpolate('hi ${who}!', { who: 'ARO' }), 'hi ARO!');
  assert.equal(interpolate('{{who}}?', { who: 'ARO' }), 'ARO?');
  assert.equal(interpolate('${missing}', {}), '');
});

// ── Engine: control flow, resilience, api ───────────────────────────────────────────────────────

const workflow = (steps: unknown[], variables?: Record<string, unknown>) => parseWorkflow(JSON.stringify({ steps, ...(variables ? { variables } : {}) }));

test('if / repeat / while / foreach all run their bodies', async () => {
  const result = await new Engine().run(workflow([
    { type: 'control', action: 'setVar', name: 'go', value: 'yes' },
    { type: 'control', action: 'if', condition: '${go} == yes', then: [{ type: 'control', action: 'log', message: 'then' }], else: [{ type: 'control', action: 'log', message: 'else' }] },
    { type: 'control', action: 'repeat', times: 2, steps: [{ type: 'control', action: 'log', message: 'tick' }] },
    { type: 'control', action: 'while', condition: '${go} == yes', maxIterations: 3, steps: [
      { type: 'control', action: 'log', message: 'loop' },
      { type: 'control', action: 'setVar', name: 'go', value: 'no' }
    ] },
    { type: 'control', action: 'foreach', items: '[1,2,3]', itemName: 'n', steps: [{ type: 'control', action: 'log', message: 'item ${n}' }] }
  ]));

  assert.equal(result.status, 'Passed', result.error);
  const messages = result.logs.map((l) => l.message);
  assert.ok(messages.includes('then'));
  assert.equal(messages.filter((m) => m === 'tick').length, 2);
  assert.equal(messages.filter((m) => m === 'loop').length, 1);
  assert.deepEqual(messages.filter((m) => m.startsWith('item ')), ['item 1', 'item 2', 'item 3']);
});

test('foreach over a variable holding JSON, and a bad collection fails loudly', async () => {
  const ok = await new Engine({ variables: { orders: '["a","b"]' } }).run(workflow([
    { type: 'control', action: 'foreach', items: 'orders', steps: [{ type: 'control', action: 'log', message: 'order ${item}' }] }
  ]));
  assert.equal(ok.status, 'Passed', ok.error);
  assert.ok(ok.logs.some((l) => l.message === 'order a'));

  const bad = await new Engine().run(workflow([{ type: 'control', action: 'foreach', items: 'not json' }]));
  assert.equal(bad.status, 'Failed');
  assert.match(bad.error ?? '', /needs a JSON array/);
});

test('retry gives a flaky step another chance and reports each attempt', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('boom', { status: calls < 3 ? 500 : 200 });
  }) as typeof fetch;

  const result = await new Engine().run(workflow([
    { type: 'api', action: 'request', url: 'https://example.test/x', assertStatus: 200, retry: 3, retryDelayMs: 1 }
  ]));
  assert.equal(result.status, 'Passed', result.error);
  assert.equal(calls, 3);
  assert.equal(result.logs.filter((l) => l.message.includes('retrying in 1ms')).length, 2);
});

test('continueOnError logs the failure and keeps going; without it the run fails', async () => {
  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;

  const tolerated = await new Engine().run(workflow([
    { type: 'api', action: 'request', url: 'https://example.test/x', assertStatus: 200, continueOnError: true },
    { type: 'control', action: 'log', message: 'still here' }
  ]));
  assert.equal(tolerated.status, 'Passed');
  assert.ok(tolerated.logs.some((l) => l.message.includes('continueOnError is set')));
  assert.ok(tolerated.logs.some((l) => l.message === 'still here'));

  const strict = await new Engine().run(workflow([
    { type: 'api', action: 'request', url: 'https://example.test/x', assertStatus: 200 }
  ]));
  assert.equal(strict.status, 'Failed');
  assert.match(strict.error ?? '', /returned 500, expected 200/);
});

test('an unknown step type or action fails instead of being skipped', async () => {
  const unknown = await new Engine().run(workflow([{ type: 'control', action: 'selfDestruct' }]));
  assert.equal(unknown.status, 'Failed');
  assert.match(unknown.error ?? '', /Unknown control action: selfDestruct/);
});

test('a cancelled run stops at the step boundary', async () => {
  let lines = 0;
  const result = await new Engine({ onLog: () => { lines++; } }).run(
    workflow([
      { type: 'control', action: 'log', message: 'one' },
      { type: 'control', action: 'log', message: 'two' }
    ]),
    // The cancel check runs before step 2; by then three lines are out (start, step 1, "one").
    { isCancelled: async () => lines >= 3 }
  );
  assert.equal(result.status, 'Failed');
  assert.match(result.error ?? '', /cancelled/);
  assert.ok(!result.logs.some((line) => line.message === 'two'), 'step 2 must not have run');
});
