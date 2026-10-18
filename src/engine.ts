/**
 * The engine — runs a workflow's steps, in order, reporting every line as it goes.
 *
 * Two jobs, deliberately in one class:
 *
 *  - LOCAL: `rpa run workflow.json` — a human watches it, or a test asserts on it.
 *  - ROBOT: the same engine executes a definition an Aro orchestrator dispatched, with the run's
 *    outcome reported back over the orchestrator's own protocol (src/robot/aro.ts).
 *
 * Both paths run identical steps against identical state, which is the point: author locally, then
 * let the orchestrator dispatch the same JSON to a machine. There is no second dialect.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Locator, Page } from 'playwright';
import { normalizeAction, parseWorkflow, validateWorkflow, type HealMode, type Step, type TargetSpec, type Workflow } from './model.js';
import {
  QueueStore, deleteFile, ensureDir, fileExists, listFiles, loadSettings, moveFile, readTable, writeTable
} from './store.js';
import { appendSheet, askHuman, readPdfText, readSheet, receiveMail, runUia, sendMail } from './gaps.js';
import { describeTarget, healTarget, resolveTarget, targetFromStep } from './targeting.js';

/** An exception a workflow raised on purpose — business vs application classification. */
export class RpaError extends Error {
  constructor(message: string, readonly kind: 'business' | 'application' = 'application') {
    super(message);
    this.name = 'RpaError';
  }
}

export interface LogLine {
  level: 'info' | 'error' | 'warn' | 'success';
  message: string;
  ts: string;
  /** Structured fields from `control.log` — the process/transaction tags a framework adds to a line. */
  fields?: Record<string, string>;
}

/** One log line as a human reads it: level, optional `{k=v, …}` fields, then the message. */
export function formatLogLine(line: LogLine): string {
  const entries = Object.entries(line.fields ?? {});
  const fields = entries.length > 0 ? ` {${entries.map(([key, value]) => `${key}=${value}`).join(', ')}}` : '';
  return `[${line.level}]${fields} ${line.message}`;
}

export interface EngineOptions {
  headless?: boolean;
  variables?: Record<string, unknown>;
  /** Where every line goes. A robot ships them to the orchestrator; a CLI prints them. */
  onLog?: (line: LogLine) => void | Promise<void>;
  /** Folder for screenshots that do not name a `path`. Created on first use. */
  runDir?: string;
  /** A whole run's budget. Mirrors the robot's own 30-minute default. */
  maxRuntimeMs?: number;
  /**
   * The folder a workflow's relative paths live in: `invoke` resolves its target here, and the local
   * transaction queue defaults to `.rpa/queues` beside it. The CLI passes the workflow file's own
   * directory; a robot passes its working directory.
   */
  baseDir?: string;
  /**
   * The run's healing cap — a step may ask for less healing than the cap allows, never more. `off`
   * therefore disables healing everywhere: the flag to reach for when a failure must be seen
   * plainly. Steps that declare nothing take the cap; with no flag at all the default is
   * `recommend` — failures keep failing, and a candidate fix rides along in the error and report.
   */
  heal?: HealMode;
}

export interface RunHooks {
  /** Asked before every step; a true answer stops the run at the next boundary. */
  isCancelled?: () => Promise<boolean>;
}

/** One healing event in a run — whether it was applied (`auto`) or only suggested (`recommend`). */
export interface HealRecord {
  /** The step's label, e.g. `3 › if › then.2`. */
  step: string;
  mode: HealMode;
  /** true when the step continued on the healed match; false when it only failed with a suggestion. */
  applied: boolean;
  /** The target as declared, one line. */
  from: string;
  /** The target that resolves to the healed element — paste it back into the workflow. */
  to: TargetSpec;
  method: 'relaxed-fuzzy' | 'resemblance';
  score: number;
}

export interface RunResult {
  status: 'Passed' | 'Failed';
  error?: string;
  logs: LogLine[];
  vars: Record<string, unknown>;
  /** Every heal that fired during the run, in order. Empty when nothing needed one. */
  heals: HealRecord[];
  durationMs: number;
  stepsRun: number;
}

/** Replace ${name} and {{name}} with collected variables. Unknown names interpolate to '' — callers
 *  that must not run on a blank value (a password) check for it explicitly. */
