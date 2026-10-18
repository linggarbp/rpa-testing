#!/usr/bin/env node
/**
 * `rpa ui` — the local Studio. One Node process serves a small single-page app on loopback and
 * opens it in the default browser, so "clone → start → a window opens" works the same on Windows,
 * Linux and macOS with no Electron, no bundler and no install step beyond npm.
 *
 * Everything the page does goes through this server, which is also the only place that touches the
 * filesystem: the workflow files, the validator, the engine, the local queue.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, formatLogLine } from '../engine.js';
import {
  CONFIG_ACTIONS, CONTROL_ACTIONS, DATA_ACTIONS, DESKTOP_ACTIONS, EXCEL_ACTIONS, FILE_ACTIONS,
  GSHEET_ACTIONS, HITL_ACTIONS, MAIL_ACTIONS, OCR_ACTIONS, PDF_ACTIONS, QUEUE_ACTIONS, VISION_ACTIONS, WEB_ACTIONS, API_ACTIONS,
  parseWorkflow, validateWorkflow, type Workflow
} from '../model.js';
import { QueueStore } from '../store.js';
import { answerHuman, pendingHuman } from '../gaps.js';
import { pickTarget } from '../pick.js';

const CATALOG: Array<{ type: string; actions: readonly string[] }> = [
  { type: 'web', actions: WEB_ACTIONS },
  { type: 'control', actions: CONTROL_ACTIONS },
  { type: 'queue', actions: QUEUE_ACTIONS },
  { type: 'excel', actions: EXCEL_ACTIONS },
  { type: 'file', actions: FILE_ACTIONS },
  { type: 'data', actions: DATA_ACTIONS },
  { type: 'config', actions: CONFIG_ACTIONS },
  { type: 'mail', actions: MAIL_ACTIONS },
  { type: 'pdf', actions: PDF_ACTIONS },
  { type: 'gsheet', actions: GSHEET_ACTIONS },
  { type: 'hitl', actions: HITL_ACTIONS },
  { type: 'api', actions: API_ACTIONS },
  { type: 'desktop', actions: DESKTOP_ACTIONS },
  { type: 'ocr', actions: OCR_ACTIONS },
  { type: 'ai-vision', actions: VISION_ACTIONS }
];

export interface UiOptions {
  projectDir: string;
  port?: number;
  /** Skip launching a browser (tests, headless hosts). */
  noOpen?: boolean;
}

export interface UiHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(here, '..', '..', 'ui');

/** Every path the API touches must stay inside the project — the page is not a file manager. */
function within(projectDir: string, candidate: string): string {
  const resolved = path.resolve(projectDir, candidate);
  const relative = path.relative(projectDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`"${candidate}" is outside the project folder.`);
  }
  return resolved;
}

async function send(response: ServerResponse, status: number, body: unknown, type = 'application/json'): Promise<void> {
  const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

async function listWorkflows(projectDir: string): Promise<Array<{ file: string; name: string; steps: number }>> {
  const found: Array<{ file: string; name: string; steps: number }> = [];
  const walk = async (dir: string, prefix = '') => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(full, relative); continue; }
      if (!entry.name.endsWith('.json')) continue;
      try {
        const workflow = parseWorkflow(await readFile(full, 'utf8'));
        // config.json (and any object without steps) parses as an empty workflow; the picker lists
        // runnable files only, so an empty one is not a workflow.
        if (workflow.steps.length === 0) continue;
        found.push({ file: relative, name: workflow.name ?? entry.name.replace(/\.json$/, ''), steps: workflow.steps.length });
      } catch {
        // Not JSON, or JSON that is not a workflow: simply not listed.
      }
    }
  };
  await walk(projectDir);
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

