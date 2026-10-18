/**
 * `rpa doctor` — machine diagnostics, in the shape of a collector run (the pattern every support
 * tool ends up inventing):
 *
 *   - each **collector** answers one question about this machine and never modifies anything;
 *   - a **profile** selects which collectors run, so a box that only dispatches desktop work is not
 *     asked about mail, and a box with no display is not asked which backend drives one;
 *   - the **report** is one JSON object; `--out report.zip` writes it as a one-entry archive, the
 *     way a support case would be filed.
 *
 * Read-only by construction: module probes, stat calls and environment reads. Every collector is
 * cross-platform; the platform differences show up as facts ("powershell: n/a on this platform"),
 * not as crashes.
 */
import { createRequire } from 'node:module';
import { constants, existsSync } from 'node:fs';
import { backendReport } from './desktop/backend.js';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseWorkflow, validateWorkflow } from '../workflow/model.js';
import { writeArchive } from '../project/pack.js';

export const DOCTOR_PROFILES = ['default', 'desktop', 'robot'] as const;
export type DoctorProfile = (typeof DOCTOR_PROFILES)[number];

export type CollectorStatus = 'ok' | 'warn' | 'fail';

export interface CollectorResult {
  name: string;
  status: CollectorStatus;
  /** Key facts the collector observed — strings, so the report reads the same in any terminal. */
  facts: Record<string, string>;
  /** Human notes: what is affected, and what to do about it. Empty when nothing is wrong. */
  notes: string[];
}

export interface DoctorReport {
  tool: string;
  version: string;
  generatedAt: string;
  profile: DoctorProfile;
  collectors: CollectorResult[];
  summary: { warnings: number; problems: number };
}

export interface DoctorOptions {
  profile?: DoctorProfile;
  /** When given, the report also validates this project's workflows and checks it is writable. */
  projectDir?: string;
  /** File to write the report to: `.json` plain, `.zip` a one-entry archive. */
  out?: string;
}

const require = createRequire(import.meta.url);

