/**
 * nut.js backend — the default desktop driver.
 *
 * nut.js is the one desktop library that covers mouse, keyboard, screen, clipboard, windows and
 * image search with prebuilt native bindings on Windows, Linux and macOS, and it is the only lane
 * the project maintains itself (see docs/desktop-backends.md). Everything the engine needs is
 * reached through this file, so a second backend can replace it without touching the engine.
 *
 * The probe is real: the module is asked for the screen width, which forces the native addon to
 * answer. A host where the addon loads but no display answers (headless, no session) is reported
 * as unavailable with that reason instead of failing later inside a step.
 */
import type {
  DesktopBackend,
  DesktopCapability,
  DesktopPoint,
  MouseButton,
  ScrollDirection,
  ScreenBox
} from './backend.js';

/** The surface of nut.js this backend uses. Typed loosely on purpose: it is an optional module. */
export interface NutModule {
  mouse: {
    setPosition(point: unknown): Promise<void>;
    getPosition(): Promise<{ x: number; y: number }>;
    click(button: unknown): Promise<void>;
    doubleClick(button: unknown): Promise<void>;
    scrollUp(amount: number): Promise<void>;
    scrollDown(amount: number): Promise<void>;
    scrollLeft(amount: number): Promise<void>;
    scrollRight(amount: number): Promise<void>;
    drag(points: unknown[]): Promise<void>;
  };
  keyboard: {
    type(text: string): Promise<void>;
    pressKey(...keys: unknown[]): Promise<void>;
  };
  screen: {
    width(): Promise<number>;
    height(): Promise<number>;
    capture(fileName: string, fileFormat?: unknown, filePath?: string): Promise<string>;
    waitFor(image: string, timeout?: number, config?: unknown, params?: unknown): Promise<ScreenBox>;
  };
  clipboard: { setContent(text: string): Promise<void> };
  Point: new (x: number, y: number) => unknown;
  Button: { LEFT: unknown; RIGHT: unknown };
  Key: Record<string, unknown>;
  getActiveWindow?: () => Promise<{ title: string; region: ScreenBox }>;
  getWindows?: () => Promise<Array<{ title: string; region: ScreenBox }>>;
}

const CAPABILITIES: DesktopCapability[] = ['move', 'click', 'scroll', 'keyboard', 'clipboard', 'capture', 'image'];

export async function createNutjsBackend(nut: NutModule): Promise<DesktopBackend> {
  // Availability was proved in a child process (see backend.ts) so a broken display cannot abort
  // this one; nothing here touches the display until a step asks for it.
  const point = (at: DesktopPoint) => new nut.Point(at.x, at.y);
  const button = (which: MouseButton) => (which === 'right' ? nut.Button.RIGHT : nut.Button.LEFT);

  return {
    name: 'nutjs',
    capabilities: new Set(CAPABILITIES),
    detail: `nut.js (mouse, keyboard, screen, clipboard, image search) on ${process.platform}`,

    async move(x, y) {
      await nut.mouse.setPosition(point({ x, y }));
    },
    async position() {
      const at = await nut.mouse.getPosition();
      return { x: at.x, y: at.y };
    },
    async click(which, at) {
      if (at) await nut.mouse.setPosition(point(at));
      await nut.mouse.click(button(which));
    },
    async doubleClick(which, at) {
      if (at) await nut.mouse.setPosition(point(at));
      await nut.mouse.doubleClick(button(which));
    },
    async scroll(direction: ScrollDirection, amount) {
      if (direction === 'up') await nut.mouse.scrollUp(amount);
      else if (direction === 'down') await nut.mouse.scrollDown(amount);
      else if (direction === 'left') await nut.mouse.scrollLeft(amount);
      else await nut.mouse.scrollRight(amount);
    },
    async type(text) {
      await nut.keyboard.type(text);
    },
    async pressKey(names) {
      const keys = names.map(name => nut.Key[name]);
      if (keys.some(key => key === undefined)) {
        throw new Error(`unknown key name(s): ${names.filter(name => nut.Key[name] === undefined).join(', ')}`);
      }
      await nut.keyboard.pressKey(...keys);
    },
    async drag(from, to) {
      await nut.mouse.drag([point(from), point(to)]);
    },
    async clipboardWrite(text) {
      await nut.clipboard.setContent(text);
    },
    async capture(target) {
      const directory = target.includes('/') || target.includes('\\') ? target.replace(/[^/\\]*$/, '') : undefined;
      const name = target.replace(/^.*[/\\]/, '').replace(/\.png$/i, '');
      return nut.screen.capture(name, undefined, directory || undefined);
    },
    async findImage(imagePath, options = {}) {
      const params = options.threshold !== undefined ? { confidence: options.threshold } : undefined;
      return nut.screen.waitFor(imagePath, options.timeoutMs ?? 10000, undefined, params);
    }
  };
}
