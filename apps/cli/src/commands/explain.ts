import { explain as detectFindings, traceByPattern } from "@archmind/explainer"
import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { parseProject, requireProject } from "../utils/parse-project.js"

interface RequestStep {
  nodeId: string
  symbol: string
  type:   string
  role:   string
}

interface RequestTraceEntry {
  entrypoint:     string
  execution_path: RequestStep[]
}

// ---------------------------------------------------------------------------
// Entrypoint matching (same normalisation as benchmark)
// ---------------------------------------------------------------------------

function findGraph(
  graphs: IntermediateExecutionGraph[],
  entrypoint: string,
): IntermediateExecutionGraph | undefined {
  const norm = entrypoint.trim().toLowerCase()
  const exact = graphs.find((g) => g.entrypoint.toLowerCase() === norm)
  if (exact) return exact

  const [method, ...pathParts] = norm.split(" ")
  const path = pathParts.join(" ").replace(/\{[^}]+\}/g, "{_}")

  return graphs.find((g) => {
    const [gm, ...gp] = g.entrypoint.toLowerCase().split(" ")
    const gpath = gp.join(" ").replace(/\{[^}]+\}/g, "{_}")
    return gm === method && gpath === path
  })
}

// ---------------------------------------------------------------------------
// Render execution path as a vertical chain
// ---------------------------------------------------------------------------

function renderPath(entry: RequestTraceEntry): void {
  console.log(`\nExecution Path — ${entry.entrypoint}`)
  console.log("─".repeat(60))
  const path = entry.execution_path
  for (let i = 0; i < path.length; i++) {
    const step = path[i]
    const roleLabel = step.role ? `  [${step.role}]` : ""
    if (i === 0) {
      console.log(`  ${step.symbol}${roleLabel}`)
    } else {
      console.log(`  ↓`)
      console.log(`  ${step.symbol}${roleLabel}`)
    }
  }

  if (path.length === 0) {
    console.log("  (no nodes in execution path)")
  }
}

// ---------------------------------------------------------------------------
// Render finding detail
// ---------------------------------------------------------------------------

function renderFinding(
  route: string,
  finding: ReturnType<typeof detectFindings>[number],
): void {
  const SEVERITY_ICON: Record<string, string> = {
    CRITICAL: "✘",
    HIGH:     "!",
    MEDIUM:   "~",
    LOW:      "·",
    INFO:     " ",
  }

  const icon = SEVERITY_ICON[finding.severity] ?? " "
  console.log(`\n${icon} ${finding.type}  [${finding.severity}]  confidence=${finding.confidence}`)
  console.log(`  Route:   ${route}`)
  console.log(`  Summary: ${finding.summary}`)

  if (finding.evidence && finding.evidence.length > 0) {
    console.log(`\n  Evidence:`)
    for (const ev of finding.evidence) {
      console.log(`    ${ev.nodeId}: ${ev.description}`)
    }
  }

  if (finding.recommendations && finding.recommendations.length > 0) {
    console.log(`\n  Recommendations:`)
    for (const rec of finding.recommendations) {
      console.log(`    • ${rec}`)
    }
  }

  if (finding.uncertainty && finding.uncertainty.length > 0) {
    console.log(`\n  Uncertainty:`)
    for (const u of finding.uncertainty) {
      console.log(`    ? ${u.kind}: ${"description" in u ? u.description : ""}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export function runExplain(flags: Record<string, string>): void {
  const projectRoot = requireProject(flags)
  const routeFilter = flags["route"]
  const findingType = flags["finding"]

  if (!routeFilter && !findingType) {
    console.error("Error: --route <entrypoint> or --finding <type> is required")
    console.error("  archmind explain --project . --route \"POST /orders\"")
    console.error("  archmind explain --project . --finding missing_authorization")
    process.exit(2)
  }

  const { graphs } = parseProject(projectRoot)

  // ---- --route mode: show execution path ------------------------------------
  if (routeFilter && !findingType) {
    const graph = findGraph(graphs, routeFilter)
    if (!graph) {
      console.error(`Route not found: ${routeFilter}`)
      console.error(`Run "archmind trace --project ${projectRoot}" to list available routes.`)
      process.exit(1)
    }

    const result = traceByPattern("request", graphs, graph.entrypoint)
    const entry  = (result.results as RequestTraceEntry[])[0]
    if (!entry) {
      console.error(`No execution path built for: ${routeFilter}`)
      process.exit(1)
    }
    renderPath(entry)

    // also show findings for this route
    const findings = detectFindings(graph)
    if (findings.length > 0) {
      console.log(`\nFindings (${findings.length}):`)
      for (const f of findings) {
        renderFinding(graph.entrypoint, f)
      }
    } else {
      console.log("\nNo findings for this route.")
    }
    return
  }

  // ---- --finding mode: show all routes with this finding type ---------------
  if (findingType) {
    const needle = findingType.toLowerCase()
    const hits: Array<{ route: string; finding: ReturnType<typeof detectFindings>[number] }> = []

    for (const graph of graphs) {
      const findings = detectFindings(graph)
      for (const f of findings) {
        if (f.type.toLowerCase() === needle || f.type.toLowerCase().includes(needle)) {
          hits.push({ route: graph.entrypoint, finding: f })
          // if --route is also given, restrict to that route
          if (routeFilter && !graph.entrypoint.toLowerCase().includes(routeFilter.toLowerCase())) {
            hits.pop()
          }
        }
      }
    }

    if (hits.length === 0) {
      const scope = routeFilter ? ` on route "${routeFilter}"` : ""
      console.log(`No findings of type "${findingType}"${scope}.`)
      process.exit(0)
    }

    console.log(`\nFinding: ${findingType}  (${hits.length} occurrence(s))`)
    console.log("─".repeat(60))
    for (const { route, finding } of hits) {
      renderFinding(route, finding)
      // also show execution path for context
      const graph = graphs.find((g) => g.entrypoint === route)
      if (graph) {
        const result = traceByPattern("request", graphs, route)
        const entry  = (result.results as RequestTraceEntry[])[0]
        if (entry) {
          console.log()
          renderPath(entry)
        }
      }
    }
  }
}
