/**
 * Targeting — how a desktop step finds its thing. Four methods, in order of confidence:
 *
 *   1. `uia`    — accessibility properties (Windows UI Automation): every listed one must match.
 *   2. `fuzzy`  — the same properties, scored by similarity against a threshold.
 *   3. `image`  — a template the backend finds on screen.
 *   4. `anchor` — a second element whose geometric relation disambiguates the target.
 *
 * `point` covers the trivial case: the workflow already knows where the thing is.
 *
 * The point of having all of them is resilience — an application that renames a control breaks a
 * property map, and a fuzzy match plus an anchor keeps the workflow running — while the log still
 * says which method actually matched, so nobody has to guess later.
 *
 * Property candidates come from the accessibility API where the host has one (Windows) and from
 * image search everywhere else; `resolveTarget` says which of the two answered.
 */
import type { AnchorSpec, FuzzySpec, Step, TargetSpec, UiaSpec } from '../workflow/model.js';
import { parseSelectorChain } from '../workflow/selector-chain.js';
import type { DesktopBackend, ScreenBox } from '../services/desktop/backend.js';
import { dumpUiaElements } from '../services/gaps.js';

/** A rectangle on the screen, in screen coordinates. */
export type Box = ScreenBox;

/** Levenshtein distance, iterative and allocation-light (property values are short strings). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Similarity of two property values, 0..1. Case- and whitespace-insensitive, because the two
 * strings compared here are a human's expectation and a control's own text, not two identifiers.
 * A containment relation (the expected text inside the control's text, or vice versa) scores at
 * least 0.9: that is what makes "Sign in" match "Sign in to continue" — the case fuzzy matching
 * exists for.
 */
export function similarity(expected: string, actual: string): number {
  const a = expected.trim().toLowerCase().replace(/\s+/g, ' ');
  const b = actual.trim().toLowerCase().replace(/\s+/g, ' ');
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const distance = levenshtein(a, b);
  const ratio = 1 - distance / Math.max(a.length, b.length);
  if (b.includes(a) || a.includes(b)) return Math.max(ratio, 0.9);
  return ratio;
}

/**
 * Score one candidate against a fuzzy spec, 0..1. A property declared 'exact' is a hard gate: a
 * mismatch zeroes the score rather than lowering it, because "this must be the Save button" is a
 * different claim from "this looks like it".
 */
export function scoreCandidate(
  candidate: { properties: Record<string, string>; text?: string },
  spec: FuzzySpec
): number {
  const parts: number[] = [];
  const wanted: Record<string, string> = { ...(spec.properties ?? {}) };
  if (spec.controlType !== undefined && spec.controlType !== '') wanted['controlType'] = spec.controlType;

  for (const [name, expected] of Object.entries(wanted)) {
    const actual = candidate.properties[name] ?? '';
    const level = spec.levels?.[name] ?? 'fuzzy';
    const score = similarity(expected, actual);
    if (level === 'exact') {
      if (score < 1) return 0;
      parts.push(1);
    } else if (typeof level === 'number') {
      if (score < level) return 0;
      parts.push(score);
    } else {
      parts.push(score);
    }
  }

  if (spec.text !== undefined) parts.push(similarity(spec.text, candidate.text ?? ''));

  if (parts.length === 0) return 0;
  return parts.reduce((sum, part) => sum + part, 0) / parts.length;
}

/** Does `main` sit where `relation` says it should, relative to `anchor`? */
export function relationHolds(relation: NonNullable<AnchorSpec['relation']>, main: Box, anchor: Box): boolean {
  const mainCenter = centerOf(main);
  const anchorCenter = centerOf(anchor);
  const overlap = (a: Box, b: Box) =>
    a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

  switch (relation) {
    case 'left':
      return mainCenter.x < anchorCenter.x;
    case 'right':
      return mainCenter.x > anchorCenter.x;
    case 'above':
      return mainCenter.y < anchorCenter.y;
    case 'below':
      return mainCenter.y > anchorCenter.y;
    case 'near':
    default: {
      // Near = the same neighbourhood: overlapping boxes, the same row, or the same column. A label
      // and its input are exactly this case, which is what anchors are for.
      if (overlap(main, anchor)) return true;
      const sameRow = Math.abs(mainCenter.y - anchorCenter.y) <= Math.max(anchor.height, main.height);
      const sameColumn = Math.abs(mainCenter.x - anchorCenter.x) <= Math.max(anchor.width, main.width);
      return sameRow || sameColumn;
    }
  }
}

