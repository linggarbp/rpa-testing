/**
 * `word.*` — .docx read/write over the stdlib zip + XML. Three levels of proof: an engine
 * round-trip, a docx this project did NOT build (runs, tabs, breaks, entities), and — when
 * LibreOffice is installed — LibreOffice itself opening the file we wrote and reading the text back.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Engine } from '../src/engine.js';
import { parseWorkflow, validateWorkflow } from '../src/model.js';
import { readArchive, writeArchive } from '../src/pack.js';
import { buildDocx, documentText, readDocx } from '../src/word.js';

const run = promisify(execFile);

async function engineRun(dir: string, steps: unknown[]): Promise<Awaited<ReturnType<Engine['run']>>> {
  const engine = new Engine({ baseDir: dir });
  return engine.run(parseWorkflow(JSON.stringify(steps)), {});
}

let libreOffice = false;
try {
  await run('soffice', ['--version'], { timeout: 30000 });
  libreOffice = true;
} catch {
  libreOffice = false;
}

const TEXT = 'Invoice 4711\nCustomer: Ada & Co\nTotal: 120,00 EUR';

test('write → read round-trips through the engine', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpa-word-'));
  const written = await engineRun(dir, [{ type: 'word', action: 'writeText', path: 'out/report.docx', text: TEXT }]);
  assert.equal(written.status, 'Passed', written.error);

  const read = await engineRun(dir, [{ type: 'word', action: 'readText', path: 'out/report.docx', saveAs: 'doc' }]);
  assert.equal(read.status, 'Passed', read.error);
  assert.equal(read.vars['doc'], TEXT);
});

test('a docx this project did not write still reads: runs, tabs, breaks, entities', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpa-word-foreign-'));
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r><w:r><w:tab/><w:t>second</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>line</w:t><w:br/><w:t>broken</w:t></w:r></w:p>'
    + '</w:body></w:document>';
  const file = path.join(dir, 'foreign.docx');
  // The same three parts, but the XML is hand-written here — a different producer than buildDocx.
  await writeFile(file, writeArchive(new Map([
    ['[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')],
    ['_rels/.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')],
    ['word/document.xml', Buffer.from(document)]
  ])));

  assert.equal(await readDocx(file), 'Hello & welcome\tsecond\nline\nbroken');
});

test('the written docx carries the parts a Word file needs, and escapes its text', () => {
  const entries = readArchive(buildDocx('a <tag> & "quotes"'));
  assert.deepEqual([...entries.keys()], ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']);
  const document = entries.get('word/document.xml')!.toString('utf8');
  assert.ok(document.includes('<w:sectPr/>'));
  assert.ok(document.includes('a &lt;tag&gt; &amp; &quot;quotes&quot;'), document);
  assert.equal(documentText(document), 'a <tag> & "quotes"');
});

test('a non-docx file fails naming the file, and validation catches missing fields', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpa-word-bad-'));
  await writeFile(path.join(dir, 'notes.docx'), 'plain text, not a zip');
  const result = await engineRun(dir, [{ type: 'word', action: 'readText', path: 'notes.docx' }]);
  assert.equal(result.status, 'Failed');
  assert.match(result.error ?? '', /notes\.docx/);

  const errors = validateWorkflow(parseWorkflow(JSON.stringify([
    { type: 'word', action: 'writeText' },
    { type: 'word', action: 'readText', path: 'x.docx' }
  ])));
  assert.equal(errors.length, 2, errors.join('\n'));
});

test('LibreOffice opens the document we wrote and reads the same text back', { skip: libreOffice ? false : 'no LibreOffice on this host' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpa-word-lo-'));
  const written = await engineRun(dir, [{ type: 'word', action: 'writeText', path: 'report.docx', text: TEXT }]);
  assert.equal(written.status, 'Passed', written.error);

  await run('soffice', [
    `-env:UserInstallation=file://${dir}/lo-profile`,
    '--headless', '--convert-to', 'txt:Text (encoded):UTF8',
    '--outdir', dir, path.join(dir, 'report.docx')
  ], { timeout: 120000 });

  const converted = await readFile(path.join(dir, 'report.txt'), 'utf8');
  // LibreOffice's txt export opens with a UTF-8 BOM; the document text itself is what matters.
  assert.equal(converted.replace(/^\uFEFF/, '').replace(/\r/g, '').trimEnd(), TEXT);
});
