#!/usr/bin/env node
/**
 * Execution topology regression CLI.
 *
 * Parses a real Laravel project, captures the execution topology of every
 * route, and compares it against a stored baseline. Flags routes that lost
 * critical node types (transaction_boundary, auth, tenant scope, etc.).
 *
 * Usage:
 *   node topology-diff.js --project <path> --update [--label <name>]
 *   node topology-diff.js --project <path> --verify [--label <name>]
 *
 * Required:
 *   --project <path>     Absolute path to a Laravel project root
 *   --update | --verify  Mode
 *
 * Optional:
 *   --label <name>       Baseline label / filename (default: topology-main)
 *
 * Exit codes:
 *   0 — verify passed (no regressions) or update succeeded
 *   1 — verify failed (topology regression detected or route removed)
 *   2 — no stored baseline found on --verify (informational, exits 0)
 *
 * Baselines are stored at: benchmarks/topology-baselines/<label>.json
 */
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import {
  parseRouteFile,
  augmentGraph,
  loadProjectConfig,
  resolveAliasMap,
} from "@kidkender/archmind-laravel-parser"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import {
  captureTopologyBaseline,
  verifyTopologyBaseline,
  saveTopologyBaseline,
  loadTopologyBaseline,
  DANGER_NODE_TYPES,
} from "../topology-baseline.js"

const __filename   = fileURLToPath(import.meta.url)
const __dirname    = dirname(__filename)
const REPO_ROOT    = join(__dirname, "../../../..")
const BASELINE_DIR = join(REPO_ROOT, "benchmarks/topology-baselines")

// ---- Parse args ----------------------------------------------------------

function argAfter(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : undefined
}

const projectRoot = argAfter("--project")
const label       = argAfter("--label") ?? "topology-main"
const mode        = process.argv.includes("--update") ? "update"
                  : process.argv.includes("--verify") ? "verify"
                  : null

if (!mode || !projectRoot) {
  console.error(
    "Usage: topology-diff.js --project <path> --update | --verify [--label <name>]"
  )
  process.exit(1)
}

// ---- Parse project -------------------------------------------------------

console.log(`Parsing project: ${projectRoot}`)
const config   = loadProjectConfig(projectRoot)
const { aliasMap, routeFiles } = resolveAliasMap(projectRoot, config)

const allGraphs: IntermediateExecutionGraph[] = []
for (const relFile of routeFiles) {
  const skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap })
  for (const g of skeletons) {
    allGraphs.push(augmentGraph(g, { projectRoot, config }))
  }
}
console.log(`Extracted ${allGraphs.length} execution graphs from ${routeFiles.length} route file(s)`)
console.log()

// ---- Capture current topology -------------------------------------------

const current = captureTopologyBaseline({ graphs: allGraphs, label, projectRoot })
const routeCount = Object.keys(current.entries).length
console.log(`Routes captured: ${routeCount}`)

// ---- Update mode ---------------------------------------------------------

if (mode === "update") {
  const outPath = saveTopologyBaseline(current, BASELINE_DIR)
  console.log(`Topology baseline saved: ${outPath}`)
  console.log()
  console.log("Route summary:")
  for (const [route, entry] of Object.entries(current.entries)) {
    const types = entry.critical_node_types.length > 0
      ? entry.critical_node_types.join(", ")
      : "(none)"
    console.log(`  ${route.padEnd(50)} [${types}]`)
  }
  process.exit(0)
}

// ---- Verify mode ---------------------------------------------------------

const stored = loadTopologyBaseline(BASELINE_DIR, label)
if (!stored) {
  console.log(`No stored baseline found at benchmarks/topology-baselines/${label}.json`)
  console.log("Run with --update first. Exiting without error (first-run grace).")
  process.exit(0)
}

const result = verifyTopologyBaseline(current, stored)

// Print new routes (informational)
if (result.new_routes.length > 0) {
  console.log(`New routes (${result.new_routes.length}) — not in baseline:`)
  for (const r of result.new_routes) console.log(`  + ${r}`)
  console.log()
}

// Print removed routes (regression)
if (result.removed_routes.length > 0) {
  console.error(`Removed routes (${result.removed_routes.length}) — present in baseline but gone:`)
  for (const r of result.removed_routes) console.error(`  - ${r}`)
  console.error()
}

// Print topology drifts
if (result.drifts.length > 0) {
  const regressions = result.drifts.filter((d) => d.changed)
  const additions   = result.drifts.filter((d) => !d.changed)

  if (regressions.length > 0) {
    console.error(`Topology regressions (${regressions.length} route(s)):`)
    for (const d of regressions) {
      console.error(`  ${d.route}`)
      if (d.lost_types.length > 0) {
        console.error(`    lost:   [${d.lost_types.join(", ")}]`)
      }
      const dangerGained = d.gained_types.filter((t) => DANGER_NODE_TYPES.includes(t))
      const safeGained   = d.gained_types.filter((t) => !DANGER_NODE_TYPES.includes(t))
      if (dangerGained.length > 0) {
        console.error(`    danger: [${dangerGained.join(", ")}] — dangerous type appeared`)
      }
      if (safeGained.length > 0) {
        console.error(`    gained: [${safeGained.join(", ")}]`)
      }
    }
    console.error()
  }

  if (additions.length > 0) {
    console.log(`Topology additions (${additions.length} route(s) gained node types — informational):`)
    for (const d of additions) {
      console.log(`  ${d.route}: gained [${d.gained_types.join(", ")}]`)
    }
    console.log()
  }
}

// Summary
const stable = routeCount - result.drifts.length - result.new_routes.length - result.removed_routes.length
if (result.ok) {
  console.log(`Topology verify PASSED (${label}) — ${stable}/${routeCount} routes stable`)
  if (result.new_routes.length > 0) {
    console.log(`  (${result.new_routes.length} new route(s) not yet in baseline — run --update to accept)`)
  }
  process.exit(0)
} else {
  console.error(`Topology verify FAILED (${label})`)
  console.error(`  Stable: ${stable}  Drifted: ${result.drifts.filter((d) => d.changed).length}  Removed: ${result.removed_routes.length}`)
  console.error()
  console.error("If this drift is intentional, run with --update to accept the new baseline.")
  process.exit(1)
}
