import { explain } from "@kidkender/archmind-explainer"
import type { Finding } from "@kidkender/archmind-explainer"
import { parseProject, requireProject } from "../utils/parse-project.js"

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"]

const SEVERITY_PREFIX: Record<string, string> = {
  critical: "✘ CRITICAL",
  high:     "! HIGH    ",
  medium:   "~ MEDIUM  ",
  low:      "· LOW     ",
  info:     "  INFO    ",
}

export function runFindings(flags: Record<string, string>, positional: string[]): void {
  const projectRoot = requireProject(flags)
  const routeFilter = positional[0]
  const isJson      = "json" in flags

  const { graphs } = parseProject(projectRoot)

  let allFindings: Array<{ route: string; finding: Finding }> = []

  for (const g of graphs) {
    const routeKey = `${g.method} ${g.path}`
    if (routeFilter) {
      const needle = routeFilter.toLowerCase()
      if (!routeKey.toLowerCase().includes(needle) && !g.path.toLowerCase().includes(needle)) {
        continue
      }
    }
    const findings = explain(g)
    for (const f of findings) {
      allFindings.push({ route: routeKey, finding: f })
    }
  }

  if (isJson) {
    // Use exitCode + return so stdout flushes before the process ends
    process.exitCode = allFindings.length > 0 ? 1 : 0
    process.stdout.write(JSON.stringify(allFindings, null, 2) + "\n")
    return
  }

  if (allFindings.length === 0) {
    console.log("No findings.")
    process.exit(0)
  }

  // Sort by severity
  allFindings.sort((a, b) => {
    const ai = SEVERITY_ORDER.indexOf(a.finding.severity.toLowerCase())
    const bi = SEVERITY_ORDER.indexOf(b.finding.severity.toLowerCase())
    return ai - bi
  })

  // Group by route for readability
  const byRoute = new Map<string, Finding[]>()
  for (const { route, finding } of allFindings) {
    if (!byRoute.has(route)) byRoute.set(route, [])
    byRoute.get(route)!.push(finding)
  }

  let total = 0
  for (const [route, findings] of byRoute) {
    console.log(`\n${route}`)
    for (const f of findings) {
      const prefix = SEVERITY_PREFIX[f.severity.toLowerCase()] ?? "  "
      console.log(`  ${prefix}  ${f.type}`)
      if (f.summary) {
        console.log(`             ${f.summary}`)
      }
      total++
    }
  }

  console.log(`\n${total} finding(s) across ${byRoute.size} route(s)`)

  const hasHighPlus = allFindings.some(({ finding: f }) =>
    ["critical", "high"].includes(f.severity.toLowerCase())
  )
  process.exit(hasHighPlus ? 1 : 0)
}