/** The middle of a box — where a click lands. */
export function centerOf(box: Box): { x: number; y: number } {
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
}

/** Distance between two box centres, for picking the closest anchored candidate. */
export function centerDistance(a: Box, b: Box): number {
  const first = centerOf(a);
  const second = centerOf(b);
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** One line naming a box, for a log or an error. */
export function describeBox(box: Box): string {
  return `${box.left},${box.top} (${box.width}x${box.height})`;
}

/**
 * The target a step declares, from any of the shapes a definition arrives in:
 *
 *  - `target` (this toolkit's structured form),
 *  - `selectorChain` / `selector` holding a recorded `<wnd …/><ctrl …/>` chain,
 *  - the step's own `name`/`automationId`/`className`/`controlType` fields (how `desktop.uia` reads),
 *  - `imagePath` (+ `confidence`), or an explicit `x`/`y` pair.
 *
 * Returns null when the step names nothing to find — a plain click where the pointer already is.
 */
export function targetFromStep(step: Step): TargetSpec | null {
  const declared = step.target as TargetSpec | undefined;
  if (declared && typeof declared === 'object') {
    if (typeof declared.selectorChain === 'string') {
      const parsed = parseSelectorChain(declared.selectorChain);
      if (parsed) {
        const { selectorChain: _chain, ...rest } = declared;
        return { ...parsed, ...rest };
      }
    }
    return declared;
  }

  for (const candidate of [step.selectorChain, step.selector]) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue;
    const parsed = parseSelectorChain(candidate);
    if (parsed) return parsed;
  }

  const uia: UiaSpec = {};
  for (const field of ['name', 'automationId', 'className', 'controlType'] as const) {
    const value = step[field];
    if (typeof value === 'string' && value.trim() !== '') uia[field] = value;
  }
  if (Object.keys(uia).length > 0) return { uia };

  const imagePath = typeof step.imagePath === 'string' ? step.imagePath.trim() : '';
  if (imagePath !== '') {
    return { image: { path: imagePath, ...(step.confidence !== undefined ? { threshold: Number(step.confidence) } : {}) } };
  }

  const x = Number(step.x);
  const y = Number(step.y);
  if (Number.isFinite(x) && Number.isFinite(y)) return { point: { x, y } };
  return null;
}

