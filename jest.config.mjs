/**
 * Jest runs the same headless suites as Vitest, on the same sources (README → Tests). ESM because the
 * repo is ESM (`"type": "module"`); TypeScript is stripped by Babel — the type-check is a separate
 * step (`npm run test:types`), so this transform stays version-proof and fast.
 *
 *   npm run test:jest
 */
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '\\.e2e\\.test\\.ts$'],
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': ['babel-jest', { presets: [['@babel/preset-typescript', { onlyRemoveTypeImports: true }]] }],
  },
  moduleNameMapper: {
    // The suites import `test` from 'node:test'; under Jest that specifier is the shim.
    '^node:test$': '<rootDir>/test/support/jest-node-test.cjs',
    // TypeScript-style relative imports (`./model.js`) name the file they compile to: drop the extension.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testTimeout: 60_000, // the transactional-loop suite drives real retries (and a capture per retry)
};
