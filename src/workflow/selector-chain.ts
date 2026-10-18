/**
 * Selector-chain interoperability: reading the `<html …/><webctrl …/>` form that desktop recorders emit.
 *
 * Two things live here:
 *
 *  `parseSelectorChain` takes a chain like
 *     `<html app='chrome.exe' /><webctrl id='submit' tag='BUTTON' aaname='Sign in' />`
 *     and returns a `TargetSpec`, so a selector copied from a recorded session works here
 *     instead of being re-derived by hand.
 *  The grammar is a chain of nodes, each a tag plus `name='value'` attributes; `matching:<attr>` and
 *  `fuzzylevel:<attr>` mark attributes that must be matched approximately rather than exactly.
 *
 * Node kinds seen in practice: `html`/`wnd` describe the application window (kept as `scope`),
 * `webctrl`/`ctrl`/`java`/`sap` describe the element (`tag`, `id`, `name`, `class`, `aaname`,
 * `idx`).
 */
import type { FuzzySpec, TargetSpec } from './model.js';

interface SelectorNode {
  tag: string;
  attributes: Record<string, string>;
  /** `matching:<attr>` values ('fuzzy' | 'exact') and `fuzzylevel:<attr>` values (0..1). */
  matching: Record<string, string>;
  fuzzylevel: Record<string, number>;
}

const decode = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Split a selector string into its nodes and their attributes. */
export function parseSelectorNodes(raw: string): SelectorNode[] {
  const nodes: SelectorNode[] = [];
  const tagPattern = /<([A-Za-z][\w:.-]*)([^>]*?)\/?>/g;
  for (const match of raw.matchAll(tagPattern)) {
    const tag = match[1] ?? '';
    const body = match[2] ?? '';
    const attributes: Record<string, string> = {};
    const matching: Record<string, string> = {};
    const fuzzylevel: Record<string, number> = {};

    const attributePattern = /([A-Za-z0-9:_-]+)\s*=\s*(['"])(.*?)\2/g;
    for (const attribute of body.matchAll(attributePattern)) {
      const name = attribute[1] ?? '';
      const value = decode(attribute[3] ?? '');
      if (name.startsWith('matching:')) matching[name.slice('matching:'.length)] = value.toLowerCase();
      else if (name.startsWith('fuzzylevel:')) fuzzylevel[name.slice('fuzzylevel:'.length)] = Number(value) || 0;
      else attributes[name] = value;
    }
    nodes.push({ tag, attributes, matching, fuzzylevel });
  }
  return nodes;
}

/** A CSS/Playwright selector for one element node, or undefined when the node is only a scope. */
function cssForNode(node: SelectorNode): string | undefined {
  if (node.tag === 'html') return undefined; // the window scope, not an element
  const isWeb = node.tag === 'webctrl' || node.tag === 'web';
  const tag = (node.attributes['tag'] ?? (isWeb ? '*' : node.tag)).toLowerCase();
  const id = node.attributes['id'];
  if (id) return `#${id.replace(/([^\w-])/g, '\\$1')}`;

  const parts: string[] = [];
  for (const name of ['name', 'type', 'role', 'placeholder']) {
    const value = node.attributes[name];
    if (value) parts.push(`[${name}="${value.replace(/"/g, '\\"')}"]`);
  }
  const classes = (node.attributes['class'] ?? '').split(/\s+/).filter(Boolean);
  if (classes.length > 0) parts.push(...classes.map((token) => `.${token.replace(/([^\w-])/g, '\\$1')}`));

  // Playwright's CSS engine understands :has-text, which is the closest cheap equivalent of
  // `aaname` (accessible name) when no id/name is present.
  const aaname = node.attributes['aaname'] || node.attributes['innertext'];
  let selector = `${tag}${parts.join('')}`;
  if (aaname) selector += `:has-text("${aaname.replace(/"/g, '\\"')}")`;
  else if (parts.length === 0 && node.tag !== 'webctrl' && tag === '*') return undefined;
  return selector;
}

/**
 * Turn a selector chain into a TargetSpec. Returns null when the string is not a chain
 * (so callers can keep treating it as a plain Playwright selector).
 *
 * - A node with `matching:*` / `fuzzylevel:*` attributes becomes the fuzzy spec. A chain's
 *   `fuzzylevel` (0 = exact, higher = more lenient) maps to our minimum similarity as `1 - level`.
 * - Without those attributes the last element node becomes a strict CSS selector.
 * - `idx` (1-based) is carried through; `idx='1'` is the default and therefore dropped.
 * - Attributes of the `<html>`/`wnd` node describe the application window; they are kept as `scope`
 *   (logged, not matched) because this engine targets one page at a time.
 */
export function parseSelectorChain(raw: string): TargetSpec | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('<')) return null;
  const nodes = parseSelectorNodes(trimmed);
  if (nodes.length === 0) return null;

  const scope: Record<string, string> = {};
  for (const node of nodes.filter((candidate) => candidate.tag === 'html' || candidate.tag === 'wnd')) {
    for (const [key, value] of Object.entries(node.attributes)) {
      if (value !== '') scope[key] = value;
    }
  }

  const elementNodes = nodes.filter((node) => node.tag !== 'html' && node.tag !== 'wnd');
  if (elementNodes.length === 0) return null;
  const last = elementNodes[elementNodes.length - 1]!;

  const idxRaw = Number(last.attributes['idx'] ?? '1');
  const idx = Number.isFinite(idxRaw) && idxRaw > 1 ? idxRaw : undefined;
  const base: TargetSpec = {};
  if (idx) base.idx = idx;
  if (Object.keys(scope).length > 0) base.scope = scope;

  const fuzzyKeys = [...Object.keys(last.matching), ...Object.keys(last.fuzzylevel)];
  if (fuzzyKeys.length > 0) {
    const attributes: Record<string, string> = {};
    for (const [name, value] of Object.entries(last.attributes)) {
      if (name === 'tag' || name === 'idx' || value === '') continue;
      attributes[name] = value;
    }
    const levels: FuzzySpec['levels'] = {};
    for (const name of Object.keys(attributes)) {
      const matching = last.matching[name];
      const fuzz = last.fuzzylevel[name];
      if (fuzz !== undefined) levels[name] = Math.max(0, 1 - fuzz); // fuzzylevel 0 → exact (1.0)
      else if (matching === 'exact') levels[name] = 'exact';
      else if (matching === 'fuzzy') levels[name] = 'fuzzy';
    }
    const fuzzy: FuzzySpec = {
      tag: (last.attributes['tag'] ?? last.tag).toUpperCase(),
      attributes,
      ...(Object.keys(levels).length > 0 ? { levels } : {}),
      threshold: 0.7
    };
    return { ...base, fuzzy };
  }

  const strict = cssForNode(last);
  if (!strict) return null;
  return { ...base, strict };
}
