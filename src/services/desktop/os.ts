/**
 * The OS backend — the real desktop, through the tools the operating system already ships.
 *
 * No native addon and no build step: `xdotool` on Linux/X11, PowerShell over the .NET input and
 * drawing assemblies on Windows, `osascript` + `screencapture` on macOS. That makes a robot host
 * installable with `npm i` alone, and it is the only backend a CI container can exercise for real
 * under a virtual display.
 *
 * Each platform declares only what it can actually do here — macOS, for instance, clicks and types
 * through System Events but cannot move the pointer, so `move` stays off its capability list and a
 * `desktop.move` step is refused by name instead of half-happening. The probe is per platform too:
 * a pointer read on Linux and Windows, the Accessibility grant on macOS.
 */
import { spawn } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  DesktopBackend,
  DesktopCapability,
  DesktopPoint,
  MouseButton,
  ScrollDirection,
  ScreenBox
} from './backend.js';
import { commandOnPath } from './backend.js';

interface Command {
  file: string;
  args: string[];
  /** Written to the child's stdin and then closed (clipboard tools read the payload that way). */
  stdin?: string;
}

interface OsProfile {
  capabilities: DesktopCapability[];
  detail: string;
  /** Binaries that must be on PATH for this profile to answer at all. */
  needs: string[];
  /** Proof that this host can actually be driven — not just that the tools are installed. */
  probe(): Command;
  /** A reason the probe output is not good enough; undefined means the host is ready. */
  probeReason?(stdout: string): string | undefined;
  parsePoint?(stdout: string): DesktopPoint;
  move?(point: DesktopPoint): Command;
  position?(): Command;
  click(button: MouseButton, at?: DesktopPoint): Command;
  doubleClick(button: MouseButton, at?: DesktopPoint): Command;
  scroll?(direction: ScrollDirection, amount: number): Command;
  type(text: string): Command;
  pressKey(names: string[]): Command;
  drag?(from: DesktopPoint, to: DesktopPoint): Command;
  clipboard?(text: string): Command;
  /** Capture commands, best first: the backend tries each until one really writes a file. */
  captures(target: string): Command[];
}

const pair = (stdout: string): DesktopPoint => {
  const [x, y] = stdout.split(',').map(value => Number(value.trim()));
  return { x: x ?? 0, y: y ?? 0 };
};

// ── Linux / X11 ────────────────────────────────────────────────────────────────────────────────

/** xdotool mouse buttons: 1 left, 3 right; 4/5 wheel, 6/7 horizontal wheel. */
const XDOTOOL_BUTTON: Record<MouseButton, number> = { left: 1, right: 3 };
const XDOTOOL_SCROLL: Record<ScrollDirection, number> = { up: 4, down: 5, left: 6, right: 7 };

/** Key names as xdotool spells them (X keysyms). */
const XDOTOOL_KEYS: Record<string, string> = {
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super', cmd: 'super', win: 'super', super: 'super',
  enter: 'Return', return: 'Return', tab: 'Tab', escape: 'Escape', esc: 'Escape', space: 'space',
  backspace: 'BackSpace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', insert: 'Insert'
};

function xdotoolKey(name: string): string {
  const value = name.trim();
  if (value.length === 1) return value;
  const lower = value.toLowerCase();
  if (XDOTOOL_KEYS[lower]) return XDOTOOL_KEYS[lower]!;
  if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
  return value;
}

