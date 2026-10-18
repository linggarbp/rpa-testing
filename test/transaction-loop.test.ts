/**
 * The transactional-loop template, end to end: scaffold it, dispatch work into its queue, run
 * Main.json, and check what the template did with each transaction — the question a queue's owner
 * asks after a run.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Engine } from '../src/engine.js';
import { parseWorkflow, validateWorkflow } from '../src/model.js';
import { QueueStore } from '../src/store.js';
import { scaffoldTransactional } from '../src/templates.js';

const QUEUE = 'InvoiceQueue';

async function scaffold(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpa-txloop-'));
  await scaffoldTransactional(dir, 'InvoiceBot');
  return dir;
}

/** Every workflow the template wrote must at least validate. */
test('every scaffolded template file validates', async () => {
  const dir = await scaffold();
  for (const file of ['Main.json', 'Framework/InitAllSettings.json', 'Framework/GetTransactionData.json', 'Framework/Process.json', 'Framework/RetryCurrentTransaction.json', 'Framework/SetTransactionStatus.json', 'Framework/TakeScreenshot.json']) {
    const workflow = parseWorkflow(await readFile(path.join(dir, file), 'utf8'));
    const errors = validateWorkflow(workflow);
    assert.deepEqual(errors, [], `${file}: ${errors.join('; ')}`);
  }
});

test('an empty queue makes the framework end cleanly', async () => {
  const dir = await scaffold();
  const engine = new Engine({ baseDir: dir });
  const result = await engine.run(parseWorkflow(await readFile(path.join(dir, 'Main.json'), 'utf8')));

  assert.equal(result.status, 'Passed', result.error);
  const messages = result.logs.map((line) => line.message).join(' | ');
  assert.match(messages, /Settings loaded — queue "InvoiceQueue"/);
  assert.match(messages, /No more transactions/);
  assert.match(messages, /CloseAllApplications/);
});

test('transactions are processed, one business exception is caught, and statuses land in the queue', async () => {
  const dir = await scaffold();
  const store = new QueueStore(dir);
  await store.add(QUEUE, 'INV-001', { amount: '120.00' });
  await store.add(QUEUE, 'fail-me', { amount: '0.00' });
  await store.add(QUEUE, 'INV-003', { amount: '75.50' });

  const engine = new Engine({ baseDir: dir });
  const result = await engine.run(parseWorkflow(await readFile(path.join(dir, 'Main.json'), 'utf8')));

  assert.equal(result.status, 'Passed', result.error);
  const messages = result.logs.map((line) => line.message).join('\n');
  assert.match(messages, /Transaction INV-001 claimed/);
  assert.match(messages, /Business exception on fail-me: Reference "fail-me" violates a business rule/);
  assert.match(messages, /Transaction INV-003 claimed/);

  const items = await store.items(QUEUE);
  const byReference = Object.fromEntries(items.map((item) => [item.reference, item.status]));
  assert.equal(byReference['INV-001'], 'Successful');
  assert.equal(byReference['fail-me'], 'BusinessException', 'a business exception is terminal — no retry');
  assert.equal(byReference['INV-003'], 'Successful');
  assert.equal(items.find((item) => item.reference === 'fail-me')?.retries, 0, 'business exceptions do not consume retries');
});

test('an application exception is retried up to MaxRetryNumber and then failed', async () => {
  const dir = await scaffold();
  // Make the business stub fail with an application exception for one reference.
  const processFile = path.join(dir, 'Framework/Process.json');
  const process = JSON.parse(await readFile(processFile, 'utf8')) as { steps: unknown[] };
  await writeFile(processFile, JSON.stringify({
    ...process,
    steps: [
      { type: 'control', action: 'if', condition: '${TransactionItem.reference} == explode-me',
        then: [{ type: 'control', action: 'throw', message: 'application blew up' }] },
      { type: 'control', action: 'log', message: 'processed ${TransactionItem.reference}' }
    ]
  }, null, 2));

  const store = new QueueStore(dir);
  await store.add(QUEUE, 'explode-me', {});

  const engine = new Engine({ baseDir: dir });
  const result = await engine.run(parseWorkflow(await readFile(path.join(dir, 'Main.json'), 'utf8')));

  assert.equal(result.status, 'Passed', result.error);
  const messages = result.logs.map((line) => line.message).join('\n');
  assert.match(messages, /requeued \(attempt 1\/3\)/);
  assert.match(messages, /requeued \(attempt 2\/3\)/);
  assert.match(messages, /requeued \(attempt 3\/3\)/);
  assert.match(messages, /ApplicationException/);

  const item = (await store.items(QUEUE))[0];
  assert.equal(item?.status, 'ApplicationException');
  assert.equal(item?.retries, 3, 'three requeues, then the cap');
  assert.equal(item?.reason, 'application blew up');
});
