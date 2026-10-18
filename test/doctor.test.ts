/**
 * `rpa doctor` — the collector run itself: report shape, profile selection, project validation and
 * the `--out` archive. Everything asserted here is platform-independent on purpose; the collectors
 * themselves adapt per OS by reporting facts, not by changing shape.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DOCTOR_PROFILES, runDoctor } from '../src/services/doctor.js';
import { readArchive } from '../src/project/pack.js';

test('the default profile reports runtime, dependencies and tools as one JSON object', async () => {
  const report = await runDoctor();
  assert.equal(report.tool, 'nutjs-testing');
  assert.equal(report.profile, 'default');
  assert.ok(report.generatedAt.length > 0);
  assert.deepEqual(
    report.collectors.map((collector) => collector.name),
    ['runtime', 'dependencies', 'tools']
  );

  const runtime = report.collectors[0]!;
  assert.equal(runtime.status, 'ok');
  assert.equal(runtime.facts['node'], process.version);

  const dependencies = report.collectors[1]!;
  assert.ok('@nut-tree-fork/nut-js' in dependencies.facts, 'the default desktop backend is always reported');
  assert.ok('robotjs' in dependencies.facts, 'the fallback backend is always reported');

  assert.equal(report.summary.warnings + report.summary.problems,
    report.collectors.filter((collector) => collector.status !== 'ok').length);

  // The report must survive JSON.stringify — it travels in logs, robots and support cases.
  const roundTrip = JSON.parse(JSON.stringify(report)) as typeof report;
  assert.equal(roundTrip.collectors.length, report.collectors.length);
});

test('profiles select collectors: desktop asks the backends, robot adds the session', async () => {
  assert.deepEqual([...DOCTOR_PROFILES], ['default', 'desktop', 'robot']);

  const desktop = await runDoctor({ profile: 'desktop' });
  assert.ok(desktop.collectors.some((collector) => collector.name === 'desktop'));
  assert.ok(!desktop.collectors.some((collector) => collector.name === 'session'));

  const robot = await runDoctor({ profile: 'robot' });
  assert.ok(robot.collectors.some((collector) => collector.name === 'desktop'));
  assert.ok(robot.collectors.some((collector) => collector.name === 'session'));
});

test('a project is validated: good workflow counted, broken one fails the collector', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpa-doctor-'));
  await writeFile(path.join(dir, 'Main.json'), JSON.stringify([{ type: 'control', action: 'delay', ms: 1 }]));
  await writeFile(path.join(dir, 'Broken.json'), JSON.stringify([{ type: 'desktop', action: 'clik' }]));
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ name: 'not a workflow' }));

  const report = await runDoctor({ projectDir: dir });
  const project = report.collectors.find((collector) => collector.name === 'project');
  assert.ok(project, 'the project collector runs when a project is given');
  assert.equal(project.status, 'fail');
  assert.equal(project.facts['workflow files'], '2');
  assert.equal(project.facts['invalid workflows'], '1');
  assert.ok(project.notes.some((note) => note.includes('Broken.json')));
  assert.ok(report.summary.problems >= 1);

  const missing = await runDoctor({ projectDir: path.join(dir, 'does-not-exist') });
  const missingProject = missing.collectors.find((collector) => collector.name === 'project');
  assert.equal(missingProject?.status, 'fail');
});

test('--out writes .json plain and .zip as a one-entry archive', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpa-doctor-out-'));

  const jsonOut = path.join(dir, 'report.json');
  const fromJson = await runDoctor({ out: jsonOut });
  const written = JSON.parse(await readFile(jsonOut, 'utf8')) as typeof fromJson;
  assert.equal(written.generatedAt, fromJson.generatedAt);
  assert.equal(written.tool, 'nutjs-testing');

  const zipOut = path.join(dir, 'report.zip');
  const fromZip = await runDoctor({ out: zipOut });
  const entries = readArchive(await readFile(zipOut));
  assert.deepEqual([...entries.keys()], ['report.json']);
  const inZip = JSON.parse(entries.get('report.json')!.toString('utf8')) as typeof fromZip;
  assert.equal(inZip.generatedAt, fromZip.generatedAt);

  await assert.rejects(() => runDoctor({ out: path.join(dir, 'report.txt') }), /--out must end with \.json or \.zip/);
});
