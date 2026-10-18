/**
 * The pieces the engine reaches for when a step is about *data* rather than a screen: the local
 * transaction queue, the settings file, small file helpers and CSV. Nothing here touches Playwright.
 *
 * The queue exists because the transactional pattern is built on two of them:
 * a dispatcher that adds items and a performer that consumes them. Aro has no queue service yet, so
 * the default backend is a folder of JSONL files beside the workflow: `queue add` from anywhere
 * (including a dispatcher robot), `getTransactionItem` / `setStatus` from the performer. The
 * semantics: New → InProgress → Successful | BusinessException |
 * ApplicationException, and Retry puts the item back as New with its retry count incremented.
 */
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type TransactionStatus =
  | 'New'
  | 'InProgress'
  | 'Successful'
  | 'BusinessException'
  | 'ApplicationException'
  | 'Abandoned';

export interface TransactionItem {
  id: string;
  reference: string;
  /** `SpecificContent`: the payload a dispatcher handed over. */
  data: Record<string, unknown>;
  /** The same payload under its queue-field name, so a queue file is self-describing. */
  specificContent: Record<string, unknown>;
  status: TransactionStatus;
  reason?: string;
  /** `ProcessingException`: the type of failure and its reason, set when the status is closed. */
  processingException?: { type: 'business' | 'application' | 'system'; reason: string };
  analytics?: Record<string, unknown>;
  retries: number;
  createdUtc: string;
  updatedUtc: string;
}

/** Only the statuses a workflow may *set*; InProgress is the engine's own claim. */
const SETTABLE: ReadonlySet<string> = new Set(['Successful', 'BusinessException', 'ApplicationException', 'Retry', 'Abandoned', 'New']);

/** The exception type a closing status implies, when the caller does not name one. */
function inferExceptionType(status: string): 'business' | 'application' | undefined {
  if (status === 'BusinessException') return 'business';
  if (status === 'ApplicationException') return 'application';
  return undefined;
}

export class QueueStore {
  /** One process holds one workflow run, so a per-instance mutex is enough — no cross-process locking. */
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly baseDir: string) {}

  private file(queue: string): string {
    const safe = queue.replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.baseDir, '.rpa', 'queues', `${safe}.jsonl`);
  }

  /** Serialise every mutation of one queue file — the alternative is two steps interleaving writes. */
  private async locked<T>(queue: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(queue) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.locks.set(queue, next.catch(() => undefined));
    return next;
  }

  private async read(queue: string): Promise<TransactionItem[]> {
    try {
      const text = await readFile(this.file(queue), 'utf8');
      return text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as TransactionItem);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  private async write(queue: string, items: TransactionItem[]): Promise<void> {
    const file = this.file(queue);
    await mkdir(path.dirname(file), { recursive: true });
    // Write-then-rename: a crash mid-write leaves the previous queue intact rather than a half file.
    const temporary = `${file}.tmp`;
    await writeFile(temporary, items.map((item) => JSON.stringify(item)).join('\n') + (items.length ? '\n' : ''));
    await rename(temporary, file);
  }

  async add(queue: string, reference: string, data: Record<string, unknown>): Promise<TransactionItem> {
    return this.locked(queue, async () => {
      const items = await this.read(queue);
      const item: TransactionItem = {
        id: `tx-${(items.length + 1).toString().padStart(6, '0')}-${Math.random().toString(36).slice(2, 8)}`,
        reference,
        data,
        specificContent: data,
        status: 'New',
        retries: 0,
        createdUtc: new Date().toISOString(),
        updatedUtc: new Date().toISOString()
      };
      items.push(item);
      await this.write(queue, items);
      return item;
    });
  }

  /**
   * The next New item, claimed as InProgress — the same hand-over a work queue performs, so two
   * performers racing over one queue cannot pick the same transaction.
   */
  async getTransactionItem(queue: string): Promise<TransactionItem | null> {
    return this.locked(queue, async () => {
      const items = await this.read(queue);
      const next = items.find((item) => item.status === 'New');
      if (!next) return null;
      next.status = 'InProgress';
      next.updatedUtc = new Date().toISOString();
      await this.write(queue, items);
      return next;
    });
  }

  /** `Retry` returns the item to New with its retry count bumped; everything else is terminal. */
  async setStatus(
    queue: string,
    id: string,
    status: string,
    reason?: string,
    exceptionType?: 'business' | 'application' | 'system',
    analytics?: Record<string, unknown>
  ): Promise<TransactionItem> {
    if (!SETTABLE.has(status)) {
      throw new Error(`queue.setStatus got "${status}"; expected one of ${[...SETTABLE].join(', ')}.`);
    }
    return this.locked(queue, async () => {
      const items = await this.read(queue);
      const item = items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`queue.setStatus: no transaction "${id}" in queue "${queue}".`);
      if (status === 'Retry') {
        item.status = 'New';
        item.retries += 1;
        item.reason = reason ?? item.reason;
      } else {
        item.status = status as TransactionStatus;
        if (reason) item.reason = reason;
        // A ProcessingException is recorded alongside the terminal status; keeping the same shape
        // means a queue file stays readable by anything that knows the format. The type is inferred
        // from the status when the caller does not name one (BusinessException → business), so a
        // status set by hand in the Studio records the same shape a performer's setStatus does.
        const type = exceptionType ?? inferExceptionType(status);
        if (type) item.processingException = { type, reason: reason ?? '' };
        if (analytics) item.analytics = analytics;
      }
      item.updatedUtc = new Date().toISOString();
      await this.write(queue, items);
      return item;
    });
  }

  async count(queue: string, status?: string): Promise<number> {
    const items = await this.read(queue);
    return status ? items.filter((item) => item.status === status).length : items.length;
  }

  async items(queue: string): Promise<TransactionItem[]> {
    return this.read(queue);
  }
}

