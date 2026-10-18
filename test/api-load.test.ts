/**
 * `api.load` — a smoke-shaped load check against a real local server: iterations are honoured
 * (the server counts too), percentiles come from real latencies, and failures are counted rather
 * than thrown. No browser needed.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Engine } from '../src/engine/engine.js';
import { parseWorkflow, validateWorkflow } from '../src/workflow/model.js';

interface Harness {
  base: string;
  hits: () => Record<string, number>;
}

async function withServer<T>(run: (harness: Harness) => Promise<T>): Promise<T> {
  const hits: Record<string, number> = {};
  const server: Server = createServer((request, response) => {
    const route = request.url ?? '/';
    hits[route] = (hits[route] ?? 0) + 1;
    const delay = route === '/slow' ? 60 : 8;
    setTimeout(() => {
      response.writeHead(route === '/boom' ? 500 : 200, { 'Content-Type': 'text/plain' });
      response.end(route === '/boom' ? 'nope' : 'ok');
    }, delay);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    return await run({ base, hits: () => hits });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function runStep(step: Record<string, unknown>): Promise<Awaited<ReturnType<Engine['run']>>> {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-load-'));
  const engine = new Engine({ baseDir: runDir });
  return engine.run(parseWorkflow(JSON.stringify([step])), {});
}

test('iterations are honoured end to end, and the stats are real numbers', async () => {
  await withServer(async ({ base, hits }) => {
    const result = await runStep({ type: 'api', action: 'load', url: `${base}/fast`, vus: 4, iterations: 20, saveAs: 'load' });
    assert.equal(result.status, 'Passed', result.error);
    assert.equal(hits()['/fast'], 20, 'the server itself counted 20 requests');

    const stats = JSON.parse(String(result.vars['load'])) as {
      requested: number; errors: number; rps: number; durationMs: number;
      latencyMs: { min: number; avg: number; p50: number; p95: number; max: number };
    };
    assert.equal(stats.requested, 20);
    assert.equal(stats.errors, 0);
    assert.ok(stats.rps > 0, `rps ${stats.rps}`);
    assert.ok(stats.latencyMs.p50 >= 5, `p50 ${stats.latencyMs.p50} should cover the 8 ms server delay`);
    assert.ok(stats.latencyMs.p95 >= stats.latencyMs.p50);
    assert.ok(stats.latencyMs.max >= stats.latencyMs.p95);
    assert.equal(result.vars['load.p95'], String(stats.latencyMs.p95));
    assert.equal(result.vars['load.errors'], '0');
    assert.ok(result.logs.some((line) => line.message.includes('api.load GET') && line.message.includes('rps')));
  });
});

test('a failing endpoint is measured, not thrown: errors land in the stats', async () => {
  await withServer(async ({ base, hits }) => {
    const result = await runStep({ type: 'api', action: 'load', url: `${base}/boom`, vus: 2, iterations: 6, expectStatus: 200, saveAs: 'load' });
    assert.equal(result.status, 'Passed');
    assert.equal(hits()['/boom'], 6);
    const stats = JSON.parse(String(result.vars['load'])) as { errors: number; requested: number };
    assert.equal(stats.requested, 6);
    assert.equal(stats.errors, 6, 'every 500 counts against expectStatus');
    assert.equal(result.vars['load.errors'], '6');
  });
});

test('a duration cap stops the run and still reports', async () => {
  await withServer(async ({ base }) => {
    const result = await runStep({ type: 'api', action: 'load', url: `${base}/slow`, vus: 2, durationMs: 500, saveAs: 'load' });
    assert.equal(result.status, 'Passed');
    const stats = JSON.parse(String(result.vars['load'])) as { requested: number; durationMs: number };
    assert.ok(stats.requested >= 4, `requests during 500 ms at 60 ms each: ${stats.requested}`);
    assert.ok(stats.durationMs >= 500 && stats.durationMs <= 3000, `duration ${stats.durationMs}`);
  });
});

test('api.load without a url is refused at validation time', () => {
  const errors = validateWorkflow(parseWorkflow(JSON.stringify([{ type: 'api', action: 'load', iterations: 5 }])));
  assert.ok(errors.some((error) => error.includes('api.load') && error.includes('url')), errors.join('\n'));
});
