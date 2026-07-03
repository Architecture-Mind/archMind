#!/usr/bin/env node
import { build } from "esbuild"

console.log("Bundling MCP server...")
await build({
  entryPoints: ["src/index.ts"],
  bundle:      true,
  platform:    "node",
  format:      "cjs",
  outfile:     "dist/index.cjs",
  // Native modules + large packages kept as real npm deps
  external: [
    "tree-sitter", "tree-sitter-php", "tree-sitter-java",
    "ts-morph", "typescript",
    // all workspace packages — resolved at runtime via npm install
    "@kidkender/archmind-protocol",
    "@kidkender/archmind-graph-query",
    "@kidkender/archmind-context",
    "@kidkender/archmind-explainer",
    "@kidkender/archmind-protocol",
    "@kidkender/archmind-explainer",
    "@kidkender/archmind-laravel-parser",
    "@kidkender/archmind-nestjs-parser",
    "@kidkender/archmind-retrieval",
    "@kidkender/archmind-runtime-ingest",
    "@kidkender/archmind-runtime-correlator",
  ],
  logLevel: "warning",
})

console.log("Done → dist/index.cjs")
