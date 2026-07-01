#!/usr/bin/env node
import { build } from "esbuild"

// esbuild handles TypeScript transpilation — tsc is for type checks only (run separately)
console.log("Bundling...")
await build({
  entryPoints: ["src/index.ts"],
  bundle:      true,
  platform:    "node",
  format:      "cjs",
  outfile:     "dist/index.cjs",
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Native modules and workspace packages — resolved at runtime via npm install
  external: [
    "tree-sitter", "tree-sitter-php", "tree-sitter-java",
    "@archmind/explainer",
    "@archmind/laravel-parser",
    "@archmind/nestjs-parser",
    "@archmind/llm-client",
    "@archmind/orchestrator",
    "@archmind/protocol",
    "@archmind/retrieval",
    "@archmind/scorer",
    "@kidkender/archmind-protocol",
  ],
  logLevel: "warning",
})

console.log("Done → dist/index.cjs")
