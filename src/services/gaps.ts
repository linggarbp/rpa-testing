/**
 * The gaps that were open after the first pass, closed one at a time:
 * mail (SMTP/IMAP), PDF text, Google Sheets, and the human-in-the-loop prompt behind the
 * attended-input activity. Each module keeps its dependency optional and its failure message actionable — a
 * robot on a bare Node must still start and say what is missing, not crash at import time.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ── Mail ───────────────────────────────────────────────────────────────────────────────────────

export interface MailServerOptions {
  host: string;
  port?: number;
  /** true = implicit TLS (465); false/undefined = STARTTLS where offered (587/25). */
  secure?: boolean;
  user?: string;
  pass?: string;
  /** Reject unauthorised certificates — off by default only for a local test server. */
  rejectUnauthorized?: boolean;
}

export interface SendMailOptions {
  server: MailServerOptions;
  from: string;
  to: string | string[];
  cc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; path?: string; content?: string }>;
}

/** Send one mail. Uses `nodemailer` when it is installed (SMTP is not in Node's standard library). */
export async function sendMail(options: SendMailOptions): Promise<{ messageId: string; accepted: string[] }> {
  if (!options.server?.host) throw new Error('mail.send needs server.host (SMTP).');
  if (!options.to) throw new Error('mail.send needs "to".');
  let nodemailer: { createTransport: (config: unknown) => { sendMail: (mail: unknown) => Promise<{ messageId: string; accepted?: unknown[] }> } };
  try {
    const specifier = 'nodemailer';
    nodemailer = await import(specifier) as unknown as typeof nodemailer;
  } catch {
    throw new Error('mail.send needs the optional dependency "nodemailer" — install it with `npm i nodemailer`.');
  }

  const transport = nodemailer.createTransport({
    host: options.server.host,
    port: options.server.port ?? (options.server.secure ? 465 : 587),
    secure: options.server.secure === true,
    ...(options.server.user ? { auth: { user: options.server.user, pass: options.server.pass ?? '' } } : {}),
    ...(options.server.rejectUnauthorized === false ? { tls: { rejectUnauthorized: false } } : {})
  });
  const info = await transport.sendMail({
    from: options.from,
    to: options.to,
    ...(options.cc ? { cc: options.cc } : {}),
    subject: options.subject,
    ...(options.text ? { text: options.text } : {}),
    ...(options.html ? { html: options.html } : {}),
    ...(options.attachments ? { attachments: options.attachments } : {})
  });
  return {
    messageId: info.messageId,
    accepted: (info.accepted ?? []).map((entry) => String(entry))
  };
}

export interface ReceiveMailOptions {
  server: MailServerOptions;
  mailbox?: string;
  /** IMAP search: unseen only, within the last N days, and/or from/subject substrings. */
  search?: { unseen?: boolean; sinceDays?: number; from?: string; subject?: string };
  limit?: number;
  markSeen?: boolean;
}

export interface ReceivedMail {
  uid: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  text: string;
}

