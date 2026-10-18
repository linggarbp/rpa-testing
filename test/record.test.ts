/**
 * The recorder — the event→step rules as pure unit cases, then one honest end-to-end: drive a real
 * chromium page with Playwright, record the session, and run the emitted draft in a fresh engine
 * against a fresh browser to prove the recording reproduces the interaction. Skipped (not failed)
 * when this host has no browser.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Engine } from '../src/engine.js';
import { parseWorkflow } from '../src/model.js';
import { eventsToSteps, startRecording, targetForElement, type RecordedElement, type RecordedEvent } from '../src/recorder.js';

const PAGE = `<!doctype html><html><body>
  <h1 id="heading">Signup</h1>
  <label for="u">User</label><input id="u" name="user" placeholder="your name">
  <select id="sel" name="plan"><option value="a">Alpha</option><option value="b">Beta</option></select>
  <button id="save" aria-label="Save the form"
    onclick="document.getElementById('out').textContent = 'u=' + document.getElementById('u').value + ';sel=' + document.getElementById('sel').value;">Save</button>
  <div id="out"></div>
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
const skip = available ? false : 'no chromium on this host';

function element(overrides: Partial<RecordedElement> = {}): RecordedElement {
  return {
    tag: 'BUTTON',
    id: '',
    name: '',
    type: '',
    placeholder: '',
    ariaLabel: '',
    text: '',
    classes: [],
    cssPath: 'div > button',
    uniqueId: false,
    uniqueName: false,
    ...overrides
  };
}

// ── pure rules ────────────────────────────────────────────────────────────────────────────────

test('targets prefer the strongest unique form, and always carry the fuzzy fallback', () => {
  const unique = targetForElement(element({ id: 'save', uniqueId: true, text: 'Save', ariaLabel: 'Save the form' }));
  assert.equal(unique.strict, '[id="save"]');
  assert.deepEqual(unique.fuzzy?.attributes, { id: 'save', aaname: 'Save the form' });
  assert.deepEqual(unique.fuzzy?.levels, { id: 'exact', aaname: 'fuzzy' });
  assert.equal(unique.text, 'Save');

  const byName = targetForElement(element({ tag: 'INPUT', name: 'user', uniqueName: true }));
  assert.equal(byName.strict, 'input[name="user"]');

  const positional = targetForElement(element({ uniqueName: false }));
  assert.equal(positional.strict, undefined);
  assert.deepEqual(positional.strictAny, ['div > button']);

  // Long text is not a useful text= hint.
  assert.equal(targetForElement(element({ text: 'x'.repeat(80), uniqueId: true, id: 'a' })).text, undefined);
});

test('typing merges per field, double-clicks collapse, navigation dedupes', () => {
  const input = (ts: number, value: string) =>
    ({ kind: 'input', ts, url: 'http://x/', value, element: element({ tag: 'INPUT', id: 'u', uniqueId: true }) }) as RecordedEvent;
  const click = (ts: number) =>
    ({ kind: 'click', ts, url: 'http://x/', element: element({ id: 'save', uniqueId: true }) }) as RecordedEvent;
  const goto = (ts: number, url: string) => ({ kind: 'goto', ts, url }) as RecordedEvent;

  const { steps, dropped } = eventsToSteps([
    goto(1, 'http://x/'),
    goto(2, 'http://x/'), // same page again: one step
    input(3, 'a'),
    input(4, 'ad'),
    input(5, 'ada'),
    click(6),
    click(6), // 0 ms later, same target: the second half of a double-click
    click(700),
    goto(701, 'http://x/next')
  ]);

  assert.deepEqual(steps.map((entry) => entry.step.action), ['goto', 'type', 'click', 'click', 'goto']);
  // one type step, holding the latest value, in its first position
  assert.equal(steps[1]?.step.text, 'ada');
  assert.deepEqual(steps[4]?.step.url, 'http://x/next');
  assert.equal(dropped.length, 1);
  assert.match(dropped[0]!, /double-click/);
});

// ── end to end, with a real browser ───────────────────────────────────────────────────────────

test('a recorded session runs back and produces the same page state', { skip }, async () => {
  const { chromium } = await import('playwright');
  await withServer(async (base) => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const recorder = await startRecording(page);
      await page.goto(base);
      await page.fill('#u', 'ada');
      await page.selectOption('#sel', { label: 'Beta' });
      await page.click('#save');
      await page.click('#__rpa_recorder_stop__'); // the overlay's Stop button ends the recording
      const recorded = await recorder.stop();

      assert.deepEqual(
        recorded.steps.map((entry) => entry.step.action),
        ['goto', 'type', 'selectOption', 'click'],
        JSON.stringify(recorded.steps.map((entry) => entry.description))
      );
      assert.equal(recorded.steps[0]?.step.url, `${base}/`); // the browser normalises the URL
      assert.equal(recorded.steps[1]?.step.text, 'ada');
      assert.equal((recorded.steps[1]?.step.target as { strict?: string }).strict, '[id="u"]', 'a unique id gives every action kind the strong target');
      assert.equal(recorded.steps[2]?.step.label, 'Beta');
      assert.equal((recorded.steps[2]?.step.target as { strict?: string }).strict, '[id="sel"]');
      assert.equal(recorded.steps[3]?.step.target && (recorded.steps[3]!.step.target as { strict?: string }).strict, '[id="save"]');
      assert.deepEqual(recorded.dropped, []);
      assert.ok(!recorded.steps.some((entry) => JSON.stringify(entry.step).includes('__rpa_recorder')), 'the overlay never leaks into steps');
    } finally {
      await browser.close();
    }

    // The draft must stand on its own: fresh engine, fresh browser, same page.
    const runDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-record-'));
    const engine = new Engine({ headless: true, baseDir: runDir });
    const workflow = parseWorkflow(JSON.stringify({
      steps: [
        { type: 'web', action: 'goto', url: base },
        { type: 'web', action: 'type', target: { strict: '[id="u"]' }, text: 'ada' },
        { type: 'web', action: 'selectOption', target: { strict: '[id="sel"]' }, label: 'Beta' },
        { type: 'web', action: 'click', target: { strict: '[id="save"]' } },
        { type: 'web', action: 'getText', target: { strict: '#out' }, saveAs: 'out' }
      ]
    }));
    const result = await engine.run(workflow, {});
    assert.equal(result.status, 'Passed', result.error);
    assert.equal(result.vars['out'], 'u=ada;sel=b');
  });
});

test('ignoreSelectors keeps chosen elements out of the recording', { skip }, async () => {
  const { chromium } = await import('playwright');
  await withServer(async (base) => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const recorder = await startRecording(page, { ignoreSelectors: ['#save'] });
      await page.goto(base);
      await page.waitForLoadState('domcontentloaded');
      await page.click('#save');
      await page.click('#__rpa_recorder_stop__');
      const recorded = await recorder.stop();
      assert.deepEqual(recorded.steps.map((entry) => entry.step.action), ['goto'], 'the ignored click produced no step');
    } finally {
      await browser.close();
    }
  });
});
