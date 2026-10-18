/**
 * `rpa import` — read a legacy desktop-automation export and write this tool's JSON.
 *
 * What it is: a converter for the *subset* a real export uses (a transactional pair: a dispatcher
 * that feeds a queue, a performer that consumes it). It reads XAML (or a project descriptor listing
 * XAML files) and writes one `.json` workflow per source file, plus `PORTING-REPORT.md` — every
 * activity it could not map, with its source line, so a port has a to-do list instead of a silent
 * loss.
 *
 * What it is not: an XAML runtime, a VB evaluator, or a full-fidelity converter. Expressions are
 * translated only where the meaning is unambiguous (`Config("X")` → `${Config.X}`, `RetryNumber + 1`
 * → `control.math`); anything else is reported rather than guessed at. Selector strings go through
 * `parseSelectorChain`, so a recorded chain becomes a target this engine resolves.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSelectorChain } from '../workflow/selector-chain.js';
import type { Step, Workflow } from '../workflow/model.js';

// ── XML ─────────────────────────────────────────────────────────────────────────────────────────

export interface XmlNode {
  /** Local name — the namespace prefix is dropped (`ui:Click` → `Click`). */
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  /** 1-based line of the element's `<`, so a report entry points at the source. */
  line: number;
  /** Character data directly inside the element, when there is any (an argument's value). */
  text?: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/**
 * A small XML reader — enough for XAML, which is machine-written and well-formed: elements,
 * attributes, self-closing tags, comments, CDATA, entities. Property elements keep their dots
 * (`Sequence.Variables`), and every node remembers its line.
 */
export function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '#document', attributes: {}, children: [], line: 1 };
  const stack: XmlNode[] = [root];
  let index = 0;
  let line = 1;
  const advance = (to: number) => {
    for (let i = index; i < to; i++) if (text[i] === '\n') line++;
    index = to;
  };

  while (index < text.length) {
    const open = text.indexOf('<', index);
    if (open < 0) break;
    // Character data between the last tag and this one: an argument's value is often written as
    // `<InArgument x:Key="path">[CurrentFile.FullName]</InArgument>`.
    const gap = text.slice(index, open).trim();
    if (gap !== '' && stack.length > 0) stack[stack.length - 1]!.text = decodeXml(gap);
    advance(open);

    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index);
      advance(end < 0 ? text.length : end + 3);
      continue;
    }
    if (text.startsWith('<?', index) || text.startsWith('<!', index)) {
      const end = text.indexOf('>', index);
      advance(end < 0 ? text.length : end + 1);
      continue;
    }

    // The end of the tag: the first `>` that is not inside a quoted attribute value (`>=` in a
    // condition is the usual way to get this wrong).
    let close = index + 1;
    let quote = '';
    for (; close < text.length; close++) {
      const char = text[close]!;
      if (quote) { if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '>') break;
    }
    if (close >= text.length) throw new Error('XAML is not well formed: an element is never closed.');
    const inner = text.slice(index + 1, close).trim();
    const startLine = line;

    if (inner.startsWith('/')) {
      const raw = inner.slice(1).trim();
      // The closing tag carries the same prefix as the opening one; compare local names.
      const name = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
      const current = stack.pop();
      if (!current || current.name !== name) {
        throw new Error(`XAML is not well formed near line ${line}: </${name}> does not close <${current?.name ?? 'nothing'}>.`);
      }
      advance(close + 1);
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/\s/);
    const rawName = space < 0 ? body : body.slice(0, space);
    const attributeText = space < 0 ? '' : body.slice(space);

    const node: XmlNode = {
      name: rawName.includes(':') ? rawName.slice(rawName.indexOf(':') + 1) : rawName,
      attributes: {},
      children: [],
      line: startLine
    };
    const attributePattern = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    for (const match of attributeText.matchAll(attributePattern)) {
      const raw = match[1]!;
      // `x:Key` keeps its prefix (it is an XML-language attribute, not an activity one); `ui:Text`
      // is the same attribute as `Text`.
      const name = raw.startsWith('x:') || raw.startsWith('xmlns:') ? raw : raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
      node.attributes[name] = decodeXml(match[3] ?? match[4] ?? '');
    }

    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) stack.push(node);
    advance(close + 1);
  }
  return root;
}

/** The property element a container keeps one of its parts in, e.g. `If.Then` / `ForEach.Body`. */
function property(node: XmlNode, name: string): XmlNode | undefined {
  const wanted = name.toLowerCase();
  return node.children.find((child) => {
    const dot = child.name.lastIndexOf('.');
    return dot > 0 && child.name.slice(dot + 1).toLowerCase() === wanted;
  });
}

/** Descend through the plumbing containers (`ActivityAction`, `Sequence`) to the steps inside. */
function bodySteps(node: XmlNode | undefined): XmlNode[] {
  if (!node) return [];
  const sequence = node.children.find((child) => child.name === 'Sequence');
  if (sequence) return sequence.children;
  const action = node.children.find((child) => child.name === 'ActivityAction');
  if (action) return bodySteps(action);
  return node.children;
}

