/**
 * Targeting — how a step finds its element. Four methods, in order of confidence:
 *
 *   1. `strict` / `strictAny` — exact selectors, first match wins, `idx` picks the nth.
 *   2. `fuzzy`              — tag + attribute values, scored by similarity against a threshold.
 *   3. `anchor`             — a second element whose geometric relation disambiguates the target.
 *   4. (image/OCR targeting lives in the ocr/ai-vision steps — this module stays DOM-level.)
 *
 * The point of having all of them is resilience: a page that changes an id
 * breaks a strict selector, and a fuzzy selector plus an anchor keeps the workflow running — while
 * the log still says which method actually matched, so nobody has to guess later.
 */
import type { Locator, Page } from 'playwright';
import type { AnchorSpec, FuzzySpec, Step, TargetSpec } from '../workflow/model.js';
import { parseSelectorChain } from '../workflow/selector-chain.js';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Levenshtein distance, iterative and allocation-light (attributes are short strings). */
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
 * Similarity of two attribute values, 0..1. Case- and whitespace-insensitive, because the two
 * strings compared here are a human's expectation and a DOM attribute, not two identifiers.
 * A containment relation (the target text inside the rendered text, or vice versa) scores at
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
 * Score one candidate against a fuzzy spec, 0..1. An attribute declared 'exact' is a hard gate: a
 * mismatch zeroes the score rather than lowering it, because "this must be the Sign in button" is a
 * different claim from "this looks like it".
 */