export function interpolate(text: string | undefined, vars: Record<string, unknown>): string {
  if (!text) return '';
  return text
    .replace(/\$\{([A-Za-z0-9_.]+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : ''))
    .replace(/\{\{([A-Za-z0-9_.]+)\}\}/g, (match, name: string) => (name in vars ? String(vars[name]) : ''));
}

/** Names referenced as ${secret.X} / ${var} anywhere in a definition — the robot resolves secrets up front. */
export function referencedSecrets(definition: string): string[] {
  const names = new Set<string>();
  for (const match of definition.matchAll(/\$\{secret\.([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_]+)?\}/g)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

export class Engine {
  private readonly vars: Record<string, unknown>;
  private readonly logs: LogLine[] = [];
  private readonly options: EngineOptions;
  private readonly queues: QueueStore;
  private browser: Browser | undefined;
  private page: Page | undefined;
  private deadline = 0;
  private stepsRun = 0;
  private runDirCreated = false;
  /**
   * The project root (EngineOptions.baseDir): where `config.load`, queue files and the file/excel
   * steps look, the way a project's paths are project-relative.
   */
  private readonly projectDir: string;
  /** Guards `invoke` against a workflow that calls itself in a cycle. */
  private invokeDepth = 0;
  /** Every heal that fired, reported with the run. */
  private readonly heals: HealRecord[] = [];
  /** The step currently executing, and how many retries are still ahead of it (heal context). */
  private currentStep?: Step;
  private currentLabel = '';
  private retryRemaining = 0;

  constructor(options: EngineOptions = {}) {
    this.options = options;
    this.vars = { ...(options.variables ?? {}) };
    this.projectDir = path.resolve(options.baseDir ?? process.cwd());
    this.queues = new QueueStore(this.projectDir);
  }

  async run(workflow: Workflow, hooks: RunHooks = {}): Promise<RunResult> {
    const startedAt = Date.now();
    this.deadline = startedAt + (this.options.maxRuntimeMs ?? 30 * 60 * 1000);
    for (const [name, value] of Object.entries(workflow.variables ?? {})) {
      if (!(name in this.vars)) this.vars[name] = value;
    }

    await this.log('success', `Starting "${workflow.name ?? 'workflow'}" (${workflow.steps.length} step(s))`);
    let failure: string | undefined;
    try {
      // Entry-point arguments: defaults fill in, and a
      // required one that is empty stops the run before the first step.
      const missing: string[] = [];
      for (const [name, spec] of Object.entries(workflow.arguments ?? {})) {
        if (this.vars[name] === undefined && spec.default !== undefined) this.vars[name] = spec.default;
        if (spec.required && (this.vars[name] === undefined || String(this.vars[name]).trim() === '')) missing.push(name);
      }
      if (missing.length > 0) {
        throw new Error(`missing required argument(s): ${missing.join(', ')} — pass them with --arg NAME=value.`);
      }

      await this.runSteps(workflow.steps, '', hooks);
      await this.log('success', 'Workflow completed.');
    } catch (e) {
      failure = (e as Error).message;
      await this.log('error', `Workflow failed: ${failure}`);
    } finally {
      if (this.browser) await this.browser.close().catch(() => {});
      this.browser = undefined;
      this.page = undefined;
    }

    return {
      status: failure ? 'Failed' : 'Passed',
      ...(failure ? { error: failure } : {}),
      logs: this.logs,
      vars: this.vars,
      heals: this.heals,
      durationMs: Date.now() - startedAt,
      stepsRun: this.stepsRun
    };
  }

  private async runSteps(steps: Step[], prefix: string, hooks: RunHooks): Promise<void> {
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      if (!step) continue;
      if (Date.now() > this.deadline) throw new Error('Workflow exceeded its maximum runtime.');
      if (hooks.isCancelled && (await hooks.isCancelled())) throw new Error('Workflow was cancelled.');

      const label = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
      const action = normalizeAction(step.action, step.type);
      await this.log('info', `Step ${label}${prefix ? '' : `/${steps.length}`}: ${step.type}.${action}`);
      await this.runStep({ ...step, action }, label, hooks);
    }
  }

  /**
   * One step, plus the options every type shares — timeout, delays, continue-on-error, retry:
   * (Delay before / Delay after / Continue on error) with a retry on top:
   *
   * - `delayBeforeMs` / `delayAfterMs` settle the UI around the action.
   * - `retry` + `retryDelayMs` give a flaky step another chance (default: exactly one attempt).
   * - `continueOnError` logs the failure loudly and keeps going, so a step whose element moved does
   *   not cost the whole run. The console line is what keeps the flag honest.
   */
  private async runStep(step: Step, label: string, hooks: RunHooks): Promise<void> {
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const before = this.duration(step.delayBeforeMs, 0);
    if (before > 0) await delay(before);

    // Heal context: which step this is, and how many retries are still ahead. Healing waits for the
    // final attempt — a retry that is about to re-run the same target is not evidence yet.
    const previous = { step: this.currentStep, label: this.currentLabel, retryRemaining: this.retryRemaining };
    this.currentStep = step;
    this.currentLabel = label;

    const attempts = this.duration(step.retry, 0, 5) + 1;
    try {
      for (let attempt = 1; ; attempt++) {
        this.retryRemaining = attempts - attempt;
        try {
          await this.executeStep(step, hooks);
          this.stepsRun++;
          break;
        } catch (e) {
          const message = (e as Error).message;
          if (attempt < attempts) {
            const backoff = this.duration(step.retryDelayMs, 500);
            await this.log('warn', `Step ${label} failed (attempt ${attempt}/${attempts}): ${message} — retrying in ${backoff}ms`);
            await delay(backoff);
            continue;
          }
          if (step.continueOnError === true) {
            await this.log('error', `Step ${label} failed and continueOnError is set: ${message} — continuing.`);
            break;
          }
          throw e;
        }
      }
    } finally {
      this.currentStep = previous.step;
      this.currentLabel = previous.label;
      this.retryRemaining = previous.retryRemaining;
    }

    const after = this.duration(step.delayAfterMs, 0);
    if (after > 0) await delay(after);
  }

  private async executeStep(step: Step, hooks: RunHooks): Promise<void> {
    switch (step.type) {
      case 'web':
        return this.runWeb(step, hooks);
      case 'control':
        return this.runControl(step, hooks);
      case 'api':
        return this.runApi(step);
      case 'desktop':
        return this.runDesktop(step);
      case 'ocr':
        return this.runOcr(step);
      case 'ai-vision':
        return this.runAiVision(step);
      case 'queue':
        return this.runQueue(step);
      case 'file':
        return this.runFile(step, hooks);
      case 'excel':
        return this.runExcel(step, hooks);
      case 'data':
        return this.runData(step);
      case 'config':
        return this.runConfig(step);
      case 'mail':
        return this.runMail(step);
      case 'pdf':
        return this.runPdf(step);
      case 'gsheet':
        return this.runGsheet(step);
      case 'hitl':
        return this.runHitl(step);
      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }

  // ── Web ────────────────────────────────────────────────────────────────────────────────────────

  private async pageFor(): Promise<Page> {
    if (!this.page) {
      const { chromium } = await this.loadOptional<typeof import('playwright')>(
        'playwright',
        'Install it with `npm i playwright`, then `npx playwright install chromium`.'
      );
      this.browser = await chromium.launch({ headless: this.options.headless ?? true });
      this.page = await this.browser.newPage();
    }
    return this.page;
  }

  private async runWeb(step: Step, hooks: RunHooks): Promise<void> {
    const page = await this.pageFor();
    const timeout = this.duration(step.timeoutMs, 30000, 300000);
    const target = targetFromStep(step);
    const log = (message: string) => this.log('info', message);
    const resolve = async () => {
      if (!target) throw new Error(`web.${String(step.action)} needs a selector or a target.`);
      return this.resolveWithHeal(page, target, step, timeout, log);
    };

    switch (normalizeAction(step.action, 'web')) {
      case 'goto':
        await page.goto(this.interp(step.url), { waitUntil: 'domcontentloaded', timeout });
        break;
      case 'click':
        await (await resolve()).click({ timeout });
        break;
      case 'type': {
        const element = await resolve();
        const text = this.interp(step.text);
        if (step.clear === false) await element.pressSequentially(text, { timeout });
        else await element.fill(text, { timeout });
        break;
      }
      case 'hover':
        await (await resolve()).hover({ timeout });
        break;
      case 'selectOption': {
        const element = await resolve();
        const label = step.label !== undefined ? this.interp(String(step.label)) : undefined;
        const value = step.value !== undefined ? this.interp(String(step.value)) : undefined;
        if (label === undefined && value === undefined) throw new Error('web.selectOption needs "label" or "value".');
        await element.selectOption(label !== undefined ? { label } : { value: value! }, { timeout });
        break;
      }
      case 'getText': {
        const text = ((await (await resolve()).textContent({ timeout })) ?? '').trim();
        await this.save(step, text, `read ${text.length} char(s)`);
        break;
      }
      case 'getAttribute': {
        const name = String(step.attribute ?? '');
        if (!name) throw new Error('web.getAttribute needs an "attribute" name.');
        const element = await resolve();
        // `value` is a property, not an attribute: reading the attribute of a filled input returns
        // whatever the HTML was born with, which is never what the caller meant.
        const value = name.toLowerCase() === 'value'
          ? await element.inputValue({ timeout }).catch(() => '')
          : (await element.getAttribute(name, { timeout })) ?? '';
        await this.save(step, value, `${name} = ${value.length} char(s)`);
        break;
      }
      case 'elementExists': {
        // The question IS whether it is there, so a miss is an answer, not a failure — and it never
        // waits the full timeout for it.
        const exists = await this.elementExists(step);
        if (step.saveAs) this.vars[String(step.saveAs)] = exists ? 'true' : 'false';
        await this.log('info', `elementExists → ${exists ? 'true' : 'false'}`);
        break;
      }
      case 'waitForElement': {
        // A wait is a check, not an interaction: it stays strict on purpose — healing it would
        // change what is being awaited. The interactions above are the ones that heal.
        if (!target) throw new Error('web.waitForElement needs a selector or a target.');
        const element = await resolveTarget(page, target, { timeoutMs: timeout, log });
        await element.waitFor({ state: (step.state as 'visible' | 'attached') ?? 'visible', timeout });
        break;
      }
      case 'pressKeys': {
        const keys = this.interp(String(step.keys ?? step.key ?? ''));
        if (!keys) throw new Error('web.pressKeys needs "keys", e.g. Control+A.');
        if (target) await (await resolve()).press(keys, { timeout });
        else await page.keyboard.press(keys);
        break;
      }
      case 'scroll': {
        if (target) await (await resolve()).scrollIntoViewIfNeeded({ timeout });
        else await page.mouse.wheel(0, Math.min(Math.max(Number(step.amount ?? 600) || 0, -20000), 20000));
        break;
      }
      case 'screenshot': {
        const file = this.interp(String(step.path ?? '')) || await this.defaultScreenshot(`web-${this.stepsRun + 1}`);
        await page.screenshot({ path: file, fullPage: step.fullPage === true });
        await this.log('info', `screenshot saved to ${file}`);
        break;
      }
      case 'assertText': {
        const text = this.interp(step.text);
        const content = await page.content();
        if (!content.includes(text)) throw new Error(`assertText failed: "${text}" not found on the page`);
        break;
      }
      case 'extractTable': {
        // A whole table in one round-trip. The callback runs INSIDE the page and is serialised from
        // its source, so it has to be self-contained: no imported helpers, no named inner functions
        // (the bundler's name-preserving transform injects a reference the page cannot resolve).
        const selector = this.interp(String(step.table ?? ''));
        if (!selector) throw new Error('web.extractTable needs "table" — the CSS selector of the table.');
        const locator = page.locator(selector);
        await locator.first().waitFor({ state: 'attached', timeout })
          .catch(() => { throw new Error(`web.extractTable: no table matched "${selector}" within ${timeout}ms.`); });
        const matched = await locator.count();
        const tables = await locator.evaluateAll((elements: Element[]) => elements
          .filter((element) => element.tagName === 'TABLE')
          .map((table) => Array.from((table as HTMLTableElement).rows)
            .map((row) => Array.from(row.cells).map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim()))));
        if (tables.length === 0) {
          throw new Error(`web.extractTable: "${selector}" matched ${matched} element(s), none of them a <table>.`);
        }
        const grid = tables[0]!;
        const rows = this.tableRows(grid, step.headerRow !== false);
        if (step.saveAs) {
          this.vars[String(step.saveAs)] = JSON.stringify(rows);
          this.vars[`${String(step.saveAs)}.count`] = String(rows.length);
        }
        await this.log('info', `extractTable ${selector} → ${rows.length} row(s), ${grid[0]?.length ?? 0} column(s)${matched > 1 ? ` (${matched} tables matched; the first was read)` : ''}`);
        break;
      }
      default:
        throw new Error(`Unknown web action: ${step.action}`);
    }
    if (step.verify) await this.verifyAfter(page, step, timeout);
  }

  /**
   * Resolve a target for an interaction, healing when every declared method failed:
   *
   * - `off`       — unchanged failure;
   * - `recommend` (default) — fail, but the candidate the healing pass found is logged and appended
   *   to the error, so the fix is one paste away;
   * - `auto`      — act on the healed element and continue; the log line and the run's `heals`
   *   record say which target was healed to what.
   *
   * Healing is skipped while retries remain (the retry has not happened yet). Checks — waits,
   * `elementExists`, `verify` — never heal; see runWeb.
   */
  private async resolveWithHeal(
    page: Page,
    target: TargetSpec,
    step: Step,
    timeoutMs: number,
    log: (message: string) => void | Promise<void>
  ): Promise<Locator> {
    try {
      return await resolveTarget(page, target, { timeoutMs, log });
    } catch (e) {
      const mode = this.healModeFor(target, step);
      if (mode === 'off') throw e;
      if (this.retryRemaining > 0) {
        await this.log('info', `heal skipped: ${this.retryRemaining} retry attempt(s) still ahead`);
        throw e;
      }

      const outcome = await healTarget(page, target, {
        ...(target.healThreshold !== undefined ? { threshold: target.healThreshold } : {})
      });
      if (!outcome) {
        await this.log('info', 'heal: no candidate reached the healing threshold — nothing to suggest');
        throw e;
      }

      this.heals.push({
        step: this.currentLabel,
        mode,
        applied: mode === 'auto',
        from: describeTarget(target),
        to: outcome.target,
        method: outcome.method,
        score: Number(outcome.score.toFixed(2))
      });

      if (mode === 'auto') {
        await this.log('warn', `target healed after every method failed — ${outcome.detail}`);
        return outcome.locator;
      }
      await this.log('warn', `heal suggestion for step ${this.currentLabel}: ${outcome.detail} (set "heal": "auto" on the step to apply it)`);
      throw new Error(`${(e as Error).message}\nheal suggestion: ${JSON.stringify(outcome.target)} (${outcome.method}, score ${outcome.score.toFixed(2)})`);
    }
  }

  private healModeFor(target: TargetSpec, step: Step): HealMode {
    // The engine's flag is a cap: a step may ask for less healing than the run allows, never more
    // (`off` at the engine level therefore disables healing everywhere). Steps that declare nothing
    // take the cap, and without a flag the default is `recommend`.
    const rank: Record<HealMode, number> = { off: 0, recommend: 1, auto: 2 };
    const declared = [target.heal, step.heal].find(
      (value): value is HealMode => value === 'off' || value === 'recommend' || value === 'auto'
    );
    const flag = this.options.heal;
    const wanted: HealMode = declared ?? flag ?? 'recommend';
    if (flag === undefined) return wanted;
    return rank[wanted] <= rank[flag] ? wanted : flag;
  }

  /**
   * Post-action verification: after the action, wait for a target to appear. An action "succeeding"
   * is not the same as the app having reacted — this is the check that proves it did.
   */
  private async verifyAfter(page: Page, step: Step, defaultTimeoutMs: number): Promise<void> {
    const verify = step.verify ?? {};
    const timeout = this.duration(verify.timeoutMs, defaultTimeoutMs, 300000);
    const spec = verify.target
      ?? targetFromStep({
        type: 'web',
        ...(verify.selector ? { selector: verify.selector } : {}),
        ...(verify.selectors ? { selectors: verify.selectors } : {})
      } as Step);
    if (!spec) throw new Error('verify needs a target or a selector.');
    const locator = await resolveTarget(page, spec, {
      timeoutMs: timeout,
      log: (message) => { void this.log('info', `verify: ${message}`); }
    });
    await locator.waitFor({ state: verify.state ?? 'visible', timeout });
    await this.log('info', `verified after ${String(step.action)}: ${describeTarget(spec)}`);
  }

  /**
   * Header-keyed rows from a table's cell grid. `headerRow: false` keys the columns by their index
   * instead; a duplicate header name gets a numeric suffix so no column is silently dropped.
   */
  private tableRows(grid: string[][], headerRow: boolean): Array<Record<string, string>> {
    if (grid.length === 0) return [];
    const header = headerRow ? grid[0]! : (grid[0] ?? []).map((_, index) => String(index));
    const body = headerRow ? grid.slice(1) : grid;
    const keys: string[] = [];
    for (const [index, cell] of header.entries()) {
      const base = cell.trim() !== '' ? cell.trim() : `Column${index + 1}`;
      let key = base;
      for (let n = 2; keys.includes(key); n++) key = `${base}_${n}`;
      keys.push(key);
    }
    return body.map((cells) => Object.fromEntries(keys.map((key, index) => [key, cells[index] ?? ''])));
  }

  private async elementExists(step: Step): Promise<boolean> {
    const page = await this.pageFor();
    const target = targetFromStep(step);
    if (!target) return false;
    try {
      await resolveTarget(page, target, { timeoutMs: this.duration(step.timeoutMs, 2000, 30000), log: () => {}, immediate: true });
      return true;
    } catch {
      return false;
    }
  }

  // ── Control ───────────────────────────────────────────────────────────────────────────────────

  private async runControl(step: Step, hooks: RunHooks): Promise<void> {
    switch (normalizeAction(step.action, 'control')) {
      case 'delay':
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(Number(step.ms) || 0, 60000)));
        break;
      case 'setVar':
        this.vars[String(step.name)] = this.interp(String(step.value ?? ''));
        break;
      case 'log':
        await this.log('info', this.interp(String(step.message ?? '')), this.logFields(step));
        break;
      case 'if': {
        const branch = this.evalCondition(String(step.condition ?? '')) ? step.then : step.else;
        const body = Array.isArray(branch) ? (branch as Step[]) : [];
        await this.runSteps(body, 'if', hooks);
        break;
      }
      case 'repeat': {
        const times = Math.max(0, Math.min(Math.floor(Number(step.times) || 0), 100));
        const body = Array.isArray(step.steps) ? (step.steps as Step[]) : [];
        for (let n = 0; n < times; n++) await this.runSteps(body, `×${n + 1}`, hooks);
        break;
      }
      case 'while': {
        const max = Math.max(1, Math.min(Math.floor(Number(step.maxIterations) || 10), 100));
        const body = Array.isArray(step.steps) ? (step.steps as Step[]) : [];
        let n = 0;
        while (this.evalCondition(String(step.condition ?? ''))) {
          if (++n > max) throw new Error(`while loop exceeded maxIterations (${max}); the condition never turned false.`);
          await this.runSteps(body, `~${n}`, hooks);
        }
        break;
      }
      case 'foreach': {
        const items = this.parseItems(String(step.items ?? ''));
        const name = String(step.itemName ?? 'item') || 'item';
        const body = Array.isArray(step.steps) ? (step.steps as Step[]) : [];
        await this.log('info', `foreach ${items.length} item(s) as \${${name}}`);
        let index = 0;
        for (const item of items) {
          this.vars[name] = typeof item === 'string' ? item : JSON.stringify(item);
          this.vars[`${name}.index`] = String(index);
          await this.runSteps(body, `item${++index}`, hooks);
        }
        break;
      }
      case 'math': {
        // No expression language, no eval: an explicit arithmetic step. The transaction loop's
        // "RetryNumber = RetryNumber + 1" lands here.
        const name = String(step.name);
        const left = Number(this.vars[name] ?? 0);
        const right = Number(this.interp(String(step.value ?? '0')));
        if (!Number.isFinite(left) || !Number.isFinite(right)) {
          throw new Error(`control.math needs numbers; got "${String(this.vars[name] ?? '')}" and "${String(step.value ?? '')}".`);
        }
        const result = step.op === 'sub' ? left - right : step.op === 'mul' ? left * right : step.op === 'div' ? left / right : left + right;
        this.vars[name] = String(result);
        break;
      }
      case 'switch': {
        const subject = this.interp(String(step.expression ?? '')).trim();
        const cases = (step.cases ?? {}) as Record<string, Step[]>;
        const branch = cases[subject] ?? cases[subject.toLowerCase()] ?? (Array.isArray(step.default) ? step.default as Step[] : []);
        await this.log('info', `switch "${subject}" → ${cases[subject] ? 'case' : 'default'} (${branch.length} steps)`);
        await this.runSteps(branch, 'switch', hooks);
        break;
      }
      case 'throw':
        throw new RpaError(this.interp(String(step.message ?? '')),
          step.kind === 'business' ? 'business' : 'application');
      case 'try': {
        const body = Array.isArray(step.body) ? (step.body as Step[]) : [];
        try {
          await this.runSteps(body, 'try', hooks);
        } catch (e) {
          const error = e as Error & { kind?: string };
          // The catch block reads what went wrong through the same variable space as everything else.
          this.vars['exception.message'] = error.message;
          this.vars['exception.kind'] = error.kind === 'business' ? 'business' : 'application';
          const catches = Array.isArray(step.catches) ? (step.catches as Array<{ kind?: string; steps?: Step[] }>) : [];
          const matched = catches.find((catcher) => {
            const kind = String(catcher.kind ?? 'any').toLowerCase();
            return kind === 'any' || kind === this.vars['exception.kind'];
          });
          if (!matched) throw e; // no handler claims it: the run fails
          await this.log('warn', `caught ${String(this.vars['exception.kind'])} exception: ${error.message}`);
          await this.runSteps(Array.isArray(matched.steps) ? matched.steps : [], 'catch', hooks);
        } finally {
          const cleanup = step['finally'];
          if (Array.isArray(cleanup)) await this.runSteps(cleanup as Step[], 'finally', hooks);
        }
        break;
      }
      case 'retryScope': {
        // Retry scope: run the body again while it fails OR until the condition holds.
        const attempts = Math.max(1, Math.min(Math.floor(Number(step.retries ?? 3)) || 3, 50));
        const body = Array.isArray(step.steps) ? (step.steps as Step[]) : [];
        const until = step.until !== undefined ? String(step.until) : undefined;
        const pause = this.duration(step.retryDelayMs, 0, 60000);
        for (let attempt = 1; ; attempt++) {
          try {
            await this.runSteps(body, attempt > 1 ? `retry${attempt}` : '', hooks);
            if (!until || this.evalCondition(until)) break;
            if (attempt >= attempts) {
              throw new Error(`retryScope: condition "${until}" still false after ${attempts} attempt(s).`);
            }
            await this.log('warn', `retryScope ${attempt}/${attempts}: "${until}" still false — retrying`);
          } catch (e) {
            if (attempt >= attempts) throw e;
            await this.log('warn', `retryScope ${attempt}/${attempts} failed: ${(e as Error).message} — retrying`);
          }
          if (pause > 0) await new Promise<void>((resolve) => setTimeout(resolve, pause));
        }
        break;
      }
      case 'invoke': {
        // Project-relative: "Framework/Process.json"
        // means the same thing in Main.json and inside another Framework/ file.
        const file = path.resolve(this.projectDir, this.interp(String(step.workflow)));
        if (this.invokeDepth >= 10) {
          throw new Error(`invoke: call stack is 10 deep at ${file} — a workflow is calling itself in a cycle.`);
        }
        // Arguments land in the SHARED variable space, which is what makes a split-file project read
        // the way the original does: the framework files pass Config/TransactionItem through scope.
        for (const [name, value] of Object.entries((step.arguments ?? {}) as Record<string, unknown>)) {
          this.vars[name] = this.interp(value === null || value === undefined ? '' : String(value));
        }
        const workflow = parseWorkflow(await readFile(file, 'utf8'));
        const problems = validateWorkflow(workflow);
        if (problems.length > 0) throw new Error(`${step.workflow}: ${problems.join('; ')}`);

        this.invokeDepth++;
        try {
          await this.runSteps(workflow.steps, `invoke:${path.basename(file, path.extname(file))}`, hooks);
        } finally {
          this.invokeDepth--;
        }
        break;
      }
      case 'stateMachine': {
        // State machine container: run a state's steps, then follow the first matching
        // `when` transition (or `next`), until a state with `final: true` — the shape the
        // reference transaction loop uses.
        const states = (step.states ?? {}) as Record<string, { steps?: Step[]; next?: string; when?: Array<{ condition?: string; to?: string }>; final?: boolean }>;
        const start = String(step.initial ?? Object.keys(states)[0] ?? '');
        if (!states[start]) throw new Error(`stateMachine: unknown initial state "${start}".`);
        const max = Math.max(1, Math.min(Math.floor(Number(step.maxTransitions ?? 200)) || 200, 5000));
        let current = start;
        let transitions = 0;
        for (;;) {
          const state = states[current];
          if (!state) throw new Error(`stateMachine: transitioned to unknown state "${current}".`);
          await this.log('info', `state ${current} (transition ${transitions + 1})`);
          await this.runSteps(Array.isArray(state.steps) ? state.steps : [], `state:${current}`, hooks);
          if (state.final === true) break;
          const matched = (Array.isArray(state.when) ? state.when : []).find((entry) => this.evalCondition(String(entry?.condition ?? '')));
          const next = matched?.to ?? state.next;
          if (!next) break;
          if (++transitions >= max) throw new Error(`stateMachine exceeded maxTransitions (${max}) — a loop with no exit?`);
          current = next;
        }
        break;
      }
      default:
        throw new Error(`Unknown control action: ${step.action}`);
    }
  }

  /**
   * The collection behind a foreach: a variable name (`orders`), an interpolated `${orders}`, or the
   * JSON array itself. Anything else fails before the body runs — iterating zero times and reporting
   * the workflow as passed is exactly the silent lie this refuses to tell.
   */
  private parseItems(raw: string): unknown[] {
    const trimmed = raw.trim();
    const named = this.vars[trimmed];
    const value = named !== undefined ? named : trimmed;
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // fall through to the error below — an unparseable string is not a collection
      }
    }
    throw new Error(`foreach needs a JSON array or a variable holding one, got "${trimmed.slice(0, 60)}".`);
  }

  // ── Queue / files / tables / data / settings ──────────────────────────────────────────────────

  /**
   * The transaction queue. The same hand-over a work queue performs: `getTransactionItem` claims
   * the next New item as InProgress, `setStatus` closes it — Successful, BusinessException,
   * ApplicationException — or returns it as New via Retry, with its retry count bumped.
   */
  private async runQueue(step: Step): Promise<void> {
    const queue = this.interp(String(step.queue ?? ''));
    switch (normalizeAction(step.action, 'queue')) {
      case 'addItem': {
        // `specificContent` is the queue format's name for the same payload; accept either spelling.
        const payload = (step.data ?? step.specificContent ?? {}) as Record<string, unknown>;
        const item = await this.queues.add(queue, this.interp(String(step.reference ?? '')), payload);
        if (step.saveAs) this.vars[String(step.saveAs)] = item.id;
        await this.log('info', `queue.addItem ${queue} → ${item.id} (${item.reference})`);
        break;
      }
      case 'getTransactionItem': {
        const item = await this.queues.getTransactionItem(queue);
        const name = String(step.saveAs ?? 'TransactionItem');
        if (!item) {
          this.vars[name] = '';
          await this.log('info', `queue.getTransactionItem ${queue} → no New items`);
          break;
        }
        this.vars[name] = JSON.stringify(item);
        for (const [key, value] of Object.entries(item)) {
          if (key === 'data') continue;
          this.vars[`${name}.${key}`] = String(value);
        }
        for (const [key, value] of Object.entries(item.data)) {
          this.vars[`${name}.${key}`] = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
        }
        await this.log('info', `queue.getTransactionItem ${queue} → ${item.reference || item.id} ${JSON.stringify(item.data).slice(0, 120)}`);
        break;
      }
      case 'setStatus': {
        const id = this.interp(String(step.item ?? '')) || String(this.vars['TransactionItem.id'] ?? '');
        if (!id) throw new Error('queue.setStatus needs "item" (or a claimed TransactionItem in scope).');
        const kind = String(step.exceptionType ?? '').toLowerCase();
        const exceptionType = kind === 'business' || kind === 'application' || kind === 'system' ? kind as 'business' | 'application' | 'system' : undefined;
        const updated = await this.queues.setStatus(
          queue,
          id,
          this.interp(String(step.status ?? '')),
          this.interp(String(step.reason ?? '')) || undefined,
          exceptionType,
          step.analytics && typeof step.analytics === 'object' ? step.analytics as Record<string, unknown> : undefined
        );
        await this.log('info', `queue.setStatus ${queue} ${updated.id} → ${updated.status}${updated.reason ? ` (${updated.reason})` : ''}${updated.retries ? ` [retries=${updated.retries}]` : ''}`);
        break;
      }
      case 'count': {
        const total = await this.queues.count(queue, step.status ? this.interp(String(step.status)) : undefined);
        if (step.saveAs) this.vars[String(step.saveAs)] = String(total);
        await this.log('info', `queue.count ${queue}${step.status ? ` (${String(step.status)})` : ''} → ${total}`);
        break;
      }
      case 'list': {
        const items = await this.queues.items(queue);
        if (step.saveAs) this.vars[String(step.saveAs)] = JSON.stringify(items);
        for (const item of items) await this.log('info', `  ${item.status.padEnd(20)} ${item.reference || item.id}`);
        await this.log('info', `queue.list ${queue} → ${items.length} item(s)`);
        break;
      }
      default:
        throw new Error(`Unknown queue action: ${step.action}`);
    }
  }

  /** File steps — "process every PDF in Data/Input, then move it to Data/Processed". */
  private async runFile(step: Step, hooks: RunHooks): Promise<void> {
    switch (normalizeAction(step.action, 'file')) {
      case 'forEachFile': {
        const folder = path.resolve(this.projectDir, this.interp(String(step.folder ?? '')));
        const files = await listFiles(folder, this.interp(String(step.pattern ?? '*')));
        const name = String(step.saveAs ?? 'file');
        await this.log('info', `forEachFile ${folder} (${String(step.pattern ?? '*')}) → ${files.length} file(s)`);
        for (const [index, file] of files.entries()) {
          this.vars[name] = file;
          this.vars[`${name}.name`] = path.basename(file);
          this.vars[`${name}.folder`] = path.dirname(file);
          this.vars[`${name}.extension`] = path.extname(file);
          if (step.max !== undefined && index >= Number(step.max)) break;
          await this.runSteps(Array.isArray(step.steps) ? (step.steps as Step[]) : [], `file${index + 1}`, hooks);
        }
        break;
      }
      case 'move':
        await moveFile(path.resolve(this.projectDir, this.interp(String(step.from))), path.resolve(this.projectDir, this.interp(String(step.to))));
        break;
      case 'readText': {
        const text = await readFile(path.resolve(this.projectDir, this.interp(String(step.path))), 'utf8');
        await this.save(step, text, `read ${text.length} char(s)`);
        break;
      }
      case 'writeText': {
        const file = path.resolve(this.projectDir, this.interp(String(step.path)));
        const text = this.interp(String(step.text ?? ''));
        await ensureDir(path.dirname(file));
        if (step.append === true) await appendFile(file, text.endsWith('\n') ? text : `${text}\n`);
        else await writeFile(file, text);
        await this.log('info', `wrote ${text.length} char(s) to ${file}`);
        break;
      }
      case 'exists': {
        const exists = await fileExists(path.resolve(this.projectDir, this.interp(String(step.path))));
        if (step.saveAs) this.vars[String(step.saveAs)] = exists ? 'true' : 'false';
        await this.log('info', `exists ${String(step.path)} → ${exists}`);
        break;
      }
      case 'delete':
        await deleteFile(path.resolve(this.projectDir, this.interp(String(step.path))));
        break;
      case 'mkdir':
        await ensureDir(path.resolve(this.projectDir, this.interp(String(step.path))));
        break;
      default:
        throw new Error(`Unknown file action: ${step.action}`);
    }
  }

  /** Excel/CSV steps — Read Range / Write Range / Write Cell / For Each Row, header-keyed. */
  private async runExcel(step: Step, hooks: RunHooks): Promise<void> {
    const file = path.resolve(this.projectDir, this.interp(String(step.path ?? '')));
    const sheet = step.sheet ? this.interp(String(step.sheet)) : undefined;

    switch (normalizeAction(step.action, 'excel')) {
      case 'readRange': {
        const rows = await readTable(file, sheet);
        if (step.saveAs) {
          this.vars[String(step.saveAs)] = JSON.stringify(rows);
          this.vars[`${String(step.saveAs)}.count`] = String(rows.length);
        }
        await this.log('info', `readRange ${path.basename(file)} → ${rows.length} row(s)`);
        break;
      }
      case 'forEachRow': {
        const rows = await readTable(file, sheet);
        const name = String(step.saveAs ?? 'row');
        await this.log('info', `forEachRow ${path.basename(file)} → ${rows.length} row(s)`);
        for (const [index, row] of rows.entries()) {
          this.vars[name] = JSON.stringify(row);
          for (const [key, value] of Object.entries(row)) this.vars[`${name}.${key}`] = value;
          await this.runSteps(Array.isArray(step.steps) ? (step.steps as Step[]) : [], `row${index + 1}`, hooks);
        }
        break;
      }
      case 'writeRange': {
        const rows = this.rowsFrom(step);
        await writeTable(file, rows, sheet);
        await this.log('info', `writeRange ${path.basename(file)} ← ${rows.length} row(s)`);
        break;
      }
      case 'writeCell': {
        const rows = await readTable(file, sheet).catch(() => [] as Array<Record<string, string>>);
        const rowIndex = Math.max(1, Math.floor(Number(step.row ?? 1)) || 1);
        while (rows.length < rowIndex) rows.push({});
        const column = step.column === undefined ? Object.keys(rows[0] ?? {})[0] ?? 'A' : this.interp(String(step.column));
        const numeric = Number(column);
        const key = Number.isFinite(numeric) && String(numeric) === column
          ? Object.keys(rows[0] ?? {})[numeric - 1] ?? `Column${numeric}`
          : column;
        rows[rowIndex - 1]![key] = this.interp(String(step.value ?? ''));
        await writeTable(file, rows, sheet);
        await this.log('info', `writeCell ${path.basename(file)} [${rowIndex}, ${key}] = ${String(step.value ?? '')}`);
        break;
      }
      default:
        throw new Error(`Unknown excel action: ${step.action}`);
    }
  }

  /** Rows for a write, from a variable set by readRange/forEachRow or from inline JSON. */
  private rowsFrom(step: Step): Array<Record<string, string>> {
    const raw = this.interp(String(step.rows ?? ''));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
      if (!Array.isArray(parsed)) throw new Error('not an array');
      return parsed.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null || value === undefined ? '' : String(value)])));
    } catch {
      throw new Error(`excel.writeRange needs "rows" as a JSON array or a variable holding one, got "${raw.slice(0, 60)}".`);
    }
  }

  /** Data-shape steps: JSON to variables, and regex extraction for scraping. */
  private async runData(step: Step): Promise<void> {
    switch (normalizeAction(step.action, 'data')) {
      case 'jsonParse': {
        const text = this.interp(String(step.text ?? ''));
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          throw new Error(`data.jsonParse: ${(e as Error).message}`);
        }
        const name = String(step.saveAs ?? 'json');
        this.vars[name] = JSON.stringify(parsed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            this.vars[`${name}.${key}`] = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
          }
        }
        if (Array.isArray(parsed)) this.vars[`${name}.count`] = String(parsed.length);
        await this.log('info', `jsonParse → ${name} (${Array.isArray(parsed) ? `${parsed.length} item(s)` : typeof parsed})`);
        break;
      }
      case 'regexMatches': {
        const pattern = this.interp(String(step.pattern ?? ''));
        const flags = (String(step.flags ?? 'g').replace(/[^gimsuy]/g, '') || 'g');
        const regex = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
        const matches = [...this.interp(String(step.text ?? '')).matchAll(regex)].map((match) => ({
          match: match[0],
          groups: (match.slice(1) as Array<string | undefined>).map((group) => group ?? '')
        }));
        const name = String(step.saveAs ?? 'matches');
        this.vars[name] = JSON.stringify(step.groups === false ? matches.map((entry) => entry.match) : matches);
        this.vars[`${name}.count`] = String(matches.length);
        await this.log('info', `regexMatches /${pattern}/ → ${matches.length} match(es)${matches[0] ? `, first: ${matches[0].match.slice(0, 60)}` : ''}`);
        break;
      }
      default:
        throw new Error(`Unknown data action: ${step.action}`);
    }
  }

  /**
   * Settings — the Config.xlsx equivalent. Every Name/Value pair lands as `${Config.NAME}`, which is
   * how a split-file project reads it (`Config("MaxRetryNumber")` → `${Config.MaxRetryNumber}`).
   */
  private async runConfig(step: Step): Promise<void> {
    const file = path.resolve(this.projectDir, this.interp(String(step.path ?? '')));
    const prefix = step.prefix === undefined ? 'Config' : this.interp(String(step.prefix));
    const entries = await loadSettings(file);
    for (const entry of entries) {
      const key = prefix ? `${prefix}.${entry.name}` : entry.name;
      this.vars[key] = entry.value;
    }
    await this.log('info', `config.load ${path.basename(file)} → ${entries.length} setting(s)${prefix ? ` as \${${prefix}.…}` : ''}`);
    if (step.saveAs) this.vars[String(step.saveAs)] = String(entries.length);
  }

  /** Mail steps: SMTP out, IMAP in — the whole job of three of the nine analysed bots. */
  private async runMail(step: Step): Promise<void> {
    const declared = (step.server ?? {}) as Record<string, unknown>;
    const server = {
      host: this.interp(String(declared.host ?? step.host ?? '')),
      port: Number(declared.port ?? step.port) || undefined,
      secure: (declared.secure ?? step.secure) === true,
      user: this.interp(String(declared.user ?? step.user ?? '')) || undefined,
      pass: this.interp(String(declared.pass ?? step.pass ?? '')) || undefined,
      rejectUnauthorized: (declared.rejectUnauthorized ?? step.rejectUnauthorized) !== false
    };
    const address = (value: unknown): string | string[] =>
      Array.isArray(value) ? value.map((entry) => this.interp(String(entry))) : this.interp(String(value ?? ''));

    switch (normalizeAction(step.action, 'mail')) {
      case 'send': {
        const result = await sendMail({
          server,
          from: this.interp(String(step.from ?? server.user ?? '')),
          to: address(step.to),
          ...(step.cc !== undefined ? { cc: address(step.cc) } : {}),
          subject: this.interp(String(step.subject ?? '')),
          ...(step.text !== undefined ? { text: this.interp(String(step.text)) } : {}),
          ...(step.html !== undefined ? { html: this.interp(String(step.html)) } : {}),
          ...(Array.isArray(step.attachments)
            ? {
                attachments: (step.attachments as Array<{ filename?: string; path?: string; content?: string }>).map((attachment) => ({
                  filename: this.interp(String(attachment.filename ?? 'attachment')),
                  ...(attachment.path ? { path: this.interp(attachment.path) } : {}),
                  ...(attachment.content ? { content: this.interp(attachment.content) } : {})
                }))
              }
            : {})
        });
        if (step.saveAs) this.vars[String(step.saveAs)] = result.messageId;
        await this.log('info', `mail.send → ${result.messageId} (accepted: ${result.accepted.join(', ') || 'none reported'})`);
        break;
      }
      case 'receive': {
        const search = (step.search ?? {}) as Record<string, unknown>;
        const messages = await receiveMail({
          server,
          ...(step.mailbox ? { mailbox: this.interp(String(step.mailbox)) } : {}),
          ...(Object.keys(search).length > 0
            ? {
                search: {
                  ...(search.unseen === true ? { unseen: true } : {}),
                  ...(Number(search.sinceDays) ? { sinceDays: Number(search.sinceDays) } : {}),
                  ...(search.from ? { from: this.interp(String(search.from)) } : {}),
                  ...(search.subject ? { subject: this.interp(String(search.subject)) } : {})
                }
              }
            : {}),
          ...(Number(step.limit) ? { limit: Number(step.limit) } : {})
        });
        const name = String(step.saveAs ?? 'messages');
        this.vars[name] = JSON.stringify(messages);
        this.vars[`${name}.count`] = String(messages.length);
        await this.log('info', `mail.receive → ${messages.length} message(s)${messages[0] ? `, newest: ${messages[0].subject.slice(0, 60)}` : ''}`);
        break;
      }
      default:
        throw new Error(`Unknown mail action: ${step.action}`);
    }
  }

  /** Native PDF text — cheaper and more accurate than OCR for a digital PDF. */
  private async runPdf(step: Step): Promise<void> {
    const file = path.resolve(this.projectDir, this.interp(String(step.path ?? '')));
    const text = await readPdfText(file, {
      ...(step.page !== undefined ? { page: Math.max(1, Math.floor(Number(step.page)) || 1) } : {}),
      layout: step.layout !== false
    });
    await this.save(step, text, `pdf.readText ${path.basename(file)} → ${text.length} char(s)`);
  }

  /** Google Sheets: append the scrape, or read a range back. */
  private async runGsheet(step: Step): Promise<void> {
    const spreadsheetId = this.interp(String(step.spreadsheetId ?? ''));
    const range = this.interp(String(step.range ?? ''));
    const token = this.interp(String(step.token ?? ''));

    switch (normalizeAction(step.action, 'gsheet')) {
      case 'append': {
        const raw = this.interp(typeof step.values === 'string' ? step.values : JSON.stringify(step.values ?? []));
        let values: string[][];
        try {
          const parsed = JSON.parse(raw) as unknown;
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          values = rows.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : [String(row ?? '')]));
        } catch (e) {
          throw new Error(`gsheet.append needs "values" as JSON rows: ${(e as Error).message}`);
        }
        const result = await appendSheet({
          spreadsheetId,
          range,
          values,
          token,
          valueInputOption: String(step.valueInputOption ?? 'USER_ENTERED') === 'RAW' ? 'RAW' : 'USER_ENTERED'
        });
        if (step.saveAs) this.vars[String(step.saveAs)] = result.updatedRange;
        await this.log('info', `gsheet.append ${result.updatedRows} row(s) → ${result.updatedRange}`);
        break;
      }
      case 'read': {
        const rows = await readSheet({ spreadsheetId, range, token });
        await this.save(step, JSON.stringify(rows), `gsheet.read → ${rows.length} row(s)`);
        break;
      }
      default:
        throw new Error(`Unknown gsheet action: ${step.action}`);
    }
  }

  /**
   * Human in the loop — write the question, wait for
   * the answer file, or take the explicit unattended default. A timeout fails the step instead of
   * inventing an answer.
   */
  private async runHitl(step: Step): Promise<void> {
    const prompt = this.interp(String(step.prompt ?? ''));
    const choices = Array.isArray(step.choices) ? (step.choices as string[]).map((choice) => this.interp(String(choice))) : undefined;
    const defaultAnswer = step.default !== undefined ? this.interp(String(step.default)) : undefined;
    await this.log('info', `hitl.ask: ${prompt}${choices ? ` [${choices.join(' | ')}]` : ''}${defaultAnswer !== undefined ? ' (unattended default applies)' : ''}`);
    const result = await askHuman({
      projectDir: this.projectDir,
      prompt,
      ...(choices ? { choices } : {}),
      ...(defaultAnswer !== undefined ? { defaultAnswer } : {}),
      timeoutMs: this.duration(step.timeoutMs, 5 * 60 * 1000, 24 * 60 * 60 * 1000),
      ...(Number(step.pollMs) ? { pollMs: Number(step.pollMs) } : {})
    });
    if (step.saveAs) this.vars[String(step.saveAs)] = result.answer;
    await this.log('info', result.asked ? `hitl answered (${result.id}): ${result.answer}` : `hitl not asked (unattended): ${result.answer}`);
  }

  private evalCondition(raw: string): boolean {
    const expr = this.interp(raw).trim();
    if (!expr) return false;
    const comparison = expr.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.*)$/);
    if (comparison) {
      const left = this.operand(comparison[1] ?? '');
      const right = (comparison[3] ?? '').trim().replace(/^["']|["']$/g, '');
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      // Numeric when both sides are numbers (RetryNumber >= MaxRetryNumber), string otherwise.
      const numeric = left.trim() !== '' && right !== '' && Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
      switch (comparison[2]) {
        case '==': return numeric ? leftNumber === rightNumber : left === right;
        case '!=': return numeric ? leftNumber !== rightNumber : left !== right;
        case '>=': return numeric ? leftNumber >= rightNumber : left >= right;
        case '<=': return numeric ? leftNumber <= rightNumber : left <= right;
        case '>': return numeric ? leftNumber > rightNumber : left > right;
        case '<': return numeric ? leftNumber < rightNumber : left < right;
      }
    }
    if (expr.startsWith('!')) return !truthy(this.operand(expr.slice(1)));
    return truthy(this.operand(expr));
  }

  private operand(token: string): string {
    const name = token.trim();
    const value = this.vars[name];
    return value !== undefined && value !== null ? String(value) : name;
  }

  // ── API / OCR / AI vision ─────────────────────────────────────────────────────────────────────

  private async runApi(step: Step): Promise<void> {
    const url = this.interp(String(step.url ?? ''));
    if (!url) throw new Error('api.request needs a "url".');
    const method = String(step.method ?? 'GET').toUpperCase();
    const init: RequestInit = { method };
    if (step.headers) init.headers = step.headers as Record<string, string>;
    if (step.body !== undefined) init.body = typeof step.body === 'string' ? this.interp(step.body) : JSON.stringify(step.body);

    const response = await fetch(url, init);
    const text = await response.text();
    if (step.saveAs) this.vars[String(step.saveAs)] = text;
    if (Number.isFinite(Number(step.assertStatus)) && response.status !== Number(step.assertStatus)) {
      throw new Error(`API ${method} ${url} returned ${response.status}, expected ${step.assertStatus}`);
    }
    await this.log('info', `API ${method} ${url} → ${response.status}`);
  }

  private async runOcr(step: Step): Promise<void> {
    const tesseract = await this.loadOptional<{ recognize: (image: string, lang: string) => Promise<{ data: { text: string } }> }>(
      'tesseract.js',
      'Install it with `npm i tesseract.js`.'
    );
    const { data } = await tesseract.recognize(this.interp(String(step.imagePath ?? '')), String(step.lang ?? 'eng'));
    if (step.saveAs) this.vars[String(step.saveAs)] = data.text;
    await this.log('info', `OCR extracted ${data.text.length} char(s)`);
  }

  /**
   * ai-vision: screenshot → the project's own OpenAI-compatible endpoint → one action. The endpoint
   * travels with the job when an orchestrator dispatches it (there is no host credential), and the
   * screenshot never leaves the machine until this call.
   */
  private async runAiVision(step: Step): Promise<void> {
    const page = await this.pageFor();
    const baseUrl = String(step.aiBaseUrl ?? this.options.variables?.aiBaseUrl ?? '');
    const model = String(step.aiModel ?? this.options.variables?.aiModel ?? '');
    const apiKey = String(step.aiApiKey ?? this.options.variables?.aiApiKey ?? '');
    if (!baseUrl || !model) throw new Error('ai-vision needs the project AI endpoint (aiBaseUrl/aiModel) — a robot gets them with the job.');

    const goal = this.interp(String(step.goal ?? ''));
    const screenshot = (await page.screenshot()).toString('base64');
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'You drive a web browser. Answer with one JSON object: {"action":"click"|"type"|"done","selector":"<css>","text":"...","reason":"..."}'
          },
          { role: 'user', content: [{ type: 'text', text: goal }, { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot}` } }] }
        ]
      })
    });
    if (!response.ok) throw new Error(`AI endpoint answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content ?? '';
    const decision = JSON.parse(content.replace(/^```(?:json)?|```$/g, '').trim()) as {
      action?: string; selector?: string; text?: string; reason?: string;
    };
    await this.log('info', `AI decided: ${decision.action} ${decision.selector ?? ''} (${decision.reason ?? ''})`);
    if (decision.action === 'click' && decision.selector) await page.click(decision.selector);
    else if (decision.action === 'type' && decision.selector) await page.fill(decision.selector, decision.text ?? '');
  }

  // ── Desktop ───────────────────────────────────────────────────────────────────────────────────

  private async runDesktop(step: Step): Promise<void> {
    const nut = await this.loadOptional<any>('@nut-tree-fork/nut-js', 'Install it with `npm i @nut-tree-fork/nut-js` (and a GUI session to drive).');
    const { mouse, keyboard, screen, clipboard, Point, Button, Key } = nut;
    const at = (name: 'x' | 'y'): number => {
      const value = Number(step[name]);
      if (!Number.isFinite(value)) throw new Error(`desktop.${String(step.action)} needs a numeric "${name}"`);
      return value;
    };

    switch (normalizeAction(step.action, 'desktop')) {
      case 'move':
        await mouse.setPosition(new Point(at('x'), at('y')));
        break;
      case 'click':
        await mouse.click(Button.LEFT);
        break;
      case 'doubleClick':
        await mouse.doubleClick(Button.LEFT);
        break;
      case 'rightClick':
        await mouse.click(Button.RIGHT);
        break;
      case 'type':
        await keyboard.type(this.interp(step.text));
        break;
      case 'scroll': {
        const direction = String(step.direction ?? 'down').toLowerCase();
        const amount = Number(step.amount ?? 5) || 5;
        if (direction === 'up') await mouse.scrollUp(amount);
        else if (direction === 'left') await mouse.scrollLeft(amount);
        else if (direction === 'right') await mouse.scrollRight(amount);
        else if (direction === 'down') await mouse.scrollDown(amount);
        else throw new Error(`desktop.scroll direction must be up|down|left|right, got "${direction}"`);
        break;
      }
      case 'pressKey': {
        const names = (Array.isArray(step.keys) ? step.keys : [step.key]).map(String);
        if (names.length === 0 || names.some((name) => Key[name] === undefined)) {
          throw new Error(`desktop.pressKey needs valid Key names, got ${JSON.stringify(step.keys ?? step.key)}`);
        }
        await keyboard.pressKey(...names.map((name) => Key[name]));
        break;
      }
      case 'drag': {
        const from = step.from as { x?: unknown; y?: unknown } | undefined;
        const start = from ? new Point(Number(from.x), Number(from.y)) : await mouse.getPosition();
        await mouse.drag([start, new Point(at('x'), at('y'))]);
        break;
      }
      case 'clipboardCopy':
        await clipboard.setContent(this.interp(step.text));
        break;
      case 'screenshot': {
        const file = await screen.capture(String(step.fileName ?? `desktop-${this.stepsRun + 1}`), undefined, this.interp(String(step.path ?? '')) || undefined);
        await this.log('info', `desktop screenshot saved to ${file}`);
        break;
      }
      case 'waitForImage':
      case 'clickImage': {
        const imagePath = this.interp(String(step.imagePath ?? ''));
        if (!imagePath) throw new Error(`desktop.${String(step.action)} needs an "imagePath".`);
        const timeoutMs = this.duration(step.timeoutMs, 10000, 120000);
        const params = step.confidence !== undefined ? { confidence: Number(step.confidence) } : undefined;
        const region = await screen.waitFor(imagePath, timeoutMs, undefined, params);
        await this.log('info', `image found at ${region.left},${region.top} (${region.width}x${region.height})`);
        if (normalizeAction(step.action, 'desktop') === 'clickImage') {
          await mouse.setPosition(new Point(region.left + region.width / 2, region.top + region.height / 2));
          await mouse.click(Button.LEFT);
        }
        break;
      }
      case 'uia': {
        // Windows UI Automation through PowerShell — the honest cross-platform answer for the
        // native-driver family: available on Windows, a clear refusal everywhere else.
        const verb = String(step.uiaAction ?? 'invoke').toLowerCase();
        const output = await runUia({
          ...(step.name ? { name: this.interp(String(step.name)) } : {}),
          ...(step.automationId ? { automationId: this.interp(String(step.automationId)) } : {}),
          ...(step.controlType ? { controlType: this.interp(String(step.controlType)) } : {}),
          action: verb === 'setvalue' ? 'setValue' : verb === 'gettext' ? 'getText' : verb === 'focus' ? 'focus' : 'invoke',
          ...(step.value !== undefined ? { value: this.interp(String(step.value)) } : {})
        }, this.duration(step.timeoutMs, 15000, 120000));
        if (step.saveAs) this.vars[String(step.saveAs)] = output;
        await this.log('info', `desktop.uia ${verb} → ${output.slice(0, 120)}`);
        break;
      }
      default:
        throw new Error(`Unknown desktop action: ${step.action}`);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────────────────────

  private interp(value: unknown): string {
    return interpolate(value === undefined || value === null ? '' : String(value), this.vars);
  }

  private async save(step: Step, value: string, what: string): Promise<void> {
    if (step.saveAs) this.vars[String(step.saveAs)] = value;
    await this.log('info', step.saveAs ? `${what} → ${String(step.saveAs)}` : what);
  }

  private duration(value: unknown, fallbackMs: number, maxMs = 30000): number {
    const ms = Number(value);
    if (!Number.isFinite(ms)) return fallbackMs;
    return Math.min(Math.max(Math.floor(ms), 0), maxMs);
  }

  private async defaultScreenshot(name: string): Promise<string> {
    const dir = this.options.runDir ?? path.resolve('runs', new Date().toISOString().replace(/[:.]/g, '-'));
    if (!this.runDirCreated) {
      await mkdir(dir, { recursive: true });
      this.runDirCreated = true;
    }
    return path.join(dir, `${name}.png`);
  }

  private async log(level: LogLine['level'], message: string, fields?: Record<string, string>): Promise<void> {
    const line: LogLine = { level, message, ts: new Date().toISOString(), ...(fields && Object.keys(fields).length > 0 ? { fields } : {}) };
    this.logs.push(line);
    if (this.options.onLog) await this.options.onLog(line);
  }

  /** The `fields` map of a log step, interpolated; a non-object or empty map means "no fields". */
  private logFields(step: Step): Record<string, string> | undefined {
    const declared = step.fields;
    if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return undefined;
    const fields = Object.fromEntries(
      Object.entries(declared as Record<string, unknown>).map(([key, value]) => [key, this.interp(String(value ?? ''))])
    );
    return Object.keys(fields).length > 0 ? fields : undefined;
  }

  private async loadOptional<T>(module: string, hint: string): Promise<T> {
    try {
      return (await import(module)) as T;
    } catch {
      throw new Error(`Optional dependency "${module}" is not installed. ${hint}`);
    }
  }
}

function truthy(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v !== '' && v !== 'false' && v !== '0' && v !== 'null' && v !== 'undefined';
}

export { describeTarget };
