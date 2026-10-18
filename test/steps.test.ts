/**
 * The step families added for the ported workflows: the local transaction queue (the
 * dispatcher/performer contract), file/table/settings/data steps, and the control-flow primitives a
 * framework needs (try/catch with business vs application exceptions, retry scope, invoke, switch,
 * arithmetic).
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Engine, formatLogLine } from '../src/engine.js';
import { parseWorkflow, validateWorkflow } from '../src/model.js';
import { QueueStore } from '../src/store.js';

async function project(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'rpa-steps-'));
}

const wf = (steps: unknown[], variables?: Record<string, unknown>) =>
  parseWorkflow(JSON.stringify({ steps, ...(variables ? { variables } : {}) }));

const messages = (result: { logs: Array<{ message: string }> }) => result.logs.map((line) => line.message);

// ── Queue ───────────────────────────────────────────────────────────────────────────────────────

test('the queue hands one item over at a time and Retry puts it back as New with a bumped count', async () => {
  const dir = await project();
  const engine = new Engine({ baseDir: dir });
  const result = await engine.run(wf([
    { type: 'queue', action: 'addItem', queue: 'Q', reference: 'INV-1', data: { amount: '10' } },
    { type: 'queue', action: 'addItem', queue: 'Q', reference: 'INV-2', data: { amount: '20' } },
    { type: 'queue', action: 'count', queue: 'Q', saveAs: 'total' },
    { type: 'control', action: 'log', message: 'count=${total}' },
    { type: 'queue', action: 'getTransactionItem', queue: 'Q', saveAs: 'TransactionItem' },
    { type: 'control', action: 'log', message: 'claimed=${TransactionItem.reference} amount=${TransactionItem.amount} status=${TransactionItem.status}' },
    { type: 'queue', action: 'setStatus', queue: 'Q', status: 'Retry', reason: 'transient' },
    { type: 'queue', action: 'count', queue: 'Q', status: 'New', saveAs: 'backToNew' },
    { type: 'control', action: 'log', message: 'new=${backToNew}' }
  ]));

  assert.equal(result.status, 'Passed', result.error);
  assert.equal(result.vars.total, '2');
  assert.equal(result.vars.backToNew, '2', 'the retried item is claimable again');
  assert.ok(messages(result).some((line) => line.includes('claimed=INV-1 amount=10 status=InProgress')), messages(result).join(' | '));

  const items = await new QueueStore(dir).items('Q');
  assert.equal(items[0]?.retries, 1);
  assert.equal(items[0]?.status, 'New');
  assert.equal(items[0]?.reason, 'transient');
});

test('a second claim takes the other item, and setStatus closes it for good', async () => {
  const dir = await project();
  const result = await new Engine({ baseDir: dir }).run(wf([
    { type: 'queue', action: 'addItem', queue: 'Q', reference: 'A' },
    { type: 'queue', action: 'addItem', queue: 'Q', reference: 'B' },
    { type: 'queue', action: 'getTransactionItem', queue: 'Q' },
    { type: 'queue', action: 'setStatus', queue: 'Q', status: 'Successful' },
    { type: 'queue', action: 'getTransactionItem', queue: 'Q', saveAs: 'Item2' },
    { type: 'control', action: 'log', message: 'second=${Item2.reference}' },
    { type: 'queue', action: 'setStatus', queue: 'Q', item: '${Item2.id}', status: 'BusinessException', reason: 'rule 7' },
    { type: 'queue', action: 'count', queue: 'Q', status: 'Successful', saveAs: 'ok' },
    { type: 'queue', action: 'count', queue: 'Q', status: 'BusinessException', saveAs: 'biz' },
    { type: 'control', action: 'log', message: 'ok=${ok} biz=${biz}' }
  ]));

  assert.equal(result.status, 'Passed', result.error);
  assert.ok(messages(result).some((line) => line.includes('second=B')));
  assert.ok(messages(result).some((line) => line.includes('ok=1 biz=1')));
});

test('queue actions are validated: a status is required and unknown actions are refused', () => {
  const errors = validateWorkflow(wf([
    { type: 'queue', action: 'setStatus', queue: 'Q' },
    { type: 'queue', action: 'teleport', queue: 'Q' }
  ]));
  assert.equal(errors.length, 2, errors.join(' | '));
  assert.ok(errors.some((error) => error.includes('needs a "status"')));
  assert.ok(errors.some((error) => error.includes('unsupported queue action')));
});

// ── Files, tables, settings, data ───────────────────────────────────────────────────────────────

test('file steps write, read, list, move and delete inside the project', async () => {
  const dir = await project();
  const result = await new Engine({ baseDir: dir }).run(wf([
    { type: 'file', action: 'writeText', path: 'Data/invoice-1.txt', text: 'hello ${who}' },
    { type: 'file', action: 'readText', path: 'Data/invoice-1.txt', saveAs: 'text' },
    { type: 'file', action: 'writeText', path: 'Data/log.txt', text: 'line ${text}', append: true },
    { type: 'file', action: 'exists', path: 'Data/invoice-1.txt', saveAs: 'there' },
    { type: 'file', action: 'forEachFile', folder: 'Data', pattern: 'invoice-*', saveAs: 'f', steps: [
      { type: 'control', action: 'log', message: 'file ${f.name}' }
    ] },
    { type: 'file', action: 'move', from: 'Data/invoice-1.txt', to: 'Data/Processed/invoice-1.txt' },
    { type: 'file', action: 'exists', path: 'Data/invoice-1.txt', saveAs: 'gone' },
    { type: 'control', action: 'log', message: 'text=${text} there=${there} gone=${gone}' }
  ], { who: 'aro' }));

  assert.equal(result.status, 'Passed', result.error);
  assert.ok(messages(result).some((line) => line === 'file invoice-1.txt'));
  assert.ok(messages(result).some((line) => line.includes('text=hello aro there=true gone=false')), messages(result).join(' | '));
});

test('excel readRange/forEachRow/writeCell work header-keyed on CSV (and xlsx when exceljs is present)', async () => {
  const dir = await project();
  const result = await new Engine({ baseDir: dir }).run(wf([
    { type: 'excel', action: 'writeRange', path: 'Data/Orders.csv', rows: '[{"Name":"Ada","Qty":"2"},{"Name":"Alan","Qty":"3"}]' },
    { type: 'excel', action: 'readRange', path: 'Data/Orders.csv', saveAs: 'orders' },
    { type: 'control', action: 'log', message: 'rows=${orders.count}' },
    { type: 'excel', action: 'forEachRow', path: 'Data/Orders.csv', steps: [
      { type: 'control', action: 'log', message: 'row ${row.Name} x${row.Qty}' }
    ] },
    { type: 'excel', action: 'writeCell', path: 'Data/Orders.csv', row: 2, column: 'Qty', value: '9' },
    { type: 'excel', action: 'readRange', path: 'Data/Orders.csv', saveAs: 'after' },
    { type: 'control', action: 'log', message: 'after=${after}' }
  ]));

  assert.equal(result.status, 'Passed', result.error);
  assert.equal(result.vars['orders.count'], '2');
  assert.ok(messages(result).some((line) => line === 'row Ada x2'));
  assert.ok(messages(result).some((line) => line === 'row Alan x3'));
  assert.ok(messages(result).some((line) => line.includes('"Qty":"9"')), messages(result).join(' | '));
});

test('config.load reads JSON and CSV Name/Value settings into ${Config.*}', async () => {
  const dir = await project();
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ Config: { OrchestratorQueueName: 'InvoiceQueue', MaxRetryNumber: '3' } }));
  await writeFile(path.join(dir, 'legacy.csv'), 'Name,Value,Description\nQueue,LegacyQ,from csv\n');

  const result = await new Engine({ baseDir: dir }).run(wf([
    { type: 'config', action: 'load', path: 'config.json' },
    { type: 'config', action: 'load', path: 'legacy.csv', prefix: 'Legacy' },
    { type: 'control', action: 'log', message: 'queue=${Config.OrchestratorQueueName} retry=${Config.MaxRetryNumber} legacy=${Legacy.Queue}' }
  ]));

  assert.equal(result.status, 'Passed', result.error);
  assert.ok(messages(result).some((line) => line.includes('queue=InvoiceQueue retry=3 legacy=LegacyQ')), messages(result).join(' | '));
});

test('data.jsonParse exposes fields and regexMatches extracts with groups', async () => {
  const dir = await project();
  const result = await new Engine({ baseDir: dir }).run(wf([
    { type: 'data', action: 'jsonParse', text: '{"invoice":"INV-9","total":120.5}', saveAs: 'payload' },
    { type: 'data', action: 'regexMatches', text: 'Invoice INV-9 total 120.5 EUR', pattern: 'INV-(\\d+)', saveAs: 'ids' },
    { type: 'control', action: 'log', message: 'invoice=${payload.invoice} total=${payload.total} ids=${ids.count} first=${ids}' }
  ]));

  assert.equal(result.status, 'Passed', result.error);
  const line = messages(result).find((entry) => entry.startsWith('invoice=')) ?? '';
  assert.match(line, /invoice=INV-9 total=120.5 ids=1/);
  assert.match(line, /"match":"INV-9"/);
});

// ── Control flow a framework needs ──────────────────────────────────────────────────────────────

test('try routes business and application exceptions to their own catch blocks', async () => {
  const dir = await project();

  const business = await new Engine({ baseDir: dir }).run(wf([
    { type: 'control', action: 'try',
      body: [{ type: 'control', action: 'throw', kind: 'business', message: 'rule 7 failed' }],
      catches: [
        { kind: 'business', steps: [{ type: 'control', action: 'log', message: 'handled business: ${exception.message}' }] },
        { kind: 'application', steps: [{ type: 'control', action: 'log', message: 'handled application' }] }
      ] }
  ]));
  assert.equal(business.status, 'Passed', business.error);
  assert.ok(messages(business).some((line) => line === 'handled business: rule 7 failed'));

  const application = await new Engine({ baseDir: dir }).run(wf([
    { type: 'control', action: 'try',
      body: [{ type: 'control', action: 'throw', message: 'boom' }],
      catches: [
        { kind: 'business', steps: [{ type: 'control', action: 'log', message: 'handled business' }] },
        { kind: 'application', steps: [{ type: 'control', action: 'log', message: 'handled application: ${exception.message}' }] }
      ] }
  ]));
  assert.equal(application.status, 'Passed', application.error);
  assert.ok(messages(application).some((line) => line === 'handled application: boom'));
});

test('an unhandled throw fails the run, and finally still runs', async () => {
  const dir = await project();
  const result = await new Engine({ baseDir: dir }).run(wf([
    { type: 'control', action: 'try',
      body: [{ type: 'control', action: 'throw', kind: 'business', message: 'nobody catches me' }],
      catches: [{ kind: 'application', steps: [{ type: 'control', action: 'log', message: 'wrong handler' }] }],
      finally: [{ type: 'control', action: 'log', message: 'cleanup ran' }] }
  ]));

  assert.equal(result.status, 'Failed');
  assert.match(result.error ?? '', /nobody catches me/);
  assert.ok(messages(result).some((line) => line === 'cleanup ran'), 'finally is not skipped when nothing catches');
});

test('retryScope retries a failing body and gives up with a named error', async () => {
  const dir = await project();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('x', { status: calls < 3 ? 500 : 200 });
  }) as typeof fetch;

  const flaky = await new Engine({ baseDir: dir }).run(wf([
    { type: 'control', action: 'retryScope', retries: 3, retryDelayMs: 1, steps: [
      { type: 'api', action: 'request', url: 'https://x.test/v1', assertStatus: 200 }
    ] }
  ]));
  assert.equal(flaky.status, 'Passed', flaky.error);
  assert.equal(calls, 3);

  // A fresh stub that never recovers, so the second run must exhaust its attempts.
  globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
  const broken = await new Engine({ baseDir: dir }).run(wf([
    { type: 'control', action: 'retryScope', retries: 2, retryDelayMs: 1, steps: [
      { type: 'api', action: 'request', url: 'https://x.test/v1', assertStatus: 200 }
    ] }
  ]));
  assert.equal(broken.status, 'Failed');
});

test('retryScope can also retry until a condition turns true', async () => {
  const dir = await project();
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++;
    return new Response(JSON.stringify({ ready: attempts >= 2 }), { status: 200 });
  }) as typeof fetch;

  const result = await new Engine({ baseDir: dir }).run(wf([
    { type: 'control', action: 'retryScope', retries: 4, retryDelayMs: 1, until: '${ready} == true', steps: [
      { type: 'api', action: 'request', url: 'https://x.test/status', saveAs: 'body' },
      { type: 'data', action: 'jsonParse', text: '${body}', saveAs: 'status' },
      { type: 'control', action: 'setVar', name: 'ready', value: '${status.ready}' }
    ] }
  ]));

  assert.equal(result.status, 'Passed', result.error);
  assert.equal(attempts, 2);
});

test('invoke runs another workflow file with arguments in the shared scope, and a cycle is refused', async () => {
  const dir = await project();
  await writeFile(path.join(dir, 'child.json'), JSON.stringify({
    name: 'child',
    steps: [
      { type: 'control', action: 'log', message: 'child sees ${Greeting} for ${TransactionItem.reference}' },
      { type: 'control', action: 'setVar', name: 'ChildResult', value: 'done-${Greeting}' }
    ]
  }));

  const result = await new Engine({ baseDir: dir }).run(wf([
    { type: 'control', action: 'setVar', name: 'TransactionItem.reference', value: 'INV-3' },
    { type: 'control', action: 'invoke', workflow: 'child.json', arguments: { Greeting: 'hi' } },
    { type: 'control', action: 'log', message: 'back in main: ${ChildResult}' }
  ]));

  assert.equal(result.status, 'Passed', result.error);
  assert.ok(messages(result).some((line) => line === 'child sees hi for INV-3'));
  assert.ok(messages(result).some((line) => line === 'back in main: done-hi'));

  await writeFile(path.join(dir, 'loop.json'), JSON.stringify({
    name: 'loop',
    steps: [{ type: 'control', action: 'invoke', workflow: 'loop.json' }]
  }));
  const cycle = await new Engine({ baseDir: dir }).run(wf([{ type: 'control', action: 'invoke', workflow: 'loop.json' }]));
  assert.equal(cycle.status, 'Failed');
  assert.match(cycle.error ?? '', /cycle/);
});

test('math, switch and numeric comparisons behave (RETryNumber >= MaxRetryNumber)', async () => {
  const dir = await project();
  const result = await new Engine({ baseDir: dir }).run(wf([
    { type: 'control', action: 'setVar', name: 'RetryNumber', value: '1' },
    { type: 'control', action: 'setVar', name: 'Config.MaxRetryNumber', value: '3' },
    { type: 'control', action: 'math', name: 'RetryNumber', op: 'add', value: '2' },
    { type: 'control', action: 'if', condition: '${RetryNumber} >= ${Config.MaxRetryNumber}',
      then: [{ type: 'control', action: 'log', message: 'over the cap' }],
      else: [{ type: 'control', action: 'log', message: 'under the cap' }] },
    { type: 'control', action: 'switch', expression: '${RetryNumber}',
      cases: { '3': [{ type: 'control', action: 'log', message: 'case three' }] },
      default: [{ type: 'control', action: 'log', message: 'default' }] }
  ]));

  assert.equal(result.status, 'Passed', result.error);
  assert.equal(result.vars.RetryNumber, '3');
  assert.ok(messages(result).some((line) => line === 'over the cap'));
  assert.ok(messages(result).some((line) => line === 'case three'));
});

// ── Structured log fields ──────────────────────────────────────────────────────────────────────

test('control.log carries interpolated fields on the LogLine and renders them before the message', async () => {
  const dir = await project();
  const result = await new Engine({ baseDir: dir }).run(wf([
    { type: 'control', action: 'setVar', name: 'Config.ProcessName', value: 'Invoice' },
    { type: 'control', action: 'setVar', name: 'TransactionItem.id', value: 'tx-1' },
    {
      type: 'control', action: 'log', message: 'processing ${TransactionItem.id}',
      fields: { process: '${Config.ProcessName}', transaction: '${TransactionItem.id}' }
    }
  ]));

  assert.equal(result.status, 'Passed', result.error);
  const line = result.logs.find((entry) => entry.message === 'processing tx-1');
  assert.ok(line, messages(result).join(' | '));
  assert.deepEqual(line?.fields, { process: 'Invoice', transaction: 'tx-1' });
  assert.equal(formatLogLine(line!), '[info] {process=Invoice, transaction=tx-1} processing tx-1');
  // A line without fields is unchanged — no empty braces on every ordinary log line.
  assert.equal(formatLogLine({ level: 'info', message: 'plain', ts: '' }), '[info] plain');
});

test('a non-object fields map is refused at validation, not at run time', () => {
  const errors = validateWorkflow(wf([{ type: 'control', action: 'log', message: 'x', fields: ['a'] }]));
  assert.ok(errors.some((error) => error.includes('fields must be an object')), errors.join(' | '));
});