function findDeep(node: XmlNode | undefined, names: string[]): XmlNode | undefined {
  if (!node) return undefined;
  for (const child of node.children) {
    if (names.includes(child.name)) return child;
    const found = findDeep(child, names);
    if (found) return found;
  }
  return undefined;
}

// ── Expressions ─────────────────────────────────────────────────────────────────────────────────

const QUOTED = /^"([\s\S]*)"$|^'([\s\S]*)'$/;

/** The offset of a separator that sits outside quotes and brackets, or -1. */
function splitTop(text: string, separator: string): number {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') quoted = !quoted;
    if (!quoted) {
      if (char === '(' || char === '[') depth++;
      if (char === ')' || char === ']') depth--;
      if (depth === 0 && text.startsWith(separator, i)) return i;
    }
  }
  return -1;
}

/**
 * One VB reference → this tool's `${…}`, or null when the meaning is not obvious enough to guess.
 * `Config("Name")` → `${Config.Name}`, `TransactionItem("amount").ToString` →
 * `${TransactionItem.amount}`, `CurrentFile.Name` → `${CurrentFile.name}` (a loop variable is an
 * object in the source and a name/extension/folder triple here).
 */
function reference(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  const quoted = text.match(QUOTED);
  if (quoted) return quoted[1] ?? quoted[2] ?? '';
  // Literals stay literals: a number, or a boolean.
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return text;
  if (/^(true|false)$/i.test(text)) return text.toLowerCase();

  const call = text.match(/^([A-Za-z_]\w*)\(\s*"([^"]*)"\s*\)(?:\.ToString)?(?:\.Trim)?$/);
  if (call) return `\${${call[1]}.${call[2]}}`;

  const member = text.match(/^([A-Za-z_][\w.]*?)(?:\.ToString\(\)?)?(?:\.Trim\(\)?)?$/);
  if (member) {
    const dotted = member[1]!;
    const loop = dotted.match(/^([A-Za-z_]\w*)\.(Name|FullName|Extension|Folder)$/);
    if (loop) return `\${${loop[1]}${loop[2] === 'FullName' ? '' : `.${loop[2]!.toLowerCase()}`}}`;
    // The engine publishes the caught exception as `exception.message` / `exception.kind`.
    if (/^exception\./i.test(dotted)) return `\${exception.${dotted.slice(dotted.indexOf('.') + 1).toLowerCase()}}`;
    return `\${${dotted}}`;
  }
  return null;
}

/** A VB expression as an interpolated string; `+` between literals and references concatenates. */
function toText(raw: string, report: Report, line: number, what: string): string | null {
  const text = raw.trim();
  if (text === '') return '';
  const pieces: string[] = [];
  let rest = text;
  for (;;) {
    const at = splitTop(rest, '+');
    const part = at < 0 ? rest : rest.slice(0, at);
    const value = reference(part);
    if (value === null) {
      report.unmapped.push({ activity: what, line, detail: `the expression \`${part.trim()}\` was not translated` });
      return null;
    }
    pieces.push(value);
    if (at < 0) break;
    rest = rest.slice(at + 1);
  }
  return pieces.join('');
}

/** A VB boolean expression as this engine's condition syntax (`==`, `!=`, `>=`, `<=`, `>`, `<`). */
function toCondition(raw: string, report: Report, line: number, what: string): string | null {
  let text = raw.trim();
  while (text.startsWith('(') && text.endsWith(')') && splitTop(text.slice(1, -1), ')') === -1) text = text.slice(1, -1).trim();
  if (text === '') return null;
  if (text.startsWith('Not ')) {
    const inner = toCondition(text.slice(4), report, line, what);
    return inner === null ? null : `!${inner}`;
  }
  for (const [operator, symbol] of [['<>', '!='], ['>=', '>='], ['<=', '<='], ['=', '=='], ['>', '>'], ['<', '<']] as const) {
    const at = splitTop(text, operator);
    if (at < 0) continue;
    const left = reference(text.slice(0, at));
    const rightRaw = text.slice(at + operator.length).trim();
    const right = rightRaw === 'Nothing' ? '' : reference(rightRaw);
    if (left === null || right === null) {
      report.unmapped.push({ activity: what, line, detail: `the condition \`${text}\` was not translated` });
      return null;
    }
    return `${left} ${symbol} ${right}`;
  }
  const plain = reference(text);
  if (plain === null) {
    report.unmapped.push({ activity: what, line, detail: `the condition \`${text}\` was not translated` });
    return null;
  }
  return plain;
}

/** `[ … ]` (the VB expression form) or a bare attribute → the inner expression. */
const expressionOf = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const text = value.trim();
  return text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
};

/**
 * An attribute's meaning: `[…]` is an expression, anything else is the literal text it looks like.
 * (Treating `Text="Nothing left in the queue."` as an expression would blank it silently.)
 */
function attributeText(value: string, report: Report, line: number, what: string): string | null {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('[') && trimmed.endsWith(']'))) return value;
  return toText(trimmed.slice(1, -1), report, line, what);
}

/** The value of an argument element: its `Value` attribute, or the text written inside it. */
const argumentValue = (node: XmlNode): string | undefined => node.attributes['Value'] ?? node.text;

