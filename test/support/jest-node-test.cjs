/**
 * The same shim as vitest-node-test.ts, backed by the globals Jest injects. Jest maps the 'node:test'
 * specifier here (see jest.config.mjs). Plain CJS on purpose: it loads under either module system.
 */
const { test: jestTest, describe, it, beforeAll, beforeEach, afterAll, afterEach } = globalThis;

const test = (name, optionsOrBody, body) => {
  const options = typeof optionsOrBody === 'function' ? {} : optionsOrBody;
  const run = typeof optionsOrBody === 'function' ? optionsOrBody : body;
  return options && options.skip ? jestTest.skip(`${name} — ${options.skip}`, run) : jestTest(name, run);
};

Object.assign(test, jestTest);

module.exports = test;
module.exports.default = test;
module.exports.test = test;
module.exports.describe = describe;
module.exports.it = it;
module.exports.beforeAll = beforeAll;
module.exports.beforeEach = beforeEach;
module.exports.afterAll = afterAll;
module.exports.afterEach = afterEach;
