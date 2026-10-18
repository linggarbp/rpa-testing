/**
 * The Studio (`rpa ui`): the HTTP surface a clone-and-run user gets, plus the page itself driven in a
 * real browser — load the workflow, click Run, watch the console fill up.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scaffoldTransactional } from '../src/templates.js';
import { startUi } from '../src/ui/server.js';

async function withUi<T>(run: (base: string, projectDir: string) => Promise<T>): Promise<T> {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-ui-'));
  await scaffoldTransactional(projectDir, 'UiBot');
  const ui = await startUi({ projectDir, port: 0, noOpen: true });
  try {
    return await run(ui.url, projectDir);
  } finally {
    await ui.close();
  }
}

test('the UI serves the page, the catalog and the project', async () => {
  await withUi(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /rpa·studio|rpa<span>·<\/span>studio|rpa/);
    assert.match(html, /palette/);

    const catalog = await (await fetch(`${base}/api/activities`)).json() as { catalog: Array<{ type: string; actions: string[] }> };
    const queue = catalog.catalog.find((group) => group.type === 'queue');
    assert.ok(queue?.actions.includes('addItem'), 'the palette knows the queue activities');

    const project = await (await fetch(`${base}/api/project`)).json() as { dir: string; workflows: Array<{ file: string; steps: number }> };
    assert.equal(project.dir, path.resolve((project as unknown as { dir: string }).dir));
    const files = project.workflows.map((entry) => entry.file);
    assert.ok(files.includes('Main.json'), files.join(', '));
    assert.ok(files.includes('Framework/Process.json'), files.join(', '));
  });
});

test('workflows load, save (validated) and reject garbage', async () => {
  await withUi(async (base, projectDir) => {
    const loaded = await (await fetch(`${base}/api/workflow?file=Main.json`)).json() as { workflow: { steps: unknown[] }; errors: string[] };
    assert.ok(loaded.workflow.steps.length > 0);
    assert.deepEqual(loaded.errors, []);

    const saved = await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'Data/SavedByUi.json', workflow: { name: 'saved', steps: [{ type: 'control', action: 'log', message: 'hi' }] } })
    });
    assert.equal(saved.status, 200);

    const invalid = await fetch(`${base}/api/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'Data/Broken.json', workflow: { steps: [{ type: 'control', action: 'nonsense' }] } })
    });
    assert.equal(invalid.status, 400);

    const outside = await fetch(`${base}/api/workflow?file=../../etc/passwd`);
    assert.equal(outside.status, 404, 'a path outside the project is refused');
  });
});

test('running a workflow streams its log lines and the outcome', async () => {
  await withUi(async (base) => {
    const response = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'Main.json' })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const text = await response.text();
    assert.match(text, /event: started/);
    // Quotes inside the SSE payload are JSON-escaped, so match on the parts that are plain text.
    assert.match(text, /Settings loaded — queue/);
    assert.match(text, /InvoiceQueue/);
    assert.match(text, /event: finished/);
    assert.match(text, /"status":"Passed"/);
  });
});

test('the queue tab reads and writes the local queue', async () => {
  await withUi(async (base) => {
    const added = await fetch(`${base}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'InvoiceQueue', reference: 'INV-UI', data: { amount: '9' } })
    });
    assert.equal(added.status, 200);

    const queue = await (await fetch(`${base}/api/queue?name=InvoiceQueue`)).json() as { counts: Record<string, number>; items: Array<{ reference: string }> };
    assert.equal(queue.counts.New, 1);
    assert.equal(queue.items[0]?.reference, 'INV-UI');
  });
});

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

test('the page loads the workflow canvas and runs it from the Run button', { skip: !available ? 'no chromium on this host' : false }, async () => {
  await withUi(async (base) => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded' });

      // The palette is built from the server's catalog, and the canvas from Main.json.
      await page.waitForSelector('.palette-item');
      assert.ok(await page.locator('.palette-group').count() >= 8, 'activity families are listed');
      await page.waitForSelector('#steps .step');
      const canvas = await page.locator('#steps .step').first().innerText();
      assert.match(canvas, /control\.setVar/, canvas);

      // Add an activity: it lands on the canvas as a new card.
      const before = await page.locator('#steps > .step').count();
      await page.locator('.palette-item', { hasText: 'log' }).first().click();
      assert.equal(await page.locator('#steps > .step').count(), before + 1);

      // Run it: the console fills from the SSE stream and the status pill turns green.
      await page.locator('#run').click();
      await page.waitForFunction(() => document.querySelector('#status')?.textContent !== 'running', null, { timeout: 60000 });
      const status = await page.locator('#status').innerText();
      assert.equal(status, 'passed', await page.locator('#console').innerText());
      assert.match(await page.locator('#console').innerText(), /Workflow completed\./);
    } finally {
      await browser.close();
    }
  });
});
