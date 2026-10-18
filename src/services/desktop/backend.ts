/**
 * The desktop backend seam.
 *
 * Every `desktop.*` step goes through one of these — never straight to a library. Three backends
 * answer the same interface, and the engine picks the first one that works on this host:
 *
 *  - `nutjs`   — nut.js (the maintained fork): mouse, keyboard, screen, clipboard, image search.
 *  - `robotjs` — robot.js: pointer, keyboard, pixels; no image search, no clipboard.
 *  - `os`      — the OS itself through the tools that ship with it (xdotool, PowerShell,
 *                osascript): no native addon, no build step, works in CI under a virtual display.
 *
 * A backend declares its `capabilities` and the engine refuses a step the chosen backend cannot
 * serve, naming what is missing — the same honest-refusal rule the rest of the toolkit follows.
 *
 * Probes run in a **child process**, never in this one: a native addon that reaches X11 can abort
 * the whole process with an X error before any JavaScript sees it (libnut's screen call did exactly
 * that on a Wayland session here). The child's exit code and last stderr line become the reason a
 * backend is unavailable, so a broken display reads as "not here" instead of killing the robot.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

export type DesktopBackendName = 'nutjs' | 'robotjs' | 'os';

/** What a backend can do. A step checks the capability it needs before it touches the OS. */
export type DesktopCapability = 'move' | 'click' | 'scroll' | 'keyboard' | 'clipboard' | 'capture' | 'image';

export interface ScreenBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DesktopPoint {
  x: number;
  y: number;
}

export type MouseButton = 'left' | 'right';
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface DesktopBackend {
  readonly name: DesktopBackendName;
  /** The capabilities this backend proves on this host (probed, not assumed). */
  readonly capabilities: ReadonlySet<DesktopCapability>;
  /** One sentence for the log line: what this backend is and why it was picked. */
  readonly detail: string;

  move(x: number, y: number): Promise<void>;
  position(): Promise<DesktopPoint>;
  /** Click. With `at`, the backend clicks that point even if the pointer sits elsewhere. */
  click(button: MouseButton, at?: DesktopPoint): Promise<void>;
  doubleClick(button: MouseButton, at?: DesktopPoint): Promise<void>;
  scroll(direction: ScrollDirection, amount: number): Promise<void>;
  type(text: string): Promise<void>;
  pressKey(names: string[]): Promise<void>;
  drag(from: DesktopPoint, to: DesktopPoint): Promise<void>;

  /** Write text to the clipboard. Absent on a backend that has no clipboard tool. */
  clipboardWrite?(text: string): Promise<void>;
  /** Capture the screen to a PNG and return the path it was written to. */
  capture(target: string): Promise<string>;
  /** Find an image on screen. Backends without `image` throw the sentence in `capabilities`. */
  findImage(imagePath: string, options?: { threshold?: number; timeoutMs?: number }): Promise<ScreenBox>;
}

export class DesktopCapabilityError extends Error {}

/** Refuse a step the backend cannot serve, by name, before anything half-runs. */
export function requireCapability(backend: DesktopBackend, capability: DesktopCapability, step: string): void {
  if (backend.capabilities.has(capability)) return;
  throw new DesktopCapabilityError(
    `${step} needs the "${capability}" capability and the ${backend.name} backend does not provide it on ` +
      `${process.platform} — ${backend.detail}`
  );
}

/** A command that is on PATH here, or undefined. */
export function commandOnPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next directory */
    }
  }
  return undefined;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/**
 * Load a module and ask it one question in a child process. `expression` is JavaScript evaluated
 * with the module as `m`, e.g. `m.screen.width()`; its value is the proof that the backend drives
 * this display. A crash, a signal, a timeout or a non-zero exit all read as unavailable.
 */
export function probeInChild(moduleName: string, expression: string, timeoutMs = 20000): Promise<ProbeResult> {
  const script = [
    `const spec = ${JSON.stringify(moduleName)};`,
    'try {',
    '  const m = await import(spec);',
    `  const value = await (${expression});`,
    "  console.log('OK ' + String(value));",
    '} catch (error) {',
    "  console.error('ERR ' + (error && error.message ? error.message : String(error)));",
    '  process.exit(3);',
    '}'
  ].join('\n');

  return new Promise<ProbeResult>((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, detail: `${moduleName} did not answer within ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: `${moduleName} could not be probed: ${error.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && stdout.startsWith('OK')) {
        resolve({ ok: true, detail: `${moduleName} answered (${stdout.trim().slice(3)})` });
        return;
      }
      // The interesting line, not the last one: a native addon that dies on X11 prints its error
      // first and bookkeeping after it.
      const lines = stderr.trim().split('\n').map((line) => line.trim()).filter(Boolean);
      const interesting = lines.find((line) => /not installed|Cannot find package|refused|Error|error|BadMatch/i.test(line)) ?? lines.pop();
      const reason = (interesting ?? (signal ? `killed by ${signal}` : `exit ${String(code)}`)).replace(/^ERR\s*/, '');
      const missing = /Cannot find package/.test(reason);
      resolve({
        ok: false,
        detail: missing
          ? `${moduleName} is not installed (optional dependency)`
          : `${moduleName} refused this display: ${reason.slice(0, 200)}`
      });
    });
  });
}

