/**
 * The WebdriverIO-backed mobile driver — for teams whose stack is already WebdriverIO (the
 * appium-testing repo's stack). wdio owns the session handshake, error mapping and protocol
 * plumbing; every operation still maps onto the same WebDriver command the raw client sends, so
 * step semantics are identical either way. Loaded lazily: `webdriverio` is an optional dependency,
 * pulled in only by `driver: "webdriverio"`.
 */
import type { MobileDriver } from './webdriver.js';
import { normalizeCapabilities } from './webdriver.js';

type WdioModule = typeof import('webdriverio');
type WdioBrowser = Awaited<ReturnType<WdioModule['remote']>>;
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

export async function startWebdriverIo(options: {
  server: string;
  capabilities: Record<string, unknown>;
}): Promise<MobileDriver> {
  let wdio: WdioModule;
  try {
    wdio = (await import('webdriverio')) as unknown as WdioModule;
  } catch {
    throw new Error('driver "webdriverio" needs the package: npm i webdriverio');
  }

  const url = new URL(options.server);
  const secure = url.protocol === 'https:';
  const browser = await wdio.remote({
    logLevel: 'silent',
    protocol: secure ? 'https' : 'http',
    hostname: url.hostname,
    port: Number(url.port || (secure ? 443 : 80)),
    path: url.pathname === '' ? '/' : url.pathname,
    capabilities: normalizeCapabilities(options.capabilities) as never
  });
  return new WebdriverIoDriver(browser);
}

class WebdriverIoDriver implements MobileDriver {
  constructor(private readonly browser: WdioBrowser) {}

  get id(): string | undefined {
    return this.browser.sessionId === '' ? undefined : this.browser.sessionId;
  }

  async end(): Promise<void> {
    await this.browser.deleteSession().catch(() => {});
  }

  async find(using: string, value: string): Promise<string> {
    const element = (await this.browser.findElement(using, value)) as unknown;
    if (typeof element === 'string' && element !== '') return element;
    const key = (element as Record<string, unknown> | undefined)?.[ELEMENT_KEY];
    if (typeof key === 'string' && key !== '') return key;
    throw new Error(`webdriverio: no element id in the response for ${using}=${value}`);
  }

  async click(elementId: string): Promise<void> {
    await this.browser.elementClick(elementId);
  }

  async clear(elementId: string): Promise<void> {
    await this.browser.elementClear(elementId);
  }

  async type(elementId: string, text: string): Promise<void> {
    await this.browser.elementSendKeys(elementId, text);
  }

  async text(elementId: string): Promise<string> {
    return String(await this.browser.getElementText(elementId));
  }

  async displayed(elementId: string): Promise<boolean> {
    return Boolean(await this.browser.isElementDisplayed(elementId));
  }

  async screenshot(): Promise<string> {
    return String(await this.browser.takeScreenshot());
  }

  async actions(actions: unknown[]): Promise<void> {
    await this.browser.performActions(actions as never);
  }

  async windowRect(): Promise<{ width: number; height: number }> {
    const rect = await this.browser.getWindowRect();
    return { width: Number(rect.width) || 0, height: Number(rect.height) || 0 };
  }
}
