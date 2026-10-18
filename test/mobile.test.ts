/**
 * `mobile.*` — the raw WebDriver client against a mock endpoint that answers exactly the W3C
 * shapes Appium 2 does: new session, element find, click/clear/value, text, displayed, window
 * rect, actions, screenshot, delete session. That verifies our half of the protocol for real;
 * a physical device run needs a device + Appium server, which this host does not have.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Engine } from '../src/engine.js';
import { parseWorkflow, validateWorkflow } from '../src/model.js';
import { normalizeCapabilities } from '../src/webdriver.js';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

let webdriverioInstalled = true;
try {
  await import('webdriverio');
} catch {
  webdriverioInstalled = false;
}

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

interface Harness {
  base: string;
  calls: Recorded[];
  finds: number;
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : (JSON.parse(text) as unknown);
}

async function withMockDriver<T>(run: (harness: Harness) => Promise<T>): Promise<T> {
  const calls: Recorded[] = [];
  let finds = 0;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const payload = await body(request);
      calls.push({ method: request.method ?? '', path: request.url ?? '', body: payload });
      const send = (status: number, value: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ value }));
      };
      const route = request.url ?? '';
      if (request.method === 'GET' && route === '/status') return send(200, { ready: true, message: 'ok' });
      if (request.method === 'POST' && route === '/session') return send(200, { sessionId: 'sess-1', capabilities: { platformName: 'Android' } });
      if (request.method === 'GET' && route === '/session/sess-1') return send(200, { sessionId: 'sess-1', capabilities: { platformName: 'Android' } });
      if (request.method === 'DELETE' && route.startsWith('/session/')) return send(200, null);
      if (request.method === 'POST' && /\/session\/[^/]+\/(timeouts|url)$/.test(route)) return send(200, null);
      if (request.method === 'POST' && /\/element$/.test(route)) {
        const { value } = payload as { value: string };
        if (value === 'ghost') return send(404, { error: 'no such element', message: 'An element could not be located' });
        if (value === 'delayed') finds++;
        if (value === 'delayed' && finds < 3) return send(404, { error: 'no such element', message: 'An element could not be located' });
        return send(200, { [ELEMENT_KEY]: 'el-1' });
      }
      if (/\/element\/[^/]+\/displayed$/.test(route)) return send(200, true);
      if (/\/element\/[^/]+\/text$/.test(route)) return send(200, 'Ada Lovelace');
      if (/\/element\/[^/]+\/(click|clear|value)$/.test(route)) return send(200, null);
      if (route.endsWith('/window/rect')) return send(200, { width: 400, height: 800, x: 0, y: 0 });
      if (request.method === 'POST' && route.endsWith('/actions')) return send(200, null);
      if (route.endsWith('/screenshot')) return send(200, Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'));
      send(404, { error: 'unknown command', message: `mock: unhandled ${request.method} ${route}` });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    return await run({ base, calls, get finds(): number { return finds; } });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function engineRun(steps: unknown[]): Promise<Awaited<ReturnType<Engine['run']>>> {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-mobile-'));
  const engine = new Engine({ baseDir: runDir });
  return engine.run(parseWorkflow(JSON.stringify(steps)), {});
}

test('capabilities are shaped the way Appium 2 demands', () => {
  assert.deepEqual(
    normalizeCapabilities({
      platformName: 'Android',
      deviceName: 'emulator-5554',
      app: '/apps/demo.apk',
      'appium:automationName': 'UiAutomator2',
      browserName: 'chrome',
      'vendor.x:thing': 1
    }),
    {
      platformName: 'Android',
      'appium:deviceName': 'emulator-5554',
      'appium:app': '/apps/demo.apk',
      'appium:automationName': 'UiAutomator2',
      browserName: 'chrome',
      'vendor.x:thing': 1
    }
  );
});

test('a full mobile flow speaks W3C to the endpoint and the session closes with the run', async () => {
  await withMockDriver(async ({ base, calls }) => {
    const result = await engineRun([
      { type: 'mobile', action: 'session', server: base, capabilities: { platformName: 'Android', deviceName: 'emulator-5554', app: '/apps/demo.apk' }, saveAs: 'sessionId' },
      { type: 'mobile', action: 'tap', using: 'accessibility id', value: 'login' },
      { type: 'mobile', action: 'type', using: 'accessibility id', value: 'user', text: 'ada' },
      { type: 'mobile', action: 'getText', using: 'accessibility id', value: 'greeting', saveAs: 'greeting' },
      { type: 'mobile', action: 'swipe', direction: 'left', distance: 200, durationMs: 300 }
    ]);

    assert.equal(result.status, 'Passed', result.error);
    assert.equal(result.vars['sessionId'], 'sess-1');
    assert.equal(result.vars['greeting'], 'Ada Lovelace');

    const session = calls.find((call) => call.path === '/session' && call.method === 'POST');
    assert.deepEqual((session?.body as { capabilities: { alwaysMatch: unknown } }).capabilities.alwaysMatch, {
      platformName: 'Android',
      'appium:deviceName': 'emulator-5554',
      'appium:app': '/apps/demo.apk'
    });

    const value = calls.find((call) => call.path.endsWith('/value'));
    assert.deepEqual(value?.body, { text: 'ada', value: ['a', 'd', 'a'] });

    const actions = calls.find((call) => call.path.endsWith('/actions'));
    const pointer = (actions?.body as { actions: Array<{ parameters: { pointerType: string }; actions: Array<{ type: string; x?: number; y?: number; duration?: number; button?: number }> }> }).actions[0]!;
    assert.equal(pointer.parameters.pointerType, 'touch');
    const moves = pointer.actions.filter((action) => action.type === 'pointerMove');
    assert.equal(moves.length, 2, 'one pointerMove to the start point, one to the end point');
    const down = pointer.actions.find((action) => action.type === 'pointerDown')!;
    assert.equal(down.button, 0);
    assert.ok((moves[1]?.x ?? 0) < (moves[0]?.x ?? 0), 'a left swipe ends left of where it started');
    assert.equal(moves[1]?.duration, 300);

    // the run's finally closed the session, even though the workflow did not call mobile.end
    assert.ok(calls.some((call) => call.method === 'DELETE' && call.path === '/session/sess-1'));
  });
});

test('waitFor retries until the element shows up', async () => {
  await withMockDriver(async (harness) => {
    const result = await engineRun([
      { type: 'mobile', action: 'session', server: harness.base, capabilities: { platformName: 'Android' } },
      { type: 'mobile', action: 'waitFor', using: 'id', value: 'delayed', timeoutMs: 5000 }
    ]);
    assert.equal(result.status, 'Passed', result.error);
    assert.ok(harness.finds >= 3, `the mock refused twice before answering (${harness.finds} finds)`);
    assert.ok(result.logs.some((line) => line.message.includes('mobile.waitFor id=delayed → ok')));
  });
});

test('a failed step still closes the session, and the error names the protocol', async () => {
  await withMockDriver(async ({ base, calls }) => {
    const result = await engineRun([
      { type: 'mobile', action: 'session', server: base, capabilities: { platformName: 'Android' } },
      { type: 'mobile', action: 'getText', using: 'id', value: 'ghost', saveAs: 'ghost' }
    ]);
    assert.equal(result.status, 'Failed');
    assert.match(result.error ?? '', /404/);
    assert.match(result.error ?? '', /An element could not be located/);
    assert.ok(calls.some((call) => call.method === 'DELETE' && call.path === '/session/sess-1'), 'session closed on failure');
  });
});

test('steps without a session, and shapes without their fields, are refused early', async () => {
  const noSession = await engineRun([{ type: 'mobile', action: 'tap', using: 'id', value: 'x' }]);
  assert.equal(noSession.status, 'Failed');
  assert.match(noSession.error ?? '', /no session is open/);

  const errors = validateWorkflow(parseWorkflow(JSON.stringify([
    { type: 'mobile', action: 'session' },
    { type: 'mobile', action: 'tap', using: 'id' },
    { type: 'mobile', action: 'swipe', direction: 'sideways' }
  ])));
  assert.equal(errors.length, 3, errors.join('\n'));
});

test('the webdriverio driver speaks the same protocol (the optional-dependency path)', { skip: webdriverioInstalled ? false : 'webdriverio not installed' }, async () => {
  await withMockDriver(async ({ base, calls }) => {
    const result = await engineRun([
      { type: 'mobile', action: 'session', driver: 'webdriverio', server: base, capabilities: { platformName: 'Android', deviceName: 'emulator-5554', app: '/apps/demo.apk' }, saveAs: 'sessionId' },
      { type: 'mobile', action: 'tap', using: 'accessibility id', value: 'login' },
      { type: 'mobile', action: 'type', using: 'accessibility id', value: 'user', text: 'ada' },
      { type: 'mobile', action: 'getText', using: 'accessibility id', value: 'greeting', saveAs: 'greeting' },
      { type: 'mobile', action: 'end' }
    ]);

    assert.equal(result.status, 'Passed', result.error);
    assert.equal(result.vars['sessionId'], 'sess-1');
    assert.equal(result.vars['greeting'], 'Ada Lovelace');
    assert.ok(calls.some((call) => call.method === 'POST' && call.path === '/session'), 'wdio created the session over the same W3C endpoint');
    assert.ok(calls.some((call) => call.path.endsWith('/value')), 'wdio sent the text through the element value command');
    assert.ok(calls.some((call) => call.path.endsWith('/text')), 'wdio read the text through the element text command');
    assert.ok(calls.some((call) => call.method === 'DELETE' && call.path === '/session/sess-1'), 'wdio closed the session');
    assert.ok(result.logs.some((line) => line.message.includes('via webdriverio')));
  });
});

test('a screenshot step writes the bytes the endpoint sent', async () => {
  await withMockDriver(async ({ base }) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'rpa-mobile-shot-'));
    const engine = new Engine({ baseDir: dir });
    const result = await engine.run(parseWorkflow(JSON.stringify([
      { type: 'mobile', action: 'session', server: base, capabilities: { platformName: 'Android' } },
      { type: 'mobile', action: 'screenshot', path: 'shot.png' }
    ])), {});
    assert.equal(result.status, 'Passed', result.error);
    assert.deepEqual([...await readFile(path.join(dir, 'shot.png'))], [...Buffer.from('89504e470d0a1a0a', 'hex')]);
  });
});
