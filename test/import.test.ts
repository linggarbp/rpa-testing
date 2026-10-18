/**
 * The importer — legacy XAML in, this tool's JSON out, plus a porting report naming what did not
 * make it. The fixtures under test/fixtures/ are synthetic (written for this repo, not a copy of any
 * third-party export): a dispatcher/performer pair, a data-table loop, and a file with activities
 * that have no equivalent.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { convertXaml, importExport } from '../src/import.js';
import { parseWorkflow, validateWorkflow } from '../src/model.js';
import { QueueStore } from '../src/store.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(repo, 'test', 'fixtures');
const project = () => mkdtemp(path.join(os.tmpdir(), 'rpa-import-'));

/** The pair shares one queue name; a ported project gets its settings from config.load upstream. */
const SETTINGS = { 'Config.Queue': 'InvoiceQueue' };

test('a dispatcher/performer pair imports and runs against the local queue', async () => {
  const out = await project();
  const result = await importExport(path.join(fixtures, 'legacy-project', 'project.json'), out);
  assert.deepEqual(result.files.map((file) => path.basename(file.output)).sort(), ['Dispatcher.json', 'Performer.json']);

  // The dispatcher walks Data/Input; the performer closes what it finds.
  await mkdir(path.join(out, 'Data', 'Input'), { recursive: true });
  for (const name of ['inv-1.pdf', 'inv-2.pdf', 'fail-me.pdf']) {
    await writeFile(path.join(out, 'Data', 'Input', name), `%PDF-1.4 fake ${name}\n`);
  }

  const dispatcher = parseWorkflow(await readFile(path.join(out, 'Dispatcher.json'), 'utf8'));
  assert.deepEqual(validateWorkflow(dispatcher), []);
  assert.equal(dispatcher.steps.length, 1);
  const loop = dispatcher.steps[0] as unknown as Record<string, unknown>;
  assert.equal(loop['type'], 'file');
  assert.equal(loop['action'], 'forEachFile');
  assert.equal(loop['pattern'], '*.pdf');
  assert.equal(loop['saveAs'], 'CurrentFile', 'the loop variable the body reads');

  const dispatchRun = await new Engine({ baseDir: out, variables: { ...SETTINGS } }).run(dispatcher);
  assert.equal(dispatchRun.status, 'Passed', dispatchRun.error);

  const store = new QueueStore(out);
  const queued = await store.items('InvoiceQueue');
  assert.equal(queued.length, 3);
  assert.deepEqual(queued.map((item) => item.reference).sort(), ['fail-me.pdf', 'inv-1.pdf', 'inv-2.pdf']);
  assert.equal(queued[0]?.status, 'New');
  assert.match(String(queued[0]?.data.path ?? ''), /Data\/Input\/.*\.pdf$/, 'the file path travels as item data');

  // The performer claims one item per run: 3 items + 1 empty pass.
  const performer = parseWorkflow(await readFile(path.join(out, 'Performer.json'), 'utf8'));
  assert.deepEqual(validateWorkflow(performer), []);
  for (let pass = 0; pass < 4; pass++) {
    const run = await new Engine({ baseDir: out, variables: { ...SETTINGS } }).run(performer);
    assert.equal(run.status, 'Passed', run.error);
  }

  const items = await store.items('InvoiceQueue');
  const byStatus = (status: string) => items.filter((item) => item.status === status).length;
  assert.equal(byStatus('Successful'), 2, JSON.stringify(items.map((item) => [item.reference, item.status])));
  assert.equal(byStatus('BusinessException'), 1);
  assert.equal(items.find((item) => item.status === 'BusinessException')?.reference, 'fail-me.pdf');
  assert.match(items.find((item) => item.status === 'BusinessException')?.processingException?.reason ?? '', /unreadable/);

  // The report says the pair mapped cleanly.
  const report = await readFile(path.join(out, 'PORTING-REPORT.md'), 'utf8');
  assert.match(report, /## Dispatcher\.xaml/);
  assert.match(report, /## Performer\.xaml/);
  assert.ok(!/^\| \d+ \|/m.test(report.split('## Performer.xaml')[1] ?? ''), `no unmapped activities in the performer:\n${report}`);
});

test('a loop over a data table becomes readRange + forEachRow on the same sheet', async () => {
  const out = await project();
  await importExport(path.join(fixtures, 'data-table-loop.xaml'), out);
  const workflow = parseWorkflow(await readFile(path.join(out, 'data-table-loop.json'), 'utf8'));
  assert.deepEqual(validateWorkflow(workflow), []);
  assert.equal(workflow.steps.length, 3, JSON.stringify(workflow.steps, null, 2));

  const [read, loop, cell] = workflow.steps as Array<Record<string, unknown>>;
  assert.deepEqual({ type: read?.type, action: read?.action, path: read?.path, sheet: read?.sheet, saveAs: read?.saveAs },
    { type: 'excel', action: 'readRange', path: 'Data/Orders.xlsx', sheet: 'Orders', saveAs: 'orders' });
  assert.deepEqual({ type: loop?.type, action: loop?.action, path: loop?.path, saveAs: loop?.saveAs },
    { type: 'excel', action: 'forEachRow', path: 'Data/Orders.xlsx', saveAs: 'order' });
  assert.equal(((loop?.steps as Array<Record<string, unknown>>)[0]?.message), 'order ${order.Name}', 'the row loop binds the variable the body reads');
  assert.deepEqual({ action: cell?.action, row: cell?.row, column: cell?.column, value: cell?.value },
    { action: 'writeCell', row: 2, column: 'B', value: 'ported' });

  const report = await readFile(path.join(out, 'PORTING-REPORT.md'), 'utf8');
  assert.match(report, /No unmapped activities/);
});

test('the porting report names every unmapped activity with its source line', async () => {
  const out = await project();
  const result = await importExport(path.join(fixtures, 'unmapped.xaml'), out);
  const report = await readFile(result.reportFile, 'utf8');

  // The fixture's own line numbers: the scope at 7, the coded activity at 16.
  assert.match(report, /^\| 7 \| `ExcelApplicationScope` \| no equivalent step — the container is gone, the steps inside it are kept \|$/m, report);
  assert.match(report, /^\| 16 \| `InvokeCode` \| no equivalent step/m, report);

  // The steps that *are* mapped survive, including the one written inside the unmapped scope.
  const workflow = parseWorkflow(await readFile(path.join(out, 'unmapped.json'), 'utf8'));
  assert.deepEqual(workflow.steps.map((step) => [step.type, step.action]),
    [['control', 'log'], ['excel', 'writeCell'], ['control', 'log']]);
  assert.deepEqual(validateWorkflow(workflow), []);
});

test('expressions convert where the meaning is unambiguous and are reported where it is not', () => {
  const xml = `<Activity DisplayName="Expressions">
  <Sequence>
    <Assign To="[RetryNumber]" Value="[RetryNumber + 1]" />
    <Assign To="[label]" Value="[&quot;invoice &quot; + TransactionItem(&quot;reference&quot;)]" />
    <Assign To="[queue]" Value="[Config(&quot;Queue&quot;).ToString]" />
    <Assign To="[mystery]" Value="[SomeHelper.Build(1, 2)]" />
    <If Condition="[RetryNumber >= 2]">
      <If.Then><Sequence><LogMessage Text="retrying" /></Sequence></If.Then>
    </If>
    <If Condition="[TransactionItem = Nothing]">
      <If.Then><Sequence><LogMessage Text="nothing to do" /></Sequence></If.Then>
    </If>
  </Sequence>
</Activity>`;

  const { workflow, report } = convertXaml(xml, 'expressions.xaml');
  const steps = workflow.steps as Array<Record<string, unknown>>;
  assert.deepEqual({ action: steps[0]?.action, name: steps[0]?.name, op: steps[0]?.op, value: steps[0]?.value },
    { action: 'math', name: 'RetryNumber', op: 'add', value: '1' }, 'x = x + 1 is arithmetic');
  assert.equal(steps[1]?.value, 'invoice ${TransactionItem.reference}', 'string concatenation interpolates');
  assert.equal(steps[2]?.value, '${Config.Queue}');
  assert.equal((steps[3] as { condition: string }).condition, '${RetryNumber} >= 2');
  assert.equal((steps[4] as { condition: string }).condition, '${TransactionItem} == ', 'Nothing compares as empty');
  assert.deepEqual(report.unmapped.map((entry) => [entry.activity, entry.line]), [['Assign', 6]], report.unmapped.map((entry) => entry.detail).join(' | '));
  assert.match(report.unmapped[0]?.detail ?? '', /SomeHelper\.Build/);
});
