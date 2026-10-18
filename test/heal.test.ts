/**
 * Target healing — a real page whose element ids changed, driven through a real engine.
 *
 * The scenario every RPA workflow meets eventually: the page was updated and `#save-v2` is now
 * `#save-v3`. Healing is what turns that from "the bot broke" into "the bot noticed, continued, and
 * said what to fix". Skipped (not failed) when this host has no browser.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Engine } from '../src/engine/engine.js';
import { parseWorkflow } from '../src/workflow/model.js';
import { selectorHints } from '../src/engine/targeting.js';

const PAGE = `<!doctype html><html><body>
  <h1 id="heading">Orders</h1>
  <button id="save-v3" class="btn primary" aria-label="Save order">Save order</button>
  <script>
    document.getElementById('save-v3').addEventListener('click', () => {
      document.getElementById('heading').textContent = 'Saved';
    });
  </script>
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

async function runWorkflow(base: string, steps: unknown[], options: ConstructorParameters<typeof Engine>[0] = {}) {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-heal-'));
  const engine = new Engine({ headless: true, baseDir: runDir, variables: { base }, ...options });
  const workflow = parseWorkflow(JSON.stringify([{ type: 'web', action: 'goto', url: '${base}' }, ...steps]));
  return engine.run(workflow, {});
}

// ── the hint extractor is pure — no browser needed for these ─────────────────────────────────

test('selectorHints reads what a selector can be re-searched by', () => {
  assert.deepEqual(selectorHints({ strict: '#submit-v2' }), { classes: [], id: 'submit-v2' });
  assert.deepEqual(selectorHints({ strict: 'button.save.primary[name="go"]' }), {
    classes: ['save', 'primary'],
    tag: 'button',
    name: 'go'
  });
  assert.deepEqual(selectorHints({ text: 'Sign in' }), { classes: [], text: 'Sign in' });
  // A bare [type=text] matches the world; it is not evidence.
  assert.equal(selectorHints({ strict: '[type="text"]' }), null);
});

// ── engine-level healing, against the real browser ───────────────────────────────────────────

test('heal auto recovers a changed id and the run continues on the healed element', { skip }, async () => {
  await withServer(async (base) => {
    const result = await runWorkflow(base, [
      { type: 'web', action: 'click', target: { strict: '#save-v2', heal: 'auto' }, timeoutMs: 500 },
      { type: 'web', action: 'getText', target: { strict: '#heading' }, saveAs: 'heading' }
    ]);

    assert.equal(result.status, 'Passed', result.error);
    // The click landed on the healed button: the page reacted.
    assert.equal(result.vars['heading'], 'Saved');
    assert.equal(result.heals.length, 1);
    const heal = result.heals[0]!;
    assert.equal(heal.applied, true);
    assert.equal(heal.mode, 'auto');
    assert.equal(heal.method, 'resemblance');
    assert.deepEqual(heal.to, { strict: '#save-v3' });
    assert.ok(heal.score >= 0.75 && heal.score < 1, `score ${heal.score}`);
    assert.ok(result.logs.some((line) => line.message.includes('target healed')), 'the log says it healed');
  });
});

test('the default (recommend) fails the step but hands over the fix', { skip }, async () => {
  await withServer(async (base) => {
    const result = await runWorkflow(base, [
      { type: 'web', action: 'click', target: { strict: '#save-v2' }, timeoutMs: 500 }
    ]);

    assert.equal(result.status, 'Failed');
    assert.match(result.error ?? '', /target not found/);
    assert.match(result.error ?? '', /heal suggestion: \{"strict":"#save-v3"\}/);
    assert.equal(result.heals.length, 1);
    assert.equal(result.heals[0]!.applied, false);
    assert.ok(result.logs.some((line) => line.level === 'warn' && line.message.includes('heal suggestion')));
  });
});

test('heal off keeps the plain failure, and a step can override the engine default', { skip }, async () => {
  await withServer(async (base) => {
    const off = await runWorkflow(base, [
      { type: 'web', action: 'click', target: { strict: '#save-v2', heal: 'off' }, timeoutMs: 500 }
    ], { heal: 'auto' });
    assert.equal(off.status, 'Failed');
    assert.equal(off.heals.length, 0);
    assert.ok(!(off.error ?? '').includes('heal suggestion'));
  });
});

test('relaxed fuzzy heals a fuzzy target whose exact gate broke', { skip }, async () => {
  await withServer(async (base) => {
    const result = await runWorkflow(base, [
      {
        type: 'web',
        action: 'click',
        target: {
          fuzzy: {
            tag: 'BUTTON',
            attributes: { id: 'save-v2' },
            levels: { id: 'exact' },
            threshold: 0.99
          },
          heal: 'auto'
        }
      }
    ]);

    assert.equal(result.status, 'Passed', result.error);
    assert.equal(result.heals.length, 1);
    assert.equal(result.heals[0]!.method, 'relaxed-fuzzy');
    assert.ok(result.heals[0]!.score >= 0.75);
    assert.deepEqual(result.heals[0]!.to, { strict: '#save-v3' });
  });
});

test('healing waits for the last retry, then heals on it', { skip }, async () => {
  await withServer(async (base) => {
    const result = await runWorkflow(base, [
      { type: 'web', action: 'click', target: { strict: '#save-v2', heal: 'auto' }, retry: 1, retryDelayMs: 10, timeoutMs: 500 }
    ]);

    assert.equal(result.status, 'Passed', result.error);
    assert.ok(
      result.logs.some((line) => line.message.includes('heal skipped: 1 retry attempt(s) still ahead')),
      'the first attempt leaves healing to the retry'
    );
    assert.equal(result.heals.length, 1, 'exactly one heal, on the final attempt');
  });
});

test('healThreshold raises the bar: a candidate below it is not healed', { skip }, async () => {
  await withServer(async (base) => {
    const result = await runWorkflow(base, [
      { type: 'web', action: 'click', target: { strict: '#save-v2', heal: 'auto', healThreshold: 0.95 }, timeoutMs: 500 }
    ]);

    assert.equal(result.status, 'Failed');
    assert.equal(result.heals.length, 0);
    assert.ok(result.logs.some((line) => line.message.includes('no candidate reached the healing threshold')));
  });
});

test('engine --heal off is a kill switch, even when the target asks for auto', { skip }, async () => {
  await withServer(async (base) => {
    const result = await runWorkflow(base, [
      { type: 'web', action: 'click', target: { strict: '#save-v2', heal: 'auto' }, timeoutMs: 500 }
    ], { heal: 'off' });

    assert.equal(result.status, 'Failed');
    assert.equal(result.heals.length, 0);
    assert.ok(!(result.error ?? '').includes('heal suggestion'));
  });
});

test('engine --heal recommend previews what a target-auto step would have done', { skip }, async () => {
  await withServer(async (base) => {
    const result = await runWorkflow(base, [
      { type: 'web', action: 'click', target: { strict: '#save-v2', heal: 'auto' }, timeoutMs: 500 }
    ], { heal: 'recommend' });

    assert.equal(result.status, 'Failed');
    assert.equal(result.heals.length, 1);
    assert.equal(result.heals[0]!.mode, 'recommend');
    assert.equal(result.heals[0]!.applied, false);
    assert.match(result.error ?? '', /heal suggestion: \{"strict":"#save-v3"\}/);
  });
});

test('engine --heal auto turns healing on for a step that declares nothing', { skip }, async () => {
  await withServer(async (base) => {
    const result = await runWorkflow(base, [
      { type: 'web', action: 'click', target: { strict: '#save-v2' }, timeoutMs: 500 },
      { type: 'web', action: 'getText', target: { strict: '#heading' }, saveAs: 'heading' }
    ], { heal: 'auto' });

    assert.equal(result.status, 'Passed', result.error);
    assert.equal(result.vars['heading'], 'Saved');
    assert.equal(result.heals.length, 1);
    assert.equal(result.heals[0]!.applied, true);
  });
});

test('no similar element on the page means no heals — the failure stays honest', { skip }, async () => {
  await withServer(async (base) => {
    const result = await runWorkflow(base, [
      { type: 'web', action: 'click', target: { strict: '#totally-unrelated-zzz', heal: 'auto' }, timeoutMs: 500 }
    ]);

    assert.equal(result.status, 'Failed');
    assert.equal(result.heals.length, 0);
    assert.ok(!(result.error ?? '').includes('heal suggestion'));
    assert.ok(result.logs.some((line) => line.message.includes('no candidate reached the healing threshold')));
  });
});

test('checks never heal: elementExists answers false instead of recovering', { skip }, async () => {
  await withServer(async (base) => {
    const result = await runWorkflow(base, [
      { type: 'web', action: 'elementExists', target: { strict: '#save-v2' }, saveAs: 'present' }
    ], { heal: 'auto' });

    assert.equal(result.status, 'Passed');
    assert.equal(result.vars['present'], 'false');
    assert.equal(result.heals.length, 0);
  });
});
