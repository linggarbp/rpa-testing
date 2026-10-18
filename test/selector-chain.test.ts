/**
 * Selector-chain interop: parsing a recorded `<wnd …/><ctrl …/>` chain into a desktop target,
 * entry-point arguments, verify and the queue's status/exception fields.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Engine } from '../src/engine/engine.js';
import { parseWorkflow, validateWorkflow } from '../src/workflow/model.js';
import { QueueStore } from '../src/engine/store.js';
import { targetFromStep } from '../src/engine/targeting.js';
import { parseSelectorChain, parseSelectorNodes } from '../src/workflow/selector-chain.js';

const wf = (steps: unknown[], extra: Record<string, unknown> = {}) =>
  parseWorkflow(JSON.stringify({ steps, ...extra }));

// ── Selector parsing ───────────────────────────────────────────────────────────────────────────

test('a recorded chain becomes the element properties, plus its window scope', () => {
  const spec = parseSelectorChain("<wnd app='notepad.exe' title='Untitled - Notepad' /><ctrl id='textBox1' name='Text editor' role='document' />");
  assert.ok(spec);
  assert.equal(spec?.uia?.automationId, 'textBox1');
  assert.equal(spec?.uia?.name, 'Text editor');
  assert.equal(spec?.uia?.controlType, 'Document');
  assert.equal(spec?.scope?.app, 'notepad.exe');
  assert.equal(spec?.scope?.title, 'Untitled - Notepad');
  // The chain rides along, so a report can show what was recorded.
  assert.match(String(spec?.selectorChain), /<ctrl id='textBox1'/);
});

test('a fuzzy chain keeps its properties and maps fuzzylevel to a minimum similarity', () => {
  const spec = parseSelectorChain("<wnd app='app.exe' /><ctrl aaname='Sign in' class='btn primary' idx='2' matching:aaname='fuzzy' fuzzylevel:aaname='0.2' matching:class='exact' tag='BUTTON' />");
  assert.ok(spec?.fuzzy, JSON.stringify(spec));
  assert.equal(spec?.fuzzy?.controlType, 'Button');
  assert.equal(spec?.fuzzy?.properties?.['name'], 'Sign in');
  assert.equal(spec?.fuzzy?.properties?.['className'], 'btn primary');
  assert.equal(spec?.idx, 2);
  // fuzzylevel 0.2 → at least 0.8 similarity; exact stays a hard gate.
  assert.equal(spec?.fuzzy?.levels?.['name'], 0.8);
  assert.equal(spec?.fuzzy?.levels?.['className'], 'exact');
});

test('parseSelectorNodes reads quoted attributes, entities and both quote styles', () => {
  const nodes = parseSelectorNodes('<wnd cls=\'Notepad\' title="Untitled &amp; unsaved" /><ctrl name=\'Edit\' role=\'text\' />');
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0]?.attributes['title'], 'Untitled & unsaved');
  assert.equal(nodes[1]?.attributes['role'], 'text');
});

test('a chain in a step is parsed before targeting, and a plain string names nothing', () => {
  const spec = targetFromStep({ type: 'desktop', selector: "<wnd app='app.exe' /><ctrl id='submit' tag='BUTTON' />" });
  assert.equal(spec?.uia?.automationId, 'submit');
  assert.equal(spec?.uia?.controlType, 'Button');
  // There is no browser selector engine in this toolkit: a plain string is not a desktop target.
  assert.equal(targetFromStep({ type: 'desktop', selector: '#plain' }), null);
});

// ── Arguments (entry points) ───────────────────────────────────────────────────────────────────

test('a required argument that is missing fails before step 1', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpa-args-'));
  const result = await new Engine({ baseDir: dir }).run(wf(
    [{ type: 'control', action: 'log', message: 'never runs' }],
    { arguments: { in_CustomerId: { required: true, type: 'string' } } }
  ));
  assert.equal(result.status, 'Failed');
  assert.match(result.error ?? '', /missing required argument\(s\): in_CustomerId/);
  assert.ok(!result.logs.some((line) => line.message === 'never runs'));
});

test('an argument passed in becomes a variable, and a default fills the gap', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpa-args-'));
  const result = await new Engine({ baseDir: dir, variables: { in_CustomerId: 'C-42' } }).run(wf(
    [{ type: 'control', action: 'log', message: 'customer=${in_CustomerId} mode=${in_Mode}' }],
    { arguments: { in_CustomerId: { required: true }, in_Mode: { default: 'fast' } } }
  ));
  assert.equal(result.status, 'Passed', result.error);
  assert.ok(result.logs.some((line) => line.message === 'customer=C-42 mode=fast'));
});

test('verify without a target is rejected at validation time', () => {
  const errors = validateWorkflow(wf([{ type: 'desktop', action: 'click', x: 1, y: 2, verify: {} }]));
  assert.ok(errors.some((error) => error.includes('verify needs a target')), errors.join(' | '));
});

test('an image action without an image is rejected at validation time', () => {
  const errors = validateWorkflow(wf([{ type: 'desktop', action: 'clickImage' }]));
  assert.ok(errors.some((error) => error.includes('needs an "imagePath"')), errors.join(' | '));
});

// ── Orchestrator-shaped queue fields ───────────────────────────────────────────────────────────

test('queue items carry SpecificContent and a ProcessingException like Orchestrator', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpa-queue-'));
  const result = await new Engine({ baseDir: dir }).run(wf([
    { type: 'queue', action: 'addItem', queue: 'Q', reference: 'INV-7', specificContent: { amount: '12.00' } },
    { type: 'queue', action: 'getTransactionItem', queue: 'Q' },
    { type: 'queue', action: 'setStatus', queue: 'Q', status: 'BusinessException', reason: 'rule 7', exceptionType: 'business' }
  ]));
  assert.equal(result.status, 'Passed', result.error);

  const item = (await new QueueStore(dir).items('Q'))[0];
  assert.deepEqual(item?.specificContent, { amount: '12.00' });
  assert.equal(item?.status, 'BusinessException');
  assert.deepEqual(item?.processingException, { type: 'business', reason: 'rule 7' });
});
