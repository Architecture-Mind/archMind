#!/usr/bin/env node
/**
 * Retrieval baseline management CLI.
 *
 * Usage:
 *   node manage-baseline.ts --update            Save current retrieval as new baseline
 *   node manage-baseline.ts --verify            Compare current retrieval against stored baseline
 *   node manage-baseline.ts --label <name>      Baseline label (default: "retrieval-main")
 *
 * The baseline is stored at benchmarks/baselines/<label>.json
 *
 * Exit codes:
 *   0 — verify passed (no meaningful drift) or update succeeded
 *   1 — verify failed (drift detected or baseline missing)
 */
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { augmentGraph } from "@kidkender/archmind-laravel-parser"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import {
  captureBaseline,
  verifyBaseline,
  saveBaseline,
  loadBaseline,
} from "../retrieval-baseline.js"

const __filename  = fileURLToPath(import.meta.url)
const __dirname   = dirname(__filename)
const REPO_ROOT   = join(__dirname, "../../../..")
const GOLDEN_DIR  = join(REPO_ROOT, "research/golden-traces/laravel")
const FIXTURE_DIR = join(REPO_ROOT, "packages/laravel-parser/src/__tests__/fixtures")
const BASELINE_DIR = join(REPO_ROOT, "benchmarks/baselines")

// ---- Parse args ----------------------------------------------------------

const args   = process.argv.slice(2)
const mode   = args.includes("--update") ? "update"
             : args.includes("--verify") ? "verify"
             : null
const labelIdx = args.indexOf("--label")
const label    = labelIdx >= 0 ? (args[labelIdx + 1] ?? "retrieval-main") : "retrieval-main"

if (!mode) {
  console.error("Usage: manage-baseline.ts --update | --verify [--label <name>]")
  process.exit(1)
}

// ---- Build graphs --------------------------------------------------------

function buildGraphs(): Record<string, IntermediateExecutionGraph[]> {
  const skeletons: Record<string, IntermediateExecutionGraph> = {
    "LARAVEL-AUTH-001": {
      entrypoint: "PUT /tasks/{task}", method: "PUT", path: "/tasks/{task}",
      nodes: [
        { id: "mw_0", type: "authentication_gate", symbol: "auth:sanctum",            role: "authentication" },
        { id: "mw_1", type: "middleware",           symbol: "ResolveTenant::handle",   role: "middleware",    file: "app/Http/Middleware/ResolveTenant.php" },
        { id: "mw_2", type: "authorization_check",  symbol: "CheckPermission::handle", role: "authorization", file: "app/Http/Middleware/CheckPermission.php", args: ["task.update"] },
        { id: "ctrl", type: "controller_action",    symbol: "TaskController::update",  role: "handler",       file: "app/Modules/Task/Http/Controllers/TaskController.php" },
      ],
      edges: [
        { from: "mw_0", to: "mw_1", relation: "next_middleware", traceability: "static" },
        { from: "mw_1", to: "mw_2", relation: "next_middleware", traceability: "static" },
        { from: "mw_2", to: "ctrl", relation: "next_middleware", traceability: "static" },
      ],
      annotations: [],
    },
    "LARAVEL-AUTH-002": {
      entrypoint: "DELETE /tasks/{task}", method: "DELETE", path: "/tasks/{task}",
      nodes: [
        { id: "mw_0", type: "authentication_gate", symbol: "auth:sanctum",            role: "authentication" },
        { id: "mw_1", type: "middleware",           symbol: "ResolveTenant::handle",   role: "middleware",    file: "app/Http/Middleware/ResolveTenant.php" },
        { id: "mw_2", type: "authorization_check",  symbol: "CheckPermission::handle", role: "authorization", file: "app/Http/Middleware/CheckPermission.php", args: ["task.delete"] },
        { id: "ctrl", type: "controller_action",    symbol: "TaskController::destroy", role: "handler",       file: "app/Modules/Task/Http/Controllers/TaskController.php" },
      ],
      edges: [
        { from: "mw_0", to: "mw_1", relation: "next_middleware", traceability: "static" },
        { from: "mw_1", to: "mw_2", relation: "next_middleware", traceability: "static" },
        { from: "mw_2", to: "ctrl", relation: "next_middleware", traceability: "static" },
      ],
      annotations: [],
    },
    "LARAVEL-VALIDATION-001": {
      entrypoint: "PUT /tasks/{task}", method: "PUT", path: "/tasks/{task}",
      nodes: [
        { id: "mw_2", type: "authorization_check", symbol: "CheckPermission::handle", role: "authorization", file: "app/Http/Middleware/CheckPermission.php" },
        { id: "ctrl", type: "controller_action",   symbol: "TaskController::update",  role: "handler",       file: "app/Modules/Task/Http/Controllers/TaskController.php" },
      ],
      edges: [
        { from: "mw_2", to: "ctrl", relation: "next_middleware", traceability: "static" },
      ],
      annotations: [],
    },
  }

  const out: Record<string, IntermediateExecutionGraph[]> = {}
  for (const [id, skeleton] of Object.entries(skeletons)) {
    out[id] = [augmentGraph(skeleton, { projectRoot: FIXTURE_DIR })]
  }
  return out
}

// ---- Main ----------------------------------------------------------------

const graphs  = buildGraphs()
const current = captureBaseline({ goldenDir: GOLDEN_DIR, fixtureDir: FIXTURE_DIR, graphs, label })

if (mode === "update") {
  const outPath = saveBaseline(current, BASELINE_DIR)
  console.log(`Baseline saved: ${outPath}`)
  console.log(`Traces captured: ${Object.keys(current.entries).length}`)
  for (const [id, e] of Object.entries(current.entries)) {
    console.log(`  ${id.padEnd(28)} recall=${e.recall}  nodes=${e.node_count}  compression=${e.compression_ratio}x`)
  }
  process.exit(0)
}

// mode === "verify"
const stored = loadBaseline(BASELINE_DIR, label)
if (!stored) {
  console.error(`No baseline found at benchmarks/baselines/${label}.json`)
  console.error("Run with --update first to create a baseline.")
  process.exit(1)
}

const result = verifyBaseline(current, stored)

if (result.ok) {
  console.log(`Baseline verify PASSED (${label}) — no meaningful drift detected`)
  process.exit(0)
} else {
  console.error(`Baseline verify FAILED (${label}) — drift detected:`)
  for (const d of result.drifts.filter((x) => x.changed)) {
    console.error(`  ${d.golden_id}:`)
    for (const detail of d.details) {
      console.error(`    - ${detail}`)
    }
  }
  console.error("\nIf this drift is intentional, run with --update to accept the new baseline.")
  process.exit(1)
}