function linuxProfile(): OsProfile {
  const clipboardTool = ['xclip', 'xsel'].find(tool => commandOnPath(tool));
  // Capture candidates, best first. Which one *works* is proved when the backend is created: on
  // this project's own host `import` is installed and still refuses the screen, and ffmpeg's
  // x11grab is what actually grabs it.
  const captures = (target: string): Command[] => {
    const commands: Command[] = [];
    if (commandOnPath('import')) commands.push({ file: 'import', args: ['-window', 'root', target] });
    if (commandOnPath('scrot')) commands.push({ file: 'scrot', args: [target] });
    if (commandOnPath('gnome-screenshot')) commands.push({ file: 'gnome-screenshot', args: ['-f', target] });
    if (commandOnPath('spectacle')) commands.push({ file: 'spectacle', args: ['-b', '-n', '-o', target] });
    const display = process.env.DISPLAY;
    if (display && commandOnPath('ffmpeg')) {
      commands.push({
        file: 'ffmpeg',
        args: ['-loglevel', 'error', '-f', 'x11grab', '-i', display, '-frames:v', '1', '-y', target]
      });
    }
    return commands;
  };
  const capabilities: DesktopCapability[] = ['move', 'click', 'scroll', 'keyboard', 'capture'];
  if (clipboardTool) capabilities.push('clipboard');

  const moveCommand = (point: DesktopPoint): string[] => ['mousemove', '--sync', String(point.x), String(point.y)];

  return {
    capabilities,
    detail: `xdotool on Linux/X11${clipboardTool ? ` (+ ${clipboardTool})` : ''}`,
    needs: ['xdotool'],

    probe: () => ({ file: 'xdotool', args: ['getmouselocation', '--shell'] }),
    probeReason: stdout => (/X=\d+[\s\S]*Y=\d+/.test(stdout)
      ? undefined
      : `xdotool answered without a pointer position ("${stdout.split('\n')[0]}") — no usable X display`),
    parsePoint: stdout => {
      const x = Number(/X=(\d+)/.exec(stdout)?.[1] ?? '0');
      const y = Number(/Y=(\d+)/.exec(stdout)?.[1] ?? '0');
      return { x, y };
    },

    move: point => ({ file: 'xdotool', args: moveCommand(point) }),
    position: () => ({ file: 'xdotool', args: ['getmouselocation', '--shell'] }),
    click: (button, at) => ({ file: 'xdotool', args: [
      ...(at ? moveCommand(at) : []), 'click', String(XDOTOOL_BUTTON[button])
    ] }),
    doubleClick: (button, at) => ({ file: 'xdotool', args: [
      ...(at ? moveCommand(at) : []), 'click', '--repeat', '2', '--delay', '80', String(XDOTOOL_BUTTON[button])
    ] }),
    scroll: (direction, amount) => ({
      file: 'xdotool',
      args: ['click', '--repeat', String(Math.max(1, Math.round(amount))), String(XDOTOOL_SCROLL[direction])]
    }),
    type: text => ({ file: 'xdotool', args: ['type', '--delay', '12', '--', text] }),
    pressKey: names => ({ file: 'xdotool', args: ['key', '--clearmodifiers', names.map(xdotoolKey).join('+')] }),
    drag: (from, to) => ({
      file: 'xdotool',
      args: [
        ...moveCommand(from), 'mousedown', '1',
        ...moveCommand(to), 'mouseup', '1'
      ]
    }),
    ...(clipboardTool
      ? {
          clipboard: (text: string): Command => clipboardTool === 'xclip'
            ? { file: 'xclip', args: ['-selection', 'clipboard', '-in'], stdin: text }
            : { file: 'xsel', args: ['--clipboard', '--input'], stdin: text }
        }
      : {}),
    captures
  };
}

// ── Windows (PowerShell, no addon) ─────────────────────────────────────────────────────────────

const PS_HEAD = 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing';
const PS_MOUSE_TYPE = 'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;'
  + 'public class RpaMouse{[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);}\'';
const PS_POINT = (point: DesktopPoint): string => `[System.Windows.Forms.Cursor]::Position = [System.Drawing.Point]::new(${point.x},${point.y})`;

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** SendKeys reserves these; each is written wrapped in braces to mean itself. */
function sendKeysText(text: string): string {
  return text.replace(/[+^%~()[\]{}]/g, character => `{${character}}`);
}

const PS_KEYS: Record<string, string> = {
  enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}', space: ' ',
  backspace: '{BACKSPACE}', delete: '{DELETE}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', insert: '{INS}'
};

function psKeyCombo(names: string[]): string {
  let modifiers = '';
  const keys = [...names];
  while (keys.length > 1) {
    const head = keys[0]!.toLowerCase();
    if (head === 'ctrl' || head === 'control') modifiers += '^';
    else if (head === 'shift') modifiers += '+';
    else if (head === 'alt') modifiers += '%';
    else break;
    keys.shift();
  }
  const key = keys.shift() ?? '';
  const lower = key.toLowerCase();
  if (PS_KEYS[lower]) return `${modifiers}${PS_KEYS[lower]}`;
  if (/^f\d{1,2}$/.test(lower)) return `${modifiers}{${lower.toUpperCase()}}`;
  return `${modifiers}${sendKeysText(key)}`;
}

