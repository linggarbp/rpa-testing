#!/usr/bin/env node
/**
 * The CLI. Five verbs, no argument-parsing dependency — the whole surface fits in one file:
 *
 *   rpa run <file>          run a workflow here (the local story)
 *   rpa validate <file…>    check a workflow without running it
 *   rpa activities          list every activity this tool implements
 *   rpa init <dir>          scaffold a workflow project
 *   rpa robot               connect to an Aro orchestrator and take dispatched flows
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Engine, formatLogLine } from './engine.js';
import { parseWorkflow, validateWorkflow, WEB_ACTIONS, CONTROL_ACTIONS, API_ACTIONS, DESKTOP_ACTIONS, OCR_ACTIONS, VISION_ACTIONS, QUEUE_ACTIONS, FILE_ACTIONS, EXCEL_ACTIONS, DATA_ACTIONS, CONFIG_ACTIONS, MAIL_ACTIONS, PDF_ACTIONS, GSHEET_ACTIONS, HITL_ACTIONS, MOBILE_ACTIONS, WORD_ACTIONS } from './model.js';
import { AroRobot } from './robot/aro.js';
import { packProject, unpack } from './pack.js';
import { QueueStore } from './store.js';
import { scaffoldBasic, scaffoldTransactional } from './templates.js';
import { answerHuman, pendingHuman } from './gaps.js';

interface Flags {
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Flags } {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split('=');
    const key = name!;
    if (inline !== undefined) {
      pushFlag(flags, key, inline);
      continue;
    }
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      pushFlag(flags, key, next);
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, positional, flags };
}

function pushFlag(flags: Flags, key: string, value: string): void {
  const existing = flags[key];
  if (existing === undefined) flags[key] = value;
  else if (Array.isArray(existing)) existing.push(value);
  else flags[key] = [String(existing), value];
}

function values(flags: Flags, key: string): string[] {
  const value = flags[key];
  if (value === undefined || typeof value === 'boolean') return [];
  return Array.isArray(value) ? value : [value];
}

const HELP = `rpa-testing — a small, honest RPA toolkit

  rpa run <workflow.json|package.rpapkg>  run a workflow (--headed, --var name=value, --report out.json,
                               --heal off|recommend|auto — what a failed target may recover to)
  rpa validate <workflow.json…>  validate without running
  rpa import <file.xaml|project.json> --out <dir>   convert a legacy export (writes PORTING-REPORT.md)
  rpa pack <dir> --out <file.rpapkg>  zip a project with a manifest (--entry, --name, --version)
  rpa activities               list the activity catalog
  rpa init <dir>               scaffold a project (--template basic|transactional)
  rpa queue <name>             show a local queue (--project <dir>, --status <status>, --json)
  rpa queue add <name> <ref> [json]   add a transaction item
  rpa hitl                     list pending human-in-the-loop questions
  rpa hitl answer <id> <value>  answer one (what hitl.ask waits for)
  rpa pick <url>               click an element, get its target JSON (--out target.json)
  rpa record <url>             record a browser session into a draft workflow (--out draft.json,
                               --max-seconds N, --headless)
  rpa doctor                   check this machine (--profile default|robot|web, --out report.zip, --json)
  rpa ui                       the Studio in a browser (--project <dir>, --port N, --no-open)
  rpa robot --api <url> --project <id> [--api-key <key> | --robot-id <id> --robot-key <key>]
            [--name <host>] [--capabilities web,desktop,ocr] [--mode Attended|Unattended] [--once]
`;

const PICK_SCRIPT = `(() => {
  if (window.__rpaPickInstalled) return;
  window.__rpaPickInstalled = true;

  const cssPath = (element) => {
    const escape = (value) => String(value).replace(/["\\\\]/g, '\\\\$&');
    if (element.getAttribute && element.getAttribute('id')) return '#' + element.getAttribute('id');
    if (element.getAttribute && element.getAttribute('name')) return element.tagName.toLowerCase() + '[name="' + escape(element.getAttribute('name')) + '"]';
    const parts = [];
    let node = element;
    for (let depth = 0; node && node.nodeType === 1 && depth < 3; depth++) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const sameTag = Array.prototype.filter.call(parent.children, (child) => child.tagName === node.tagName);
      parts.unshift(sameTag.length > 1 ? tag + ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')' : tag);
      node = parent;
    }
    return parts.join(' > ');
  };

  document.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const element = event.target;
    if (!element || !element.tagName) return;
    const tag = element.tagName.toUpperCase();
    const ariaLabel = element.getAttribute ? (element.getAttribute('aria-label') || '') : '';
    const text = (element.innerText || element.textContent || '').trim().slice(0, 60);
    const aaname = ariaLabel || text;
    const attributes = {};
    const id = element.getAttribute ? element.getAttribute('id') : null;
    const name = element.getAttribute ? element.getAttribute('name') : null;
    if (id) attributes.id = id;
    if (name) attributes.name = name;
    if (aaname) attributes.aaname = aaname;
    const levels = {};
    Object.keys(attributes).forEach((key) => { levels[key] = key === 'aaname' ? 'fuzzy' : 'exact'; });
    window.rpaPick({
      strict: cssPath(element),
      fuzzy: { tag: tag, attributes: attributes, levels: levels, threshold: 0.7 },
      text: text
    });
  }, true);
})();`;

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'run': {
      const file = positional[0];
      if (!file) {
        console.error('rpa run needs a workflow file.');
        return 2;
      }
      // A package is a zip with a manifest: extract it, verify every hash, run its entry, clean up.
      let source = path.resolve(file);
      let cleanup: (() => Promise<void>) | undefined;
      if (path.extname(file).toLowerCase() === '.rpapkg') {
        const opened = await unpack(file);
        source = opened.entry;
        cleanup = opened.cleanup;
        console.log(`package  : ${opened.manifest.name} ${opened.manifest.version} — entry ${opened.manifest.entry}, ${Object.keys(opened.manifest.files).length} file(s), manifest verified`);
      }
      try {
        const workflow = parseWorkflow(await readFile(source, 'utf8'));
        const errors = validateWorkflow(workflow);
        if (errors.length > 0) {
          console.error(errors.join('\n'));
          return 2;
        }
        const overrides: Record<string, unknown> = {};
        for (const pair of values(flags, 'var')) {
          const index = pair.indexOf('=');
          if (index > 0) overrides[pair.slice(0, index)] = pair.slice(index + 1);
        }
        // --arg is the entry-point spelling (`in_*` arguments); it lands in the same variables.
        for (const pair of values(flags, 'arg')) {
          const index = pair.indexOf('=');
          if (index > 0) overrides[pair.slice(0, index)] = pair.slice(index + 1);
        }

        const healFlag = values(flags, 'heal')[0];
        if (healFlag !== undefined && !['off', 'recommend', 'auto'].includes(healFlag)) {
          console.error(`unknown --heal "${healFlag}" — pick off | recommend | auto.`);
          return 2;
        }

        const engine = new Engine({
          headless: flags.headed !== true,
          variables: overrides,
          // Paths inside the workflow are project-relative: invoke, config.load, files, the queue.
          baseDir: path.dirname(source),
          ...(healFlag ? { heal: healFlag as 'off' | 'recommend' | 'auto' } : {}),
          onLog: (line) => {
            if (flags.json !== true) console.log(formatLogLine(line));
          }
        });
        const result = await engine.run(workflow, {});
        if (flags.json === true || values(flags, 'report').length > 0) {
          const report = values(flags, 'report')[0];
          if (report) {
            await mkdir(path.dirname(path.resolve(report)), { recursive: true });
            await writeFile(report, JSON.stringify(result, null, 2));
            console.log(`report written to ${report}`);
          }
          if (flags.json === true) console.log(JSON.stringify({ status: result.status, error: result.error, durationMs: result.durationMs, vars: result.vars, heals: result.heals }, null, 2));
        }
        console.log(`${result.status}${result.error ? ` — ${result.error}` : ''} (${result.stepsRun} step(s), ${result.durationMs} ms)${result.heals.length > 0 ? ` · ${result.heals.length} heal(s)` : ''}`);
        return result.status === 'Passed' ? 0 : 1;
      } finally {
        if (cleanup) await cleanup();
      }
    }

    case 'pack': {
      const dir = positional[0];
      const out = values(flags, 'out')[0];
      if (!dir || !out) {
        console.error('rpa pack <project dir> --out <file.rpapkg> [--entry Main.json] [--name X] [--version 0.1.0]');
        return 2;
      }
      const result = await packProject(dir, out, {
        ...(values(flags, 'entry')[0] ? { entry: values(flags, 'entry')[0]! } : {}),
        ...(values(flags, 'name')[0] ? { name: values(flags, 'name')[0]! } : {}),
        ...(values(flags, 'version')[0] ? { version: values(flags, 'version')[0]! } : {})
      });
      console.log(`packed ${result.files} file(s) → ${result.file} (entry ${result.entry}, ${result.bytes} bytes)`);
      return 0;
    }

    case 'validate': {
      if (positional.length === 0) {
        console.error('rpa validate needs at least one workflow file.');
        return 2;
      }
      let failed = 0;
      for (const file of positional) {
        try {
          const errors = validateWorkflow(parseWorkflow(await readFile(file, 'utf8')));
          if (errors.length === 0) console.log(`ok   ${file}`);
          else {
            failed++;
            console.log(`FAIL ${file}`);
            for (const error of errors) console.log(`     ${error}`);
          }
        } catch (e) {
          failed++;
          console.log(`FAIL ${file} — ${(e as Error).message}`);
        }
      }
      return failed === 0 ? 0 : 1;
    }

    case 'activities': {
      const groups: Array<[string, readonly string[]]> = [
        ['web', WEB_ACTIONS], ['control', CONTROL_ACTIONS], ['api', API_ACTIONS],
        ['desktop', DESKTOP_ACTIONS], ['ocr', OCR_ACTIONS], ['ai-vision', VISION_ACTIONS],
        ['queue', QUEUE_ACTIONS], ['file', FILE_ACTIONS], ['excel', EXCEL_ACTIONS],
        ['data', DATA_ACTIONS], ['config', CONFIG_ACTIONS], ['mail', MAIL_ACTIONS],
        ['pdf', PDF_ACTIONS], ['gsheet', GSHEET_ACTIONS], ['hitl', HITL_ACTIONS],
        ['mobile', MOBILE_ACTIONS], ['word', WORD_ACTIONS]
      ];
      for (const [type, actions] of groups) console.log(`${type.padEnd(10)} ${actions.join(', ')}`);
      console.log('\nEvery step also accepts: timeoutMs, retry, retryDelayMs, continueOnError, delayBeforeMs, delayAfterMs, saveAs, heal (off|recommend|auto).');
      return 0;
    }

    case 'record': {
      const url = positional[0];
      if (!url) {
        console.error('rpa record <url> --out <draft.json> [--max-seconds N] [--headless]');
        return 2;
      }
      const out = values(flags, 'out')[0] ?? 'recorded.json';
      const maxSeconds = Number(values(flags, 'max-seconds')[0] ?? 900);
      let playwright: typeof import('playwright');
      try {
        playwright = await import('playwright');
      } catch {
        console.error('rpa record needs playwright: npm i playwright && npx playwright install chromium');
        return 2;
      }
      const { startRecording } = await import('./recorder.js');
      const browser = await playwright.chromium.launch({ headless: flags.headless === true });
      try {
        const page = await browser.newPage();
        const recorder = await startRecording(page, { maxMs: Math.max(5, maxSeconds) * 1000 });
        console.log(`recording ${url} — click through the page; Stop (bottom-right) ends it. ${flags.headless === true ? '' : 'The browser window is yours to drive.'}`.trim());
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const recorded = await recorder.stop();
        if (recorded.steps.length === 0) {
          console.error('nothing was recorded.');
          return 1;
        }
        const workflow = { name: `recorded: ${url}`, steps: recorded.steps.map((entry) => entry.step) };
        const errors = validateWorkflow(parseWorkflow(JSON.stringify(workflow)));
        if (errors.length > 0) {
          console.error(`the draft did not validate (that is a recorder bug, please report it):\n${errors.join('\n')}`);
          return 1;
        }
        await mkdir(path.dirname(path.resolve(out)), { recursive: true });
        await writeFile(out, `${JSON.stringify(workflow, null, 2)}\n`);
        for (const [index, entry] of recorded.steps.entries()) console.log(`${String(index + 1).padStart(2)}. ${entry.description}`);
        for (const note of recorded.dropped) console.log(`    · ${note}`);
        console.log(`\nrecorded ${recorded.steps.length} step(s) → ${out} — review it, then: rpa run ${out}`);
        return 0;
      } finally {
        await browser.close().catch(() => {});
      }
    }

    case 'doctor': {
      const { runDoctor, DOCTOR_PROFILES } = await import('./doctor.js');
      const profile = (values(flags, 'profile')[0] ?? 'default').toLowerCase();
      if (!(DOCTOR_PROFILES as readonly string[]).includes(profile)) {
        console.error(`unknown profile "${profile}" — pick one of: ${DOCTOR_PROFILES.join(', ')}`);
        return 2;
      }
      const out = values(flags, 'out')[0];
      const report = await runDoctor({
        profile: profile as (typeof DOCTOR_PROFILES)[number],
        ...(values(flags, 'project')[0] ? { projectDir: values(flags, 'project')[0]! } : {}),
        ...(out ? { out } : {})
      });
      if (flags.json === true) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        for (const collector of report.collectors) {
          console.log(`${collector.status.padEnd(4)} ${collector.name}`);
          for (const [key, value] of Object.entries(collector.facts)) console.log(`       ${key}: ${value}`);
          for (const note of collector.notes) console.log(`       · ${note}`);
        }
        console.log(`\nprofile ${report.profile} — ${report.collectors.length} collector(s), ${report.summary.warnings} warning(s), ${report.summary.problems} problem(s)${out ? ` · ${out}` : ''}`);
      }
      return report.summary.problems > 0 ? 1 : 0;
    }

    case 'queue': {
      const root = path.resolve(values(flags, 'project')[0] ?? '.');
      const store = new QueueStore(root);
      if (positional[0] === 'add') {
        const [, queueName, reference, data] = positional;
        if (!queueName || !reference) {
          console.error('rpa queue add <name> <reference> [json]');
          return 2;
        }
        let payload: Record<string, unknown> = {};
        if (data) {
          try {
            payload = JSON.parse(data) as Record<string, unknown>;
          } catch (e) {
            console.error(`the data must be JSON: ${(e as Error).message}`);
            return 2;
          }
        }
        const item = await store.add(queueName, reference, payload);
        console.log(`${item.id}  ${item.status}  ${item.reference}`);
        return 0;
      }

      const queueName = positional[0];
      if (!queueName) {
        console.error('rpa queue <name> [--status <status>] [--project <dir>]');
        return 2;
      }
      const status = values(flags, 'status')[0];
      const items = (await store.items(queueName)).filter((item) => !status || item.status === status);
      if (flags.json === true) {
        console.log(JSON.stringify(items, null, 2));
        return 0;
      }
      for (const item of items) {
        console.log(`${item.id}  ${item.status.padEnd(20)} retries=${item.retries}  ${item.reference}${item.reason ? `  (${item.reason})` : ''}`);
      }
      console.log(`${items.length} item(s)${status ? ` with status ${status}` : ''} in "${queueName}" (${root}/.rpa/queues)`);
      return 0;
    }

    case 'init': {
      const dir = positional[0];
      if (!dir) {
        console.error('rpa init needs a directory.');
        return 2;
      }
      const name = values(flags, 'name')[0] ?? path.basename(path.resolve(dir));
      const template = (values(flags, 'template')[0] ?? 'basic').toLowerCase();
      if (template !== 'basic' && template !== 'transactional') {
        console.error(`unknown template "${template}" — use basic or transactional.`);
        return 2;
      }
      const result = template === 'transactional'
        ? await scaffoldTransactional(dir, name)
        : await scaffoldBasic(dir, name);
      console.log(`scaffolded ${template} project in ${result.dir}:`);
      for (const file of result.files) console.log(`  ${file}`);
      return 0;
    }

    case 'pick': {
      const url = positional[0];
      if (!url) {
        console.error('rpa pick needs a URL to open.');
        return 2;
      }
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: false }); // clicking needs a human
      const page = await browser.newPage();
      let picked: unknown = null;
      await page.exposeBinding('rpaPick', (_source, payload: unknown) => { picked = payload; });
      // Injected as a STRING, not a function: a callback shipped to the page is serialised by the
      // bundler with its names rewritten, and tsx's keepNames would leave a `__name` call inside it
      // with no definition in the page. A string never goes through that transform.
      await page.addInitScript({ content: PICK_SCRIPT });
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      console.log('Click the element you want to drive (Ctrl+C to give up)…');

      const deadline = Date.now() + 5 * 60 * 1000;
      while (!picked && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 200));
      if (!picked) {
        console.error('nothing was picked.');
        await browser.close();
        return 1;
      }

      const target = picked as Record<string, unknown>;
      const out = values(flags, 'out')[0];
      const step = { type: 'web', action: values(flags, 'action')[0] ?? 'click', target };
      if (out) {
        await writeFile(out, JSON.stringify(step, null, 2) + '\n');
        console.log(`step written to ${out}`);
      }
      console.log(JSON.stringify(step, null, 2));
      await browser.close();
      return 0;
    }

    case 'hitl': {
      const root = path.resolve(values(flags, 'project')[0] ?? '.');
      if (positional[0] === 'answer') {
        const [, id, ...rest] = positional;
        if (!id || rest.length === 0) {
          console.error('rpa hitl answer <id> "<value>"');
          return 2;
        }
        const prompt = await answerHuman(root, id, rest.join(' '));
        console.log(`answered ${id}: ${prompt}`);
        return 0;
      }
      const pending = await pendingHuman(root);
      for (const request of pending) {
        console.log(`${request.id}  ${request.createdAt}  ${request.prompt}${request.choices ? ` [${request.choices.join(' | ')}]` : ''}`);
      }
      console.log(`${pending.length} pending request(s) in ${root}/.rpa/hitl`);
      return 0;
    }

    case 'ui': {
      const { startUi } = await import('./ui/server.js');
      const handle = await startUi({
        projectDir: path.resolve(values(flags, 'project')[0] ?? '.'),
        ...(values(flags, 'port')[0] ? { port: Number(values(flags, 'port')[0]) } : {}),
        noOpen: flags['no-open'] === true
      });
      console.log(`rpa ui — Studio on ${handle.url}`);
      console.log('Ctrl+C to stop.');
      await new Promise<void>(() => { /* the server keeps the process alive */ });
      return 0;
    }

    case 'robot': {
      const apiUrl = values(flags, 'api')[0];
      const projectId = values(flags, 'project')[0];
      if (!apiUrl || !projectId) {
        console.error('rpa robot needs --api <url> and --project <projectId>.');
        return 2;
      }
      const robot = new AroRobot({
        apiUrl,
        projectId,
        ...(values(flags, 'api-key')[0] ? { apiKey: values(flags, 'api-key')[0]! } : {}),
        ...(values(flags, 'robot-id')[0] ? { robotId: values(flags, 'robot-id')[0]! } : {}),
        ...(values(flags, 'robot-key')[0] ? { robotKey: values(flags, 'robot-key')[0]! } : {}),
        name: values(flags, 'name')[0] ?? process.env.HOSTNAME ?? 'rpa-testing',
        mode: values(flags, 'mode')[0] ?? 'Unattended',
        capabilities: (values(flags, 'capabilities')[0] ?? 'web,control,api').split(',').map((c) => c.trim()).filter(Boolean),
        headless: flags.headed !== true
      });

      if (flags.once === true) {
        const report = await robot.preflight();
        console.log(robot.describe(report));
        const task = await robot.claimOnce(1);
        if (!task) {
          console.log('claim     : nothing waiting');
          return report.ok ? 0 : 1;
        }
        const status = await robot.runTask(task);
        return status === 'Passed' ? 0 : 1;
      }

      await robot.start();
      return 0;
    }

    default:
      console.log(HELP);
      return command === 'help' ? 0 : 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
