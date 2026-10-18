/**
 * The workflow model — the shape a `.json` file (or an Aro flow definition) must have.
 *
 * It is deliberately a superset of Aro's flow step JSON: a workflow authored here runs locally with
 * `rpa run`, and the same array of steps is what an Aro orchestrator dispatches to a robot. One
 * model, two places to run it — which is the whole reason this project exists beside Aro rather
 * than inside it.
 */

export type StepType = 'web' | 'control' | 'api' | 'desktop' | 'ocr' | 'ai-vision'
  | 'queue' | 'file' | 'excel' | 'data' | 'config' | 'mail' | 'pdf' | 'gsheet' | 'hitl'
  | 'mobile' | 'word';

/**
 * What happens when every declared targeting method failed:
 *
 * - `off`       — fail the step (the historical behaviour).
 * - `recommend` — fail it, but run one healing pass and report what would have matched. The default:
 *                 a failure stays a failure, and it arrives with a fix attached.
 * - `auto`      — use the healed match and continue; the log and the run report say it happened.
 */
export type HealMode = 'off' | 'recommend' | 'auto';

/** What `target` accepts: the targeting methods, in the order they are tried. */
export interface TargetSpec {
  /** Strict selector (Playwright/CSS syntax). Tried first. */
  strict?: string;
  /** Further strict selectors, tried in order after `strict` — what survives a page that changed. */
  strictAny?: string[];
  /** Fuzzy selector: a tag plus attribute values, scored instead of matched exactly. */
  fuzzy?: FuzzySpec;
  /** An anchor: a second element that disambiguates by its geometric relation to the target. */
  anchor?: AnchorSpec;
  /** 1-based occurrence when a strict selector matches several elements. */
  idx?: number;
  /** A raw selector chain (`<html …/><webctrl …/>`), parsed by src/selector-chain.ts. */
  selectorChain?: string;
  /** Native text targeting — Playwright's `text=` engine. */
  text?: string;
  /** Match the text exactly instead of by substring. */
  textExact?: boolean;
  /** The application window a selector chain was scoped to (informational: logged, not matched). */
  scope?: Record<string, string>;
  /** Recovery when every method above fails. Defaults to the step's or the engine's mode. */
  heal?: HealMode;
  /** Minimum score (0..1) a healed candidate must reach. Default 0.75. */
  healThreshold?: number;
}

/** Post-action verification: wait for a target after the action ran. */
export interface VerifySpec {
  target?: TargetSpec;
  selector?: string;
  selectors?: string[];
  timeoutMs?: number;
  state?: 'visible' | 'attached';
}

export interface FuzzySpec {
  /** Element tag, e.g. BUTTON / INPUT / A. Case-insensitive. */
  tag: string;
  /** Expected attribute values, e.g. { aaname: "Sign in" } (aaname ≈ accessible name/text). */
  attributes?: Record<string, string>;
  /** Per attribute: 'exact' (must equal), 'fuzzy' (similarity), or a number (minimum similarity). */
  levels?: Record<string, 'exact' | 'fuzzy' | number>;
  /** Expected element text, scored like a fuzzy attribute. */
  text?: string;
  /** Minimum score (0..1) for a candidate to count as a match. Default 0.7. */
  threshold?: number;
  /** 1-based occurrence among the scored matches, best first. */
  idx?: number;
}

export interface AnchorSpec {
  target: TargetSpec;
  /** Where the anchor sits relative to the target. Default 'near'. */
  relation?: 'left' | 'right' | 'above' | 'below' | 'near';
}

export interface Step {
  type: StepType;
  action?: string;

  /** Structured targeting (this tool's native shape). */
  target?: TargetSpec;
  /** Aro-shaped targeting: strict selector, then `selectors` as fallbacks. */
  selector?: string;
  selectors?: string[];
  /** Post-action verification: wait for a target after the action ran. */
  verify?: VerifySpec;

  /** Recovery mode for this step's target (see TargetSpec.heal). Overrides the engine default. */
  heal?: HealMode;

  /** Per-step resilience, shared by every step type: timeout, delays, continue-on-error, retry. */
  timeoutMs?: number;
  retry?: number;
  retryDelayMs?: number;
  continueOnError?: boolean;
  delayBeforeMs?: number;
  delayAfterMs?: number;

  /** Where a read action (getText, getAttribute, elementExists, api, ocr) stores its value. */
  saveAs?: string;

  [key: string]: unknown;
}