/** One line naming what a target asks for. */
export function describeTarget(spec: TargetSpec): string {
  const parts: string[] = [];
  if (spec.point) parts.push(`point=${spec.point.x},${spec.point.y}`);
  if (spec.uia) {
    const wanted = Object.entries(spec.uia).filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${key}="${String(value)}"`);
    if (wanted.length > 0) parts.push(`uia(${wanted.join(' ')})`);
  }
  if (spec.fuzzy) {
    const wanted = Object.entries({ ...(spec.fuzzy.properties ?? {}), ...(spec.fuzzy.controlType ? { controlType: spec.fuzzy.controlType } : {}) })
      .map(([key, value]) => `${key}~"${value}"`);
    if (spec.fuzzy.text) wanted.push(`text~"${spec.fuzzy.text}"`);
    parts.push(`fuzzy(${wanted.join(' ')})`);
  }
  if (spec.image) parts.push(`image=${spec.image.path}${spec.image.threshold !== undefined ? `@${spec.image.threshold}` : ''}`);
  if (spec.anchor) parts.push(`anchor(${spec.anchor.relation ?? 'near'})`);
  if (spec.idx) parts.push(`idx=${spec.idx}`);
  return parts.join(' ') || '(no target)';
}

/** One candidate a method found, reduced to what scoring and reporting need. */
export interface Candidate {
  properties: Record<string, string>;
  text: string;
  box: Box;
}

export interface ResolveOptions {
  /** Where each attempt is narrated — the step log, in practice. */
  log?: (message: string) => void;
  /** How long the image search may wait. Property lookups do not wait; they read what is there. */
  timeoutMs?: number;
}

export interface ResolvedTarget {
  box: Box;
  point: { x: number; y: number };
  method: 'point' | 'uia' | 'fuzzy' | 'image';
  /** One line for the log: what was asked for, which method answered, where it landed. */
  description: string;
}

/** Every element the accessibility API can see right now, reduced to what scoring needs. */
async function elementCandidates(): Promise<Candidate[]> {
  const records = await dumpUiaElements({ max: 400 });
  return records.map((record) => ({
    properties: {
      name: record.name,
      automationId: record.automationId,
      className: record.className,
      controlType: record.controlType
    },
    text: record.name,
    box: record.box
  }));
}

/** Every property a strict spec asks for must be there, exactly (control types case-insensitively). */
function matchesStrict(candidate: Candidate, uia: UiaSpec): boolean {
  for (const [key, wanted] of Object.entries(uia)) {
    if (wanted === undefined || wanted === '') continue;
    const actual = candidate.properties[key] ?? '';
    if (key === 'controlType') {
      if (actual.toLowerCase() !== wanted.toLowerCase()) return false;
    } else if (actual !== wanted) return false;
  }
  return true;
}

/** Top to bottom, left to right — the order a person counts elements in, which is what `idx` means. */
function readingOrder(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
}

/** The property pass: the strict map first, then the scored one. */
async function propertyCandidates(
  spec: TargetSpec,
  log: (message: string) => void
): Promise<{ method: 'uia' | 'fuzzy'; candidates: Candidate[] } | null> {
  const all = await elementCandidates();

  if (spec.uia) {
    const strict = readingOrder(all.filter((candidate) => matchesStrict(candidate, spec.uia!)));
    if (strict.length > 0) {
      log(`uia: ${strict.length} element(s) match ${describeTarget({ uia: spec.uia })}`);
      return { method: 'uia', candidates: strict };
    }
    log(`uia: no element matches ${describeTarget({ uia: spec.uia })}`);
  }

  if (spec.fuzzy) {
    const threshold = spec.fuzzy.threshold ?? 0.7;
    const scored = all
      .map((candidate) => ({ candidate, score: scoreCandidate(candidate, spec.fuzzy!) }))
      .filter((entry) => entry.score >= threshold)
      .sort((a, b) => b.score - a.score);
    if (scored.length > 0) {
      log(`fuzzy: ${scored.length} element(s) scored ≥ ${threshold} (best ${scored[0]!.score.toFixed(2)})`);
      return { method: 'fuzzy', candidates: readingOrder(scored.map((entry) => entry.candidate)) };
    }
    log(`fuzzy: nothing scored ≥ ${threshold}`);
  }

  return null;
}

/**
 * Find the thing a target names and return where it is. Throws when nothing matched, naming what
 * was tried — the caller decides whether to heal, retry or fail.
 */
export async function resolveTarget(
  backend: DesktopBackend,
  spec: TargetSpec,
  options: ResolveOptions = {}
): Promise<ResolvedTarget> {
  const log = options.log ?? (() => {});
  const anchor = spec.anchor ? await resolveTarget(backend, spec.anchor.target, options) : undefined;

  let found: { method: ResolvedTarget['method']; candidates: Candidate[] } | undefined;
  if (spec.point) {
    found = {
      method: 'point',
      candidates: [{ properties: {}, text: '', box: { left: spec.point.x, top: spec.point.y, width: 0, height: 0 } }]
    };
  } else if (spec.uia || spec.fuzzy) {
    const properties = await propertyCandidates(spec, log);
    if (properties) found = properties;
  }
  if (!found && spec.image) {
    const box = await backend.findImage(spec.image.path, {
      ...(spec.image.threshold !== undefined ? { threshold: spec.image.threshold } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
    });
    log(`image: ${spec.image.path} found at ${describeBox(box)}`);
    found = { method: 'image', candidates: [{ properties: {}, text: '', box }] };
  }
  if (!found) {
    throw new Error(`nothing matched ${describeTarget(spec)} — add an image or point target, or let healing suggest one`);
  }

  const relation: NonNullable<AnchorSpec['relation']> = spec.anchor?.relation ?? 'near';
  const candidates = anchor
    ? found.candidates.filter((candidate) => relationHolds(relation, candidate.box, anchor.box))
    : found.candidates;
  if (candidates.length === 0) {
    throw new Error(`nothing that matched ${describeTarget(spec)} sits ${relation} the anchor at ${describeBox(anchor!.box)}`);
  }

  const index = Math.min(Math.max(spec.idx ?? 1, 1), candidates.length) - 1;
  const chosen = candidates[index]!;
  return {
    box: chosen.box,
    point: centerOf(chosen.box),
    method: found.method,
    description: `${describeTarget(spec)}${anchor ? ` ${relation} anchor` : ''} → ${found.method} at ${describeBox(chosen.box)}`
  };
}

export interface HealOutcome {
  box: Box;
  point: { x: number; y: number };
  /** Which pass found it. */
  method: 'relaxed-fuzzy' | 'resemblance';
  score: number;
  /** A target that resolves to the healed element — meant to be pasted back into the workflow. */
  target: TargetSpec;
  /** One line for the operator: what matched, and how well. */
  detail: string;
}

export interface HealOptions {
  /** Minimum score for a healed candidate, 0..1. Default: the target's, else 0.75. */
  threshold?: number;
  log?: (message: string) => void;
}

/**
 * Healing for a target that did not resolve. Two passes, both honest about what they did:
 *
 *   1. `relaxed-fuzzy` — the properties the target asked for, re-scored with every 'exact' gate
 *      dropped. This is the pass that survives a renamed control or a moved button.
 *   2. `resemblance`   — the image, retried with a lower threshold.
 *
 * Returns null when neither pass found anything worth offering ("no heals available").
 */
export async function healTarget(
  backend: DesktopBackend,
  spec: TargetSpec,
  options: HealOptions = {}
): Promise<HealOutcome | null> {
  const threshold = Math.min(Math.max(options.threshold ?? spec.healThreshold ?? 0.75, 0), 1);
  const log = options.log ?? (() => {});

  const wanted: Record<string, string> = { ...(spec.fuzzy?.properties ?? {}) };
  if (spec.uia) for (const [key, value] of Object.entries(spec.uia)) if (value) wanted[key] = value;
  if (spec.fuzzy?.controlType) wanted['controlType'] = spec.fuzzy.controlType;

  if (Object.keys(wanted).length > 0) {
    try {
      const all = await elementCandidates();
      const scored = all
        .map((candidate) => ({ candidate, score: scoreCandidate(candidate, { properties: wanted, ...(spec.fuzzy?.text ? { text: spec.fuzzy.text } : {}) }) }))
        .filter((entry) => entry.score >= threshold)
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (best) {
        const properties: Record<string, string> = {};
        for (const key of Object.keys(wanted)) {
          const actual = best.candidate.properties[key];
          if (actual) properties[key] = actual;
        }
        const target: TargetSpec = { fuzzy: { properties, threshold: Math.max(0.5, Number(best.score.toFixed(2)) - 0.1) } };
        log(`relaxed-fuzzy: ${describeTarget(target)} scored ${best.score.toFixed(2)}`);
        return {
          box: best.candidate.box,
          point: centerOf(best.candidate.box),
          method: 'relaxed-fuzzy',
          score: best.score,
          target,
          detail: `${describeTarget(target)} (${best.score.toFixed(2)})`
        };
      }
    } catch (error) {
      // A host without an accessibility API has nothing to re-score; the image pass may still work.
      log(`relaxed-fuzzy: unavailable here (${(error as Error).message})`);
    }
  }

  if (spec.image) {
    const relaxed = Math.max(0.45, Number((spec.image.threshold ?? 0.9).toFixed(2)) - 0.15);
    try {
      const box = await backend.findImage(spec.image.path, { threshold: relaxed });
      const target: TargetSpec = { image: { ...spec.image, threshold: relaxed } };
      log(`resemblance: ${spec.image.path} matched at threshold ${relaxed}`);
      return { box, point: centerOf(box), method: 'resemblance', score: relaxed, target, detail: `${describeTarget(target)}` };
    } catch {
      log(`resemblance: ${spec.image.path} did not match at threshold ${relaxed}`);
    }
  }

  return null;
}
