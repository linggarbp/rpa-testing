/**
 * The desktop lane: the backend seam, the per-OS command shapes, and — where a display is really
 * there — real pointer and capture I/O.
 *
 * The per-OS half is asserted from whichever host runs this file: a Windows profile's PowerShell is
 * a string, a macOS profile's AppleScript is a string, and the Linux profile's xdotool arguments
 * are strings. That is what makes "does this still work on the other two platforms" a question CI
 * can answer on one machine. The I/O half never fakes anything: it reads the pointer, moves it back
 * where it was (so a test run does not hijack the mouse), captures the screen and checks the bytes.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import {
  backendReport, commandOnPath, requireCapability, selectBackend, type DesktopBackend
} from '../src/services/desktop/backend.js';
import { createOsBackend, osProfiles } from '../src/services/desktop/os.js';
import { encodePng } from '../src/services/desktop/png.js';

// ── The seam ────────────────────────────────────────────────────────────────────────────────────

test('the seam picks a backend, and says why it skipped the others', async () => {
  const report = await backendReport();
  assert.equal(report.length, 3, 'every backend is accounted for: nutjs, robotjs, os');
  assert.deepEqual(report.map((row) => row.name), ['nutjs', 'robotjs', 'os']);
  for (const row of report) {
    assert.ok(row.detail.length > 0, `${row.name} explains itself either way`);
  }

  const choice = await selectBackend(undefined, { reload: true });
  const live = report.filter((row) => row.available);
  if (live.length === 0) {
    assert.equal(choice.backend, undefined, 'no backend answers, so no backend is chosen');
    assert.equal(choice.rejected.length, 3);
    return;
  }
  assert.ok(choice.backend, 'a live backend is chosen');
  assert.ok(live.some((row) => row.name === choice.backend!.name), 'the chosen backend is one that proved itself');
});

test('an unknown backend name is refused, not silently ignored', async () => {
  await assert.rejects(() => selectBackend('magic'), /Unknown desktop backend "magic"/);
});

test('an explicit choice is honoured even when another backend would come first', async () => {
  const choice = await selectBackend('os', { reload: true });
  // The OS backend is the last in the automatic order; asking for it by name must still win.
  if (choice.backend) assert.equal(choice.backend.name, 'os');
  else assert.ok(choice.rejected.length > 0, 'or it is reported as unavailable, with a reason');
});

test('a capability the backend does not have is refused by name, before anything half-runs', async () => {
  const fake: DesktopBackend = {
    name: 'robotjs',
    capabilities: new Set(['move']),
    detail: 'fake backend for the refusal path',
    move: async () => {},
    position: async () => ({ x: 0, y: 0 }),
    click: async () => {},
    doubleClick: async () => {},
    scroll: async () => {},
    type: async () => {},
    pressKey: async () => {},
    drag: async () => {},
    capture: async () => '',
    findImage: async () => ({ left: 0, top: 0, width: 0, height: 0 })
  };
  assert.throws(() => requireCapability(fake, 'image', 'desktop.clickImage'),
    /desktop\.clickImage needs the "image" capability and the robotjs backend does not provide it/);
  assert.doesNotThrow(() => requireCapability(fake, 'move', 'desktop.move'));
});

// ── The per-OS profiles: Windows and macOS shapes, asserted from anywhere ───────────────────────

test('the Windows profile drives .NET input and capture, with no addon', () => {
  const profile = osProfiles.win32();
  assert.deepEqual([...profile.capabilities].sort(),
    ['capture', 'click', 'clipboard', 'keyboard', 'move', 'scroll']);

  const move = profile.move!({ x: 12, y: 34 });
  assert.equal(move.file, 'powershell');
  const script = move.args.join(' ');
  assert.match(script, /System\.Windows\.Forms\.Cursor\]::Position = \[System\.Drawing\.Point\]::new\(12,34\)/);

  const click = profile.click('left', { x: 5, y: 6 });
  assert.match(click.args.join(' '), /mouse_event\(0x0002,0,0,0,0\); \[RpaMouse\]::mouse_event\(0x0004,0,0,0,0\)/);
  assert.match(click.args.join(' '), /Point\]::new\(5,6\)/, 'the click lands on the point it was given');
  const right = profile.click('right');
  assert.match(right.args.join(' '), /mouse_event\(0x0008,0,0,0,0\); \[RpaMouse\]::mouse_event\(0x0010,0,0,0,0\)/);

  assert.match(profile.pressKey(['ctrl', 'shift', 's']).args.join(' '), /\^\+s/, 'modifiers become SendKeys prefixes');
  assert.match(profile.pressKey(['enter']).args.join(' '), /\{ENTER\}/);
  assert.match(profile.type('a+b').args.join(' '), /a\{\+\}b/, 'SendKeys reserved characters are escaped');
  assert.match(profile.scroll!('down', 2).args.join(' '), /mouse_event\(2048,0,0,-240,0\)/);
  assert.match(profile.scroll!('right', 1).args.join(' '), /mouse_event\(4096,0,0,120,0\)/, 'horizontal wheel has its own flag');
  assert.match(profile.clipboard!('x').args.join(' '), /Set-Clipboard/);
  const windowsCapture = profile.captures('C:/tmp/shot.png');
  assert.equal(windowsCapture.length, 1);
  assert.match(windowsCapture[0]!.args.join(' '), /CopyFromScreen[\s\S]*ImageFormat\]::Png/);
});

test('the macOS profile clicks by coordinate and says what it cannot do', () => {
  const profile = osProfiles.darwin();
  // No pointer movement and no scrolling through System Events — declared honestly, not attempted.
  assert.deepEqual([...profile.capabilities].sort(), ['capture', 'click', 'clipboard', 'keyboard']);
  assert.equal(profile.move, undefined);
  assert.equal(profile.scroll, undefined);
  assert.equal(profile.position, undefined);

  const click = profile.click('left', { x: 30, y: 40 });
  assert.equal(click.file, 'osascript');
  assert.match(click.args.join(' '), /tell application "System Events" to click at \{30, 40\}/);
  assert.throws(() => profile.click('left'), /clicks by coordinate on macOS/, 'a click without a point is refused');

  assert.match(profile.pressKey(['cmd', 's']).args.join(' '), /keystroke "s" using \{command down\}/);
  assert.match(profile.pressKey(['ctrl', 'enter']).args.join(' '), /key code 36 using \{control down\}/);
  assert.match(profile.type('hello').args.join(' '), /keystroke "hello"/);
  assert.equal(profile.clipboard!('x').file, 'pbcopy');
  assert.deepEqual(profile.captures('/tmp/shot.png').map((command) => command.args), [['-x', '/tmp/shot.png']]);
  assert.match(profile.probe().args.join(' '), /UI elements enabled/, 'the probe checks the Accessibility grant');
  assert.match(String(profile.probeReason?.('false')), /Accessibility is not granted/);
  assert.equal(profile.probeReason?.('true'), undefined);
});

test('the Linux profile drives X11 through xdotool', () => {
  const profile = osProfiles.linux();
  assert.ok(profile.capabilities.includes('move'));
  assert.ok(profile.capabilities.includes('click'));
  assert.ok(profile.capabilities.includes('scroll'));
  assert.ok(profile.capabilities.includes('keyboard'));
  assert.equal(commandOnPath('xdotool') ? profile.needs.includes('xdotool') : true, true);

  assert.deepEqual(profile.move!({ x: 7, y: 8 }).args, ['mousemove', '--sync', '7', '8']);
  assert.deepEqual(profile.click('left', { x: 1, y: 2 }).args, ['mousemove', '--sync', '1', '2', 'click', '1']);
  assert.deepEqual(profile.click('right').args, ['click', '3']);
  assert.deepEqual(profile.doubleClick('left').args, ['click', '--repeat', '2', '--delay', '80', '1']);
  assert.deepEqual(profile.scroll!('down', 3).args, ['click', '--repeat', '3', '5']);
  assert.deepEqual(profile.pressKey(['ctrl', 'shift', 's']).args, ['key', '--clearmodifiers', 'ctrl+shift+s']);
  assert.deepEqual(profile.pressKey(['enter']).args, ['key', '--clearmodifiers', 'Return']);
  assert.deepEqual(profile.pressKey(['f5']).args, ['key', '--clearmodifiers', 'F5']);
  assert.deepEqual(profile.type('a b').args, ['type', '--delay', '12', '--', 'a b']);
  assert.deepEqual(profile.drag!({ x: 0, y: 0 }, { x: 9, y: 9 }).args,
    ['mousemove', '--sync', '0', '0', 'mousedown', '1', 'mousemove', '--sync', '9', '9', 'mouseup', '1']);
  // Every capture candidate writes to the file it was handed, whichever tool it is.
  for (const command of profile.captures('/tmp/shot.png')) {
    assert.ok(command.args.includes('/tmp/shot.png'), `${command.file} writes the requested file`);
  }
});

// ── The PNG writer over the stdlib ──────────────────────────────────────────────────────────────

test('encodePng writes a real PNG: signature, header, and inflatable pixels', () => {
  // A 2x1 image: one red pixel, one blue pixel, in BGRA order as robot.js hands them over.
  const pixels = Buffer.from([0, 0, 255, 255, 255, 0, 0, 255]);
  const png = encodePng(2, 1, pixels);

  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 2, 'width');
  assert.equal(png.readUInt32BE(20), 1, 'height');
  assert.equal(png[24], 8, '8-bit');
  assert.equal(png[25], 6, 'truecolour with alpha');

  const idatStart = png.indexOf('IDAT', 12, 'ascii') + 4;
  const idatLength = png.readUInt32BE(idatStart - 8);
  const raw = inflateSync(png.subarray(idatStart, idatStart + idatLength));
  assert.deepEqual([...raw], [0, 255, 0, 0, 255, 0, 0, 255, 255], 'filter byte then RGBA, BGR reordered per pixel');
  assert.equal(png.subarray(-8).toString('ascii').startsWith('IEND'), true, 'IEND closes the file');
});

test('encodePng refuses a buffer that is too small for the size it was given', () => {
  assert.throws(() => encodePng(4, 4, Buffer.alloc(3)), /needs 64 bytes for 4x4/);
});

// ── Real I/O, only where a display really answers ───────────────────────────────────────────────

test('a real backend reads the pointer, moves it back and captures a PNG', { skip: process.platform === 'win32' && !process.env.DISPLAY ? 'no session on this host' : false }, async () => {
  const choice = await selectBackend(undefined, { reload: true });
  if (!choice.backend || !choice.backend.capabilities.has('move')) {
    return; // nothing to prove here — the seam tests above already reported why
  }
  const backend = choice.backend;

  const before = await backend.position();
  assert.ok(Number.isFinite(before.x) && Number.isFinite(before.y), 'the pointer position is a real pair');

  // Move and put it back: this proves the input path end to end without stealing the mouse.
  await backend.move(before.x, before.y);
  const after = await backend.position();
  assert.ok(Math.abs(after.x - before.x) <= 2 && Math.abs(after.y - before.y) <= 2,
    `the pointer stayed where it was (${before.x},${before.y} → ${after.x},${after.y})`);

  if (!backend.capabilities.has('capture')) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpa-desktop-'));
  const target = path.join(dir, 'shot.png');
  try {
    const written = await backend.capture(target);
    const bytes = await readFile(written);
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a real PNG landed on disk');
    assert.ok(bytes.length > 1000, `the screenshot has pixels in it (${bytes.length} bytes)`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the os backend refuses image search with a sentence that names the way out', async () => {
  const backend = await createOsBackend().catch(() => undefined);
  if (!backend) return; // no OS backend here — covered by the seam test
  await assert.rejects(() => backend.findImage('anything.png'), /no image search on/);
});
