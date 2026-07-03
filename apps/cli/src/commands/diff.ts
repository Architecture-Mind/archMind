import { join } from "path"
import {
  captureTopologyBaseline,
  verifyTopologyBaseline,
  loadTopologyBaseline,
  DANGER_NODE_TYPES,
} from "@kidkender/archmind-retrieval"
import type { TopologyVerifyResult, TopologyDrift } from "@kidkender/archmind-retrieval"
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
// Behavior diff — semantic interpretation of topology changes
// ---------------------------------------------------------------------------

interface SemanticChange {
  severity:     "CRITICAL" | "HIGH" | "MEDIUM" | "INFO"
  description:  string
  isRegression: boolean
}

const SEVERITY_ICON: Record<string, string> = {
  CRITICAL: "⛔",
  HIGH:     "⚠ ",
  MEDIUM:   "~ ",
  INFO:     "ℹ ",
}

const LOST_SEMANTICS: Record<string, SemanticChange> = {
  "ir:auth_gate":       { severity: "CRITICAL", isRegression: true,  description: "Authentication gate removed — endpoint is now publicly accessible" },
  "ir:authz_check":     { severity: "HIGH",     isRegression: true,  description: "Authorization check removed — any authenticated user can perform this operation" },
  "ir:txn_boundary":    { severity: "HIGH",     isRegression: true,  description: "Operation is no longer atomic — partial writes can succeed on failure" },
  "ir:validation_gate": { severity: "MEDIUM",   isRegression: true,  description: "Input validation removed — request data is no longer validated" },
  "ir:scoped_query":    { severity: "MEDIUM",   isRegression: true,  description: "Scoped database query removed — queries may now cross tenant boundaries" },
  "ir:unscoped_query":  { severity: "INFO",     isRegression: false, description: "Unscoped query removed — data access is now properly scoped" },
  "ir:unscoped_write":  { severity: "INFO",     isRegression: false, description: "Unscoped write removed — data mutation is now properly scoped" },
}

const GAINED_SEMANTICS: Record<string, SemanticChange> = {
  "ir:unscoped_query":  { severity: "CRITICAL", isRegression: true,  description: "Query now runs without tenant scope — risk of cross-tenant data exposure" },
  "ir:unscoped_write":  { severity: "CRITICAL", isRegression: true,  description: "Write now runs without tenant scope — risk of cross-tenant data mutation" },
  "ir:auth_gate":       { severity: "INFO",     isRegression: false, description: "Authentication gate added — endpoint is now protected" },
  "ir:authz_check":     { severity: "INFO",     isRegression: false, description: "Authorization check added — resource-level protection in place" },
  "ir:txn_boundary":    { severity: "INFO",     isRegression: false, description: "Operation is now transactional — writes are atomic" },
  "ir:validation_gate": { severity: "INFO",     isRegression: false, description: "Input validation added" },
  "ir:scoped_query":    { severity: "INFO",     isRegression: false, description: "Query is now tenant-scoped — isolation improved" },
}

function toSemanticChanges(drift: TopologyDrift): SemanticChange[] {
  const changes: SemanticChange[] = []
  for (const type of drift.lost_types) {
    const sem = LOST_SEMANTICS[type]
    if (sem) changes.push(sem)
  }
  for (const type of drift.gained_types) {
    const sem = GAINED_SEMANTICS[type]
    if (sem) changes.push(sem)
  }
  // Sort: regressions first, then by severity
  const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 }
  return changes.sort((a, b) => {
    if (a.isRegression !== b.isRegression) return a.isRegression ? -1 : 1
    return severityOrder[a.severity] - severityOrder[b.severity]
  })
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
    console.error(`Behavior regressions (${regressions.length}):`)
    for (const d of regressions) {
      console.error(`  ${d.route}`)
      const changes = toSemanticChanges(d)
      if (changes.length > 0) {
        for (const c of changes) {
          const icon = SEVERITY_ICON[c.severity] ?? "  "
          console.error(`    ${icon} ${c.description}`)
        }
      } else {
        // Fallback: raw type list for unknown types
        if (d.lost_types.length > 0)  console.error(`    lost:   [${d.lost_types.join(", ")}]`)
        const dangerGained = d.gained_types.filter((t) => DANGER_NODE_TYPES.includes(t))
        if (dangerGained.length > 0)  console.error(`    danger: [${dangerGained.join(", ")}]`)
      }
    }
    console.error()
  }

  if (additions.length > 0) {
    console.log(`Behavior improvements (${additions.length}):`)
    for (const d of additions) {
      console.log(`  ${d.route}`)
      const changes = toSemanticChanges(d)
      for (const c of changes) {
        const icon = SEVERITY_ICON[c.severity] ?? "  "
        console.log(`    ${icon} ${c.description}`)
      }
      if (changes.length === 0) {
        console.log(`    gained: [${d.gained_types.join(", ")}]`)
      }
    }
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

  const status = result.ok ? "✅ No behavior regressions" : "❌ Behavior regression detected"
  lines.push(`## ${status} — \`${label}\``)
  lines.push("")
  lines.push(`**${stable}/${routeCount} routes stable**`)
  lines.push("")

  if (regressions.length > 0) {
    lines.push("### ⚠️ Regressions")
    lines.push("")
    for (const d of regressions) {
      lines.push(`**\`${d.route}\`**`)
      lines.push("")
      const changes = toSemanticChanges(d).filter((c) => c.isRegression)
      if (changes.length > 0) {
        for (const c of changes) {
          const icon = SEVERITY_ICON[c.severity]?.trim() ?? "⚠️"
          lines.push(`- ${icon} **${c.severity}** — ${c.description}`)
        }
      } else {
        if (d.lost_types.length > 0) {
          lines.push(`- Lost: ${d.lost_types.map((t) => `\`${t}\``).join(", ")}`)
        }
        const dangerGained = d.gained_types.filter((t) => DANGER_NODE_TYPES.includes(t))
        if (dangerGained.length > 0) {
          lines.push(`- Danger gained: ${dangerGained.map((t) => `\`${t}\``).join(", ")}`)
        }
      }
      lines.push("")
    }
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
    lines.push(`<details><summary>✅ Behavior improvements (${additions.length})</summary>`)
    lines.push("")
    for (const d of additions) {
      lines.push(`**\`${d.route}\`**`)
      const changes = toSemanticChanges(d).filter((c) => !c.isRegression)
      for (const c of changes) {
        lines.push(`- ℹ ${c.description}`)
      }
      if (changes.length === 0) {
        lines.push(`- Gained: ${d.gained_types.map((t) => `\`${t}\``).join(", ")}`)
      }
      lines.push("")
    }
    lines.push("</details>")
    lines.push("")
  }

  if (result.ok) {
    lines.push("_No behavior regressions detected. Safe to merge._")
  } else {
    lines.push("> Run `archmind diff --update` to accept if drift is intentional.")
  }

  return lines.join("\n")
}
