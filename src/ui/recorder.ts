/**
 * The recorder — click through a page, get a draft workflow.
 *
 * A recorded "step" is the user's intent, not the raw event. The capture script collects DOM events;
 * the node side filters them (noise, double-clicks, our own overlay), merges typing into a single
 * `type` step per field, and turns each element into a target using the same shapes the targeting
 * engine already resolves — a unique id beats a name, a name beats a positional path, and a fuzzy
 * spec always rides along so healing has something to work with later.
 *
 * Captured events (v1, deliberately small): click, text input, select change, and page navigation.
 * Not captured: scrolls, image clicks, global OS input (a browser tab cannot see those — an OS-level
 * recorder is a different program), per-step screenshots.
 */
import type { Page } from 'playwright';
import type { Step, TargetSpec } from '../workflow/model.js';

export interface RecordedElement {
  tag: string;
  id: string;
  name: string;
  type: string;
  placeholder: string;
  ariaLabel: string;
  text: string;
  classes: string[];
  cssPath: string;
  uniqueId: boolean;
  uniqueName: boolean;
}

export interface RecordedEvent {
  kind: 'click' | 'input' | 'select' | 'goto' | 'stop';
  url: string;
  ts: number;
  value?: string;
  label?: string;
  element?: RecordedElement;
}

export interface RecordedStep {
  step: Step;
  /** One line for the operator: what was recorded, in words. */
  description: string;
}

export interface RecordedWorkflow {
  url: string;
  startedAt: string;
  steps: RecordedStep[];
  /** Filters that actually fired — each entry is a captured event that was not worth a step. */
  dropped: string[];
}

export interface RecordOptions {
  /** Stop automatically after this long (default 15 minutes). */
  maxMs?: number;
  /** Selectors whose events are ignored (on top of the recorder's own overlay). */
  ignoreSelectors?: string[];
}

export interface Recorder {
  /** Resolves when the recorder stops (the overlay's Stop button, the deadline, or the page closing). */
  stop(): Promise<RecordedWorkflow>;
  /** Steps recorded so far (the overlay keeps its own count; this is for programmatic stops). */
  readonly recorded: RecordedStep[];
}

/**
 * The in-page capture script. One expression, so the same string can be handed to `addInitScript`
 * (future navigations) and to `page.evaluate` (a document already loaded). Self-contained on
 * purpose: Playwright serialises it, so no imports and no named helpers the bundler could rewrite.
 */
export const RECORDER_SCRIPT = `(() => {
  if (window.__rpaRecorderInstalled) return true;
  window.__rpaRecorderInstalled = true;
  window.__rpaRecorderCount = 0;

  const badge = document.createElement('div');
  badge.id = '__rpa_recorder__';
  badge.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#111;color:#fff;font:12px/1.6 system-ui,sans-serif;padding:8px 12px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.4);display:flex;gap:10px;align-items:center';
  const dot = document.createElement('span');
  dot.style.cssText = 'color:#f43f5e';
  dot.textContent = '●';
  const counter = document.createElement('span');
  counter.id = '__rpa_recorder_count__';
  counter.textContent = 'rpa record — 0 action(s)';
  const stop = document.createElement('button');
  stop.id = '__rpa_recorder_stop__';
  stop.textContent = 'Stop';
  stop.style.cssText = 'background:#fff;color:#111;border:0;border-radius:6px;padding:2px 10px;font:inherit;cursor:pointer';
  badge.append(dot, counter, stop);
  const mount = () => { if (document.body) document.body.appendChild(badge); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  const skip = (el) => !!(el && el.closest && (el.closest('#__rpa_recorder__') || el.closest('[data-rpa-ignore]')));

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

  const unique = (selector) => {
    try { return document.querySelectorAll(selector).length === 1; } catch (e) { return false; }
  };

  const describe = (el) => {
    const text = el.tagName === 'SELECT' ? '' : (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return {
      tag: el.tagName.toUpperCase(),
      id: el.getAttribute('id') || '',
      name: el.getAttribute('name') || '',
      type: el.getAttribute('type') || '',
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      text: text,
      classes: (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3),
      cssPath: cssPath(el),
      uniqueId: false,
      uniqueName: false
    };
  };

  // Every handler must know whether this element's id/name is unique — a type or select step
  // deserves the same strong strict target a click gets.
  const withUniqueness = (info, el) => {
    info.uniqueId = info.id !== '' && document.getElementById(info.id) === el;
    info.uniqueName = info.name !== '' && unique(info.tag.toLowerCase() + '[name="' + info.name + '"]');
    return info;
  };

  const send = (payload) => { try { window.__rpaRecorderEvent(payload); } catch (e) {} };

  const bump = () => {
    window.__rpaRecorderCount += 1;
    const el = document.getElementById('__rpa_recorder_count__');
    if (el) el.textContent = 'rpa record — ' + window.__rpaRecorderCount + ' action(s)';
  };

  document.addEventListener('click', (event) => {
    const el = event.target;
    if (skip(el)) return;
    if (event.button !== 0) return;                       // left clicks only
    if (!el || !el.tagName || typeof el.getAttribute !== 'function') return;
    if ((el.tagName === 'BODY' || el.tagName === 'HTML') && !el.getAttribute('id')) return;
    const info = withUniqueness(describe(el), el);
    bump();
    send({ kind: 'click', element: info, ts: Date.now(), url: location.href });
  }, true);

  document.addEventListener('input', (event) => {
    const el = event.target;
    if (skip(el) || !el || !el.tagName) return;
    if (!['INPUT', 'TEXTAREA'].includes(el.tagName)) return;  // selects are captured by change
    if (el.tagName === 'INPUT' && ['checkbox', 'radio', 'file', 'submit', 'button'].includes((el.type || '').toLowerCase())) return;
    const info = withUniqueness(describe(el), el);
    bump();
    send({ kind: 'input', element: info, value: String(el.value || ''), ts: Date.now(), url: location.href });
  }, true);

  document.addEventListener('change', (event) => {
    const el = event.target;
    if (skip(el) || !el || el.tagName !== 'SELECT') return;
    const selected = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
    const info = withUniqueness(describe(el), el);
    bump();
    send({ kind: 'select', element: info, value: String(el.value || ''), label: selected ? selected.text : undefined, ts: Date.now(), url: location.href });
  }, true);

  stop.addEventListener('click', () => send({ kind: 'stop', ts: Date.now(), url: location.href }));
  return true;
})()`;

