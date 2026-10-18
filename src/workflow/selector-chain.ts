/**
 * Selector-chain interoperability: reading the `<wnd …/><ctrl …/>` form that desktop recorders emit.
 *
 * Two things live here:
 *
 *  `parseSelectorNodes` takes a chain like
 *     `<wnd app='notepad.exe' title='Untitled - Notepad' /><ctrl name='Text editor' role='document' />`
 *     and returns its nodes, so a selector copied from a recorded session works here instead of
 *     being re-derived by hand.
 *  The grammar is a chain of nodes, each a tag plus `name='value'` attributes; `matching:<attr>` and
 *  `fuzzylevel:<attr>` mark attributes that must be matched approximately rather than exactly.
 *
 * Node kinds seen in practice: `wnd`/`html` describe the application window (kept as `scope`),
 * `ctrl`/`webctrl`/`java`/`sap` describe the element. The attributes are mapped onto the properties
 * the accessibility API matches on, which is what makes a recorded chain usable as a target: an
 * `id`/`automationId` is the stable identifier, `aaname`/`name` the accessible name, `class` the
 * window class, and a `role`/`tag` naming a control type becomes that control type.
 */
import type { FuzzySpec, TargetSpec, UiaSpec } from './model.js';

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

/** Control types as the Windows accessibility API names them, for the tags recorders emit. */
const CONTROL_TYPES: Record<string, string> = {
  button: 'Button', input: 'Edit', edit: 'Edit', text: 'Text', textbox: 'Edit', document: 'Document',
  link: 'Hyperlink', hyperlink: 'Hyperlink', checkbox: 'CheckBox', radio: 'RadioButton', combobox: 'ComboBox',
  select: 'ComboBox', list: 'List', listitem: 'ListItem', tab: 'TabItem', menu: 'Menu', menuitem: 'MenuItem',
  tree: 'Tree', treeitem: 'TreeItem', table: 'Table', cell: 'DataItem', image: 'Image', img: 'Image',
  pane: 'Pane', window: 'Window', toolbar: 'ToolBar', group: 'Group', statusbar: 'StatusBar'
};

/** One property a chain names the element by, and the attribute it was read from. */
interface ElementProperty {
  property: keyof UiaSpec;
  value: string;
  from: string;
}

/** The properties a chain's element node carries, most reliable first, one per property. */
function propertiesForNode(node: SelectorNode): ElementProperty[] {
  const found: ElementProperty[] = [];
  const push = (property: keyof UiaSpec, attribute: string): void => {
    const value = node.attributes[attribute] ?? '';
    if (value === '' || found.some((entry) => entry.property === property)) return;
    found.push({ property, value, from: attribute });
  };
  push('automationId', 'automationId');
  push('automationId', 'id');
  push('name', 'aaname');
  push('name', 'name');
  push('name', 'innertext');
  push('className', 'class');
  push('className', 'cls');
  const tagOrRole = (node.attributes['role'] ?? node.attributes['tag'] ?? node.tag).toLowerCase();
  const controlType = CONTROL_TYPES[tagOrRole];
  if (controlType) found.push({ property: 'controlType', value: controlType, from: tagOrRole });
  return found;
}

/**
 * Turn a selector chain into a TargetSpec. Returns null when the string is not a chain, or a chain
 * that names no element this toolkit could find.
 *
 * - A node with `matching:*` / `fuzzylevel:*` attributes becomes the fuzzy spec. A chain's
 *   `fuzzylevel` (0 = exact, higher = more lenient) maps to our minimum similarity as `1 - level`.
 * - Without those attributes the element node becomes the strict property map.
 * - `idx` (1-based) is carried through; `idx='1'` is the default and therefore dropped.
 * - The `<wnd>`/`<html>` node describes the application window; it is kept as `scope` (logged, and
 *   matched against the window title where the host can enumerate windows).
 * - The chain itself rides along as `selectorChain`, so a report shows what was recorded.
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
  const base: TargetSpec = { selectorChain: trimmed };
  if (idx) base.idx = idx;
  if (Object.keys(scope).length > 0) base.scope = scope;

  const properties = propertiesForNode(last);
  if (properties.length === 0) return null;

  const fuzzyKeys = [...Object.keys(last.matching), ...Object.keys(last.fuzzylevel)];
  if (fuzzyKeys.length > 0) {
    const values: Record<string, string> = {};
    const levels: NonNullable<FuzzySpec['levels']> = {};
    for (const entry of properties) {
      values[entry.property] = entry.value;
      const fuzz = last.fuzzylevel[entry.from];
      const matching = last.matching[entry.from];
      if (fuzz !== undefined) levels[entry.property] = Math.max(0, 1 - fuzz); // fuzzylevel 0 → exact (1.0)
      else if (matching === 'exact') levels[entry.property] = 'exact';
      else if (matching === 'fuzzy') levels[entry.property] = 'fuzzy';
    }
    const controlType = properties.find((entry) => entry.property === 'controlType')?.value;
    const fuzzy: FuzzySpec = {
      properties: values,
      ...(controlType ? { controlType } : {}),
      ...(Object.keys(levels).length > 0 ? { levels } : {}),
      threshold: 0.7
    };
    return { ...base, fuzzy };
  }

  const uia: UiaSpec = {};
  for (const entry of properties) uia[entry.property] = entry.value;
  return { ...base, uia };
}