export function scoreCandidate(
  candidate: { attributes: Record<string, string>; text: string },
  spec: FuzzySpec
): number {
  const parts: number[] = [];

  for (const [name, expected] of Object.entries(spec.attributes ?? {})) {
    const actual = candidate.attributes[name] ?? '';
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

  if (spec.text !== undefined) parts.push(similarity(spec.text, candidate.text));

  if (parts.length === 0) return 0;
  return parts.reduce((sum, part) => sum + part, 0) / parts.length;
}

/** Does `main` sit where `relation` says it should, relative to `anchor`? */
export function relationHolds(relation: NonNullable<AnchorSpec['relation']>, main: Box, anchor: Box): boolean {
  const mainCenter = { x: main.x + main.width / 2, y: main.y + main.height / 2 };
  const anchorCenter = { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 };
  const overlap = (a: Box, b: Box) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

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

/** Distance between two box centres, for picking the closest anchored candidate. */
export function centerDistance(a: Box, b: Box): number {
  const dx = (a.x + a.width / 2) - (b.x + b.width / 2);
  const dy = (a.y + a.height / 2) - (b.y + b.height / 2);
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * The target a step declares, from either shape: this tool's `target`, or Aro's `selector` +
 * `selectors` fallbacks. A selector string in the `<html …/><webctrl …/>` chain form (exactly
 * what a desktop recorder emits) is parsed into the structured spec, so a
 * selector copied from a recorded session works here unchanged.
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

  const raw = typeof step.selector === 'string' && step.selector.trim() !== '' ? step.selector : undefined;
  const rawAny = Array.isArray(step.selectors)
    ? step.selectors.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    : undefined;

  const fromChain = raw ? parseSelectorChain(raw) : null;
  if (fromChain) {
    if (rawAny?.length) {
      const extra = rawAny.map((entry) => parseSelectorChain(entry)?.strict ?? entry).filter((entry): entry is string => Boolean(entry));
      return { ...fromChain, strictAny: extra };
    }
    return fromChain;
  }

  if (!raw && !rawAny?.length) return null;
  const spec: TargetSpec = {};
  if (raw) spec.strict = raw;
  if (rawAny) spec.strictAny = rawAny;
  return spec;
}

export function describeTarget(spec: TargetSpec): string {
  const parts: string[] = [];
  if (spec.strict) parts.push(`strict=${spec.strict}`);
  if (spec.strictAny?.length) parts.push(`fallbacks=${spec.strictAny.join(' | ')}`);
  if (spec.fuzzy) parts.push(`fuzzy=<${spec.fuzzy.tag}${spec.fuzzy.text ? ` text~"${spec.fuzzy.text}"` : ''}>`);
  if (spec.anchor) parts.push(`anchor(${spec.anchor.relation ?? 'near'})`);
  if (spec.idx) parts.push(`idx=${spec.idx}`);
  return parts.join(' ') || '(no target)';
}

export interface ResolveOptions {
  timeoutMs: number;
  log: (message: string) => void | Promise<void>;
  /** Only check what is on the page right now — for `elementExists`, which must not wait. */
  immediate?: boolean;
}

/**
 * Resolve the element a target describes. Strict selectors first, in order; the fuzzy spec next;
 * anchors filter whatever came out of either. Throws with every method that was tried, so a failure
 * says what the page was asked for instead of just "not found".
 */
export async function resolveTarget(page: Page, spec: TargetSpec, options: ResolveOptions): Promise<Locator> {
  const tried: string[] = [];
  const slice = options.immediate
    ? 0
    : Math.max(500, Math.floor(options.timeoutMs / Math.max(1, countMethods(spec))));

  const strictLocator = await findStrict(page, spec, slice, tried);
  if (strictLocator) {
    await options.log(`target found by strict selector (${describeTarget(spec)})`);
    return strictLocator;
  }

  let fuzzyLocator = await findFuzzy(page, spec, slice, tried, options);
  if (!fuzzyLocator && spec.anchor) {
    // Anchors exist to disambiguate something the main target matched too loosely. When the fuzzy
    // pass found nothing at all, try the anchor's own neighbourhood as a last resort.
    const anchored = await findThroughAnchor(page, spec, slice, tried);
    if (anchored) {
      await options.log(`target found through its anchor (${describeTarget(spec)})`);
      return anchored;
    }
  }
  if (fuzzyLocator) return fuzzyLocator;

  throw new Error(`target not found — tried ${tried.join('; ') || describeTarget(spec)}`);
}

function countMethods(spec: TargetSpec): number {
  let count = 0;
  if (spec.strict) count++;
  count += spec.strictAny?.length ?? 0;
  if (spec.fuzzy) count++;
  if (spec.anchor) count++;
  return count;
}

async function findStrict(page: Page, spec: TargetSpec, slice: number, tried: string[]): Promise<Locator | null> {
  const candidates = [spec.strict, ...(spec.strictAny ?? [])].filter(
    (value): value is string => typeof value === 'string' && value.trim() !== ''
  );
  // Native text targeting: Playwright's own text engine — exact enough, and cheap.
  if (spec.text) candidates.push(spec.textExact ? `text="${spec.text.replace(/"/g, '\\"')}"` : `text=${spec.text}`);
  if (spec.scope && Object.keys(spec.scope).length > 0) {
    tried.push(`scope ${Object.entries(spec.scope).map(([key, value]) => `${key}='${value}'`).join(' ')}`);
  }

  for (const selector of candidates) {
    const locator = page.locator(selector);
    try {
      const count = await locator.count();
      if (count === 0) {
        if (slice === 0) {
          tried.push(`${selector} → 0 matches`);
          continue;
        }
        // The element may simply not be there yet: a strict candidate waits for its slice, exactly
        // as a plain page.click() would, so `waitForElement` and a late-rendered page still work.
        await locator.first().waitFor({ state: 'visible', timeout: slice });
      }

      if (!spec.anchor && spec.idx === undefined) return locator.first();

      const anchorBox = spec.anchor ? await anchorBoxFor(page, spec.anchor, slice, tried) : null;
      const relation = spec.anchor?.relation ?? 'near';
      let matches = await waitForMatches(locator, spec.idx ?? 1, slice);

      if (anchorBox && spec.anchor) {
        const anchored = matches.filter((candidate) => {
          const box = candidate.box;
          return box ? relationHolds(relation, box, anchorBox) : false;
        });
        if (anchored.length > 0) {
          // Nearest to the anchor first: with two identical inputs beside one label, the closer one
          // is the one a human would have pointed at.
          matches = anchored.sort((a, b) => centerDistance(a.box!, anchorBox) - centerDistance(b.box!, anchorBox));
        } else if (matches.length > 0) {
          tried.push(`${selector} + anchor(${relation}) → no match was ${relation} of the anchor`);
        }
      }

      if (matches.length === 0) {
        tried.push(`${selector} → 0 visible matches`);
        continue;
      }
      const pick = matches[(spec.idx ?? 1) - 1];
      if (!pick) {
        tried.push(`${selector} → ${matches.length} matches, idx=${spec.idx}`);
        continue;
      }
      await pick.locator.waitFor({ state: 'visible', timeout: slice });
      return pick.locator;
    } catch (e) {
      tried.push(`${selector} → ${firstLine((e as Error).message)}`);
    }
  }
  return null;
}

/**
 * Every visible match of a selector, waiting for at least `need` of them to appear (a list that
 * renders row by row is the case this exists for). Returns what it has when the slice runs out.
 */
async function waitForMatches(locator: Locator, need: number, timeoutMs: number): Promise<Array<{ locator: Locator; box: Box | null }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const matches = await collectVisible(locator);
    if (matches.length >= need || timeoutMs === 0 || Date.now() > deadline) return matches;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

async function collectVisible(locator: Locator): Promise<Array<{ locator: Locator; box: Box | null }>> {
  const matches: Array<{ locator: Locator; box: Box | null }> = [];
  for (const candidate of await locator.all()) {
    if (!(await candidate.isVisible().catch(() => false))) continue;
    matches.push({ locator: candidate, box: await candidate.boundingBox().catch(() => null) });
  }
  return matches;
}

interface Candidate {
  locator: Locator;
  attributes: Record<string, string>;
  text: string;
  box: Box | null;
  score: number;
}

async function findFuzzy(
  page: Page,
  spec: TargetSpec,
  slice: number,
  tried: string[],
  options: ResolveOptions
): Promise<Locator | null> {
  const fuzzy = spec.fuzzy;
  if (!fuzzy) return null;

  const threshold = fuzzy.threshold ?? 0.7;
  const anchorBox = spec.anchor ? await anchorBoxFor(page, spec.anchor, slice, tried) : null;
  const attributesWanted = Object.keys(fuzzy.attributes ?? {});
  const candidates: Candidate[] = [];
  let candidateCount = 0;
  let bestScoreSeen: number | null = null;

  try {
    const all = await page.locator(fuzzy.tag.toLowerCase()).all();
    for (const locator of all) {
      if (!(await locator.isVisible().catch(() => false))) continue;
      candidateCount++;
      const attributes: Record<string, string> = {};
      for (const name of attributesWanted) {
        attributes[name] = (await locator.getAttribute(name).catch(() => null)) ?? '';
      }
      // `aaname` is the accessible name — approximated by aria-label, then the element's text.
      if (attributesWanted.includes('aaname') && !attributes['aaname']) {
        attributes['aaname'] = (await locator.getAttribute('aria-label').catch(() => null))
          ?? (await locator.innerText().catch(() => '')) ?? '';
      }
      const text = options.immediate ? '' : (await locator.innerText().catch(() => '')) ?? '';
      const score = scoreCandidate({ attributes, text }, fuzzy);
      bestScoreSeen = bestScoreSeen === null ? score : Math.max(bestScoreSeen, score);
      if (score <= 0 || score < threshold) continue;
      candidates.push({ locator, attributes, text, box: await locator.boundingBox().catch(() => null), score });
    }
  } catch (e) {
    tried.push(`fuzzy <${fuzzy.tag}> → ${firstLine((e as Error).message)}`);
    return null;
  }

  let ranked = candidates.sort((a, b) => b.score - a.score);
  if (anchorBox && spec.anchor) {
    const relation = spec.anchor.relation ?? 'near';
    const anchored = ranked.filter(candidate => candidate.box && relationHolds(relation, candidate.box, anchorBox));
    if (anchored.length > 0) {
      ranked = anchored.sort((a, b) => centerDistance(a.box!, anchorBox) - centerDistance(b.box!, anchorBox));
      await options.log(`fuzzy selector matched ${anchored.length} element(s) near the anchor (${relation})`);
    } else if (ranked.length > 0) {
      tried.push(`anchor(${relation}) → no candidate was ${relation} of the anchor`);
    }
  }

  if (ranked.length === 0) {
    const scored = bestScoreSeen;
    tried.push(scored === null
      ? `fuzzy <${fuzzy.tag}> → no visible element of that tag`
      : `fuzzy <${fuzzy.tag}> → ${candidateCount} element(s), best score ${scored.toFixed(2)} < ${threshold}`);
    return null;
  }

  const pick = ranked[(fuzzy.idx ?? 1) - 1];
  if (!pick) {
    tried.push(`fuzzy <${fuzzy.tag}> → ${ranked.length} matches, idx=${fuzzy.idx}`);
    return null;
  }
  await options.log(`target found by fuzzy selector (score ${pick.score.toFixed(2)}, ${ranked.length} match(es))`);
  return pick.locator;
}

async function anchorBoxFor(page: Page, anchor: AnchorSpec, slice: number, tried: string[]): Promise<Box | null> {
  try {
    const locator = await resolveTarget(page, anchor.target, { timeoutMs: slice, log: () => {} });
    return await locator.boundingBox();
  } catch (e) {
    tried.push(`anchor → ${firstLine((e as Error).message)}`);
    return null;
  }
}

/**
 * Last resort: no candidate scored, so scan every visible element of the anchor's relation and take
 * the closest one that looks interactive. This is the "the label is still there" branch — the same
 * fallback a human performs by hand.
 */
async function findThroughAnchor(page: Page, spec: TargetSpec, slice: number, tried: string[]): Promise<Locator | null> {
  const anchor = spec.anchor;
  if (!anchor) return null;
  const box = await anchorBoxFor(page, anchor, slice, tried);
  if (!box) return null;

  const relation = anchor.relation ?? 'near';
  const tags = spec.fuzzy?.tag ? [spec.fuzzy.tag.toLowerCase()] : ['input', 'button', 'a', 'select', 'textarea'];
  let best: { locator: Locator; distance: number } | null = null;

  for (const tag of tags) {
    for (const locator of await page.locator(tag).all()) {
      if (!(await locator.isVisible().catch(() => false))) continue;
      const candidate = await locator.boundingBox().catch(() => null);
      if (!candidate || !relationHolds(relation, candidate, box)) continue;
      const distance = centerDistance(candidate, box);
      if (!best || distance < best.distance) best = { locator, distance };
    }
  }
  return best?.locator ?? null;
}

function firstLine(message: string): string {
  return message.split('\n')[0] ?? message;
}

// ── Healing ────────────────────────────────────────────────────────────────────────────────────

/**
 * Target healing — what runs when every declared method failed. Local and evidence-only, two passes:
 *
 *   1. `relaxed-fuzzy` — the declared attributes re-scored without the hard 'exact' gates that a
 *      changed page usually breaks, against a lower bar;
 *   2. `resemblance`   — hints taken from the selector text itself (id / name / class / [attr=v] /
 *      `text`) and scored against the visible elements with the same similarity function fuzzy
 *      matching uses.
 *
 * A candidate must reach `threshold` (default 0.75). Nothing is invented — no ML, no service, only
 * strings already on the page. The caller decides whether to use the result or only report it.
 */
export interface HealOutcome {
  locator: Locator;
  /** Which pass found it. */
  method: 'relaxed-fuzzy' | 'resemblance';
  score: number;
  /** A target that resolves to the healed element — meant to be pasted back into the workflow. */
  target: TargetSpec;
  /** One line for the operator: what matched, and how well. */
  detail: string;
}

export interface HealOptions {
  /** Minimum score for a healed candidate, 0..1. Default 0.75. */
  threshold?: number;
}

export interface Hints {
  tag?: string;
  id?: string;
  name?: string;
  type?: string;
  placeholder?: string;
  classes: string[];
  text?: string;
}

/** Everything a selector string and/or `text` can be re-searched by, or null when it carries none. */
export function selectorHints(spec: TargetSpec): Hints | null {
  const hints: Hints = { classes: [] };
  const source =
    typeof spec.strict === 'string' && spec.strict.trim() !== ''
      ? spec.strict
      : spec.strictAny?.find((value) => typeof value === 'string' && value.trim() !== '');
  if (typeof spec.text === 'string' && spec.text.trim() !== '') hints.text = spec.text;

  if (source) {
    const tag = /^([a-zA-Z][\w-]*)/.exec(source.trim());
    if (tag) hints.tag = tag[1]!.toLowerCase();
    const id = /#([\w-]+)/.exec(source);
    if (id) hints.id = id[1];
    for (const token of source.matchAll(/\.([\w-]+)/g)) hints.classes.push(token[1]!);
    for (const attr of source.matchAll(/\[([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))/g)) {
      const key = attr[1]!.toLowerCase();
      const value = attr[2] ?? attr[3] ?? attr[4] ?? '';
      if (value === '') continue;
      if (key === 'id') hints.id = value;
      else if (key === 'name') hints.name = value;
      else if (key === 'type') hints.type = value;
      else if (key === 'placeholder') hints.placeholder = value;
    }
  }

  // `type`/`placeholder` alone match the world; require one piece of real evidence.
  const usable = hints.id || hints.name || hints.text || hints.classes.length > 0;
  return usable ? hints : null;
}

/** One visible element, reduced to what healing scores and what a suggestion can be built from. */
interface ScannedElement {
  tag: string;
  locator: Locator;
  id: string;
  name: string;
  type: string;
  placeholder: string;
  classes: string[];
  text: string;
}

/** Healing scans stop here so a huge page cannot turn a failed step into a long walk. */
const HEAL_SCAN_LIMIT = 600;

async function scanTags(page: Page, tags: string[]): Promise<ScannedElement[]> {
  const found: ScannedElement[] = [];
  const seenIds = new Set<string>();
  for (const tag of tags) {
    const locator = page.locator(tag);
    const count = Math.min(await locator.count().catch(() => 0), HEAL_SCAN_LIMIT);
    for (let index = 0; index < count && found.length < HEAL_SCAN_LIMIT; index++) {
      const item = locator.nth(index);
      if (!(await item.isVisible().catch(() => false))) continue;
      const id = (await item.getAttribute('id').catch(() => null)) ?? '';
      if (id !== '' && seenIds.has(id)) continue;
      if (id !== '') seenIds.add(id);
      const placeholder = (await item.getAttribute('placeholder').catch(() => null)) ?? '';
      const aria = (await item.getAttribute('aria-label').catch(() => null)) ?? '';
      const text = ((await item.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
        || aria
        || placeholder;
      found.push({
        tag: tag.startsWith('[') || tag.startsWith('.') ? 'input' : tag,
        locator: item,
        id,
        name: (await item.getAttribute('name').catch(() => null)) ?? '',
        type: (await item.getAttribute('type').catch(() => null)) ?? '',
        placeholder,
        classes: ((await item.getAttribute('class').catch(() => null)) ?? '').split(/\s+/).filter(Boolean),
        text: text.slice(0, 120)
      });
    }
  }
  return found;
}

/** A target that resolves to a scanned element — the thing a healed run suggests pasting back. */
function suggestedTarget(candidate: ScannedElement): TargetSpec {
  if (candidate.id) return { strict: `#${candidate.id}` };
  if (candidate.text) return { fuzzy: { tag: candidate.tag.toUpperCase(), text: candidate.text.slice(0, 80) } };
  if (candidate.name) return { strict: `[name="${candidate.name}"]` };
  return { fuzzy: { tag: candidate.tag.toUpperCase() } };
}

/** Score a scan against the hints, and name the strongest component for the log line. */
function scoreHints(hints: Hints, candidate: ScannedElement): { score: number; label: string } {
  const strong: Array<{ label: string; value: number }> = [];
  if (hints.id) strong.push({ label: `id '${hints.id}' ≈ '${candidate.id}'`, value: similarity(hints.id, candidate.id) });
  if (hints.name) strong.push({ label: `name '${hints.name}' ≈ '${candidate.name}'`, value: similarity(hints.name, candidate.name) });
  if (hints.text) strong.push({ label: `text '${hints.text}' ≈ '${candidate.text}'`, value: similarity(hints.text, candidate.text) });
  if (strong.length > 0) {
    const best = strong.reduce((a, b) => (b.value > a.value ? b : a));
    const score = strong.reduce((sum, part) => sum + part.value, 0) / strong.length;
    return { score, label: best.label };
  }
  // Weak evidence only (a class-based selector): token overlap wins, then placeholder/type refine.
  const weak: number[] = [];
  if (hints.classes.length > 0) {
    weak.push(Math.max(...hints.classes.map((want) => Math.max(...candidate.classes.map((have) => similarity(want, have)), 0))));
  }
  if (hints.placeholder) weak.push(similarity(hints.placeholder, candidate.placeholder));
  if (hints.type) weak.push(similarity(hints.type, candidate.type));
  const label = hints.classes.length > 0 ? `class '.${hints.classes[0]}' ≈ '${candidate.classes.join(' ')}'` : 'attribute match';
  return { score: weak.length > 0 ? weak.reduce((sum, part) => sum + part, 0) / weak.length : 0, label };
}

/** Pass 1: the declared fuzzy spec, re-scored with every gate relaxed. */
async function healRelaxedFuzzy(page: Page, fuzzy: FuzzySpec, threshold: number): Promise<{ candidate: ScannedElement; score: number } | null> {
  const attributesWanted = Object.keys(fuzzy.attributes ?? {});
  const relaxed: FuzzySpec = {
    tag: fuzzy.tag,
    ...(fuzzy.attributes ? { attributes: fuzzy.attributes } : {}),
    ...(fuzzy.text !== undefined ? { text: fuzzy.text } : {}),
    threshold
  };
  const locator = page.locator(fuzzy.tag.toLowerCase());
  const count = Math.min(await locator.count().catch(() => 0), HEAL_SCAN_LIMIT);
  let best: { candidate: ScannedElement; score: number } | null = null;

  for (let index = 0; index < count; index++) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;
    const attributes: Record<string, string> = {};
    for (const name of attributesWanted) {
      attributes[name] = (await item.getAttribute(name).catch(() => null)) ?? '';
    }
    if (attributesWanted.includes('aaname') && !attributes['aaname']) {
      attributes['aaname'] = (await item.getAttribute('aria-label').catch(() => null))
        ?? (await item.innerText().catch(() => '')) ?? '';
    }
    const text = ((await item.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
    const score = scoreCandidate({ attributes, text }, relaxed);
    if (score < threshold) continue;
    if (!best || score > best.score) {
      best = {
        score,
        candidate: {
          tag: fuzzy.tag,
          locator: item,
          id: (await item.getAttribute('id').catch(() => null)) ?? '',
          name: attributes['name'] ?? (await item.getAttribute('name').catch(() => null)) ?? '',
          type: attributes['type'] ?? '',
          placeholder: attributes['placeholder'] ?? '',
          classes: (attributes['class'] ?? '').split(/\s+/).filter(Boolean),
          text: text.slice(0, 120)
        }
      };
    }
  }
  return best;
}

/**
 * Run the healing passes for a target that did not resolve. Returns the best candidate at or above
 * the threshold, or null when the page offers nothing similar ("no heals available").
 */
export async function healTarget(page: Page, spec: TargetSpec, options: HealOptions = {}): Promise<HealOutcome | null> {
  const threshold = Math.min(Math.max(options.threshold ?? 0.75, 0), 1);
  const outcomes: HealOutcome[] = [];

  if (spec.fuzzy) {
    const relaxed = await healRelaxedFuzzy(page, spec.fuzzy, threshold);
    if (relaxed) {
      const target = suggestedTarget(relaxed.candidate);
      outcomes.push({
        locator: relaxed.candidate.locator,
        method: 'relaxed-fuzzy',
        score: relaxed.score,
        target,
        detail: `relaxed fuzzy <${spec.fuzzy.tag}> scored ${relaxed.score.toFixed(2)} (bar ${threshold}) → ${JSON.stringify(target)}`
      });
    }
  }

  const hints = selectorHints(spec);
  if (hints) {
    const tags = new Set<string>();
    if (hints.tag) tags.add(hints.tag);
    for (const fallback of ['input', 'button', 'a', 'select', 'textarea']) tags.add(fallback);
    if (hints.id) tags.add('[id]');
    const scanned = await scanTags(page, [...tags]);
    let best: { candidate: ScannedElement; score: number; label: string } | null = null;
    for (const candidate of scanned) {
      const { score, label } = scoreHints(hints, candidate);
      if (score < threshold) continue;
      if (!best || score > best.score) best = { candidate, score, label };
    }
    if (best) {
      const target = suggestedTarget(best.candidate);
      outcomes.push({
        locator: best.candidate.locator,
        method: 'resemblance',
        score: best.score,
        target,
        detail: `resemblance: ${best.label} (score ${best.score.toFixed(2)}) → ${JSON.stringify(target)}`
      });
    }
  }

  outcomes.sort((a, b) => b.score - a.score);
  return outcomes[0] ?? null;
}