/** The toolkit's own version, from its package.json (works from src/ and from a build). */
function ownVersion(): string {
  try {
    return (require('../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Resolve a module's installed version without assuming how deep its main file sits. */
function packageVersion(name: string): string {
  try {
    let dir = path.dirname(require.resolve(name));
    for (let depth = 0; depth < 6; depth++) {
      const candidate = path.join(dir, 'package.json');
      if (existsSync(candidate)) {
        const parsed = require(candidate) as { name?: string; version?: string };
        if (parsed.name === name) return parsed.version ?? 'unknown';
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* fall through */
  }
  return 'unknown';
}

/**
 * Load an optional module. The specifier is a variable on purpose: a literal `import('exceljs')`
 * is resolved at type-check time and fails on a host that did not install that optional package.
 */
async function probeModule(name: string): Promise<{ installed: boolean; version: string }> {
  try {
    await import(name);
    return { installed: true, version: packageVersion(name) };
  } catch {
    return { installed: false, version: '' };
  }
}

/** `command -v` with a version probe: null when the executable is not on PATH. No shell on purpose —
 *  a missing .exe must surface as ENOENT, not as a cmd.exe error line that looks like output. */
function commandVersion(command: string): string | null {
  try {
    const result = spawnSync(command, ['-v'], { encoding: 'utf8', timeout: 5000 });
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n')[0]?.trim() ?? '';
    return output !== '' ? output : 'present';
  } catch {
    return null;
  }
}

async function collectRuntime(): Promise<CollectorResult> {
  return {
    name: 'runtime',
    status: 'ok',
    facts: {
      node: process.version,
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      cpus: String(os.cpus().length),
      memory: `${Math.round(os.freemem() / 1024 / 1024)} MB free of ${Math.round(os.totalmem() / 1024 / 1024)} MB`,
      cwd: process.cwd()
    },
    notes: []
  };
}

/** Optional capabilities: what each module unlocks, and whether this machine has it. */
const OPTIONAL_MODULES: Array<{ name: string; unlocks: string }> = [
  { name: 'robotjs', unlocks: 'desktop steps (fallback backend)' },
  { name: '@nut-tree-fork/nut-js', unlocks: 'desktop steps' },
  { name: 'tesseract.js', unlocks: 'ocr steps' },
  { name: 'exceljs', unlocks: 'xlsx files' },
  { name: 'nodemailer', unlocks: 'mail.send' },
  { name: 'imapflow', unlocks: 'mail.receive' }
];

async function collectDependencies(): Promise<CollectorResult> {
  const facts: Record<string, string> = {};
  const notes: string[] = [];
  for (const { name, unlocks } of OPTIONAL_MODULES) {
    const probe = await probeModule(name);
    facts[name] = probe.installed ? probe.version : `not installed (${unlocks})`;
    if (!probe.installed && name === '@nut-tree-fork/nut-js') {
      notes.push('nut.js is the default desktop backend: npm i @nut-tree-fork/nut-js (robot.js or the OS tools stand in without it)');
    }
  }
  const backendMissing = facts['@nut-tree-fork/nut-js'] === undefined || String(facts['@nut-tree-fork/nut-js']).startsWith('not installed');
  if (backendMissing) notes.push('no nut.js: desktop steps fall back to robot.js or the OS tools — run: npm i @nut-tree-fork/nut-js');
  return { name: 'dependencies', status: backendMissing ? 'warn' : 'ok', facts, notes };
}

async function collectDesktop(): Promise<CollectorResult> {
  const rows = await backendReport();
  const live = rows.filter((row) => row.available);
  return {
    name: 'desktop',
    status: live.length > 0 ? 'ok' : 'warn',
    facts: Object.fromEntries(rows.map((row) => [row.name, row.available ? row.detail : `unavailable — ${row.detail}`])),
    notes: live.length > 0
      ? []
      : ['no desktop backend answers here: install @nut-tree-fork/nut-js, or the tools one of the OS backends needs (xdotool on Linux)']
  };
}

function collectSession(): CollectorResult {
  if (process.platform === 'linux') {
    const display = process.env.DISPLAY ?? '';
    const wayland = process.env.WAYLAND_DISPLAY ?? '';
    const interactive = display !== '' || wayland !== '';
    return {
      name: 'session',
      status: interactive ? 'ok' : 'warn',
      facts: { display: display || '(unset)', wayland: wayland || '(unset)' },
      notes: interactive
        ? []
        : ['desktop steps need a graphical session; for headless runs wrap with: xvfb-run -a rpa run …']
    };
  }
  if (process.platform === 'darwin') {
    return {
      name: 'session',
      status: 'ok',
      facts: { session: 'always interactive on macOS' },
      notes: ['desktop steps additionally need Accessibility + Screen Recording granted to the terminal']
    };
  }
  return { name: 'session', status: 'ok', facts: { session: 'always interactive on Windows' }, notes: [] };
}

function collectTools(): CollectorResult {
  const facts: Record<string, string> = {};
  const notes: string[] = [];

  const pdftotext = commandVersion('pdftotext');
  facts['pdftotext'] = pdftotext ?? 'not found';
  if (!pdftotext) {
    notes.push('pdf.readText shells out to pdftotext (poppler-utils; brew install poppler)');
  }

  if (process.platform === 'win32') {
    const powershell = commandVersion('powershell');
    facts['powershell'] = powershell ?? 'not found';
    if (!powershell) notes.push('desktop.uia needs Windows PowerShell');
  } else {
    facts['powershell'] = 'n/a on this platform (desktop.uia is Windows-only)';
  }

  return { name: 'tools', status: notes.length > 0 ? 'warn' : 'ok', facts, notes };
}

async function collectProject(projectDir: string): Promise<CollectorResult> {
  const facts: Record<string, string> = { directory: projectDir };
  const notes: string[] = [];
  let status: CollectorStatus = 'ok';

  if (!existsSync(projectDir)) {
    return { name: 'project', status: 'fail', facts, notes: [`${projectDir} does not exist`] };
  }

  try {
    await access(projectDir, constants.W_OK);
    facts['writable'] = 'yes';
  } catch {
    facts['writable'] = 'no';
    status = 'warn';
    notes.push('the project directory is not writable — the queue and run artifacts need writes');
  }

  const entries = await readdir(projectDir).catch(() => [] as string[]);
  let workflows = 0;
  let invalid = 0;
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.json')) continue;
    const text = await readFile(path.join(projectDir, entry), 'utf8').catch(() => '');
    if (text === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const candidate = parsed as { steps?: unknown };
    const steps = Array.isArray(parsed) ? parsed : Array.isArray(candidate.steps) ? candidate.steps : null;
    if (!steps || steps.length === 0) continue; // config.json or a data file, not a workflow
    workflows++;
    try {
      const errors = validateWorkflow(parseWorkflow(text));
      if (errors.length > 0) {
        invalid++;
        notes.push(`${entry}: ${errors[0]}`);
      }
    } catch (e) {
      invalid++;
      notes.push(`${entry}: ${(e as Error).message}`);
    }
  }
  facts['workflow files'] = String(workflows);
  facts['invalid workflows'] = String(invalid);
  if (invalid > 0) status = 'fail';
  return { name: 'project', status, facts, notes };
}

/**
 * Run the collectors a profile selects and produce the report. Writing the file is part of the
 * contract: `--out` was asked for, and a doctor that silently skips writing would be lying.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const profile = options.profile ?? 'default';
  const collectors: CollectorResult[] = [];
  collectors.push(await collectRuntime());
  collectors.push(await collectDependencies());
  if (profile === 'desktop' || profile === 'robot') collectors.push(await collectDesktop());
  if (profile === 'robot') collectors.push(collectSession());
  collectors.push(collectTools());
  if (options.projectDir) collectors.push(await collectProject(path.resolve(options.projectDir)));

  const report: DoctorReport = {
    tool: 'nutjs-testing',
    version: ownVersion(),
    generatedAt: new Date().toISOString(),
    profile,
    collectors,
    summary: {
      warnings: collectors.filter((collector) => collector.status === 'warn').length,
      problems: collectors.filter((collector) => collector.status === 'fail').length
    }
  };

  if (options.out) {
    const target = path.resolve(options.out);
    const lower = target.toLowerCase();
    if (lower.endsWith('.zip')) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, writeArchive(new Map([['report.json', Buffer.from(JSON.stringify(report, null, 2))]])));
    } else if (lower.endsWith('.json')) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(report, null, 2));
    } else {
      throw new Error(`--out must end with .json or .zip (got "${options.out}")`);
    }
  }

  return report;
}
