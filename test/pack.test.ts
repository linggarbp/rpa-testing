/**
 * Packages — `rpa pack` writes a zip with a manifest, `rpa run` accepts it, and a file that changed
 * after packing is refused by name. The archive is read and written by src/project/pack.ts itself (node:zlib,
 * no dependency), so this suite also pins that format.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine/engine.js';
import { parseWorkflow } from '../src/workflow/model.js';
import { MANIFEST_FILE, packProject, readArchive, unpack, writeArchive } from '../src/project/pack.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A tiny project: settings in a file, one log line, one file written — all project-relative. */
async function project(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpa-pack-'));
  await writeFile(path.join(dir, 'Main.json'), JSON.stringify({
    name: 'packed',
    steps: [
      { type: 'config', action: 'load', path: 'config.json' },
      { type: 'control', action: 'log', message: 'hello ${Config.Who}' },
      { type: 'file', action: 'writeText', path: '${Out}', text: 'packed ${Config.Who}' }
    ]
  }));
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ Config: { Who: 'packaged' } }));
  return dir;
}

test('pack → unpack → run: the entry runs against the extracted project, and the manifest describes it', async () => {
  const dir = await project();
  const archive = path.join(await mkdtemp(path.join(os.tmpdir(), 'rpa-pkg-out-')), 'demo.rpapkg');
  const packed = await packProject(dir, archive, { name: 'demo', version: '1.2.3' });
  assert.equal(packed.files, 2, 'Main.json and config.json');
  assert.equal(packed.entry, 'Main.json');
  assert.ok(packed.bytes > 0);

  const opened = await unpack(archive);
  try {
    assert.equal(opened.manifest.name, 'demo');
    assert.equal(opened.manifest.version, '1.2.3');
    assert.equal(opened.manifest.entry, 'Main.json');
    assert.deepEqual(Object.keys(opened.manifest.files).sort(), ['Main.json', 'config.json']);
    assert.match(opened.manifest.files['Main.json'] ?? '', /^[0-9a-f]{64}$/);

    const out = path.join(opened.dir, 'Data', 'out.txt');
    const result = await new Engine({ baseDir: opened.dir, variables: { Out: out } })
      .run(parseWorkflow(await readFile(opened.entry, 'utf8')));
    assert.equal(result.status, 'Passed', result.error);
    assert.ok(result.logs.some((line) => line.message === 'hello packaged'), 'config.load read the packaged settings');
    assert.equal(await readFile(out, 'utf8'), 'packed packaged', 'the file step wrote inside the extracted project');
  } finally {
    await opened.cleanup();
  }
});

test('rpa run accepts the archive: it verifies the manifest and runs the entry', async () => {
  const dir = await project();
  const archive = path.join(await mkdtemp(path.join(os.tmpdir(), 'rpa-pkg-cli-')), 'demo.rpapkg');
  await packProject(dir, archive);
  const out = path.join(await mkdtemp(path.join(os.tmpdir(), 'rpa-pkg-run-')), 'cli-out.txt');

  const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(repo, 'src', 'cli.ts'), 'run', archive, '--var', `Out=${out}`], {
    cwd: repo, encoding: 'utf8', timeout: 60_000
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /manifest verified/);
  assert.match(run.stdout, /hello packaged/);
  assert.equal(await readFile(out, 'utf8'), 'packed packaged', 'the run really wrote the file');
});

test('a file changed after packing fails the manifest check and names the file', async () => {
  const dir = await project();
  const archive = path.join(await mkdtemp(path.join(os.tmpdir(), 'rpa-pkg-bad-')), 'demo.rpapkg');
  await packProject(dir, archive);

  const entries = readArchive(await readFile(archive));
  assert.ok(entries.has(MANIFEST_FILE), 'the manifest is inside the archive');
  entries.set('Main.json', Buffer.from(JSON.stringify([{ type: 'control', action: 'log', message: 'tampered' }]), 'utf8'));
  const tampered = path.join(path.dirname(archive), 'tampered.rpapkg');
  await writeFile(tampered, writeArchive(entries));

  await assert.rejects(() => unpack(tampered), /Main\.json does not match the manifest/);

  const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(repo, 'src', 'cli.ts'), 'run', tampered], {
    cwd: repo, encoding: 'utf8', timeout: 60_000
  });
  assert.notEqual(run.status, 0, 'the CLI refuses the package');
  assert.match(`${run.stdout}\n${run.stderr}`, /does not match the manifest/);
});

test('packing is reproducible and refuses an entry that is not in the project', async () => {
  const dir = await project();
  const first = path.join(await mkdtemp(path.join(os.tmpdir(), 'rpa-pkg-a-')), 'a.rpapkg');
  const second = path.join(await mkdtemp(path.join(os.tmpdir(), 'rpa-pkg-b-')), 'b.rpapkg');
  await packProject(dir, first);
  await packProject(dir, second);
  assert.deepEqual(await readFile(first), await readFile(second), 'same files, same bytes');

  await assert.rejects(() => packProject(dir, path.join(path.dirname(first), 'x.rpapkg'), { entry: 'Nope.json' }), /entry "Nope\.json" is not in/);
});