// ── Report ──────────────────────────────────────────────────────────────────────────────────────

export interface UnmappedEntry {
  activity: string;
  line: number;
  detail: string;
}

export interface Report {
  file: string;
  mapped: Map<string, number>;
  unmapped: UnmappedEntry[];
  notes: string[];
}

interface ImportedFile {
  source: string;
  output: string;
  steps: number;
  workflow: Workflow;
}

export interface ImportResult {
  outDir: string;
  files: ImportedFile[];
  report: Report[];
  reportFile: string;
}

// ── Conversion ──────────────────────────────────────────────────────────────────────────────────

interface Context {
  report: Report;
  /** Data tables that came from a file path, so `ForEachRow` / `WriteRange` can name it. */
  tables: Map<string, { path: string; sheet?: string }>;
}

/** Property containers and argument holders: never steps, never "unmapped activities" either. */
const PLUMBING = new Set([
  'Variable', 'Variables', 'DelegateInArgument', 'VisualBasicValue', 'VisualBasicReference', 'Literal',
  'InArgument', 'OutArgument', 'Argument', 'Members', 'TextExpression', 'Catch', 'ActivityAction',
  'AssignOperation', 'Collection', 'String', 'Boolean', 'TargetApp', 'TargetAnchorable', 'ItemInformation'
]);

/** Elements that hold a value, not steps: their children are never walked as a body. */
const VALUE_HOLDERS = new Set([
  'Variable', 'DelegateInArgument', 'VisualBasicValue', 'VisualBasicReference', 'Literal',
  'InArgument', 'OutArgument', 'Argument', 'AssignOperation', 'Catch', 'TargetAnchorable'
]);

const isPlumbing = (name: string): boolean => name.includes('.') || PLUMBING.has(name);

function attribute(node: XmlNode, ...names: string[]): string | undefined {
  for (const name of names) {
    const wanted = name.toLowerCase();
    const found = Object.entries(node.attributes).find(([key]) => {
      const lower = key.toLowerCase();
      return lower === wanted || lower === `x:${wanted}`;
    });
    if (found) return found[1];
  }
  return undefined;
}

/** The recorded chain on an activity, whatever attribute carried it. */
function chainOf(node: XmlNode): string | undefined {
  const target = node.children.find((child) => child.name.endsWith('.Target'));
  const anchorable = target ? findDeep(target, ['TargetAnchorable', 'Target']) : undefined;
  const raw = attribute(node, 'Selector', 'FullSelectorArgument', 'StrictSelector')
    ?? anchorable?.attributes['FullSelectorArgument']
    ?? anchorable?.attributes['Selector']
    ?? anchorable?.attributes['StrictSelector']
    ?? attribute(node, 'FuzzySelectorArgument')
    ?? anchorable?.attributes['FuzzySelectorArgument'];
  return raw ? decodeXml(raw) : undefined;
}

/**
 * What a `desktop.uia` step needs to find the element a recorded chain describes: the properties
 * the accessibility API knows it by (name, automation id, control type), plus the raw chain kept
 * on the step's target so nothing the record captured is thrown away.
 */
function elementFields(node: XmlNode): Record<string, unknown> {
  const chain = chainOf(node);
  if (!chain) return {};
  const fields: Record<string, unknown> = { target: { selectorChain: chain } };
  const spec = parseSelectorChain(chain);
  if (!spec?.uia) return fields;
  if (spec.uia.name) fields.name = spec.uia.name;
  if (spec.uia.automationId) fields.automationId = spec.uia.automationId;
  if (spec.uia.controlType) fields.controlType = spec.uia.controlType;
  return fields;
}

/** A selector, from an attribute or a `<Click.Target>` property element holding a target object. */
function selectorOf(node: XmlNode): Record<string, unknown> | undefined {
  const chain = chainOf(node);
  if (!chain) return undefined;
  const parsed = parseSelectorChain(chain);
  return parsed ? (parsed as Record<string, unknown>) : { strict: chain };
}

