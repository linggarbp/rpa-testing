/**
 * Selector-chain interop: parsing a recorded `<html …/><webctrl …/>` chain, entry-point arguments,
 * verify execution and the queue's status/exception fields.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
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

test('a strict selector chain becomes a CSS selector plus its window scope', () => {
  const spec = parseSelectorChain("<html app='chrome.exe' title='Rpa Challenge' url='https://rpachallenge.com/*' /><webctrl id='LaqF8' tag='INPUT' type='text' />");
  assert.ok(spec);
  assert.equal(spec?.strict, '#LaqF8');
  assert.equal(spec?.scope?.app, 'chrome.exe');
  assert.equal(spec?.scope?.url, 'https://rpachallenge.com/*');
});

test('a fuzzy selector chain keeps its attributes and maps fuzzylevel to a minimum similarity', () => {
  const spec = parseSelectorChain("<html app='chrome.exe' /><webctrl aaname='Sign in' class='btn primary' idx='2' matching:aaname='fuzzy' fuzzylevel:aaname='0.2' matching:class='exact' tag='BUTTON' />");
  assert.ok(spec?.fuzzy, JSON.stringify(spec));
  assert.equal(spec?.fuzzy?.tag, 'BUTTON');
  assert.equal(spec?.fuzzy?.attributes?.['aaname'], 'Sign in');
  assert.equal(spec?.fuzzy?.attributes?.['class'], 'btn primary');
  assert.equal(spec?.idx, 2);
  // fuzzylevel 0.2 → at least 0.8 similarity; exact stays a hard gate.
  assert.equal(spec?.fuzzy?.levels?.['aaname'], 0.8);
  assert.equal(spec?.fuzzy?.levels?.['class'], 'exact');
});

test('parseSelectorNodes reads quoted attributes, entities and both quote styles', () => {
  const nodes = parseSelectorNodes('<wnd cls=\'Notepad\' title="Untitled &amp; unsaved" /><ctrl name=\'Edit\' role=\'text\' />');
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0]?.attributes['title'], 'Untitled & unsaved');
  assert.equal(nodes[1]?.attributes['role'], 'text');
});

test('a selector chain in a step is parsed before targeting', () => {
  const spec = targetFromStep({ type: 'web', selector: "<html app='chrome.exe' /><webctrl id='submit' tag='BUTTON' />" });
  assert.equal(spec?.strict, '#submit');
  // Plain Playwright selectors are untouched.
  assert.deepEqual(targetFromStep({ type: 'web', selector: '#plain' }), { strict: '#plain' });
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
  const errors = validateWorkflow(wf([{ type: 'web', action: 'click', selector: '#a', verify: {} }]));
  assert.ok(errors.some((error) => error.includes('verify needs a target')), errors.join(' | '));
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

// ── The same things in a real browser ─────────────────────────────────────────────────────────

const PAGE = `<!doctype html><html><body>
  <h1 id="heading">Sign in</h1>
  <label for="u">Username</label><input id="u" name="username">
  <button id="submit" class="btn primary" aria-label="Sign in">Sign in</button>
  <script>document.getElementById('submit').addEventListener('click', () => {
    setTimeout(() => { document.getElementById('heading').textContent = 'Welcome back'; }, 100);
  });</script>
</body></html>`;

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    return await run(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function browserAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const available = await browserAvailable();

test('a selector chain drives a real page, and verify waits for the reaction', { skip: !available ? 'no chromium on this host' : false }, async () => {
  await withServer(async (base) => {
    const engine = new Engine({ headless: true, variables: { base } });
    const result = await engine.run(wf([
      { type: 'web', action: 'goto', url: '${base}/' },
      {
        type: 'web', action: 'click',
        selector: "<html app='chrome.exe' /><webctrl id='submit' tag='BUTTON' aaname='Sign in' />",
        verify: { selector: 'text=Welcome back', timeoutMs: 5000 }
      }
    ]));
    assert.equal(result.status, 'Passed', result.error);
    const messages = result.logs.map((line) => line.message).join(' | ');
    assert.match(messages, /verified after click/);
  });
});

test('native text targeting clicks by visible text', { skip: !available ? 'no chromium on this host' : false }, async () => {
  await withServer(async (base) => {
    const engine = new Engine({ headless: true, variables: { base } });
    const result = await engine.run(wf([
      { type: 'web', action: 'goto', url: '${base}/' },
      { type: 'web', action: 'click', target: { text: 'Sign in' } },
      { type: 'web', action: 'assertText', text: 'Welcome back' }
    ]));
    assert.equal(result.status, 'Passed', result.error);
  });
});