/** Fetch messages over IMAP. Uses `imapflow` when installed. */
export async function receiveMail(options: ReceiveMailOptions): Promise<ReceivedMail[]> {
  if (!options.server?.host) throw new Error('mail.receive needs server.host (IMAP).');
  let ImapFlow: new (config: unknown) => {
    connect: () => Promise<void>;
    mailboxOpen: (mailbox: string) => Promise<unknown>;
    fetch: (range: unknown, query: unknown) => AsyncIterable<{ uid: number; envelope?: { from?: Array<{ address?: string }>; to?: Array<{ address?: string }>; subject?: string; date?: Date }; source?: Buffer }>;
    logout: () => Promise<void>;
  };
  try {
    const specifier = 'imapflow';
    ({ ImapFlow } = await import(specifier) as unknown as { ImapFlow: typeof ImapFlow });
  } catch {
    throw new Error('mail.receive needs the optional dependency "imapflow" — install it with `npm i imapflow`.');
  }

  const client = new ImapFlow({
    host: options.server.host,
    port: options.server.port ?? 993,
    secure: options.server.secure !== false,
    auth: { user: options.server.user ?? '', pass: options.server.pass ?? '' },
    ...(options.server.rejectUnauthorized === false ? { tls: { rejectUnauthorized: false } } : {})
  });

  const criteria: Record<string, unknown> = {};
  if (options.search?.unseen) criteria.seen = false;
  if (options.search?.sinceDays) criteria.since = new Date(Date.now() - options.search.sinceDays * 86400000);
  if (options.search?.from) criteria.from = options.search.from;
  if (options.search?.subject) criteria.subject = options.search.subject;

  const messages: ReceivedMail[] = [];
  await client.connect();
  try {
    await client.mailboxOpen(options.mailbox ?? 'INBOX');
    for await (const message of client.fetch(criteria, { envelope: true, source: true })) {
      const source = message.source ? message.source.toString('utf8') : '';
      messages.push({
        uid: String(message.uid),
        from: message.envelope?.from?.map((entry) => entry.address ?? '').join(', ') ?? '',
        to: message.envelope?.to?.map((entry) => entry.address ?? '').join(', ') ?? '',
        subject: message.envelope?.subject ?? '',
        date: message.envelope?.date?.toISOString() ?? '',
        text: bodyText(source)
      });
      if (messages.length >= (options.limit ?? 10)) break;
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return messages;
}

/** The plain-text part of a raw MIME message, good enough for RPA triage (no HTML rendering). */
export function bodyText(raw: string): string {
  const separator = raw.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
  const headerEnd = raw.indexOf(separator);
  const body = headerEnd >= 0 ? raw.slice(headerEnd + separator.length) : raw;
  const decoded = body
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── PDF ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Native PDF text, through `pdftotext` (poppler). OCR is the fallback for scans, but a digital PDF
 * has its text already — extracting it beats OCR on both accuracy and speed.
 */
export async function readPdfText(file: string, options: { page?: number; layout?: boolean } = {}): Promise<string> {
  const args = ['-enc', 'UTF-8', '-q'];
  if (options.layout !== false) args.push('-layout');
  if (options.page !== undefined) args.push('-f', String(options.page), '-l', String(options.page));
  args.push(file, '-');

  return new Promise<string>((resolve, reject) => {
    const child = spawn('pdftotext', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT'
        ? new Error('pdf.readText needs the `pdftotext` binary (poppler) on PATH — install poppler-utils.')
        : error);
    });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`pdftotext exited ${code}: ${stderr.trim() || 'no output'}`));
    });
  });
}