/** A second click on the same element this soon after the first is a double-click, not intent. */
const DOUBLE_CLICK_MS = 400;

/** The target a recorded element should get: strongest strict form first, fuzzy always as the fallback. */
export function targetForElement(element: RecordedElement): TargetSpec {
  const escapeAttr = (value: string) => value.replace(/"/g, '\\"');
  const strict = element.uniqueId && element.id !== ''
    ? `[id="${escapeAttr(element.id)}"]`
    : element.uniqueName && element.name !== ''
      ? `${element.tag.toLowerCase()}[name="${escapeAttr(element.name)}"]`
      : undefined;

  const attributes: Record<string, string> = {};
  if (element.id) attributes['id'] = element.id;
  if (element.name) attributes['name'] = element.name;
  if (element.type && element.tag === 'INPUT') attributes['type'] = element.type;
  if (element.placeholder) attributes['placeholder'] = element.placeholder;
  const aaname = element.ariaLabel || element.text;
  if (aaname) attributes['aaname'] = aaname;

  const levels: Record<string, 'exact' | 'fuzzy'> = {};
  for (const key of Object.keys(attributes)) levels[key] = key === 'aaname' ? 'fuzzy' : 'exact';

  const spec: TargetSpec = {};
  if (strict) spec.strict = strict;
  else if (element.cssPath) spec.strictAny = [element.cssPath];
  if (Object.keys(attributes).length > 0) {
    spec.fuzzy = { tag: element.tag, attributes, levels, threshold: 0.7 };
  }
  const text = element.text.trim();
  if (text !== '' && text.length <= 40) spec.text = text;
  return spec;
}

function describeElement(element: RecordedElement): string {
  const name = element.ariaLabel || element.text || element.placeholder || element.id || element.name;
  return name ? `${element.tag.toLowerCase()} "${name.slice(0, 40)}"` : element.tag.toLowerCase();
}

/**
 * Turn captured events (already in arrival order) into steps: navigation becomes `goto`, typing
 * merges per element keeping its first position, double-clicks collapse. Pure — everything the
 * browser contributed is in the events.
 */
export function eventsToSteps(events: RecordedEvent[]): { steps: RecordedStep[]; dropped: string[] } {
  const steps: RecordedStep[] = [];
  const dropped: string[] = [];
  const typingIndex = new Map<string, number>();
  let lastClick: { key: string; ts: number } | undefined;

  for (const event of events) {
    if (event.kind === 'stop') continue;

    if (event.kind === 'goto') {
      const last = steps[steps.length - 1];
      const lastUrl = last?.step.action === 'goto' ? String(last.step.url ?? '') : '';
      if (event.url !== '' && event.url !== lastUrl && event.url !== 'about:blank') {
        steps.push({ step: { type: 'web', action: 'goto', url: event.url }, description: `open ${event.url}` });
      }
      lastClick = undefined;
      continue;
    }

    const element = event.element;
    if (!element) continue;
    const key = element.id !== '' ? `#${element.id}` : element.cssPath;

    if (event.kind === 'input') {
      lastClick = undefined;
      const existing = typingIndex.get(key);
      const value = event.value ?? '';
      if (existing !== undefined) {
        // Same field again: the step keeps its place, only the value updates to the latest one.
        steps[existing]!.step.text = value;
        steps[existing]!.description = `type "${value.slice(0, 40)}" into ${describeElement(element)}`;
        continue;
      }
      typingIndex.set(key, steps.length);
      steps.push({
        step: { type: 'web', action: 'type', target: targetForElement(element), text: value },
        description: `type "${value.slice(0, 40)}" into ${describeElement(element)}`
      });
      continue;
    }

    if (event.kind === 'select') {
      lastClick = undefined;
      const step: Step = { type: 'web', action: 'selectOption', target: targetForElement(element) };
      if (event.label !== undefined && event.label !== '') step.label = event.label;
      else step.value = event.value ?? '';
      steps.push({ step, description: `select "${String(event.label ?? event.value ?? '')}" in ${describeElement(element)}` });
      continue;
    }

    // click — collapse a double-click into the single step it was meant to be.
    const targetKey = JSON.stringify(targetForElement(element));
    if (lastClick && lastClick.key === targetKey && event.ts - lastClick.ts < DOUBLE_CLICK_MS) {
      dropped.push(`double-click on ${describeElement(element)} collapsed into one click`);
      lastClick = { key: targetKey, ts: event.ts };
      continue;
    }
    lastClick = { key: targetKey, ts: event.ts };
    steps.push({ step: { type: 'web', action: 'click', target: targetForElement(element) }, description: `click ${describeElement(element)}` });
  }

  return { steps, dropped };
}

/**
 * Start recording on a page. Call before `goto` for a fresh navigation; if a document is already
 * loaded, the capture script is injected into it too.
 */
export async function startRecording(page: Page, options: RecordOptions = {}): Promise<Recorder> {
  const events: RecordedEvent[] = [];
  let done = false;
  let resolveStop: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  const stop = () => { if (!done) { done = true; resolveStop?.(); } };

  await page.exposeFunction('__rpaRecorderEvent', (payload: RecordedEvent) => {
    if (payload.kind === 'stop') { stop(); return; }
    events.push(payload);
  });

  const applyIgnore = async () => {
    for (const selector of options.ignoreSelectors ?? []) {
      await page.evaluate(
        `(() => { for (const node of document.querySelectorAll('${selector.replace(/'/g, "\\'")}')) node.setAttribute('data-rpa-ignore', '1'); return true; })()`
      ).catch(() => {});
    }
  };

  const inject = async () => {
    await page.evaluate(RECORDER_SCRIPT).catch(() => {});
    await applyIgnore();
  };

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame() || done) return;
    const url = frame.url();
    const last = events[events.length - 1];
    if (!last || last.kind !== 'goto' || last.url !== url) {
      events.push({ kind: 'goto', url, ts: Date.now() });
    }
  });
  // The ignore list must survive navigation: it is applied again once a fresh document is ready.
  page.on('domcontentloaded', () => { void applyIgnore(); });
  page.on('close', stop);

  await page.addInitScript({ content: RECORDER_SCRIPT });
  if (page.url() !== 'about:blank') await inject();

  const start = Date.now();
  const maxMs = options.maxMs ?? 15 * 60 * 1000;
  const deadline = setTimeout(stop, maxMs);

  return {
    get recorded(): RecordedStep[] {
      return eventsToSteps(events).steps;
    },
    async stop(): Promise<RecordedWorkflow> {
      await stopped;
      clearTimeout(deadline);
      try {
        await page.evaluate(`(() => { const b = document.getElementById('__rpa_recorder__'); if (b) b.remove(); return true; })()`);
      } catch {
        /* the page may be gone; the recording is already in hand */
      }
      const { steps, dropped } = eventsToSteps(events);
      return {
        url: page.url(),
        startedAt: new Date(start).toISOString(),
        steps,
        dropped
      };
    }
  };
}