export interface BackendChoice {
  backend: DesktopBackend | undefined;
  /** Why the preferred backend was not used, in order — the honest half of the log line. */
  rejected: Array<{ name: DesktopBackendName; reason: string }>;
}

const ORDER: DesktopBackendName[] = ['nutjs', 'robotjs', 'os'];

let cached: BackendChoice | undefined;

function parsePreference(preference: string | undefined): DesktopBackendName[] {
  const wanted = (preference ?? process.env.RPA_DESKTOP_BACKEND ?? 'auto').trim().toLowerCase();
  if (wanted === 'auto' || wanted === '') return ORDER;
  const name = wanted as DesktopBackendName;
  if (!ORDER.includes(name)) {
    throw new Error(`Unknown desktop backend "${wanted}" — auto | ${ORDER.join(' | ')}.`);
  }
  // An explicit choice first, then the rest as fallbacks: a step still runs on a host where the
  // wanted backend cannot load, and the log says it happened.
  return [name, ...ORDER.filter(candidate => candidate !== name)];
}

/**
 * Pick the desktop backend for this host. `preference` (a step's `backend` field, or the
 * `RPA_DESKTOP_BACKEND` variable) wins over the automatic order; the choice is cached per run
 * because probing loads native modules.
 */
export async function selectBackend(preference?: string, options: { reload?: boolean } = {}): Promise<BackendChoice> {
  if (cached && !options.reload && preference === undefined) return cached;
  const rejected: BackendChoice['rejected'] = [];
  for (const name of parsePreference(preference)) {
    try {
      const backend = await loadBackend(name);
      const choice: BackendChoice = { backend, rejected };
      if (preference === undefined) cached = choice;
      return choice;
    } catch (error) {
      rejected.push({ name, reason: (error as Error).message });
    }
  }
  return { backend: undefined, rejected };
}

async function loadBackend(name: DesktopBackendName): Promise<DesktopBackend> {
  if (name === 'nutjs') {
    // The probe captures: a display can answer a size query and still refuse XGetImage (this
    // host's Wayland session did), and the capture is the call the screenshot step depends on.
    const probe = await probeInChild('@nut-tree-fork/nut-js',
      "(async () => { const os = await import('node:os'); const fs = await import('node:fs/promises'); "
      + "const file = await m.screen.capture('rpa-probe-' + process.pid, undefined, os.tmpdir()); "
      + "await fs.unlink(file).catch(() => {}); return file; })()");
    if (!probe.ok) throw new Error(probe.detail);
    // The specifier is a variable on purpose: a literal specifier would be resolved by the
    // type-check on a host that did not install the optional dependency.
    const specifier = '@nut-tree-fork/nut-js';
    const module = await import(specifier);
    return (await import('./nutjs.js')).createNutjsBackend(module);
  }
  if (name === 'robotjs') {
    const probe = await probeInChild('robotjs', 'm.screen.capture().width');
    if (!probe.ok) throw new Error(probe.detail);
    const specifier = 'robotjs';
    const module = await import(specifier);
    return (await import('./robotjs.js')).createRobotjsBackend(module);
  }
  return (await import('./os.js')).createOsBackend();
}

/** The picture `rpa doctor` prints: which backends load here and what each one proved. */
export async function backendReport(): Promise<Array<{ name: DesktopBackendName; available: boolean; detail: string }>> {
  const rows: Array<{ name: DesktopBackendName; available: boolean; detail: string }> = [];
  for (const name of ORDER) {
    try {
      const backend = await loadBackend(name);
      rows.push({
        name,
        available: true,
        detail: `${[...backend.capabilities].sort().join(', ') || 'nothing'} — ${backend.detail}`
      });
    } catch (error) {
      rows.push({ name, available: false, detail: (error as Error).message });
    }
  }
  return rows;
}

/** Tests probe several backends in one process; the cache would hide the second probe. */
export function resetBackendCache(): void {
  cached = undefined;
}
