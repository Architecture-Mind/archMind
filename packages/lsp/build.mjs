import { build } from "esbuild"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [join(__dirname, "src/server.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: join(__dirname, "dist/lsp.cjs"),
  external: ["tree-sitter", "tree-sitter-php", "tree-sitter-java", "ts-morph"],
  banner: { js: "#!/usr/bin/env node" },
  minify: false,
})

console.log("Done → dist/lsp.cjs")