// ── Google Sheets ────────────────────────────────────────────────────────────────────────────

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Append rows to a sheet — the "write the scrape into Google Sheets" step the analysed bots use. */
export async function appendSheet(options: {
  spreadsheetId: string;
  range: string;
  values: string[][];
  token: string;
  valueInputOption?: 'RAW' | 'USER_ENTERED';
}): Promise<{ updatedRange: string; updatedRows: number }> {
  if (!options.spreadsheetId) throw new Error('gsheet.append needs a spreadsheetId.');
  if (!options.range) throw new Error('gsheet.append needs a range, e.g. "Sheet1!A1".');
  if (!options.token) throw new Error('gsheet.append needs an OAuth token (put it in ${secret.GSHEET_TOKEN}).');

  const url = `${SHEETS}/${encodeURIComponent(options.spreadsheetId)}/values/${encodeURIComponent(options.range)}:append?valueInputOption=${options.valueInputOption ?? 'USER_ENTERED'}&insertDataOption=INSERT_ROWS`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: options.values })
  });
  if (!response.ok) throw new Error(`Sheets append answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const payload = (await response.json()) as { updates?: { updatedRange?: string; updatedRows?: number } };
  return { updatedRange: payload.updates?.updatedRange ?? '', updatedRows: payload.updates?.updatedRows ?? 0 };
}

/** Read a range back as rows of strings. */
export async function readSheet(options: {
  spreadsheetId: string;
  range: string;
  token: string;
}): Promise<string[][]> {
  const url = `${SHEETS}/${encodeURIComponent(options.spreadsheetId)}/values/${encodeURIComponent(options.range)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${options.token}` } });
  if (!response.ok) throw new Error(`Sheets read answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const payload = (await response.json()) as { values?: string[][] };
  return payload.values ?? [];
}

// ── Human in the loop (a local, file-based prompt) ──────────────────────────────────────────

export interface HitlRequest {
  id: string;
  prompt: string;
  choices?: string[];
  createdAt: string;
  answeredAt?: string;
  answer?: string;
}

export interface AskOptions {
  projectDir: string;
  prompt: string;
  choices?: string[];
  timeoutMs?: number;
  /** Used instead of asking when the run is unattended. */
  defaultAnswer?: string;
  /** Poll interval; tests use a short one. */
  pollMs?: number;
}

/**
 * Ask a human and wait. The request is a file (`<project>/.rpa/hitl/<id>.json`) and the answer is
 * another (`<id>.answer.json`), so the operator can reply from a terminal (`rpa hitl answer …`), a
 * remote shell, or the Studio UI — no server, no session, no orchestrator. A timeout fails the step
 * rather than inventing an answer; `defaultAnswer` is the explicit way to say "do not ask".
 */
export async function askHuman(options: AskOptions): Promise<{ id: string; answer: string; asked: boolean }> {
  if (options.defaultAnswer !== undefined) {
    return { id: 'default', answer: options.defaultAnswer, asked: false };
  }
  const dir = path.join(options.projectDir, '.rpa', 'hitl');
  await mkdir(dir, { recursive: true });
  const id = `hitl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const request: HitlRequest = { id, prompt: options.prompt, ...(options.choices ? { choices: options.choices } : {}), createdAt: new Date().toISOString() };
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(request, null, 2) + '\n');

  const answerFile = path.join(dir, `${id}.answer.json`);
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(await readFile(answerFile, 'utf8')) as { answer?: string };
      if (parsed.answer !== undefined) {
        return { id, answer: String(parsed.answer), asked: true };
      }
    } catch {
      // not answered yet
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`hitl.ask timed out after ${timeoutMs}ms waiting for ${id}. Answer it with: rpa hitl answer ${id} "<value>"`);
}

/** Answer a pending request (what `rpa hitl answer` calls). */
export async function answerHuman(projectDir: string, id: string, answer: string): Promise<string> {
  const dir = path.join(projectDir, '.rpa', 'hitl');
  const requestFile = path.join(dir, `${id}.json`);
  const request = JSON.parse(await readFile(requestFile, 'utf8')) as HitlRequest;
  await writeFile(path.join(dir, `${id}.answer.json`), JSON.stringify({ ...request, answer, answeredAt: new Date().toISOString() }, null, 2) + '\n');
  return request.prompt;
}

/** Every unanswered request in the project (what `rpa hitl list` shows). */
export async function pendingHuman(projectDir: string): Promise<HitlRequest[]> {
  const dir = path.join(projectDir, '.rpa', 'hitl');
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir).catch(() => [] as string[]);
  const pending: HitlRequest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.endsWith('.answer.json')) continue;
    const id = entry.replace(/\.json$/, '');
    if (entries.includes(`${id}.answer.json`)) continue;
    pending.push(JSON.parse(await readFile(path.join(dir, entry), 'utf8')) as HitlRequest);
  }
  return pending;
}

// ── Windows UIA bridge ──────────────────────────────────────────────────────────────────────

export interface UiaStep {
  /** Which element: by name (accessible name), automationId, or control type. */
  name?: string;
  automationId?: string;
  controlType?: string;
  /** What to do with it. */
  action?: 'invoke' | 'setValue' | 'getText' | 'focus';
  value?: string;
}

/**
 * The Windows UI Automation driver, as far as a Node tool honestly can: a PowerShell script over
 * `UIAutomationClient` (the accessibility API native automation tools build on). Windows only —
 * everywhere else the step fails with that sentence instead of pretending.
 */
export function buildUiaScript(step: UiaStep): string {
  const conditions: string[] = [];
  if (step.name) conditions.push(`New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, ${psString(step.name)})`);
  if (step.automationId) conditions.push(`New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, ${psString(step.automationId)})`);
  if (step.controlType) conditions.push(`New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::${step.controlType})`);
  if (conditions.length === 0) throw new Error('desktop.uia needs name, automationId or controlType to find the element.');

  const condition = conditions.length === 1 ? conditions[0] : `New-Object System.Windows.Automation.AndCondition(${conditions.join(', ')})`;
  const action = step.action ?? 'invoke';
  const body = action === 'setValue'
    ? `$p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $p.SetValue(${psString(step.value ?? '')}); Write-Output 'ok'`
    : action === 'getText'
      ? `Write-Output $el.Current.Name`
      : action === 'focus'
        ? `$el.SetFocus(); Write-Output 'ok'`
        : `$p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $p.Invoke(); Write-Output 'ok'`;

  return [
    'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes',
    '$root = [System.Windows.Automation.AutomationElement]::RootElement',
    `$cond = ${condition}`,
    '$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)',
    "if ($null -eq $el) { Write-Error 'element not found'; exit 3 }",
    body
  ].join('; ');
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Run one UIA action on Windows. Returns the script's stdout (the element's text for getText). */
export async function runUia(step: UiaStep, timeoutMs = 15000): Promise<string> {
  if (process.platform !== 'win32') {
    throw new Error(`desktop.uia drives Windows UI Automation and this host is ${process.platform}. Use desktop.* (nut.js) here, or run the robot on Windows.`);
  }
  const script = buildUiaScript(step);
  return new Promise<string>((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`desktop.uia timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`UIA failed (exit ${code}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}