export async function startUi(options: UiOptions): Promise<UiHandle> {
  const projectDir = path.resolve(options.projectDir);
  const queues = new QueueStore(projectDir);

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      try {
        // ── API ────────────────────────────────────────────────────────────────────────────────
        if (url.pathname === '/api/activities') return void await send(response, 200, { catalog: CATALOG });

        if (url.pathname === '/api/project') {
          return void await send(response, 200, { dir: projectDir, workflows: await listWorkflows(projectDir) });
        }

        if (url.pathname === '/api/workflow') {
          const file = url.searchParams.get('file') ?? '';
          const full = within(projectDir, file);
          const workflow = parseWorkflow(await readFile(full, 'utf8'));
          return void await send(response, 200, { file, workflow, errors: validateWorkflow(workflow) });
        }

        if (url.pathname === '/api/save' && request.method === 'POST') {
          const body = await readJson(request);
          const file = String(body.file ?? '');
          const full = within(projectDir, file);
          const workflow = body.workflow as Workflow;
          const errors = validateWorkflow(workflow);
          if (errors.length > 0) return void await send(response, 400, { errors });
          await writeFile(full, JSON.stringify(workflow, null, 2) + '\n');
          return void await send(response, 200, { ok: true, file, steps: workflow.steps.length });
        }

        if (url.pathname === '/api/queue' && request.method === 'POST') {
          const body = await readJson(request);
          const name = String(body.name ?? '');
          const reference = String(body.reference ?? '');
          if (!name || !reference) return void await send(response, 400, { error: 'name and reference are required' });
          const item = await queues.add(name, reference, (body.data ?? {}) as Record<string, unknown>);
          return void await send(response, 200, { item });
        }

        if (url.pathname === '/api/queue/status' && request.method === 'POST') {
          const body = await readJson(request);
          const name = String(body.name ?? '');
          const id = String(body.id ?? '');
          const status = String(body.status ?? '');
          if (!name || !id || !status) return void await send(response, 400, { error: 'name, id and status are required' });
          const kind = String(body.exceptionType ?? '').toLowerCase();
          const item = await queues.setStatus(
            name,
            id,
            status,
            String(body.reason ?? '') || undefined,
            kind === 'business' || kind === 'application' || kind === 'system' ? kind : undefined
          );
          return void await send(response, 200, { item });
        }

        if (url.pathname === '/api/hitl') {
          return void await send(response, 200, { requests: await pendingHuman(projectDir) });
        }

        if (url.pathname === '/api/hitl/answer' && request.method === 'POST') {
          const body = await readJson(request);
          const id = String(body.id ?? '');
          const value = String(body.value ?? '');
          if (!id) return void await send(response, 400, { error: 'id is required' });
          const prompt = await answerHuman(projectDir, id, value);
          return void await send(response, 200, { ok: true, id, prompt });
        }

        if (url.pathname === '/api/pick' && request.method === 'POST') {
          const body = await readJson(request);
          const target = String(body.url ?? '');
          if (!target) return void await send(response, 400, { error: 'a url is required' });
          // The same code path as `rpa pick`, so the button and the verb cannot drift apart.
          const step = await pickTarget(target, {
            timeoutMs: Number(body.timeoutMs ?? 120000),
            headless: body.headless === true
          });
          if (!step) return void await send(response, 408, { error: 'nothing was picked before the timeout' });
          return void await send(response, 200, { step });
        }

        if (url.pathname === '/api/queue') {
          const name = url.searchParams.get('name') ?? '';
          if (!name) return void await send(response, 400, { error: 'a queue name is required' });
          const items = await queues.items(name);
          const counts: Record<string, number> = {};
          for (const item of items) counts[item.status] = (counts[item.status] ?? 0) + 1;
          return void await send(response, 200, { name, counts, items });
        }

        if (url.pathname === '/api/run' && request.method === 'POST') {
          const body = await readJson(request);
          const file = String(body.file ?? '');
          const full = within(projectDir, file);
          const workflow = parseWorkflow(await readFile(full, 'utf8'));
          const errors = validateWorkflow(workflow);
          if (errors.length > 0) return void await send(response, 400, { errors });

          // Server-sent events: the run's lines reach the page as they happen, which is what makes
          // the console feel like Studio's output pane instead of a spinner.
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive'
          });
          const emit = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

          const engine = new Engine({
            baseDir: projectDir,
            // Entry-point arguments typed into the Studio's panel arrive here as variables.
            variables: (body.variables ?? {}) as Record<string, unknown>,
            onLog: (line) => {
              // `text` is the same rendering the CLI prints, so the console shows fields too.
              emit('log', { ...line, text: formatLogLine(line) });
            }
          });
          emit('started', { file, name: workflow.name ?? file });
          const result = await engine.run(workflow, {});
          emit('finished', { status: result.status, error: result.error ?? null, durationMs: result.durationMs, stepsRun: result.stepsRun, vars: result.vars });
          response.end();
          return;
        }

        // ── Static SPA ─────────────────────────────────────────────────────────────────────────
        const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const full = path.resolve(uiDir, relative);
        if (!full.startsWith(uiDir)) return void await send(response, 403, { error: 'forbidden' });
        const type = full.endsWith('.html') ? 'text/html; charset=utf-8'
          : full.endsWith('.js') ? 'text/javascript; charset=utf-8'
            : full.endsWith('.css') ? 'text/css; charset=utf-8'
              : 'application/octet-stream';
        return void await send(response, 200, await readFile(full), type);
      } catch (e) {
        const message = (e as NodeJS.ErrnoException).code === 'ENOENT'
          ? `not found: ${url.pathname}`
          : (e as Error).message;
        if (!response.headersSent) await send(response, 404, { error: message });
        else response.end();
      }
    })();
  });

  const port = options.port ?? 4319;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actual = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${actual}`;

  if (!options.noOpen) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {
      console.log(`(could not open a browser automatically — open ${url} yourself)`);
    }).unref();
  }

  return {
    url,
    port: actual,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

/** CLI entry: `rpa ui [--project <dir>] [--port N] [--no-open]`. */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const handle = await startUi({
    projectDir: path.resolve(flag('project') ?? '.'),
    ...(flag('port') ? { port: Number(flag('port')) } : {}),
    noOpen: args.includes('--no-open')
  });
  console.log(`rpa ui — Studio on ${handle.url} (project ${path.resolve(flag('project') ?? '.')})`);
  console.log('Ctrl+C to stop.');
}