export interface Workflow {
  name?: string;
  description?: string;
  /** Starting variables; `${name}` in any string field interpolates them. */
  variables?: Record<string, string | number | boolean>;
  /**
   * The workflow's entry-point inputs:
   * `rpa run Main.json --arg name=value`, and a required one that is missing fails before step 1.
   */
  arguments?: Record<string, { type?: string; required?: boolean; description?: string; default?: string }>;
  steps: Step[];
}

export const WEB_ACTIONS = [
  'goto', 'click', 'type', 'hover', 'selectOption', 'getText', 'getAttribute',
  'elementExists', 'waitForElement', 'pressKeys', 'scroll', 'screenshot', 'assertText',
  'extractTable'
] as const;
export const CONTROL_ACTIONS = [
  'delay', 'setVar', 'math', 'log', 'if', 'switch', 'repeat', 'while', 'foreach',
  'try', 'throw', 'retryScope', 'invoke', 'stateMachine'
] as const;
export const API_ACTIONS = ['request', 'load'] as const;
export const DESKTOP_ACTIONS = [
  'move', 'click', 'doubleClick', 'rightClick', 'type', 'scroll', 'pressKey', 'drag',
  'clipboardCopy', 'screenshot', 'waitForImage', 'clickImage', 'uia'
] as const;
export const OCR_ACTIONS = ['recognize'] as const;
export const VISION_ACTIONS = ['decide'] as const;
/** The transaction queue — dispatcher/performer semantics. */
export const QUEUE_ACTIONS = ['addItem', 'getTransactionItem', 'setStatus', 'count', 'list'] as const;
export const FILE_ACTIONS = ['forEachFile', 'move', 'readText', 'writeText', 'exists', 'delete', 'mkdir'] as const;
export const EXCEL_ACTIONS = ['readRange', 'writeRange', 'writeCell', 'forEachRow'] as const;
export const DATA_ACTIONS = ['jsonParse', 'regexMatches'] as const;
export const CONFIG_ACTIONS = ['load'] as const;
export const MAIL_ACTIONS = ['send', 'receive'] as const;
export const PDF_ACTIONS = ['readText'] as const;
export const GSHEET_ACTIONS = ['append', 'read'] as const;
export const HITL_ACTIONS = ['ask'] as const;
/** Mobile over the raw WebDriver protocol — Appium answers it; so does Selenium. */
export const MOBILE_ACTIONS = ['session', 'end', 'tap', 'type', 'getText', 'waitFor', 'swipe', 'screenshot'] as const;
/** Word documents — .docx is a zip of XML; read and written with the stdlib. */
export const WORD_ACTIONS = ['readText', 'writeText'] as const;

const ACTIONS: Record<StepType, readonly string[]> = {
  web: WEB_ACTIONS,
  control: CONTROL_ACTIONS,
  api: API_ACTIONS,
  desktop: DESKTOP_ACTIONS,
  ocr: OCR_ACTIONS,
  'ai-vision': VISION_ACTIONS,
  queue: QUEUE_ACTIONS,
  file: FILE_ACTIONS,
  excel: EXCEL_ACTIONS,
  data: DATA_ACTIONS,
  config: CONFIG_ACTIONS,
  mail: MAIL_ACTIONS,
  pdf: PDF_ACTIONS,
  gsheet: GSHEET_ACTIONS,
  hitl: HITL_ACTIONS,
  mobile: MOBILE_ACTIONS,
  word: WORD_ACTIONS
};

/**
 * Aliases a human (or a ported legacy workflow) may spell out. Per type on purpose: `forEachRow`
 * means "loop the rows of a sheet" under `excel` and must not become `control.foreach`.
 */
