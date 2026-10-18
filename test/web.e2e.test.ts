/**
 * Browser layer — the real thing: chromium, a real page, a real workflow. Skipped (not failed) when
 * this host has no browser, so the suite stays honest on a machine without one.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Engine } from '../src/engine.js';
import { parseWorkflow } from '../src/model.js';

const PAGE = `<!doctype html><html><body>
  <h1 id="heading">Sign in</h1>
  <label for="u">Username</label><input id="u" name="username">
  <label for="p">Password</label><input id="p" type="password">
  <button id="submit" class="btn primary" aria-label="Sign in to continue">Sign in</button>
  <ul id="items"><li>alpha</li><li>beta</li></ul>
  <div id="late"></div>
  <script>
    document.getElementById('submit').addEventListener('click', () => {
      document.getElementById('heading').textContent = 'Welcome back';
    });
    // A control that only exists after a moment — the case retry/waitForElement is for.
    setTimeout(() => {
      const late = document.getElementById('late');
      late.innerHTML = '<button id="lateBtn">Continue</button>';
    }, 600);
  </script>
</body></html>`;

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server: Server = createServer((request, response) => {
    if (request.url === '/slow') {
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(PAGE);
      }, 600);
      return;
    }
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

test('a web workflow drives a real page: strict, fuzzy, fallback, reads and retry', { skip: !available ? 'no chromium on this host' : false }, async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-e2e-'));

  await withServer(async (base) => {
    const engine = new Engine({ headless: true, runDir, variables: { base } });
    const result = await engine.run(parseWorkflow(JSON.stringify({
      name: 'e2e',
      steps: [
        // strict target, straight CSS
        { type: 'web', action: 'goto', url: '${base}/' },
        { type: 'web', action: 'type', target: { strict: '#u' }, text: 'ada' },
        { type: 'web', action: 'type', target: { strict: '#p' }, text: 'hunter2' },
        // fuzzy targeting: the id may change, the accessible name may not
        { type: 'web', action: 'click', target: { fuzzy: { tag: 'BUTTON', attributes: { aaname: 'Sign in' }, threshold: 0.8 } } },
        { type: 'web', action: 'assertText', text: 'Welcome back' },
        // Aro-shaped targeting: a broken primary selector with a working fallback
        { type: 'web', action: 'click', selector: '#nope-renamed', selectors: ['#submit'] },
        // reads
        { type: 'web', action: 'getText', target: { strict: '#heading' }, saveAs: 'heading' },
        { type: 'web', action: 'getAttribute', target: { strict: '#submit' }, attribute: 'class', saveAs: 'cls' },
        { type: 'web', action: 'elementExists', selector: '#nothing-here', saveAs: 'ghost' },
        { type: 'web', action: 'elementExists', selector: '#items' },
        // an element that appears late: first attempt fails, the retry wins
        { type: 'web', action: 'click', selector: '#lateBtn', retry: 3, retryDelayMs: 300 },
        // screenshot evidence
        { type: 'web', action: 'screenshot' },
        // collection read through a step, then looped
        { type: 'web', action: 'getText', target: { strict: '#items' }, saveAs: 'list' },
        { type: 'control', action: 'foreach', items: '["x","y"]', steps: [{ type: 'control', action: 'log', message: 'loop ${item}' }] }
      ]
    })));

    assert.equal(result.status, 'Passed', result.error);
    assert.equal(result.vars.heading, 'Welcome back', 'the fuzzy click ran the page handler');
    assert.match(String(result.vars.cls), /primary/);
    assert.equal(result.vars.ghost, 'false');
    assert.ok(result.logs.some((l) => l.message.includes('fuzzy selector')), 'the log says which method matched');
    assert.ok(result.logs.some((l) => l.message === 'loop y'));
    // The late button: a strict candidate waits for its element, so the click lands even though the
    // button only exists ~600 ms after load. (Retry is proven in test/unit.test.ts.)
    assert.ok(result.logs.some((l) => l.message.includes('#lateBtn')), 'the late element was targeted');
  });
});

test('an anchor disambiguates two identical inputs', { skip: !available ? 'no chromium on this host' : false }, async () => {
  await withServer(async (base) => {
    const engine = new Engine({ headless: true, variables: { base } });
    const result = await engine.run(parseWorkflow(JSON.stringify({
      steps: [
        { type: 'web', action: 'goto', url: '${base}/' },
        // Both #u and #p are inputs; the anchor says "the one to the right of the Username label".
        {
          type: 'web', action: 'type',
          target: {
            strict: 'input',
            anchor: { target: { strict: 'label[for="u"]' }, relation: 'right' },
            idx: 1
          },
          text: 'anchored'
        },
        { type: 'web', action: 'getAttribute', target: { strict: '#u' }, attribute: 'value', saveAs: 'uvalue' }
      ]
    })));
    assert.equal(result.status, 'Passed', result.error);
    assert.equal(result.vars.uvalue, 'anchored');
  });
});

test('a missing target fails the step and names what was tried', { skip: !available ? 'no chromium on this host' : false }, async () => {
  await withServer(async (base) => {
    const engine = new Engine({ headless: true, variables: { base } });
    const result = await engine.run(parseWorkflow(JSON.stringify({
      steps: [
        { type: 'web', action: 'goto', url: '${base}/' },
        { type: 'web', action: 'click', selector: '#does-not-exist', timeoutMs: 1500 }
      ]
    })));
    assert.equal(result.status, 'Failed');
    assert.match(result.error ?? '', /target not found/);
  });
});

test('screenshots land in the run folder', { skip: !available ? 'no chromium on this host' : false }, async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-shot-'));
  await withServer(async (base) => {
    const engine = new Engine({ headless: true, runDir, variables: { base } });
    const result = await engine.run(parseWorkflow(JSON.stringify({
      steps: [
        { type: 'web', action: 'goto', url: '${base}/' },
        { type: 'web', action: 'screenshot', path: path.join(runDir, 'shot.png') }
      ]
    })));
    assert.equal(result.status, 'Passed', result.error);
    assert.ok(existsSync(path.join(runDir, 'shot.png')), 'the screenshot exists on disk');
  });
});
