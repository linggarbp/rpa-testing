/**
 * The Studio (`rpa ui`): the HTTP surface a clone-and-run user gets, plus the page itself driven in a
 * real browser — load the workflow, click Run, watch the console fill up.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { askHuman } from '../src/services/gaps.js';
import { pickTarget } from '../src/ui/pick.js';
import { scaffoldTransactional } from '../src/project/templates.js';
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

      // The Human tab: nothing waiting, and it says so instead of showing an empty box.
      await page.locator('.tabs button', { hasText: 'Human' }).click();
      await page.waitForSelector('#tab-human:not(.hidden) #hitl-list');
      assert.match(await page.locator('#hitl-list').innerText(), /nothing waiting/);

      // The queue panel: add an item from the form, then close it from the row's own control.
      await page.locator('.tabs button', { hasText: 'Queue' }).click();
      await page.fill('#queue-name', 'InvoiceQueue');
      await page.fill('#queue-ref', 'INV-FROM-UI');
      await page.locator('#queue-add').click();
      await page.waitForSelector('#queue-table tbody tr');
      assert.match(await page.locator('#queue-counts').innerText(), /New: 1/);
      await page.locator('#queue-table tbody tr').first().locator('select[data-status]').selectOption('Successful');
      await page.locator('#queue-table tbody tr').first().locator('[data-set]').click();
      await page.waitForFunction(() => /Successful: 1/.test(document.querySelector('#queue-counts')?.textContent ?? ''));

      // Pick element: with no URL in the workflow it says what it needs instead of opening nothing.
      await page.locator('.tabs button', { hasText: 'Properties' }).click();
      await page.locator('#pick').click();
      await page.waitForFunction(() => /give a URL/.test(document.querySelector('#props-hint')?.textContent ?? ''));
    } finally {
      await browser.close();
    }
  });
});

test('the Human tab lists a pending hitl.ask and answers it', async () => {
  await withUi(async (base, projectDir) => {
    // A workflow that is waiting on a human: askHuman writes the request and blocks on the answer.
    const waiting = askHuman({ projectDir, prompt: 'Approve INV-UI?', choices: ['yes', 'no'], timeoutMs: 15000, pollMs: 50 });

    let pending: { requests: Array<{ id: string; prompt: string; choices?: string[] }> } = { requests: [] };
    for (let attempt = 0; attempt < 40 && pending.requests.length === 0; attempt++) {
      pending = await (await fetch(`${base}/api/hitl`)).json() as typeof pending;
      if (pending.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(pending.requests.length, 1, 'the panel sees the waiting question');
    assert.equal(pending.requests[0]?.prompt, 'Approve INV-UI?');
    assert.deepEqual(pending.requests[0]?.choices, ['yes', 'no']);

    const answered = await fetch(`${base}/api/hitl/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: pending.requests[0]?.id, value: 'yes' })
    });
    assert.equal(answered.status, 200);

    // The run that was waiting really got the answer — not just a 200 from the endpoint.
    const result = await waiting;
    assert.equal(result.asked, true);
    assert.equal(result.answer, 'yes');

    const after = await (await fetch(`${base}/api/hitl`)).json() as { requests: unknown[] };
    assert.equal(after.requests.length, 0, 'answered requests are no longer pending');

    const missing = await fetch(`${base}/api/hitl/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'x' }) });
    assert.equal(missing.status, 400);
  });
});

test('the queue panel sets an item status from the UI', async () => {
  await withUi(async (base) => {
    await fetch(`${base}/api/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'InvoiceQueue', reference: 'INV-STATUS', data: { amount: '3' } })
    });
    const before = await (await fetch(`${base}/api/queue?name=InvoiceQueue`)).json() as { items: Array<{ id: string; status: string }> };
    const id = before.items[0]?.id ?? '';
    assert.equal(before.items[0]?.status, 'New');

    const set = await fetch(`${base}/api/queue/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'InvoiceQueue', id, status: 'BusinessException', reason: 'rule 7' })
    });
    assert.equal(set.status, 200);

    const after = await (await fetch(`${base}/api/queue?name=InvoiceQueue`)).json() as { counts: Record<string, number>; items: Array<{ status: string; reason?: string; processingException?: { type: string } }> };
    assert.equal(after.counts.BusinessException, 1);
    assert.equal(after.items[0]?.reason, 'rule 7');
    assert.equal(after.items[0]?.processingException?.type, 'business');

    // A status the queue does not know is refused with the list of what it accepts.
    const refused = await fetch(`${base}/api/queue/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'InvoiceQueue', id, status: 'Teleported' })
    });
    assert.ok(refused.status >= 400);
    assert.match(String(((await refused.json()) as { error?: string }).error ?? ''), /expected one of/);
  });
});

test('the pick code path turns a real click into a target, and the endpoint reports an idle picker', { skip: !available ? 'no chromium on this host' : false }, async () => {
  await withUi(async (base) => {
    // `rpa pick` and the Studio button share this: a real chromium, the injected script, one click.
    const step = await pickTarget(base, {
      headless: true,
      timeoutMs: 15000,
      onPage: async (page) => { await page.click('#save'); } // a scripted clicker instead of a human
    });
    assert.equal(step?.type, 'web');
    assert.equal(step?.action, 'click');
    assert.equal(step?.target.strict, '#save');
    assert.deepEqual((step?.target.fuzzy as { tag: string; attributes: Record<string, string> }).attributes.id, 'save');
    assert.equal((step?.target.fuzzy as { tag: string }).tag, 'BUTTON', 'fuzzy targeting comes from the same click');

    // The endpoint validates its input, and a pick nobody answers times out instead of hanging.
    const missing = await fetch(`${base}/api/pick`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(missing.status, 400);

    const idle = await fetch(`${base}/api/pick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: base, headless: true, timeoutMs: 1000 })
    });
    assert.equal(idle.status, 408);
    assert.match(String(((await idle.json()) as { error?: string }).error ?? ''), /nothing was picked/);
  });
});
