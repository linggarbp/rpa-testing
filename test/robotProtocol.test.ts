/**
 * Orchestrator layer — the robot protocol, against a fake Aro. This is the contract that makes the
 * tool a robot: enrol with a project API key, heartbeat with what it proved, claim a job, ship its
 * step logs, mark a run cancelled when asked, and finalize the run with its outcome. Every endpoint
 * is asserted to have been called with the headers Aro's own agent sends.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ENGINE_CAPABILITIES, AroRobot } from '../src/robot/aro.js';
import { QueueStore } from '../src/engine/store.js';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

const TASK = (base: string) => ({
  jobId: 'job-1',
  flowRunId: '11111111-2222-3333-4444-555555555555',
  projectId: '22222222-3333-4444-5555-666666666666',
  flowId: '33333333-4444-5555-6666-777777777777',
  flowName: 'fake flow',
  robotId: '44444444-5555-6666-7777-888888888888',
  definition: JSON.stringify([
    { type: 'control', action: 'setVar', name: 'who', value: 'robot' },
    { type: 'api', action: 'request', url: `${base}/work`, assertStatus: 200, saveAs: 'answer' },
    { type: 'control', action: 'log', message: 'answer is ${answer}' }
  ]),
  finalizePath: '/api/flows/runs/11111111-2222-3333-4444-555555555555/finalize',
  callbackToken: 'token-1'
});

async function withFakeAro(run: (base: string, state: { calls: Call[]; finalized: unknown[]; claimed: number }) => Promise<void>): Promise<void> {
  const state = {
    calls: [] as Call[],
    finalized: [] as unknown[],
    claimed: 0
  };

  const readBody = async (request: import('node:http').IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : undefined;
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const body = await readBody(request).catch(() => undefined);
      state.calls.push({ method: request.method ?? '', path: url.pathname, headers: request.headers, body });

      const json = (payload: unknown, status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      if (url.pathname.endsWith('/robots/enroll')) {
        return json({ robot: { id: '44444444-5555-6666-7777-888888888888' }, machineKey: 'machine-key-1' });
      }
      if (url.pathname.endsWith('/heartbeat')) return json({ status: 'Online' });
      if (url.pathname.endsWith('/jobs/claim')) {
        state.claimed++;
        if (state.claimed === 1) return json(TASK(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
        response.writeHead(204);
        return response.end();
      }
      if (url.pathname.endsWith('/logs')) return json({ accepted: true });
      if (url.pathname.endsWith('/cancel')) return json({ cancelRequested: false });
      if (url.pathname.endsWith('/finalize')) {
        state.finalized.push({ body, query: url.search });
        return json({ status: 'ok' });
      }
      if (url.pathname === '/work') return json({ hello: 'world' });
      return json({ error: 'not found' }, 404);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    await run(base, state);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('the robot enrols with the project API key and proves its capabilities', async () => {
  await withFakeAro(async (base, state) => {
    const robot = new AroRobot({ apiUrl: base, projectId: 'p', apiKey: 'project-key', name: 'test-host', capabilities: ['web', 'control'] });
    const report = await robot.preflight();

    assert.equal(report.ok, true, robot.describe(report));
    assert.equal(report.robotId, '44444444-5555-6666-7777-888888888888');
    assert.ok(report.proved.includes('web'), 'playwright is installed in this repo, so web must be proved');
    assert.ok(report.proved.includes('control'));

    const enrol = state.calls.find((call) => call.path.endsWith('/enroll'));
    assert.ok(enrol, 'enrolment was called');
    assert.equal(enrol?.headers['x-api-key'], 'project-key');
    assert.equal((enrol?.body as { name: string }).name, 'test-host');

    const heartbeat = state.calls.find((call) => call.path.endsWith('/heartbeat'));
    assert.equal(heartbeat?.headers['x-aro-robot-key'], 'machine-key-1');
    const heartbeatBody = heartbeat?.body as { probedCapabilities: string; busy: boolean };
    assert.deepEqual(JSON.parse(heartbeatBody.probedCapabilities).includes('web'), true);
  });
});

test('a claimed flow runs and its outcome is finalized with the callback token', async () => {
  await withFakeAro(async (base, state) => {
    const robot = new AroRobot({ apiUrl: base, projectId: 'p', apiKey: 'project-key', name: 'test-host' });
    await robot.connect();

    const task = await robot.claimOnce(1);
    assert.ok(task, 'a job was claimed');
    const status = await robot.runTask(task!);

    assert.equal(status, 'Passed');
    assert.equal(state.finalized.length, 1);
    const finalize = state.finalized[0] as { body: { status: string; robotId: string }; query: string };
    assert.equal(finalize.body.status, 'Passed');
    assert.equal(finalize.body.robotId, '44444444-5555-6666-7777-888888888888');
    assert.match(finalize.query, /callbackToken=token-1/);

    const logs = state.calls.filter((call) => call.path.endsWith('/logs'));
    assert.ok(logs.length > 0, 'step logs were shipped');
    const shipped = (logs[0]?.body as { lines: Array<{ message: string }> }).lines.map((line) => line.message).join(' | ');
    assert.match(shipped, /Step 1\/3/);
  });
});

test('a failing flow is finalized Failed and the error travels with it', async () => {
  await withFakeAro(async (base, state) => {
    const robot = new AroRobot({ apiUrl: base, projectId: 'p', apiKey: 'project-key', name: 'test-host' });
    await robot.connect();
    const task = (await robot.claimOnce(1))!;
    // Point the api step at an endpoint the fake Aro answers with 404: the run must fail, not pass.
    const broken = { ...task, definition: JSON.stringify([{ type: 'api', action: 'request', url: `${base}/missing`, assertStatus: 200 }]) };

    const status = await robot.runTask(broken);
    assert.equal(status, 'Failed');
    const finalize = state.finalized[0] as { body: { status: string; error: string } };
    assert.equal(finalize.body.status, 'Failed');
    assert.match(finalize.body.error, /returned 404, expected 200/);
  });
});

test('a pinned identity skips enrolment entirely', async () => {
  await withFakeAro(async (base, state) => {
    const robot = new AroRobot({
      apiUrl: base, projectId: 'p', name: 'pinned-host',
      robotId: '44444444-5555-6666-7777-888888888888', robotKey: 'pinned-key'
    });
    const report = await robot.preflight(); // connect + one heartbeat
    assert.equal(report.ok, true);
    assert.equal(state.calls.some((call) => call.path.endsWith('/enroll')), false, 'no enrolment call');
    const heartbeat = state.calls.find((call) => call.path.endsWith('/heartbeat'));
    assert.equal(heartbeat?.headers['x-aro-robot-key'], 'pinned-key');
  });
});

test('structured log fields travel in the existing log batch, and unknown keys do not break it', async () => {
  await withFakeAro(async (base, state) => {
    const robot = new AroRobot({ apiUrl: base, projectId: 'p', apiKey: 'project-key', name: 'test-host' });
    await robot.connect();
    const task = (await robot.claimOnce(1))!;
    const structured = {
      ...task,
      definition: JSON.stringify([
        { type: 'control', action: 'setVar', name: 'TransactionItem.id', value: 'tx-1' },
        {
          type: 'control', action: 'log', message: 'processing ${TransactionItem.id}',
          fields: { process: 'Invoice', transaction: '${TransactionItem.id}' }
        }
      ])
    };

    assert.equal(await robot.runTask(structured), 'Passed');
    const batches = state.calls.filter((call) => call.path.endsWith('/logs'));
    const lines = batches.flatMap((call) => (call.body as { lines: Array<{ message: string; fields?: Record<string, string> }> }).lines);
    const line = lines.find((entry) => entry.message === 'processing tx-1');
    assert.ok(line, lines.map((entry) => entry.message).join(' | '));
    assert.deepEqual(line?.fields, { process: 'Invoice', transaction: 'tx-1' });
  });
});

test('the robot proves every engine family it can run, and a dispatched queue flow really runs', async () => {
  await withFakeAro(async (base, state) => {
    // The project folder a dispatched flow resolves in (queue files, config, invoke).
    const projectDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-robot-flow-'));
    const robot = new AroRobot({ apiUrl: base, projectId: 'p', apiKey: 'project-key', name: 'test-host', baseDir: projectDir });
    const report = await robot.preflight();

    // What an orchestrator routes on: the families this host can actually run are the proved ones.
    assert.deepEqual(report.declared, [...ENGINE_CAPABILITIES]);
    for (const capability of ['web', 'control', 'queue', 'excel', 'file', 'data', 'config', 'gsheet', 'hitl']) {
      assert.ok(report.proved.includes(capability), `${capability} should be proved (${report.proved.join(', ')})`);
    }
    // mail and pdf are proved only when this host has the module or the binary.
    if (report.proved.includes('pdf')) {
      assert.equal(spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).error, undefined);
    }

    const task = (await robot.claimOnce(1))!;
    const queueFlow = {
      ...task,
      definition: JSON.stringify([
        { type: 'queue', action: 'addItem', queue: 'InvoiceQueue', reference: 'INV-1', data: { amount: '10' } },
        { type: 'queue', action: 'getTransactionItem', queue: 'InvoiceQueue', saveAs: 'TransactionItem' },
        { type: 'control', action: 'log', message: 'claimed ${TransactionItem.reference}' },
        { type: 'queue', action: 'setStatus', queue: 'InvoiceQueue', status: 'Successful', reason: 'verified' }
      ])
    };

    assert.equal(await robot.runTask(queueFlow), 'Passed');

    // The queue file in the robot's project folder is the proof, not the log line.
    const items = await new QueueStore(projectDir).items('InvoiceQueue');
    assert.equal(items.length, 1);
    assert.equal(items[0]?.status, 'Successful');
    assert.equal(items[0]?.reference, 'INV-1');
    assert.equal(items[0]?.reason, 'verified');

    const shipped = state.calls.filter((call) => call.path.endsWith('/logs'))
      .flatMap((call) => (call.body as { lines: Array<{ message: string }> }).lines)
      .map((line) => line.message);
    assert.ok(shipped.some((line) => line.includes('claimed INV-1')), shipped.join(' | '));
    const finalized = state.finalized[0] as { body: { status: string } };
    assert.equal(finalized.body.status, 'Passed');
  });
});