function windowsProfile(): OsProfile {
  const clickPair = (button: MouseButton): string => button === 'right'
    ? '[RpaMouse]::mouse_event(0x0008,0,0,0,0); [RpaMouse]::mouse_event(0x0010,0,0,0,0)'
    : '[RpaMouse]::mouse_event(0x0002,0,0,0,0); [RpaMouse]::mouse_event(0x0004,0,0,0,0)';
  const script = (body: string): Command => ({ file: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', body] });

  return {
    capabilities: ['move', 'click', 'scroll', 'keyboard', 'clipboard', 'capture'],
    detail: 'PowerShell + .NET (System.Windows.Forms, System.Drawing) on Windows — no addon',
    needs: ['powershell'],

    probe: () => script(`${PS_HEAD};$p = [System.Windows.Forms.Cursor]::Position; Write-Output "$($p.X),$($p.Y)"`),
    probeReason: stdout => (/^\d+\s*,\s*\d+$/.test(stdout) ? undefined : `no desktop session answered ("${stdout}")`),
    parsePoint: pair,

    move: point => script(`${PS_HEAD};${PS_POINT(point)}`),
    position: () => script(`${PS_HEAD};$p = [System.Windows.Forms.Cursor]::Position; Write-Output "$($p.X),$($p.Y)"`),
    click: (button, at) => script(`${PS_HEAD};${PS_MOUSE_TYPE};${at ? `${PS_POINT(at)};` : ''}${clickPair(button)}`),
    doubleClick: (button, at) => script(
      `${PS_HEAD};${PS_MOUSE_TYPE};${at ? `${PS_POINT(at)};` : ''}${clickPair(button)}; Start-Sleep -Milliseconds 60; ${clickPair(button)}`
    ),
    scroll: (direction, amount) => {
      const notches = Math.max(1, Math.round(amount)) * 120;
      const flag = direction === 'left' || direction === 'right' ? 0x1000 : 0x0800;
      // A positive wheel delta scrolls away from the user: up vertically, right horizontally.
      const delta = direction === 'down' || direction === 'left' ? -notches : notches;
      return script(`${PS_HEAD};${PS_MOUSE_TYPE};[RpaMouse]::mouse_event(${flag},0,0,${delta},0)`);
    },
    type: text => script(`${PS_HEAD};[System.Windows.Forms.SendKeys]::SendWait(${psString(sendKeysText(text))})`),
    pressKey: names => script(`${PS_HEAD};[System.Windows.Forms.SendKeys]::SendWait(${psString(psKeyCombo(names))})`),
    drag: (from, to) => script(
      `${PS_HEAD};${PS_MOUSE_TYPE};${PS_POINT(from)};[RpaMouse]::mouse_event(0x0002,0,0,0,0);`
      + ` Start-Sleep -Milliseconds 40;${PS_POINT(to)};[RpaMouse]::mouse_event(0x0004,0,0,0,0)`
    ),
    clipboard: (text: string) => script(`Set-Clipboard -Value ${psString(text)}`),
    captures: target => [script(
      `${PS_HEAD};$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;`
      + '$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height);'
      + '$g = [System.Drawing.Graphics]::FromImage($bmp);'
      + '$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size);'
      + `$bmp.Save(${psString(target)}, [System.Drawing.Imaging.ImageFormat]::Png)`
    )]
  };
}

// ── macOS (osascript + screencapture) ──────────────────────────────────────────────────────────

/** System Events key codes for the keys that are not a printable character. */
const MAC_KEY_CODES: Record<string, number> = {
  enter: 36, return: 36, tab: 48, space: 49, backspace: 51, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121, delete: 117
};

function macModifiers(names: string[]): { using: string; rest: string[] } {
  const held: string[] = [];
  const rest = [...names];
  while (rest.length > 1) {
    const head = rest[0]!.toLowerCase();
    const mapped = head === 'ctrl' || head === 'control' ? 'control'
      : head === 'shift' ? 'shift'
        : head === 'alt' || head === 'option' ? 'option'
          : head === 'meta' || head === 'cmd' || head === 'command' || head === 'win' || head === 'super' ? 'command'
            : undefined;
    if (!mapped) break;
    held.push(mapped);
    rest.shift();
  }
  return { using: held.length > 0 ? ` using {${held.map(name => `${name} down`).join(', ')}}` : '', rest };
}

function macProfile(): OsProfile {
  const applescript = (body: string): Command => ({ file: 'osascript', args: ['-e', `tell application "System Events" to ${body}`] });
  const needPoint = (at?: DesktopPoint): DesktopPoint => {
    if (at) return at;
    throw new Error(
      'the OS backend clicks by coordinate on macOS (System Events has no pointer position) — give the step a target, ' +
      'or install nut.js (npm i @nut-tree-fork/nut-js) to click wherever the pointer already is.'
    );
  };

  return {
    // Clicking and typing work through System Events; moving the pointer and scrolling do not.
    capabilities: ['click', 'keyboard', 'clipboard', 'capture'],
    detail: 'osascript (System Events) + screencapture on macOS — click, type, clipboard, capture; no pointer movement',
    needs: ['osascript'],

    probe: () => ({ file: 'osascript', args: ['-e', 'tell application "System Events" to get UI elements enabled'] }),
    probeReason: stdout => (stdout.trim().toLowerCase() === 'true'
      ? undefined
      : 'Accessibility is not granted to this terminal — System Settings › Privacy & Security › Accessibility'),

    click: (button, at) => {
      const point = needPoint(at);
      void button; // System Events has one click; a right-click needs the nut.js backend
      return applescript(`click at {${point.x}, ${point.y}}`);
    },
    doubleClick: (_button, at) => {
      const point = needPoint(at);
      return applescript(`click at {${point.x}, ${point.y}}\n delay 0.05 \n tell application "System Events" to click at {${point.x}, ${point.y}}`);
    },
    type: text => applescript(`keystroke ${JSON.stringify(text)}`),
    pressKey: names => {
      const { using, rest } = macModifiers(names);
      const key = rest[0] ?? '';
      const code = MAC_KEY_CODES[key.toLowerCase()];
      return applescript(code !== undefined
        ? `key code ${code}${using}`
        : `keystroke ${JSON.stringify(key)}${using}`);
    },
    clipboard: (text: string) => ({ file: 'pbcopy', args: [], stdin: text }),
    captures: target => [{ file: 'screencapture', args: ['-x', target] }]
  };
}

const PROFILES: Partial<Record<NodeJS.Platform, () => OsProfile>> = {
  linux: linuxProfile,
  win32: windowsProfile,
  darwin: macProfile
};

/** Wait for a capture to land on disk: some tools fork and return before the file is written. */
async function waitForFile(target: string, graceMs = 800): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    if (await stat(target).then(() => true, () => false)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Prove that a capture command really grabs this screen: try each one on a throwaway file and keep
 * the first that writes something. A tool that is installed but cannot reach the display — or exits
 * without leaving a file — is not a capability, and the detail line says so instead of a step
 * failing later.
 */
async function proveCapture(profile: OsProfile, timeoutMs: number): Promise<{ tool?: string; reason?: string }> {
  const target = path.join(os.tmpdir(), `rpa-capture-probe-${process.pid}.png`);
  const commands = profile.captures(target);
  if (commands.length === 0) return { reason: 'no capture tool is installed' };
  let reason = '';
  try {
    for (const command of commands) {
      try {
        await run(command, timeoutMs);
        if (await waitForFile(target)) return { tool: command.file };
        reason = `${command.file} exited without writing a file`;
      } catch (error) {
        reason = (error as Error).message.split('\n')[0] ?? '';
      }
    }
  } finally {
    await rm(target, { force: true });
  }
  return { reason };
}

/** Run one command to completion. stdout comes back trimmed; stderr becomes the error message. */
function run(command: Command, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command.file, command.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command.file} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    // Most of these commands read no stdin and exit immediately, which closes the pipe under us:
    // EPIPE on the way in is not a failure of the command, and an unhandled stream error would
    // take the whole run down (CI caught exactly that).
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stderr += `${error.message}\n`;
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command.file} failed (exit ${code}): ${(stderr.trim() || stdout.trim()).split('\n')[0]}`));
    });
    child.stdin.end(command.stdin ?? '');
  });
}

export async function createOsBackend(timeoutMs = 20000): Promise<DesktopBackend> {
  const build = PROFILES[process.platform];
  if (!build) throw new Error(`the OS backend has no profile for ${process.platform} (linux | win32 | darwin).`);
  const profile = build();

  for (const tool of profile.needs) {
    if (!commandOnPath(tool)) {
      throw new Error(`${tool} is not on PATH, so the OS backend cannot drive this ${process.platform} host`);
    }
  }
  const probe = await run(profile.probe(), timeoutMs);
  const reason = profile.probeReason?.(probe);
  if (reason) throw new Error(`the OS backend is installed but not usable: ${reason}`);

  // Capture is proved like everything else: a tool on PATH that cannot grab this screen is not a
  // capability, and the reason rides along in the backend's detail line.
  const capabilities = new Set(profile.capabilities);
  let detail = profile.detail;
  let provenCapture: string | undefined;
  if (capabilities.has('capture')) {
    const proof = await proveCapture(profile, timeoutMs);
    provenCapture = proof.tool;
    if (proof.tool) detail = `${detail} — capture via ${proof.tool}`;
    else {
      capabilities.delete('capture');
      detail = `${detail} — no working screen capture here (${proof.reason})`;
    }
  }

  const unsupported = (what: string) => async (): Promise<never> => {
    throw new Error(
      `the OS backend cannot ${what} on ${process.platform} — ${profile.detail}. Install the nut.js backend ` +
      '(npm i @nut-tree-fork/nut-js) for full pointer control here.'
    );
  };

  return {
    name: 'os',
    capabilities,
    detail,

    move: profile.move ? (x, y) => run(profile.move!({ x, y }), timeoutMs).then(() => undefined) : unsupported('move the pointer'),
    position: profile.position
      ? async () => profile.parsePoint!(await run(profile.position!(), timeoutMs))
      : unsupported('read the pointer position'),
    click: (button, at) => run(profile.click(button, at), timeoutMs).then(() => undefined),
    doubleClick: (button, at) => run(profile.doubleClick(button, at), timeoutMs).then(() => undefined),
    scroll: profile.scroll
      ? (direction, amount) => run(profile.scroll!(direction, amount), timeoutMs).then(() => undefined)
      : unsupported('scroll'),
    type: text => run(profile.type(text), timeoutMs).then(() => undefined),
    pressKey: names => run(profile.pressKey(names), timeoutMs).then(() => undefined),
    drag: profile.drag
      ? (from, to) => run(profile.drag!(from, to), timeoutMs).then(() => undefined)
      : unsupported('drag'),
    ...(profile.clipboard
      ? { clipboardWrite: (text: string) => run(profile.clipboard!(text), timeoutMs).then(() => undefined) }
      : {}),
    async capture(target) {
      if (!capabilities.has('capture')) throw new Error(`the OS backend cannot capture on ${process.platform} — ${detail}`);
      // The tool the probe proved goes first: on a host where the first candidate is installed but
      // useless (ImageMagick's `import`), trying it again per capture would burn a grace period each
      // time — enough to turn a retrying workflow into a slow one.
      const candidates = profile.captures(target);
      const ordered = provenCapture
        ? [...candidates.filter((command) => command.file === provenCapture), ...candidates.filter((command) => command.file !== provenCapture)]
        : candidates;
      let lastError: Error | undefined;
      for (const command of ordered) {
        try {
          await run(command, timeoutMs);
          if (await waitForFile(target)) return target;
          lastError = new Error(`${command.file} exited without writing ${target}`);
        } catch (error) {
          lastError = error as Error;
        }
      }
      throw lastError ?? new Error(`no capture command is available on this ${process.platform} host`);
    },
    async findImage(): Promise<ScreenBox> {
      throw new Error(
        `the OS backend has no image search on ${process.platform} — install nut.js (npm i @nut-tree-fork/nut-js), ` +
        'or use `ocr.recognize` / `ai-vision.decide` on a captured screenshot instead.'
      );
    }
  };
}

/** The command shapes, exported for tests: the Windows and macOS profiles are asserted from Linux. */
export const osProfiles = { linux: linuxProfile, win32: windowsProfile, darwin: macProfile };
