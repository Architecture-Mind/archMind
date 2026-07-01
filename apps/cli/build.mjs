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
  // Native modules cannot be bundled — mark as external
  external: [
    "tree-sitter",
    "tree-sitter-php",
    "tree-sitter-java",
  ],
  logLevel: "warning",
})

console.log("Done → dist/index.cjs")
