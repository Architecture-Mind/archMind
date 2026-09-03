/** @type {import('jest').Config} */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  // See packages/laravel-parser/jest.config.js for the full explanation: Jest
  // reuses one worker process across test files in this package, and this
  // package holds a module-level tree-sitter Parser singleton — reusing that
  // native addon across many test files in one process causes intermittent,
  // silently-swallowed parse failures. maxWorkers set well above this
  // package's test file count so every file always gets its own process.
  maxWorkers: 50,
  extensionsToTreatAsEsm: [".ts"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "/__tests__/fixtures/"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {
      useESM: true,
      diagnostics: { ignoreCodes: [151002, 1343] },
    }],
  },
}