// ── Settings (the Config.xlsx equivalent) ───────────────────────────────────────────────────────

/** Parse RFC-4180-ish CSV: quoted fields, embedded commas and newlines, doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (char === '\r') continue;
    field += char;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

export function toCsv(rows: Array<Record<string, unknown>> | string[][]): string {
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  if (rows.length === 0) return '';
  if (Array.isArray(rows[0])) {
    return (rows as string[][]).map((cells) => cells.map(escape).join(',')).join('\n') + '\n';
  }
  const objects = rows as Array<Record<string, unknown>>;
  const headers = [...new Set(objects.flatMap((row) => Object.keys(row)))];
  const lines = [headers.join(',')];
  for (const row of objects) lines.push(headers.map((header) => escape(row[header])).join(','));
  return lines.join('\n') + '\n';
}

export interface SettingsEntry {
  name: string;
  value: string;
  description?: string;
}

/**
 * Read a settings file into Name/Value pairs — the Name/Value shape a spreadsheet config uses
 * (sheets Settings / Constants / Assets). JSON (`{ "Key": "value" }` or `{ "Config": { … } }`),
 * CSV and XLSX are accepted; XLSX needs the optional `exceljs` module, and the error says so.
 */
export async function loadSettings(file: string): Promise<SettingsEntry[]> {
  const resolved = path.resolve(file);
  const extension = path.extname(resolved).toLowerCase();

  if (extension === '.json') {
    const parsed = JSON.parse(await readFile(resolved, 'utf8')) as Record<string, unknown>;
    const scope = typeof parsed.Config === 'object' && parsed.Config !== null ? parsed.Config as Record<string, unknown> : parsed;
    return Object.entries(scope).map(([name, value]) => ({
      name,
      value: value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
    }));
  }

  if (extension === '.csv') {
    const rows = parseCsv(await readFile(resolved, 'utf8'));
    const header = rows[0]?.map((cell) => cell.trim().toLowerCase()) ?? [];
    const nameAt = Math.max(header.indexOf('name'), 0);
    const valueAt = header.indexOf('value') >= 0 ? header.indexOf('value') : 1;
    const descriptionAt = header.indexOf('description');
    return rows.slice(1).map((cells) => ({
      name: (cells[nameAt] ?? '').trim(),
      value: (cells[valueAt] ?? '').trim(),
      ...(descriptionAt >= 0 ? { description: (cells[descriptionAt] ?? '').trim() } : {})
    })).filter((entry) => entry.name !== '');
  }

  if (extension === '.xlsx') {
    interface SheetLike {
      eachRow: (
        options: { includeEmpty: boolean },
        callback: (row: { getCell: (index: number) => { value: unknown } }, index: number) => void
      ) => void;
    }
    interface WorkbookLike {
      xlsx: { load: (file: string) => Promise<void> };
      worksheets: SheetLike[];
    }
    let ExcelJS: { Workbook: new () => WorkbookLike };
    const specifier = 'exceljs';
    try {
      ExcelJS = await import(specifier) as unknown as typeof ExcelJS;
    } catch {
      throw new Error('Reading .xlsx settings needs the optional dependency "exceljs" — install it with `npm i exceljs`, or export the sheet to the same Name/Value columns as CSV.');
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(resolved);
    const entries: SettingsEntry[] = [];
    for (const sheet of workbook.worksheets) {
      sheet.eachRow({ includeEmpty: false }, (row, index) => {
        if (index === 1) return; // header
        const name = row.getCell(1).value;
        const value = row.getCell(2).value;
        const description = row.getCell(3).value;
        if (name !== null && name !== undefined && String(name).trim() !== '') {
          entries.push({
            name: String(name).trim(),
            value: value === null || value === undefined ? '' : String(value),
            ...(description ? { description: String(description) } : {})
          });
        }
      });
    }
    return entries;
  }

  throw new Error(`Unsupported settings file "${path.basename(resolved)}": use .json, .csv or .xlsx.`);
}

// ── Files ───────────────────────────────────────────────────────────────────────────────────────

/** A `*`/`**` glob, compiled to a regex — enough for "process every PDF in this folder". */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${withWildcards}$`, 'i');
}

/** Every file under `folder` matching the glob, sorted for a deterministic run order. */
export async function listFiles(folder: string, pattern = '*'): Promise<string[]> {
  const root = path.resolve(folder);
  const regex = globToRegExp(pattern);
  const found: string[] = [];

  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (regex.test(relative) || regex.test(entry.name)) found.push(full);
    }
  };
  await walk(root);
  return found.sort();
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function moveFile(from: string, to: string): Promise<void> {
  await ensureDir(path.dirname(path.resolve(to)));
  await rename(from, to);
}

export async function deleteFile(file: string): Promise<void> {
  await unlink(file);
}

// ── Tables (CSV natively; XLSX through the optional exceljs) ─────────────────────────────────────

export type TableRow = Record<string, string>;

interface ExcelSheet {
  getRow: (index: number) => { values: unknown[] };
  addRow: (values: unknown[]) => unknown;
  rowCount: number;
}

interface ExcelWorkbook {
  addWorksheet: (name: string) => ExcelSheet;
  getWorksheet: (name: string) => ExcelSheet | undefined;
  worksheets: ExcelSheet[];
  csv: { readFile: (file: string) => Promise<void>; writeFile: (file: string) => Promise<void> };
  xlsx: { readFile: (file: string) => Promise<void>; writeFile: (file: string) => Promise<void> };
}

async function loadExcelJs(): Promise<{ Workbook: new () => ExcelWorkbook }> {
  try {
    const specifier = 'exceljs';
        return await import(specifier) as unknown as { Workbook: new () => ExcelWorkbook };
  } catch {
    throw new Error('Reading or writing .xlsx needs the optional dependency "exceljs" — install it with `npm i exceljs` (Excel Application Scope equivalent).');
  }
}

/** A sheet or CSV as header-keyed rows: `[{"Invoice Number": "INV-1", ...}, …]`. */
export async function readTable(file: string, sheet?: string): Promise<TableRow[]> {
  const resolved = path.resolve(file);
  const extension = path.extname(resolved).toLowerCase();

  if (extension === '.csv') {
    const rows = parseCsv(await readFile(resolved, 'utf8'));
    const header = (rows.shift() ?? []).map((cell) => cell.trim());
    return rows.map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ''])));
  }

  if (extension === '.xlsx') {
    const { Workbook } = await loadExcelJs();
    const workbook = new Workbook();
    await workbook.xlsx.readFile(resolved);
    const worksheet = sheet ? workbook.getWorksheet(sheet) : workbook.worksheets[0];
    if (!worksheet) throw new Error(`No sheet "${sheet ?? '(first)'}" in ${path.basename(resolved)}.`);
    const header = (worksheet.getRow(1).values as unknown[]).slice(1).map((cell) => String(cell ?? '').trim());
    const rows: TableRow[] = [];
    for (let index = 2; index <= worksheet.rowCount; index++) {
      const values = (worksheet.getRow(index).values as unknown[]).slice(1);
      if (values.every((value) => value === null || value === undefined || String(value).trim() === '')) continue;
      rows.push(Object.fromEntries(header.map((key, column) => [key, valueOf(values[column])])));
    }
    return rows;
  }

  throw new Error(`Unsupported table "${path.basename(resolved)}": use .csv or .xlsx.`);
}

function valueOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const record = value as { text?: string; result?: unknown; richText?: Array<{ text: string }> };
    if (record.richText) return record.richText.map((part) => part.text).join('');
    if (record.text !== undefined) return String(record.text);
    if (record.result !== undefined) return String(record.result);
    return JSON.stringify(value);
  }
  return String(value);
}

/** Write header-keyed rows back — used by both `excel.writeRange` and `excel.writeCell`. */
export async function writeTable(file: string, rows: TableRow[], sheet?: string): Promise<void> {
  const resolved = path.resolve(file);
  const extension = path.extname(resolved).toLowerCase();
  await ensureDir(path.dirname(resolved));

  if (extension === '.csv') {
    await writeFile(resolved, toCsv(rows));
    return;
  }

  if (extension === '.xlsx') {
    const { Workbook } = await loadExcelJs();
    const workbook = new Workbook();
    const worksheet = workbook.addWorksheet(sheet ?? 'Sheet1');
    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    worksheet.addRow(headers);
    for (const row of rows) worksheet.addRow(headers.map((header) => row[header] ?? ''));
    await workbook.xlsx.writeFile(resolved);
    return;
  }

  throw new Error(`Unsupported table "${path.basename(resolved)}": use .csv or .xlsx.`);
}