const ACTION_ALIASES: Record<StepType, Record<string, string>> = {
  web: { navigate: 'goto', open: 'goto', openbrowser: 'goto', fill: 'type', typeinto: 'type', settext: 'type', keypress: 'pressKeys', pressshortcut: 'pressKeys' },
  control: { wait: 'delay', assign: 'setVar', multipleassign: 'setVar', logmessage: 'log', writeline: 'log', increment: 'math', trycatch: 'try', retryscope: 'retryScope', invokeWorkflowFile: 'invoke', invokeWorkflow: 'invoke', statemachine: 'stateMachine' },
  api: { http: 'request' },
  desktop: { presskeys: 'pressKey', uiautomation: 'uia', uiaclick: 'uia', uiatype: 'uia', uiagettext: 'uia' },
  ocr: { readpdfwithocr: 'recognize' },
  'ai-vision': {},
  queue: { addqueueitem: 'addItem', gettransactionitem: 'getTransactionItem', getqueueitem: 'getTransactionItem', settransactionstatus: 'setStatus' },
  file: { foreachfilex: 'forEachFile', foreachfile: 'forEachFile', appendsline: 'writeText', readtextfile: 'readText', writetextfile: 'writeText' },
  excel: { readrange: 'readRange', writerange: 'writeRange', writecell: 'writeCell', foreachrow: 'forEachRow' },
  data: { deserializejson: 'jsonParse', matches: 'regexMatches' },
  config: { loadsettings: 'load', initsettings: 'load' },
  mail: { sendmail: 'send', sendmailmessage: 'send', getsmtpmail: 'send', getimapmail: 'receive', getoutlookmail: 'receive', getexchange: 'receive' },
  pdf: { readpdftext: 'readText' },
  gsheet: { writersheet: 'append', appendsheet: 'append', googlesheets: 'append', gsuiteapplication: 'append' },
  hitl: { inputdialog: 'ask', formtask: 'ask', waitforformtask: 'ask' },
  mobile: { start: 'session', close: 'end', click: 'tap', setvalue: 'type', scroll: 'swipe', screenshot: 'screenshot' },
  word: { readdocx: 'readText', writedocx: 'writeText', readdocument: 'readText', writedocument: 'writeText' }
};

export function normalizeAction(action: string | undefined, type: StepType): string {
  const raw = (action ?? '').trim();
  if (!raw) {
    // Types with exactly one action do not need it spelled out (Aro writes api steps that way).
    if (type === 'api') return 'request';
    if (type === 'ocr') return 'recognize';
    if (type === 'ai-vision') return 'decide';
    if (type === 'config') return 'load';
    return '';
  }
  const alias = ACTION_ALIASES[type]?.[raw.toLowerCase()];
  if (alias && ACTIONS[type]?.includes(alias)) return alias;
  const exact = ACTIONS[type]?.find(candidate => candidate.toLowerCase() === raw.toLowerCase());
  return exact ?? raw;
}

