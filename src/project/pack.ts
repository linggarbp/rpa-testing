/**
 * Packages — a workflow project as one file.
 *
 * A `.rpapkg` is a zip holding the project's files plus a `manifest.json` (name, version, entry and
 * a sha256 per file). `rpa pack` writes it, `rpa run` accepts it: the archive is extracted to a
 * temporary folder, every file is checked against the manifest, and the entry workflow runs with the
 * extracted folder as its project root — so `invoke`, `config.load`, files and the queue resolve the
 * way they do when the project sits on disk.
 *
 * Deliberately small: the zip is written and read here (node:zlib, no dependency) and there is no
 * signing. A hash in a manifest catches a corrupted or edited archive; it is not authentication.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const MANIFEST_FILE = 'manifest.json';

export interface PackManifest {
  name: string;
  version: string;
  /** The workflow the package starts from, relative to the package root. */
  entry: string;
  /** Relative file path → sha256 of its bytes. */
  files: Record<string, string>;
}

export interface PackResult {
  file: string;
  entry: string;
  files: number;
  bytes: number;
}

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

// ── zip (write + read) ─────────────────────────────────────────────────────────────────────────

let crcTable: number[] | undefined;

function crc32(buffer: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  crc: number;
  compressed: Buffer;
  uncompressedLength: number;
}

/** Zip the given entries (path → bytes) in the order given. Deflated, no timestamps to keep it reproducible. */
export function writeArchive(files: Map<string, Buffer>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(content, { level: 6 });
    const body = deflated.length < content.length ? deflated : content;
    const method = body === deflated ? 8 : 0;
    const crc = crc32(content);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);          // version needed
    header.writeUInt16LE(0x0800, 6);      // UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(0, 10);          // time: fixed, so packing twice gives the same bytes
    header.writeUInt16LE(0x21, 12);       // date: 1980-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, nameBuffer, body);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);       // version made by
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0x21, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(body.length, 20);
    directory.writeUInt32LE(content.length, 24);
    directory.writeUInt16LE(nameBuffer.length, 28);
    directory.writeUInt16LE(0, 30);       // extra
    directory.writeUInt16LE(0, 32);       // comment
    directory.writeUInt16LE(0, 34);       // disk
    directory.writeUInt16LE(0, 36);       // internal attributes
    directory.writeUInt32LE(0, 38);       // external attributes
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBuffer);

    offset += header.length + nameBuffer.length + body.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, centralBuffer, end]);
}

/** Read a zip's entries (path → bytes) by walking its central directory. */
export function readArchive(buffer: Buffer): Map<string, Buffer> {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Not a zip archive: no end-of-central-directory record.');

  const entries = new Map<string, Buffer>();
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);

  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`Broken central directory at entry ${index + 1}.`);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedLength = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const body = buffer.subarray(start, start + compressedLength);
    entries.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// ── the package ────────────────────────────────────────────────────────────────────────────────

/** Folders that are machinery rather than a project: state, caches, the archive itself. */
const SKIPPED = new Set(['.git', '.rpa', 'node_modules', 'runs']);

async function collect(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name) || entry.name.startsWith('.')) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await collect(path.join(dir, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

/** sha256 per file, keyed by relative path — the manifest's `files` map. */
export function fileHashes(files: Map<string, Buffer>): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const [name, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (name === MANIFEST_FILE) continue;
    hashes[name] = sha256(content);
  }
  return hashes;
}

/** Zip a project folder into `<out>` with a manifest beside its files. */
export async function packProject(
  projectDir: string,
  outFile: string,
  options: { name?: string; version?: string; entry?: string } = {}
): Promise<PackResult> {
  const root = path.resolve(projectDir);
  const entry = options.entry ?? 'Main.json';
  const files = new Map<string, Buffer>();
  for (const relative of await collect(root)) {
    files.set(relative, await readFile(path.join(root, relative)));
  }
  if (files.size === 0) throw new Error(`${root} has no files to pack.`);
  if (!files.has(entry)) {
    const workflows = [...files.keys()].filter((name) => name.endsWith('.json')).sort();
    throw new Error(`entry "${entry}" is not in ${root} — use --entry; JSON files here: ${workflows.join(', ') || '(none)'}.`);
  }

  const manifest: PackManifest = {
    name: options.name ?? path.basename(root),
    version: options.version ?? '0.1.0',
    entry,
    files: fileHashes(files)
  };
  // The manifest goes in first so a reader has it before anything else.
  const archive = new Map<string, Buffer>([[MANIFEST_FILE, Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8')], ...files]);
  const buffer = writeArchive(archive);

  const out = path.resolve(outFile);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, buffer);
  return { file: out, entry, files: files.size, bytes: buffer.length };
}

/** Check an archive against its own manifest. Returns the manifest; throws naming what is wrong. */
export function verifyArchive(entries: Map<string, Buffer>): PackManifest {
  const declared = entries.get(MANIFEST_FILE);
  if (!declared) throw new Error(`Not a package: ${MANIFEST_FILE} is missing.`);
  const manifest = JSON.parse(declared.toString('utf8')) as PackManifest;
  if (!manifest.entry || !manifest.files) throw new Error(`${MANIFEST_FILE} has no entry or file list.`);

  for (const [name, content] of entries) {
    if (name === MANIFEST_FILE) continue;
    const expected = manifest.files[name];
    if (!expected) throw new Error(`${name} is in the package but not in the manifest.`);
    const actual = sha256(content);
    if (actual !== expected) {
      throw new Error(`${name} does not match the manifest (sha256 ${actual.slice(0, 12)}… ≠ ${expected.slice(0, 12)}…) — the package was modified after packing.`);
    }
  }
  for (const name of Object.keys(manifest.files)) {
    if (!entries.has(name)) throw new Error(`${name} is listed in the manifest but missing from the package.`);
  }
  return manifest;
}

export interface UnpackedPackage {
  dir: string;
  entry: string;
  manifest: PackManifest;
  cleanup: () => Promise<void>;
}

/** Extract a verified package to a temporary folder and return its entry workflow's path. */
export async function unpack(archiveFile: string): Promise<UnpackedPackage> {
  const entries = readArchive(await readFile(archiveFile));
  const manifest = verifyArchive(entries);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpa-pkg-'));
  for (const [name, content] of entries) {
    const file = path.resolve(dir, name);
    if (!file.startsWith(dir + path.sep)) throw new Error(`Refusing "${name}": it escapes the package.`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return { dir, entry: path.join(dir, manifest.entry), manifest, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
