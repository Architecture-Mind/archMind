#!/usr/bin/env node
/**
 * Save a benchmark snapshot to benchmarks/snapshots/<label>.json
 * Usage: npx tsx src/scripts/save-snapshot.ts <label> <graphsJson>
 *
 * For quick runs with current extracted graphs:
 *   node --loader ts-node/esm src/scripts/save-snapshot.ts P2-baseline '{}'
 */
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { writeFileSync, mkdirSync } from "fs"
import { runBenchmark } from "../benchmark.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

const REPO_ROOT   = join(__dirname, "../../../../..")
const GOLDEN_DIR  = join(REPO_ROOT, "research/golden-traces/laravel")
const FIXTURE_DIR = join(REPO_ROOT, "packages/laravel-parser/src/__tests__/fixtures")
const SNAP_DIR    = join(REPO_ROOT, "benchmarks/snapshots")

const label      = process.argv[2] ?? "snapshot"
const graphsJson = process.argv[3] ?? "{}"
const graphs     = JSON.parse(graphsJson) as Record<string, IntermediateExecutionGraph[]>

mkdirSync(SNAP_DIR, { recursive: true })

const snapshot = runBenchmark({ goldenDir: GOLDEN_DIR, fixtureDir: FIXTURE_DIR, graphs, label })
const outPath  = join(SNAP_DIR, `${label}.json`)

writeFileSync(outPath, JSON.stringify(snapshot, null, 2))
console.log(`Saved: ${outPath}`)
console.log(`Summary: recall=${snapshot.summary.avg_r0_recall} compression=${snapshot.summary.avg_compression_r0}x savings=${snapshot.summary.avg_token_savings_r0}%`)
