import { build } from "esbuild"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [join(__dirname, "src/index.ts")],
  bundle:   true,
  platform: "node",
  format:   "cjs",
  outfile:  join(__dirname, "dist/analysis.cjs"),
  external: [
    "tree-sitter", "tree-sitter-php", "tree-sitter-java", "ts-morph",
    "@kidkender/archmind-protocol",
    "@kidkender/archmind-laravel-parser",
    "@kidkender/archmind-nestjs-parser",
    "@kidkender/archmind-springboot-parser",
    "@kidkender/archmind-go-parser",
  ],
  minify:   false,
})

console.log("Done → dist/analysis.cjs")
