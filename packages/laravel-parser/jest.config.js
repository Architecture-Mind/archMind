/** @type {import('jest').Config} */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  // Force one worker process per test file. This package's parsers each hold a
  // module-level tree-sitter Parser singleton; when Jest reuses a worker process
  // across multiple test files, the native addon gets re-imported into that same
  // process and tree-sitter's parse() intermittently throws — silently swallowed
  // by each parser's `catch { return emptyDefaults }`, producing nondeterministic
  // "found nothing" failures. Verified in plain Node (no Jest) this never happens
  // even under 500 heavy repeated parses of the same singleton — it's a Jest
  // worker-reuse artifact, not a tree-sitter reliability bug. maxWorkers set
  // comfortably above the current test file count so growth doesn't reintroduce it.
  maxWorkers: 50,
  extensionsToTreatAsEsm: [".ts"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
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