/** TimeSpan / `hh:mm:ss` / `[TimeSpan.FromSeconds(n)]` → milliseconds. */
function durationToMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const text = expressionOf(value)?.trim() ?? '';
  const clock = text.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (clock) {
    const [, hours, minutes, seconds, fraction] = clock;
    return (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 + Number(`0.${fraction ?? '0'}`) * 1000;
  }
  const from = text.match(/TimeSpan\.From(Milliseconds|Seconds|Minutes)\((\d+(?:\.\d+)?)\)/);
  if (from) {
    const unit = from[1] === 'Milliseconds' ? 1 : from[1] === 'Seconds' ? 1000 : 60000;
    return Math.round(Number(from[2]) * unit);
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

const QUEUE_STATUS: Record<string, string> = {
  successful: 'Successful', businessexception: 'BusinessException', businessruleexception: 'BusinessException',
  applicationexception: 'ApplicationException', retry: 'Retry', abandoned: 'Abandoned', new: 'New'
};

/** `Status="Successful"` (or `[TransactionStatus.Successful]`) → this queue's status vocabulary. */
function statusOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = (expressionOf(value) ?? '').replace(/^TransactionStatus\./i, '').replace(/[^\w]/g, '').toLowerCase();
  return QUEUE_STATUS[text];
}

/** The variable a loop body calls with `("field")` — the name the engine must bind (`row`, `dtRow`…). */
function calledVariable(nodes: XmlNode[], fallback: string): string {
  for (const node of nodes) {
    for (const value of Object.values(node.attributes)) {
      const match = expressionOf(value)?.match(/([A-Za-z_]\w*)\(\s*"/);
      if (match) return match[1]!;
    }
    const deeper = calledVariable(node.children, '');
    if (deeper) return deeper;
  }
  return fallback;
}

/** The variable a file loop body reads `X.Name` / `X.FullName` from. */
function fileVariable(nodes: XmlNode[], fallback: string): string {
  for (const node of nodes) {
    for (const value of Object.values(node.attributes)) {
      const match = expressionOf(value)?.match(/([A-Za-z_]\w*)\.(FullName|Name|Extension|Folder)\b/);
      if (match) return match[1]!;
    }
    const deeper = fileVariable(node.children, '');
    if (deeper) return deeper;
  }
  return fallback;
}

const bare = (name: string | null | undefined): string | undefined => name?.replace(/^\$\{/, '').replace(/\}$/, '');

/**
 * Convert one element. Returns the steps it became (empty = handled, nothing to emit), or null when
 * the element is an activity this converter does not know — the caller reports those with the line.
 */
function convertActivity(node: XmlNode, context: Context): Step[] | null {
  const { report } = context;
  const line = node.line;
  const name = node.name;
  const mapped = (): void => { report.mapped.set(name, (report.mapped.get(name) ?? 0) + 1); };
  const fail = (detail: string): Step[] => {
    report.unmapped.push({ activity: name, line, detail });
    return [];
  };
  const text = (value: string | undefined, what = name): string | undefined => {
    if (value === undefined) return undefined;
    return attributeText(value, report, line, what) ?? undefined;
  };

  switch (name) {
    // ── plumbing ─────────────────────────────────────────────────────────────────────────────
    case 'Sequence':
    case 'Activity':
    case 'Workflow':
      mapped();
      return convertChildren(node.children, context);
    case 'Flowchart':
    case 'StateMachine':
      mapped();
      report.notes.push(`line ${line}: a ${name} is flattened into its steps in order — check the transitions by hand.`);
      return convertChildren(node.children, context);
    case 'Comment':
    case 'CommentOut':
      mapped();
      return [];

    // ── control flow ────────────────────────────────────────────────────────────────────────
    case 'If': {
      mapped();
      const raw = expressionOf(attribute(node, 'Condition'))
        ?? findDeep(property(node, 'Condition'), ['VisualBasicValue'])?.attributes['ExpressionText'] ?? '';
      const condition = toCondition(raw, report, line, name);
      const then = bodySteps(property(node, 'Then')).length > 0
        ? convertChildren(bodySteps(property(node, 'Then')), context)
        : [];
      const otherwise = convertChildren(bodySteps(property(node, 'Else')), context);
      if (condition === null) {
        report.notes.push(`line ${line}: the if was flattened (its condition was not translated) — the branch runs unconditionally until the condition is fixed.`);
        return [...then, ...otherwise];
      }
      return [{ type: 'control', action: 'if', condition, then, else: otherwise } as Step];
    }
    case 'While': {
      mapped();
      const raw = expressionOf(attribute(node, 'Condition'))
        ?? findDeep(property(node, 'Condition'), ['VisualBasicValue'])?.attributes['ExpressionText'] ?? '';
      const condition = toCondition(raw, report, line, name);
      const steps = convertChildren(bodySteps(property(node, 'Body')), context);
      if (condition === null) return fail('the while condition was not translated, so the loop is left out');
      return [{ type: 'control', action: 'while', condition, maxIterations: 100, steps } as Step];
    }
    case 'ForEach': {
      mapped();
      const values = expressionOf(attribute(node, 'Values')) ?? '';
      const itemName = attribute(node, 'ItemName') ?? findDeep(node, ['DelegateInArgument'])?.attributes['Name'] ?? 'item';
      const collection = bare(reference(values));
      if (!collection) return fail(`the collection \`${values}\` was not translated`);
      const steps = convertChildren(bodySteps(property(node, 'Body')), context);
      return [{ type: 'control', action: 'foreach', items: collection, itemName, steps } as Step];
    }
    case 'TryCatch': {
      mapped();
      const body = convertChildren(bodySteps(property(node, 'Try')), context);
      const catchContainers = property(node, 'Catches')?.children.filter((child) => child.name === 'Catch') ?? [];
      const catches = catchContainers.map((catcher) => ({
        kind: /BusinessRule/i.test(attribute(catcher, 'TypeArguments') ?? '') ? 'business' : 'application',
        steps: convertChildren(bodySteps(catcher), context)
      }));
      const cleanup = convertChildren(bodySteps(property(node, 'Finally')), context);
      return [{ type: 'control', action: 'try', body, catches, finally: cleanup } as Step];
    }
    case 'Throw': {
      mapped();
      const exception = attribute(node, 'Exception') ?? '';
      const kind = /BusinessRule/i.test(exception) ? 'business' : 'application';
      // `New SomeException("the invoice is unreadable")` — take the literal; anything else is either
      // a reference (interpolated) or goes into the report.
      const constructed = exception.match(/New\s+[\w.]*Exception\s*\(\s*"([\s\S]*)"\s*\)/);
      if (constructed) return [{ type: 'control', action: 'throw', kind, message: constructed[1]! } as Step];
      const message = text(exception);
      if (message === undefined || message === '') return fail('the exception message was not translated');
      return [{ type: 'control', action: 'throw', kind, message } as Step];
    }
    case 'RetryScope': {
      mapped();
      const container = property(node, 'ActivityBody') ?? property(node, 'Body');
      const steps = convertChildren(bodySteps(container), context);
      const raw = expressionOf(attribute(node, 'Condition'))
        ?? findDeep(property(node, 'Condition'), ['VisualBasicValue'])?.attributes['ExpressionText'] ?? '';
      const until = toCondition(raw, report, line, name);
      const retries = Number(expressionOf(attribute(node, 'NumberOfRetries')) ?? 3) || 3;
      const delay = durationToMs(attribute(node, 'RetryInterval'));
      return [{
        type: 'control', action: 'retryScope', retries,
        ...(delay !== undefined ? { retryDelayMs: delay } : {}),
        ...(until ? { until } : {}),
        steps
      } as Step];
    }
    case 'Assign':
    case 'MultipleAssign':
      return assignSteps(node, context);
    case 'Delay': {
      mapped();
      return [{ type: 'control', action: 'delay', ms: durationToMs(attribute(node, 'Duration')) ?? 0 } as Step];
    }
    case 'LogMessage': {
      mapped();
      const message = text(attribute(node, 'Text', 'Message'));
      if (message === undefined) return fail('the message was not translated');
      return [{ type: 'control', action: 'log', message } as Step];
    }
    case 'InvokeWorkflowFile': {
      mapped();
      const workflow = text(attribute(node, 'WorkflowFileName'));
      if (!workflow) return fail('the workflow file name was not translated');
      const argumentNodes = (property(node, 'Arguments') ?? node).children;
      const args: Record<string, string> = {};
      for (const child of argumentNodes) {
        const key = child.attributes['x:Key'] ?? child.attributes['Key'] ?? child.attributes['Argument'];
        const raw = argumentValue(child);
        if (!key || raw === undefined) continue;
        const translated = attributeText(raw, report, line, `${name} › ${key}`);
        if (translated !== null) args[key] = translated;
      }
      return [{ type: 'control', action: 'invoke', workflow: workflow.replace(/\\/g, '/'), ...(Object.keys(args).length > 0 ? { arguments: args } : {}) } as Step];
    }
    case 'InputDialog': {
      mapped();
      const prompt = text(attribute(node, 'Label', 'Title'));
      if (prompt === undefined) return fail('the dialog label was not translated');
      const saveAs = bare(reference(expressionOf(attribute(node, 'Result')) ?? ''));
      return [{ type: 'hitl', action: 'ask', prompt, ...(saveAs ? { saveAs } : {}) } as Step];
    }

    // ── the application scope + element steps ───────────────────────────────────────────────
    case 'NApplicationCard':
    case 'ApplicationCard':
    case 'UseApplicationBrowser':
    case 'UseBrowser':
    case 'BrowserScope': {
      mapped();
      const steps: Step[] = [];
      const url = attribute(node, 'Url', 'URL');
      const title = attribute(node, 'WindowTitle', 'Title') ?? findDeep(node, ['TargetApp'])?.attributes['Title'];
      if (url) {
        const translated = text(url);
        if (translated) {
          report.notes.push(`line ${line}: the scope opens a browser at ${translated} — this toolkit drives the desktop only, so the page is not opened; the steps inside run against whatever window has focus.`);
          steps.push({ type: 'control', action: 'log', message: `browser scope (not opened): ${translated}` } as Step);
        }
      } else if (title) {
        report.notes.push(`line ${line}: the application scope opens a window ("${title}") — no window is opened; a targeted step finds it by its properties instead.`);
        steps.push({ type: 'control', action: 'log', message: `application scope: ${title}` } as Step);
      }
      steps.push(...convertChildren(bodySteps(property(node, 'Body') ?? node), context));
      return steps;
    }
    case 'Click':
    case 'NClick': {
      mapped();
      if (!chainOf(node)) return fail('the click has no element to find');
      return [{ type: 'desktop', action: 'uia', uiaAction: 'invoke', ...elementFields(node) } as Step];
    }
    case 'TypeInto':
    case 'NTypeInto': {
      mapped();
      const value = toText(expressionOf(attribute(node, 'Text')) ?? '', report, line, name);
      if (!chainOf(node)) return fail('the type step has no element to find');
      if (value === null) return []; // toText reported the expression
      return [{ type: 'desktop', action: 'uia', uiaAction: 'setValue', value, ...elementFields(node) } as Step];
    }
    case 'GetText':
    case 'NGetText': {
      mapped();
      const saveAs = bare(reference(expressionOf(attribute(node, 'Result', 'Text', 'Output')) ?? ''));
      if (!chainOf(node)) return fail('the read has no element to find');
      if (!saveAs) return fail('the result variable was not translated');
      return [{ type: 'desktop', action: 'uia', uiaAction: 'getText', saveAs, ...elementFields(node) } as Step];
    }

    // ── the queue ────────────────────────────────────────────────────────────────────────────
    case 'AddQueueItem': {
      mapped();
      const queue = text(attribute(node, 'QueueName'));
      if (!queue) return fail('the queue name was not translated');
      const referenceValue = text(attribute(node, 'Reference', 'Reference1')) ?? '';
      const data: Record<string, string> = {};
      for (const child of (property(node, 'ItemInformation') ?? node).children) {
        const key = child.attributes['x:Key'] ?? child.attributes['Key'] ?? child.attributes['Argument'];
        const raw = argumentValue(child);
        if (!key || raw === undefined) continue;
        const translated = attributeText(raw, report, line, `${name} › ${key}`);
        if (translated !== null) data[key] = translated;
      }
      return [{ type: 'queue', action: 'addItem', queue, reference: referenceValue, data } as Step];
    }
    case 'GetTransactionItem': {
      mapped();
      const queue = text(attribute(node, 'QueueName'));
      if (!queue) return fail('the queue name was not translated');
      const saveAs = bare(reference(expressionOf(attribute(node, 'Output', 'TransactionItem', 'Result')) ?? '')) ?? 'TransactionItem';
      return [{ type: 'queue', action: 'getTransactionItem', queue, saveAs } as Step];
    }
    case 'SetTransactionStatus': {
      mapped();
      const queue = text(attribute(node, 'QueueName'));
      const status = statusOf(attribute(node, 'Status', 'TransactionStatus'));
      if (!queue) return fail('the queue name was not translated');
      if (!status) return fail('the status was not translated');
      const reason = text(attribute(node, 'Reason', 'ErrorMessage')) ?? '';
      const item = bare(reference(expressionOf(attribute(node, 'TransactionItem')) ?? ''));
      const exceptionType = /Business/i.test(status) ? 'business' : /Application/i.test(status) ? 'application' : undefined;
      return [{
        type: 'queue', action: 'setStatus', queue, status,
        ...(item ? { item } : {}),
        ...(reason ? { reason } : {}),
        ...(exceptionType ? { exceptionType } : {})
      } as Step];
    }

    // ── spreadsheets and the row loop ────────────────────────────────────────────────────────
    case 'ReadRange': {
      mapped();
      const file = text(attribute(node, 'WorkbookPath'));
      if (!file) return fail('the workbook path was not translated');
      const sheet = text(attribute(node, 'SheetName'));
      const table = bare(reference(expressionOf(attribute(node, 'DataTable', 'Result', 'Output')) ?? '')) ?? 'DataTable';
      const clean = file.replace(/\\/g, '/');
      context.tables.set(table, { path: clean, ...(sheet ? { sheet } : {}) });
      return [{ type: 'excel', action: 'readRange', path: clean, ...(sheet ? { sheet } : {}), saveAs: table } as Step];
    }
    case 'ForEachRow': {
      mapped();
      const body = bodySteps(property(node, 'Body'));
      const steps = convertChildren(body, context);
      const tableName = bare(reference(expressionOf(attribute(node, 'DataTable')) ?? '')) ?? '';
      const table = context.tables.get(tableName);
      if (!table) return fail(`the data table \`${tableName || '(unnamed)'}\` was not read from a file — read it with ReadRange first so the loop can name it`);
      const rowName = calledVariable(body, 'row');
      return [{ type: 'excel', action: 'forEachRow', path: table.path, ...(table.sheet ? { sheet: table.sheet } : {}), saveAs: rowName, steps } as Step];
    }
    case 'WriteRange': {
      mapped();
      const tableName = bare(reference(expressionOf(attribute(node, 'DataTable')) ?? '')) ?? '';
      const table = context.tables.get(tableName);
      const file = text(attribute(node, 'WorkbookPath')) ?? table?.path;
      if (!file) return fail('the workbook path was not translated');
      const sheet = text(attribute(node, 'SheetName')) ?? table?.sheet;
      const clean = file.replace(/\\/g, '/');
      context.tables.set(tableName || 'DataTable', { path: clean, ...(sheet ? { sheet } : {}) });
      return [{ type: 'excel', action: 'writeRange', path: clean, ...(sheet ? { sheet } : {}), rows: tableName ? `\${${tableName}}` : '' } as Step];
    }
    case 'WriteCell': {
      mapped();
      const file = text(attribute(node, 'WorkbookPath'));
      if (!file) return fail('the workbook path was not translated');
      const value = text(attribute(node, 'Text', 'Value'));
      if (value === undefined) return fail('the cell value was not translated');
      const sheet = text(attribute(node, 'SheetName'));
      const cell = text(attribute(node, 'Cell')) ?? 'A1';
      return [{
        type: 'excel', action: 'writeCell', path: file.replace(/\\/g, '/'), ...(sheet ? { sheet } : {}),
        row: Number(cell.replace(/\D+/g, '')) || 1, column: cell.replace(/\d+/g, '') || 'A', value
      } as Step];
    }

    // ── files, documents, data ───────────────────────────────────────────────────────────────
    case 'ForEachFileX':
    case 'ForEachFile': {
      mapped();
      const folder = text(attribute(node, 'Folder', 'FolderPath'));
      if (!folder) return fail('the folder was not translated');
      const body = bodySteps(property(node, 'Body'));
      const steps = convertChildren(body, context);
      const pattern = expressionOf(attribute(node, 'Filter', 'Pattern', 'SearchPattern')) ?? '*';
      const saveAs = fileVariable(body, 'CurrentFile');
      return [{ type: 'file', action: 'forEachFile', folder: folder.replace(/\\/g, '/'), pattern, saveAs, steps } as Step];
    }
    case 'MoveFile': {
      mapped();
      const from = text(attribute(node, 'From', 'Path'));
      const to = text(attribute(node, 'To', 'Destination'));
      if (!from || !to) return fail('the source or the destination was not translated');
      return [{ type: 'file', action: 'move', from: from.replace(/\\/g, '/'), to: to.replace(/\\/g, '/') } as Step];
    }
    case 'ReadPDFText': {
      mapped();
      const file = text(attribute(node, 'FileName', 'Path'));
      if (!file) return fail('the PDF path was not translated');
      const saveAs = bare(reference(expressionOf(attribute(node, 'Text', 'Result', 'Output')) ?? ''));
      return [{ type: 'pdf', action: 'readText', path: file.replace(/\\/g, '/'), ...(saveAs ? { saveAs } : {}) } as Step];
    }
    case 'Matches': {
      mapped();
      const input = toText(expressionOf(attribute(node, 'Input')) ?? '', report, line, name);
      const pattern = text(attribute(node, 'Pattern'));
      if (input === null) return []; // toText reported the expression
      if (!pattern) return fail('the pattern was not translated');
      const saveAs = bare(reference(expressionOf(attribute(node, 'Result', 'Output')) ?? ''));
      return [{ type: 'data', action: 'regexMatches', text: input, pattern, ...(saveAs ? { saveAs } : {}) } as Step];
    }
    case 'DeserializeJson': {
      mapped();
      const input = toText(expressionOf(attribute(node, 'JsonString', 'Input', 'Json')) ?? '', report, line, name);
      if (input === null) return []; // toText reported the expression
      const saveAs = bare(reference(expressionOf(attribute(node, 'JsonObject', 'Result', 'Output')) ?? ''));
      return [{ type: 'data', action: 'jsonParse', text: input, ...(saveAs ? { saveAs } : {}) } as Step];
    }

    default:
      return null;
  }
}

/** `Assign` (one operation) and `MultipleAssign` (a list of them) in the same shape. */
function assignSteps(node: XmlNode, context: Context): Step[] {
  const { report } = context;
  const operations = node.name === 'MultipleAssign'
    ? (property(node, 'AssignOperations')?.children ?? node.children).filter((child) => child.name === 'AssignOperation')
    : [node];
  const steps: Step[] = [];
  for (const operation of operations) {
    const target = reference(expressionOf(attribute(operation, 'To') ?? '') ?? '');
    if (!target || !target.startsWith('${')) {
      report.unmapped.push({ activity: node.name, line: operation.line, detail: `the assignment target \`${attribute(operation, 'To') ?? ''}\` was not translated` });
      continue;
    }
    const name = target.slice(2, -1);
    const raw = expressionOf(attribute(operation, 'Value') ?? '') ?? '';
    // `x = x + 1` (and - * /) is arithmetic on the same variable → control.math; our engine has no
    // expression language, so a compound expression over two variables is reported instead.
    const arithmetic = raw.match(/^([A-Za-z_][\w.]*)\s*([+\-*/])\s*(.+)$/);
    if (arithmetic && reference(arithmetic[1]!) === target) {
      const op = ({ '+': 'add', '-': 'sub', '*': 'mul', '/': 'div' } as const)[arithmetic[2] as '+' | '-' | '*' | '/'];
      const right = toText(arithmetic[3]!, report, operation.line, node.name);
      // toText already reported what it could not translate; falling through would report it twice.
      if (right !== null) {
        report.mapped.set(node.name, (report.mapped.get(node.name) ?? 0) + 1);
        steps.push({ type: 'control', action: 'math', name, op, value: right } as Step);
        continue;
      }
      continue;
    }
    const value = toText(raw, report, operation.line, node.name);
    // toText reports every expression it cannot translate; there is nothing to add here.
    if (value === null) continue;
    report.mapped.set(node.name, (report.mapped.get(node.name) ?? 0) + 1);
    steps.push({ type: 'control', action: 'setVar', name, value } as Step);
  }
  return steps;
}

/** Convert a list of sibling elements, reporting every activity that has no equivalent. */
function convertChildren(nodes: XmlNode[], context: Context): Step[] {
  const steps: Step[] = [];
  for (const child of nodes) {
    const converted = convertActivity(child, context);
    if (converted) { steps.push(...converted); continue; }
    if (!isPlumbing(child.name)) {
      // An activity with no equivalent is reported, but its body is still walked: a scope this
      // converter does not model should not cost the steps written inside it.
      context.report.unmapped.push({
        activity: child.name, line: child.line,
        detail: child.children.length > 0
          ? 'no equivalent step — the container is gone, the steps inside it are kept'
          : 'no equivalent step — port it by hand'
      });
    }
    if (!VALUE_HOLDERS.has(child.name)) steps.push(...convertChildren(child.children, context));
  }
  return steps;
}

// ── Files ───────────────────────────────────────────────────────────────────────────────────────

export function convertXaml(xml: string, name: string): { workflow: Workflow; report: Report } {
  const report: Report = { file: name, mapped: new Map(), unmapped: [], notes: [] };
  const document = parseXml(xml);
  const root = document.children.find((child) => child.name === 'Activity' || child.name === 'Workflow') ?? document.children[0];
  if (!root) throw new Error(`${name}: no root element.`);

  const declared = findDeep(root, ['Variables'])?.children.filter((child) => child.name === 'Variable') ?? [];
  const variables = Object.fromEntries(declared.map((node) => [node.attributes['Name'] ?? '', '']).filter(([key]) => key !== ''));

  const context: Context = { report, tables: new Map() };
  const steps = convertChildren([root], context);
  if (steps.length === 0) report.notes.push('no convertible steps — see the table above for what was dropped.');

  return {
    workflow: {
      name: attribute(root, 'DisplayName') ?? name.replace(/\.xaml$/i, ''),
      description: `Converted from ${name} by rpa import.`,
      ...(Object.keys(variables).length > 0 ? { variables } : {}),
      steps
    },
    report
  };
}

interface ProjectDescriptor {
  name?: string;
  projectVersion?: string;
  workflows?: Array<{ filePath?: string; name?: string }>;
}

/** `rpa import <file.xaml|project.json> --out <dir>` */
export async function importExport(input: string, outDir: string): Promise<ImportResult> {
  const source = path.resolve(input);
  const out = path.resolve(outDir);
  await mkdir(out, { recursive: true });
  const report: Report[] = [];
  const files: ImportedFile[] = [];

  const convert = async (xamlFile: string, outputName: string): Promise<void> => {
    const converted = convertXaml(await readFile(xamlFile, 'utf8'), path.basename(xamlFile));
    const output = path.join(out, outputName);
    await writeFile(output, JSON.stringify(converted.workflow, null, 2) + '\n');
    files.push({ source: xamlFile, output, steps: converted.workflow.steps.length, workflow: converted.workflow });
    report.push(converted.report);
  };

  if (path.extname(source).toLowerCase() === '.xaml') {
    await convert(source, `${path.basename(source, path.extname(source))}.json`);
  } else {
    const descriptor = JSON.parse(await readFile(source, 'utf8')) as ProjectDescriptor;
    const listed = (descriptor.workflows ?? []).filter((entry) => entry.filePath);
    if (listed.length === 0) throw new Error(`${path.basename(source)} lists no workflows (expected "workflows": [{ "filePath": … }]).`);
    for (const entry of listed) {
      const xamlFile = path.resolve(path.dirname(source), entry.filePath!);
      await convert(xamlFile, `${entry.name ?? path.basename(entry.filePath!, path.extname(entry.filePath!))}.json`);
    }
  }

  const reportFile = path.join(out, 'PORTING-REPORT.md');
  await writeFile(reportFile, renderReport(report));
  return { outDir: out, files, report, reportFile };
}

/** The porting report: what mapped, what did not (with its line), and what a human must decide. */
export function renderReport(reports: Report[]): string {
  const lines: string[] = [
    '# Porting report',
    '',
    'Written by `rpa import`. Every activity the converter could not map is listed with its source',
    'line; everything else became a step in the JSON beside this file.',
    ''
  ];
  for (const report of reports) {
    lines.push(`## ${report.file}`, '');
    const mapped = [...report.mapped].sort(([a], [b]) => a.localeCompare(b));
    const total = mapped.reduce((sum, [, amount]) => sum + amount, 0);
    lines.push(`Mapped ${total} activit${total === 1 ? 'y' : 'ies'}: ${mapped.map(([name, amount]) => `\`${name}\`${amount > 1 ? ` ×${amount}` : ''}`).join(', ') || '(none)'}.`, '');
    if (report.unmapped.length > 0) {
      lines.push('| Line | Activity | What happened |', '|---|---|---|');
      for (const entry of [...report.unmapped].sort((a, b) => a.line - b.line)) {
        lines.push(`| ${entry.line} | \`${entry.activity}\` | ${entry.detail} |`);
      }
      lines.push('');
    } else {
      lines.push('No unmapped activities.', '');
    }
    if (report.notes.length > 0) {
      lines.push('Notes:', '');
      for (const note of report.notes) lines.push(`- ${note}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
