/**
 * The suites import `test` from 'node:test' — the repo's own runner stays the source of truth, and
 * this file lets Vitest run them unchanged. The specifier is aliased here (see vitest.config.ts):
 * same surface, backed by Vitest.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, test as vitestTest } from 'vitest';

interface NodeTestOptions {
  skip?: boolean | string;
}

type Body = () => void | Promise<void>;

/**
 * `node:test` takes its options as an object — `test(name, { skip: reason }, fn)` — where Vitest
 * spells the same thing `test.skip(...)`. The reason is kept, appended to the name, so the reporter
 * still says why a suite stepped aside.
 */
const test = Object.assign(
  (name: string, optionsOrBody: NodeTestOptions | Body, body?: Body) => {
    const options: NodeTestOptions = typeof optionsOrBody === 'function' ? {} : optionsOrBody;
    const run = (typeof optionsOrBody === 'function' ? optionsOrBody : body) as Body;
    return options.skip ? vitestTest.skip(`${name} — ${options.skip}`, run) : vitestTest(name, run);
  },
  vitestTest,
) as typeof vitestTest;

export default test;
export { test, describe, it, beforeAll, afterAll, beforeEach, afterEach };