/** Parse a workflow file or an Aro flow definition. Both are arrays of steps; an object may wrap them. */
export function parseWorkflow(text: string): Workflow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Workflow is not valid JSON: ${(e as Error).message}`);
  }

  if (Array.isArray(parsed)) return { steps: parsed as Step[] };
  if (parsed && typeof parsed === 'object') {
    const candidate = parsed as Partial<Workflow>;
    return {
      ...(candidate.name ? { name: candidate.name } : {}),
      ...(candidate.description ? { description: candidate.description } : {}),
      ...(candidate.variables ? { variables: candidate.variables } : {}),
      ...(candidate.arguments ? { arguments: candidate.arguments } : {}),
      steps: Array.isArray(candidate.steps) ? candidate.steps : []
    };
  }
  throw new Error('Workflow must be a JSON array of steps, or an object with a "steps" array.');
}

/** Everything wrong with a workflow, as human sentences. Empty means runnable. */
export function validateWorkflow(workflow: Workflow): string[] {
  const errors: string[] = [];
  if (workflow.steps.length === 0) errors.push('Workflow must contain at least one step.');
  if (workflow.steps.length > 200) errors.push('Workflow cannot contain more than 200 steps.');
  validateSteps(workflow.steps, 'Step', 0, errors);
  return errors;
}

const MAX_NESTING = 5;

function validateSteps(steps: Step[], label: string, depth: number, errors: string[]): void {
  if (depth > MAX_NESTING) {
    errors.push(`${label} exceeds the maximum nesting depth of ${MAX_NESTING}.`);
    return;
  }

  steps.forEach((step, index) => {
    const name = `${label} ${index + 1}`;
    if (!step || typeof step !== 'object' || typeof step.type !== 'string') {
      errors.push(`${name} must be an object with a "type".`);
      return;
    }
    const actions = ACTIONS[step.type as StepType];
    if (!actions) {
      errors.push(`${name} has an unsupported type "${String(step.type)}".`);
      return;
    }

    const action = normalizeAction(step.action, step.type);
    if (!action || !actions.includes(action)) {
      errors.push(`${name} has an unsupported ${step.type} action "${String(step.action ?? '')}".`);
      return;
    }

    if (step.type === 'web' && action === 'extractTable' && String(step.table ?? '').trim() === '') {
      errors.push(`${name} (web.extractTable) needs a "table" — the CSS selector of the table.`);
    }

    const body = (property: string) => {
      const branch = step[property];
      if (branch === undefined) return;
      if (!Array.isArray(branch)) {
        errors.push(`${name} › ${property} must be an array of steps.`);
        return;
      }
      validateSteps(branch as Step[], `${name} › ${action} › ${property}`, depth + 1, errors);
    };

    if (step.type === 'control') {
      if (action === 'log' && step.fields !== undefined && (typeof step.fields !== 'object' || Array.isArray(step.fields))) {
        errors.push(`${name} › fields must be an object of { name: value }.`);
      }
      if (action === 'if' || action === 'while') {
        if (String(step.condition ?? '').trim() === '') errors.push(`${name} needs a condition.`);
      }
      if (action === 'repeat' && !Number.isFinite(Number(step.times))) {
        errors.push(`${name} needs a numeric times count.`);
      }
      if (action === 'foreach' && String(step.items ?? '').trim() === '') {
        errors.push(`${name} needs "items" — a variable name or a JSON array.`);
      }
      if (action === 'math') {
        if (String(step.name ?? '').trim() === '') errors.push(`${name} needs a "name" to write to.`);
        if (!['add', 'sub', 'mul', 'div'].includes(String(step.op ?? ''))) {
          errors.push(`${name} needs "op" = add | sub | mul | div.`);
        }
      }
      if (action === 'throw' && String(step.message ?? '').trim() === '') {
        errors.push(`${name} needs a "message".`);
      }
      if (action === 'invoke' && String(step.workflow ?? '').trim() === '') {
        errors.push(`${name} needs a "workflow" file (relative to the workflow that calls it).`);
      }
      if (action === 'if') { body('then'); body('else'); }
      if (action === 'try') { body('body'); body('finally'); }
      if (action === 'repeat' || action === 'while' || action === 'foreach' || action === 'retryScope') body('steps');
      if (action === 'switch') {
        const cases = step.cases;
        if (cases !== undefined && (typeof cases !== 'object' || Array.isArray(cases))) {
          errors.push(`${name} › cases must be an object of { value: [steps] }.`);
        } else if (cases) {
          for (const [value, branch] of Object.entries(cases as Record<string, unknown>)) {
            if (!Array.isArray(branch)) { errors.push(`${name} › cases.${value} must be an array of steps.`); continue; }
            validateSteps(branch as Step[], `${name} › switch › ${value}`, depth + 1, errors);
          }
        }
        if (Array.isArray(step.default)) validateSteps(step.default as Step[], `${name} › switch › default`, depth + 1, errors);
      }
      if (action === 'try' && step.catches !== undefined) {
        if (!Array.isArray(step.catches)) errors.push(`${name} › catches must be an array.`);
        else for (const [index, catcher] of (step.catches as Array<Record<string, unknown>>).entries()) {
          const branch = catcher?.steps;
          if (!Array.isArray(branch)) { errors.push(`${name} › catch ${index + 1} needs a "steps" array.`); continue; }
          validateSteps(branch as Step[], `${name} › catch ${index + 1}`, depth + 1, errors);
        }
      }
    }

    if (step.type === 'queue') {
      if (String(step.queue ?? '').trim() === '') errors.push(`${name} needs a "queue" name.`);
      if (action === 'setStatus' && String(step.status ?? '').trim() === '') errors.push(`${name} needs a "status".`);
    }

    if (step.type === 'file') {
      if (action === 'forEachFile') {
        if (String(step.folder ?? '').trim() === '') errors.push(`${name} needs a "folder".`);
        body('steps');
      }
      if (action === 'move' && (String(step.from ?? '').trim() === '' || String(step.to ?? '').trim() === '')) {
        errors.push(`${name} needs "from" and "to".`);
      }
      if ((action === 'readText' || action === 'writeText' || action === 'exists' || action === 'delete' || action === 'mkdir')
        && String(step.path ?? '').trim() === '') {
        errors.push(`${name} needs a "path".`);
      }
    }

    if (step.type === 'excel') {
      if (String(step.path ?? '').trim() === '') errors.push(`${name} needs a "path" (.csv or .xlsx).`);
      if (action === 'forEachRow') body('steps');
    }

    if (step.type === 'data') {
      if (action === 'jsonParse' && String(step.text ?? '').trim() === '') errors.push(`${name} needs "text".`);
      if (action === 'regexMatches') {
        if (String(step.pattern ?? '').trim() === '') errors.push(`${name} needs a "pattern".`);
        if (String(step.text ?? '').trim() === '') errors.push(`${name} needs "text".`);
      }
    }

    if (step.type === 'config' && String(step.path ?? '').trim() === '') errors.push(`${name} needs a "path" to a settings file.`);

    if (step.type === 'mail') {
      if (action === 'send' && String(step.to ?? '').trim() === '') errors.push(`${name} needs a "to".`);
      if (action === 'send' && String(step.subject ?? '').trim() === '') errors.push(`${name} needs a "subject".`);
    }

    if (step.type === 'pdf' && String(step.path ?? '').trim() === '') errors.push(`${name} needs a "path" to a PDF.`);

    if (step.type === 'gsheet') {
      if (String(step.spreadsheetId ?? '').trim() === '') errors.push(`${name} needs a "spreadsheetId".`);
      if (String(step.range ?? '').trim() === '') errors.push(`${name} needs a "range", e.g. "Sheet1!A1".`);
    }

    if (step.type === 'api' && action === 'load' && String(step.url ?? '').trim() === '') {
      errors.push(`${name} (api.load) needs a "url".`);
    }

    if (step.type === 'mobile') {
      if (action === 'session') {
        const capabilities = step.capabilities;
        if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities) || Object.keys(capabilities).length === 0) {
          errors.push(`${name} (mobile.session) needs "capabilities" — e.g. { platformName: "Android", app: … }.`);
        }
      }
      if (['tap', 'type', 'getText', 'waitFor'].includes(action)) {
        if (String(step.using ?? '').trim() === '') errors.push(`${name} (mobile.${action}) needs "using" — accessibility id | id | xpath | class name.`);
        if (String(step.value ?? '').trim() === '') errors.push(`${name} (mobile.${action}) needs "value" — the element to find.`);
      }
      if (action === 'type' && step.text === undefined) errors.push(`${name} (mobile.type) needs "text".`);
      if (action === 'swipe' && !['left', 'right', 'up', 'down'].includes(String(step.direction ?? ''))) {
        errors.push(`${name} (mobile.swipe) needs "direction" = left | right | up | down.`);
      }
    }

    if (step.type === 'word') {
      if (String(step.path ?? '').trim() === '') errors.push(`${name} needs a "path" to a .docx.`);
      if (action === 'writeText' && String(step.text ?? '') === '') errors.push(`${name} (word.writeText) needs "text".`);
    }

    if (step.type === 'hitl' && String(step.prompt ?? '').trim() === '') errors.push(`${name} needs a "prompt".`);

    if (step.type === 'control' && action === 'stateMachine') {
      if (String(step.initial ?? '').trim() === '') errors.push(`${name} needs an "initial" state.`);
      const states = step.states;
      if (states === undefined || typeof states !== 'object' || Array.isArray(states)) {
        errors.push(`${name} needs "states" as an object of { Name: { steps, next|when, final } }.`);
      } else {
        for (const [stateName, state] of Object.entries(states as Record<string, { steps?: unknown }>)) {
          if (!state || typeof state !== 'object') { errors.push(`${name} › state ${stateName} must be an object.`); continue; }
          if (Array.isArray(state.steps)) validateSteps(state.steps as Step[], `${name} › state ${stateName}`, depth + 1, errors);
        }
      }
    }

    if (step.type === 'desktop' && action === 'uia') {
      const finds = ['name', 'automationId', 'controlType'].filter((key) => String(step[key] ?? '').trim() !== '');
      if (finds.length === 0) errors.push(`${name} needs name, automationId or controlType to find the element.`);
    }

    const healModes = ['off', 'recommend', 'auto'];
    if (step.heal !== undefined && !healModes.includes(String(step.heal))) {
      errors.push(`${name} has an unknown heal mode "${String(step.heal)}" (off | recommend | auto).`);
    }
    const targetHeal = (step.target as { heal?: unknown } | undefined)?.heal;
    if (targetHeal !== undefined && !healModes.includes(String(targetHeal))) {
      errors.push(`${name} › target has an unknown heal mode "${String(targetHeal)}" (off | recommend | auto).`);
    }

    // A targeting action without any target can only fail at run time; say so now.
    const needsTarget = step.type === 'web'
      && ['click', 'type', 'hover', 'selectOption', 'getText', 'getAttribute', 'waitForElement', 'pressKeys', 'scroll'].includes(action)
      && !step.selector && !(Array.isArray(step.selectors) && step.selectors.length > 0) && !step.target;
    if (needsTarget) errors.push(`${name} (web.${action}) needs a selector or a target.`);

    if (step.verify) {
      const verify = step.verify as { target?: unknown; selector?: unknown; selectors?: unknown };
      const hasTarget = verify.target !== undefined
        || (typeof verify.selector === 'string' && verify.selector.trim() !== '')
        || (Array.isArray(verify.selectors) && verify.selectors.length > 0);
      if (!hasTarget) errors.push(`${name} › verify needs a target or a selector.`);
    }
  });
}
