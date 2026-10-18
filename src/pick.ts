/**
 * `rpa pick` — open a browser, let a human click one element, and turn that click into target JSON.
 *
 * The CLI verb and the Studio's "Pick element" button both call in here, so there is exactly one pick
 * code path (and one injected script to keep honest). The script is passed to the page as a STRING:
 * a callback shipped to the page is serialised by the bundler with its names rewritten, and tsx's
 * keepNames would leave a `__name` call inside it with no definition in the page.
 */
import type { Page } from 'playwright';

export interface PickStep {
  type: 'web';
  action: string;
  target: Record<string, unknown>;
}

export interface PickOptions {
  /** Wait this long for a click. Default 5 minutes. */
  timeoutMs?: number;
  /** A human needs a window; a scripted caller (or a headless host) can run without one. */
  headless?: boolean;
  /** Called once the page is loaded — a hook for driving the page instead of waiting for a human. */
  onPage?: (page: Page) => Promise<void>;
}

export const PICK_SCRIPT = `(() => {
  if (window.__rpaPickInstalled) return;
  window.__rpaPickInstalled = true;

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

  document.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const element = event.target;
    if (!element || !element.tagName) return;
    const tag = element.tagName.toUpperCase();
    const ariaLabel = element.getAttribute ? (element.getAttribute('aria-label') || '') : '';
    const text = (element.innerText || element.textContent || '').trim().slice(0, 60);
    const aaname = ariaLabel || text;
    const attributes = {};
    const id = element.getAttribute ? element.getAttribute('id') : null;
    const name = element.getAttribute ? element.getAttribute('name') : null;
    if (id) attributes.id = id;
    if (name) attributes.name = name;
    if (aaname) attributes.aaname = aaname;
    const levels = {};
    Object.keys(attributes).forEach((key) => { levels[key] = key === 'aaname' ? 'fuzzy' : 'exact'; });
    window.rpaPick({
      strict: cssPath(element),
      fuzzy: { tag: tag, attributes: attributes, levels: levels, threshold: 0.7 },
      text: text
    });
  }, true);
})();`;

/** Open `url`, wait for one click, and return the step that click describes. Null = nothing picked. */
export async function pickTarget(url: string, options: PickOptions = {}): Promise<PickStep | null> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: options.headless ?? false });
  try {
    const page = await browser.newPage();
    let picked: unknown = null;
    await page.exposeBinding('rpaPick', (_source, payload: unknown) => { picked = payload; });
    await page.addInitScript({ content: PICK_SCRIPT });
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    if (options.onPage) await options.onPage(page);

    const deadline = Date.now() + (options.timeoutMs ?? 5 * 60 * 1000);
    while (!picked && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 200));
    if (!picked) return null;
    return { type: 'web', action: 'click', target: picked as Record<string, unknown> };
  } finally {
    await browser.close();
  }
}
