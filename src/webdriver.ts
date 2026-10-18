/**
 * A raw WebDriver client — the W3C protocol is JSON over HTTP, so the mobile lane needs no
 * dependency. The same client talks to Appium (mobile), Selenium or chromedriver, because they all
 * speak this protocol; only the subset the `mobile.*` steps use is implemented, and responses are
 * read in their W3C shapes (Appium 2 answers exactly these).
 */
export interface WebDriverStartOptions {
  server: string;
  capabilities: Record<string, unknown>;
  timeoutMs?: number;
}

/** The W3C element key — Appium and Selenium both put the element id here. */
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

/**
 * Capabilities the way Appium 2 demands them: the W3C-standard names stay bare, everything else
 * needs the `appium:` vendor prefix (an unprefixed `deviceName` is rejected outright).
 */
const W3C_STANDARD = new Set([
  'platformName', 'browserName', 'browserVersion', 'acceptInsecureCerts', 'pageLoadStrategy',
  'proxy', 'setWindowRect', 'timeouts', 'unhandledPromptBehavior', 'strictFileInteractability'
]);

export function normalizeCapabilities(capabilities: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(capabilities)) {
    normalized[key.includes(':') || W3C_STANDARD.has(key) ? key : `appium:${key}`] = value;
  }
  return normalized;
}

export class WebDriverClient {
  private sessionId: string | undefined;

  constructor(private readonly server: string, private readonly timeoutMs = 60000) {}

  get id(): string | undefined {
    return this.sessionId;
  }

  static async start(options: WebDriverStartOptions): Promise<WebDriverClient> {
    const client = new WebDriverClient(options.server, options.timeoutMs);
    const response = await client.call('POST', '/session', {
      capabilities: { alwaysMatch: normalizeCapabilities(options.capabilities) }
    });
    const value = response.value as { sessionId?: unknown };
    if (typeof value?.sessionId !== 'string' || value.sessionId === '') {
      throw new Error('WebDriver: the session response carried no sessionId.');
    }
    client.sessionId = value.sessionId;
    return client;
  }

  async end(): Promise<void> {
    if (!this.sessionId) return;
    const session = this.sessionId;
    this.sessionId = undefined;
    await this.call('DELETE', `/session/${session}`).catch(() => {});
  }

  async find(using: string, value: string): Promise<string> {
    const response = await this.call('POST', `/session/${this.sid()}/element`, { using, value });
    const element = response.value as Record<string, unknown>;
    const id = element[ELEMENT_KEY] ?? Object.values(element)[0];
    if (typeof id !== 'string' || id === '') throw new Error(`WebDriver: no element id in the find response for ${using}=${value}`);
    return id;
  }

  async click(elementId: string): Promise<void> {
    await this.call('POST', `/session/${this.sid()}/element/${elementId}/click`, {});
  }

  async clear(elementId: string): Promise<void> {
    await this.call('POST', `/session/${this.sid()}/element/${elementId}/clear`, {});
  }

  async type(elementId: string, text: string): Promise<void> {
    // `text` is the W3C field; `value` rides along for older servers that still read it.
    await this.call('POST', `/session/${this.sid()}/element/${elementId}/value`, { text, value: [...text] });
  }

  async text(elementId: string): Promise<string> {
    const response = await this.call('GET', `/session/${this.sid()}/element/${elementId}/text`);
    return String(response.value ?? '');
  }

  async displayed(elementId: string): Promise<boolean> {
    const response = await this.call('GET', `/session/${this.sid()}/element/${elementId}/displayed`);
    return response.value === true;
  }

  async screenshot(): Promise<string> {
    const response = await this.call('GET', `/session/${this.sid()}/screenshot`);
    return String(response.value ?? '');
  }

  async actions(actions: unknown[]): Promise<void> {
    await this.call('POST', `/session/${this.sid()}/actions`, { actions });
  }

  /** Screen size: the W3C route first, the legacy `/window/size` as fallback. */
  async windowRect(): Promise<{ width: number; height: number }> {
    const session = this.sid();
    try {
      const response = await this.call('GET', `/session/${session}/window/rect`);
      const rect = response.value as { width?: unknown; height?: unknown };
      return { width: Number(rect.width) || 0, height: Number(rect.height) || 0 };
    } catch {
      const response = await this.call('GET', `/session/${session}/window/size`);
      const rect = response.value as { width?: unknown; height?: unknown };
      return { width: Number(rect.width) || 0, height: Number(rect.height) || 0 };
    }
  }

  private sid(): string {
    if (!this.sessionId) throw new Error('mobile: no session yet — run a mobile.session step first.');
    return this.sessionId;
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ value: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.server}${path}`, {
        method,
        ...(body !== undefined
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
        signal: controller.signal
      });
      const raw = await response.text();
      let parsed: { value?: unknown; message?: string } = {};
      try {
        parsed = raw === '' ? {} : (JSON.parse(raw) as typeof parsed);
      } catch {
        throw new Error(`WebDriver ${method} ${path} → ${response.status} (non-JSON response)`);
      }
      if (!response.ok) {
        const value = parsed.value as { message?: string } | undefined;
        const message = value?.message ?? parsed.message ?? raw.slice(0, 200);
        throw new Error(`WebDriver ${method} ${path} → ${response.status}: ${message}`);
      }
      return parsed as { value: unknown };
    } finally {
      clearTimeout(timer);
    }
  }
}
