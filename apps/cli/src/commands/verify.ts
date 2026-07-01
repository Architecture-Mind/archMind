import { join } from "path"
import {
  captureTopologyBaseline,
  verifyTopologyBaseline,
  saveTopologyBaseline,
  loadTopologyBaseline,
  DANGER_NODE_TYPES,
} from "@archmind/retrieval"
import { parseProject, requireProject } from "../utils/parse-project.js"

// Constraints are optional — loaded dynamically so the CLI works without the package.
function tryCheckConstraints(
  projectRoot: string,
  graphs: unknown[],
): { ok: boolean; report: string } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@kidkender/archmind-constraints")
    const config = mod.loadConstraints(projectRoot)
    if (!config) return null
    const report = mod.checkConstraints(config, graphs)
    return { ok: report.ok, report: formatConstraintReport(report) }
  } catch {
    return null   // package not installed — silently skip
  }
}

function formatConstraintReport(report: {
  ok: boolean
  violations: Array<{ rule: { name: string; severity: string; message?: string }; routes: string[] }>
  total_violations: number
  checked: number
}): string {
  const lines: string[] = []
  if (report.ok) {
    lines.push(`Constraints: PASSED — ${report.checked} rule(s) satisfied`)
    return lines.join("\n")
  }
  lines.push(`Constraint violations (${report.violations.length} rule(s), ${report.total_violations} route(s)):`)
  for (const v of report.violations) {
    const msg = v.rule.message ? ` — ${v.rule.message}` : ""
    lines.push(`  [${v.rule.severity}] ${v.rule.name}${msg}`)
    for (const route of v.routes) {
      lines.push(`    ${route}`)
    }
  }
  return lines.join("\n")
}

export async function runVerify(flags: Record<string, string>): Promise<void> {
  const projectRoot  = requireProject(flags)
  const label        = flags["label"] ?? "topology-main"
  const mode         = flags["update"] !== undefined ? "update" : "verify"
  // Default: store baseline inside the project being analyzed so it can be committed to that repo
  const BASELINE_DIR = flags["baseline-dir"] ?? join(projectRoot, ".archmind", "baselines")

  console.log(`Parsing: ${projectRoot}`)
  const { graphs, routeCount, fileCount } = parseProject(projectRoot)
  console.log(`Parsed ${routeCount} routes from ${fileCount} file(s)\n`)

  const current = captureTopologyBaseline({ graphs, label, projectRoot })

  if (mode === "update") {
    const out = saveTopologyBaseline(current, BASELINE_DIR)
    console.log(`Baseline saved: ${out}`)
    console.log(`Routes: ${routeCount}`)
    for (const [route, entry] of Object.entries(current.entries)) {
      const types = entry.critical_node_types.length > 0
        ? entry.critical_node_types.join(", ")
        : "(none)"
      console.log(`  ${route.padEnd(55)} [${types}]`)
    }
    process.exit(0)
  }

  const stored = loadTopologyBaseline(BASELINE_DIR, label)
  if (!stored) {
    console.log(`No baseline found at benchmarks/topology-baselines/${label}.json`)
    console.log("Run with --update to create one.")
    process.exit(0)
  }

  const result = verifyTopologyBaseline(current, stored)

  if (result.new_routes.length > 0) {
    console.log(`New routes (${result.new_routes.length}) — not in baseline:`)
    result.new_routes.forEach((r) => console.log(`  + ${r}`))
    console.log()
  }

  if (result.removed_routes.length > 0) {
    console.error(`Removed routes (${result.removed_routes.length}):`)
    result.removed_routes.forEach((r) => console.error(`  - ${r}`))
    console.error()
  }

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
        if (dangerGained.length > 0) {
          console.error(`    danger: [${dangerGained.join(", ")}]`)
        }
      }
      console.error()
    }

    if (additions.length > 0) {
      console.log(`Informational additions (${additions.length} route(s)):`)
      additions.forEach((d) => console.log(`  ${d.route}: gained [${d.gained_types.join(", ")}]`))
      console.log()
    }
  }

  const stable = routeCount - result.drifts.length - result.new_routes.length - result.removed_routes.length

  // --- Architecture Constraints (optional) ---
  const constraintResult = tryCheckConstraints(projectRoot, graphs)
  if (constraintResult) {
    if (constraintResult.ok) {
      console.log(constraintResult.report)
    } else {
      console.error(constraintResult.report)
    }
    console.log()
  }

  const failed = !result.ok || (constraintResult !== null && !constraintResult.ok)

  if (!failed) {
    console.log(`PASSED (${label}) — ${stable}/${routeCount} routes stable`)
    if (result.new_routes.length > 0) {
      console.log(`  (${result.new_routes.length} new route(s) — run with --update to accept)`)
    }
    process.exit(0)
  } else {
    if (!result.ok) {
      console.error(`FAILED (${label})`)
      console.error(`  Stable: ${stable}  Regressions: ${result.drifts.filter((d) => d.changed).length}  Removed: ${result.removed_routes.length}`)
      console.error()
      console.error("Run with --update to accept the new baseline if this drift is intentional.")
    } else {
      console.error("FAILED — architecture constraint violations detected.")
    }
    process.exit(1)
  }
}
