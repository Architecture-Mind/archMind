import { join } from "path"
import {
  captureTopologyBaseline,
  verifyTopologyBaseline,
  loadTopologyBaseline,
  DANGER_NODE_TYPES,
} from "@archmind/retrieval"
import type { TopologyVerifyResult } from "@archmind/retrieval"
import { parseProject, requireProject } from "../utils/parse-project.js"

export async function runDiff(flags: Record<string, string>): Promise<void> {
  const projectRoot  = requireProject(flags)
  const label        = flags["label"] ?? "topology-main"
  const format       = flags["format"] ?? "text"
  const BASELINE_DIR = flags["baseline-dir"] ?? join(projectRoot, ".archmind", "baselines")

  const { graphs, routeCount } = parseProject(projectRoot)
  const current = captureTopologyBaseline({ graphs, label, projectRoot })

  const stored = loadTopologyBaseline(BASELINE_DIR, label)
  if (!stored) {
    console.error(`No baseline found at ${join(BASELINE_DIR, label + ".json")}`)
    console.error(`Run first: archmind verify --project ${projectRoot} --update`)
    process.exit(1)
  }

  const result = verifyTopologyBaseline(current, stored)

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2))
  } else if (format === "markdown") {
    console.log(renderMarkdown(result, label, routeCount))
  } else {
    renderText(result, label, routeCount)
  }

  process.exit(result.ok ? 0 : 1)
}

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------

function renderText(result: TopologyVerifyResult, label: string, routeCount: number): void {
  const regressions = result.drifts.filter((d) => d.changed)
  const additions   = result.drifts.filter((d) => !d.changed)
  const stable      = routeCount - result.drifts.length - result.new_routes.length - result.removed_routes.length

  if (result.new_routes.length > 0) {
    console.log(`New routes (${result.new_routes.length}):`)
    result.new_routes.forEach((r) => console.log(`  + ${r}`))
    console.log()
  }

  if (result.removed_routes.length > 0) {
    console.error(`Removed routes (${result.removed_routes.length}):`)
    result.removed_routes.forEach((r) => console.error(`  - ${r}`))
    console.error()
  }

  if (regressions.length > 0) {
    console.error(`Topology regressions (${regressions.length}):`)
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
    console.log(`Additions (${additions.length}):`)
    additions.forEach((d) => console.log(`  ${d.route}: gained [${d.gained_types.join(", ")}]`))
    console.log()
  }

  if (result.ok) {
    console.log(`PASSED (${label}) — ${stable}/${routeCount} routes stable`)
  } else {
    console.error(`FAILED (${label}) — ${regressions.length} regression(s), ${result.removed_routes.length} removed`)
  }
}

// ---------------------------------------------------------------------------
// Markdown renderer (GitHub PR comment)
// ---------------------------------------------------------------------------

function renderMarkdown(result: TopologyVerifyResult, label: string, routeCount: number): string {
  const regressions = result.drifts.filter((d) => d.changed)
  const additions   = result.drifts.filter((d) => !d.changed)
  const stable      = routeCount - result.drifts.length - result.new_routes.length - result.removed_routes.length
  const lines: string[] = []

  const status = result.ok ? "✅ Topology OK" : "❌ Topology Regression"
  lines.push(`## ${status} — \`${label}\``)
  lines.push("")
  lines.push(`**${stable}/${routeCount} routes stable**`)
  lines.push("")

  if (regressions.length > 0) {
    lines.push("### ⚠️ Regressions")
    lines.push("")
    lines.push("| Route | Lost | Danger gained |")
    lines.push("|-------|------|---------------|")
    for (const d of regressions) {
      const lost      = d.lost_types.length > 0
        ? d.lost_types.map((t) => `\`${t}\``).join(", ")
        : "—"
      const danger    = d.gained_types.filter((t) => DANGER_NODE_TYPES.includes(t))
      const dangerStr = danger.length > 0 ? danger.map((t) => `\`${t}\``).join(", ") : "—"
      lines.push(`| \`${d.route}\` | ${lost} | ${dangerStr} |`)
    }
    lines.push("")
  }

  if (result.removed_routes.length > 0) {
    lines.push("### 🗑️ Removed routes")
    lines.push("")
    result.removed_routes.forEach((r) => lines.push(`- \`${r}\``))
    lines.push("")
  }

  if (result.new_routes.length > 0) {
    lines.push(`<details><summary>➕ New routes (${result.new_routes.length})</summary>`)
    lines.push("")
    result.new_routes.forEach((r) => lines.push(`- \`${r}\``))
    lines.push("")
    lines.push("</details>")
    lines.push("")
  }

  if (additions.length > 0) {
    lines.push(`<details><summary>ℹ️ Informational additions (${additions.length})</summary>`)
    lines.push("")
    for (const d of additions) {
      const gained = d.gained_types.map((t) => `\`${t}\``).join(", ")
      lines.push(`- \`${d.route}\`: gained ${gained}`)
    }
    lines.push("")
    lines.push("</details>")
    lines.push("")
  }

  if (result.ok) {
    lines.push("_No topology regressions detected. Safe to merge._")
  } else {
    lines.push("> Run `archmind verify --project . --update` to accept if drift is intentional.")
  }

  return lines.join("\n")
}
