import { join } from "path"
import {
  captureTopologyBaseline,
  verifyTopologyBaseline,
  saveTopologyBaseline,
  loadTopologyBaseline,
} from "@kidkender/archmind-retrieval"
import { parseProject, requireProject } from "../utils/parse-project.js"

export function runBaseline(subcommand: string | undefined, flags: Record<string, string>): void {
  if (subcommand !== "update" && subcommand !== "verify") {
    console.error("Usage: archmind baseline update|verify --project <path> [--label <name>] [--baseline-dir <path>]")
    process.exit(2)
  }

  const projectRoot  = requireProject(flags)
  const label        = flags["label"] ?? "topology-main"
  const BASELINE_DIR = flags["baseline-dir"] ?? join(projectRoot, ".archmind", "baselines")

  const { graphs, routeCount, fileCount } = parseProject(projectRoot)
  console.log(`Parsed ${routeCount} routes from ${fileCount} file(s)`)

  const current = captureTopologyBaseline({ graphs, label, projectRoot })

  if (subcommand === "update") {
    const out = saveTopologyBaseline(current, BASELINE_DIR)
    console.log(`Baseline saved: ${out}`)
    process.exit(0)
  }

  const stored = loadTopologyBaseline(BASELINE_DIR, label)
  if (!stored) {
    console.log(`No baseline found. Run "archmind baseline update" first.`)
    process.exit(0)
  }

  const result = verifyTopologyBaseline(current, stored)

  if (result.removed_routes.length > 0) {
    console.error(`Removed routes: ${result.removed_routes.join(", ")}`)
  }
  if (result.new_routes.length > 0) {
    console.log(`New routes (${result.new_routes.length}): ${result.new_routes.join(", ")}`)
  }

  const regressions = result.drifts.filter((d) => d.changed)
  for (const d of regressions) {
    console.error(`REGRESSION: ${d.route}`)
    if (d.lost_types.length > 0) console.error(`  lost: [${d.lost_types.join(", ")}]`)
    const dangerGained = d.gained_types.filter((t) => ["unscoped_write", "unscoped_query"].includes(t))
    if (dangerGained.length > 0) console.error(`  danger appeared: [${dangerGained.join(", ")}]`)
  }

  if (result.ok) {
    const stable = routeCount - result.drifts.length - result.new_routes.length - result.removed_routes.length
    console.log(`PASSED — ${stable}/${routeCount} routes stable`)
    process.exit(0)
  } else {
    console.error(`FAILED — ${regressions.length} regression(s)`)
    process.exit(1)
  }
}
