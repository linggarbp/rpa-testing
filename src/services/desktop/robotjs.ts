/**
 * robot.js backend — the fallback driver.
 *
 * robot.js does pointer, keyboard and raw pixel capture through its own prebuilt binding, on all
 * three platforms. It has no clipboard and no image search, so `desktop.*` steps that need those
 * stay with nut.js — this backend exists so a host where nut.js cannot load still drives the OS
 * instead of refusing the whole lane.
 *
 * Capture hands back raw BGRA pixels, which `png.ts` turns into a PNG with the stdlib — no image
 * library, matching how the rest of the toolkit writes its own file formats.
 */
import { writeFile } from 'node:fs/promises';
import type { DesktopBackend, DesktopCapability, DesktopPoint, MouseButton, ScrollDirection } from './backend.js';
import { encodePng } from './png.js';

/** The surface of robot.js this backend uses. */
export interface RobotModule {
  moveMouse(x: number, y: number): void;
  getMousePos(): { x: number; y: number };
  mouseClick(button?: string, double?: boolean): void;
  mouseToggle(state: 'down' | 'up', button?: string): void;
  scrollMouse(x: number, y: number): void;
  typeString(text: string): void;
  keyTap(key: string, modifier?: string | string[]): void;
  getScreenSize(): { width: number; height: number };
  screen: { capture(x?: number, y?: number, width?: number, height?: number): { image: Buffer; width: number; height: number } };
}

const CAPABILITIES: DesktopCapability[] = ['move', 'click', 'scroll', 'keyboard', 'capture'];

/** robot.js modifiers are single words: 'control' | 'shift' | 'alt' | 'command'. */
const MODIFIERS: Record<string, string> = {
  ctrl: 'control',
  control: 'control',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'command',
  cmd: 'command',
  win: 'command',
  super: 'command'
};

export function createRobotjsBackend(robot: RobotModule): DesktopBackend {
  // The display was proved in a child process (see backend.ts); this module only wraps the calls.
  return {
    name: 'robotjs',
    capabilities: new Set(CAPABILITIES),
    detail: `robot.js (pointer, keyboard, capture) on ${process.platform} — no clipboard, no image search`,

    async move(x, y) {
      robot.moveMouse(x, y);
    },
    async position() {
      const at = robot.getMousePos();
      return { x: at.x, y: at.y };
    },
    async click(which, at) {
      if (at) robot.moveMouse(at.x, at.y);
      robot.mouseClick(which === 'right' ? 'right' : 'left');
    },
    async doubleClick(which, at) {
      if (at) robot.moveMouse(at.x, at.y);
      robot.mouseClick(which === 'right' ? 'right' : 'left', true);
    },
    async scroll(direction: ScrollDirection, amount) {
      const step = amount * 120;
      const [dx, dy] = direction === 'up' ? [0, step]
        : direction === 'down' ? [0, -step]
          : direction === 'left' ? [-step, 0]
            : [step, 0];
      robot.scrollMouse(dx, dy);
    },
    async type(text) {
      robot.typeString(text);
    },
    async pressKey(names) {
      const keys = [...names];
      const held: string[] = [];
      while (keys.length > 1 && MODIFIERS[keys[0]!.toLowerCase()]) held.push(MODIFIERS[keys.shift()!.toLowerCase()]!);
      const key = keys.shift() ?? keys[0];
      if (!key) throw new Error('desktop.pressKey needs at least one key name.');
      robot.keyTap(normalizeKey(key), held.length === 1 ? held[0]! : held.length > 1 ? held : undefined);
    },
    async drag(from: DesktopPoint, to: DesktopPoint) {
      robot.moveMouse(from.x, from.y);
      robot.mouseToggle('down');
      robot.moveMouse(to.x, to.y);
      robot.mouseToggle('up');
    },
    async capture(target) {
      const shot = robot.screen.capture();
      await writeFile(target, encodePng(shot.width, shot.height, shot.image));
      return target;
    },
    async findImage(): Promise<never> {
      throw new Error('the robot.js backend has no image search — install nut.js, or use `ocr.recognize` / `ai-vision.decide` here.');
    }
  };
}

/** robot.js key names are lowercase letters, digits, or one of its named keys. */
function normalizeKey(name: string): string {
  const value = name.trim();
  if (value.length === 1) return value.toLowerCase();
  const named = value.toLowerCase();
  const aliases: Record<string, string> = {
    enter: 'enter', return: 'enter', tab: 'tab', escape: 'escape', esc: 'escape', space: 'space',
    backspace: 'backspace', delete: 'delete', up: 'up', down: 'down', left: 'left', right: 'right',
    home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown'
  };
  return aliases[named] ?? named;
}
