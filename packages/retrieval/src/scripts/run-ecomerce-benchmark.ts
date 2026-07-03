#!/usr/bin/env node
/**
 * Multi-project benchmark: ecomerce-api
 *
 * Proves ArchMind generalises beyond the original tenant-workspace-api fixture.
 * Parses ecomerce-api from source (uses inferProjectConfig — zero-config, no
 * .archmind.json required), then scores against golden traces in
 * research/golden-traces/ecomerce-api/.
 *
 * Usage (from repo root):
 *   node --loader ts-node/esm packages/retrieval/src/scripts/run-ecomerce-benchmark.ts \
 *     <ecomerce-api-root> [label]
 *
 * Example:
 *   node --loader ts-node/esm packages/retrieval/src/scripts/run-ecomerce-benchmark.ts \
 *     "C:/Users/Admin/Desktop/DuckCode/New folder/ecomerce-api" ecomerce-baseline
 */
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from "fs"
import yaml from "js-yaml"
import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from "@kidkender/archmind-laravel-parser"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { runBenchmark } from "../benchmark.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

const REPO_ROOT  = join(__dirname, "../../../..")
const GOLDEN_DIR = join(REPO_ROOT, "research/golden-traces/ecomerce-api")
const SNAP_DIR   = join(REPO_ROOT, "benchmarks/snapshots")

const projectRoot = process.argv[2]
const label       = process.argv[3] ?? "ecomerce-baseline"

if (!projectRoot) {
  console.error("Usage: run-ecomerce-benchmark.ts <ecomerce-api-root> [label]")
  process.exit(1)
}

// ---- Extract graphs from the real project --------------------------------

console.log(`Parsing project: ${projectRoot}`)
const config = loadProjectConfig(projectRoot)
console.log(`Config — routeFiles: ${config.routeFiles.join(", ")}`)
console.log(`Config — namespaces: ${JSON.stringify(config.namespaces)}`)

const { aliasMap, routeFiles } = resolveAliasMap(projectRoot, config)
console.log(`Resolved routeFiles: ${routeFiles.join(", ")}`)

const allGraphs: IntermediateExecutionGraph[] = []
for (const relFile of routeFiles) {
  const skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap })
  for (const g of skeletons) {
    allGraphs.push(augmentGraph(g, { projectRoot, config }))
  }
}

console.log(`Extracted ${allGraphs.length} execution graphs`)
allGraphs.forEach((g) => console.log(`  ${g.entrypoint} — ${g.nodes.length} nodes`))

// ---- Map all graphs to each golden trace ID ----------------------------
// The benchmark runner picks the right graph by entrypoint match inside the array.
// All ecomerce-api traces share the same extracted graph pool.

const traceIds = readdirSync(GOLDEN_DIR)
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => (yaml.load(readFileSync(join(GOLDEN_DIR, f), "utf-8")) as { id: string }).id)

const graphs: Record<string, IntermediateExecutionGraph[]> = {}
for (const id of traceIds) {
  graphs[id] = allGraphs
}

// ---- Run benchmark -------------------------------------------------------

const snapshot = runBenchmark({
  goldenDir:  GOLDEN_DIR,
  fixtureDir: projectRoot,  // naive RAG reads real source files from the project
  graphs,
  label,
})

mkdirSync(SNAP_DIR, { recursive: true })
const outPath = join(SNAP_DIR, `${label}.json`)
writeFileSync(outPath, JSON.stringify(snapshot, null, 2))

console.log(`\nSaved: ${outPath}`)
console.log(`Summary:`)
console.log(`  avg_r0_recall    = ${snapshot.summary.avg_r0_recall}`)
console.log(`  avg_compression  = ${snapshot.summary.avg_compression_r0}x`)
console.log(`  token_savings    = ${snapshot.summary.avg_token_savings_r0}%`)
console.log(`  total_traces     = ${snapshot.summary.total_traces}`)
console.log(`\nPer-trace:`)
for (const [id, t] of Object.entries(snapshot.traces)) {
  const gap = t.recall_gap_reason !== "ok" ? ` [${t.recall_gap_reason}]` : ""
  console.log(`  ${id}: recall=${t.r0_recall} compression=${t.compression_r0}x savings=${t.token_savings_r0}%${gap}`)
}
