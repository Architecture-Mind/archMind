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
    "@kidkender/archmind-explainer",
    "@kidkender/archmind-laravel-parser",
    "@kidkender/archmind-nestjs-parser",
    "@kidkender/archmind-go-parser",
    "@kidkender/archmind-llm-client",
    "@kidkender/archmind-orchestrator",
    "@kidkender/archmind-protocol",
    "@kidkender/archmind-retrieval",
    "@kidkender/archmind-scorer",
    "@kidkender/archmind-protocol",
  ],
  logLevel: "warning",
})

console.log("Done → dist/index.cjs")
