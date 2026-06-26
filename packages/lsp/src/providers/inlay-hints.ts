import { InlayHint, InlayHintKind } from "vscode-languageserver"
import type { RouteInfo } from "@archmind/protocol"

export function buildInlayHints(routes: RouteInfo[]): InlayHint[] {
  return routes.map(route => ({
    position:     { line: Math.max(0, route.line - 1), character: 10000 },
    label:        buildLabel(route),
    kind:         InlayHintKind.Parameter,
    paddingLeft:  true,
    paddingRight: false,
    tooltip:      buildTooltip(route),
  }))
}

function buildLabel(r: RouteInfo): string {
  const parts: string[] = [`${r.method} ${r.path}`]

  if (r.isPublic) {
    parts.push("🌐 public")
  } else if (r.authGates.length > 0) {
    parts.push(`🔒 ${r.authGates.join(", ")}`)
  } else {
    parts.push("⚠ no-auth")
  }

  if (r.validations.length > 0) parts.push(`✓ ${r.validations[0]}`)
  if (r.services.length > 0)    parts.push(`[${r.services.length} svc]`)
  if (r.hasTransaction)          parts.push("⟲ txn")

  const critical = r.findings.filter(f => f.severity === "CRITICAL" || f.severity === "HIGH")
  if (critical.length > 0) parts.push(`⛔ ${critical[0].type}`)

  return parts.join("  ")
}

function buildTooltip(r: RouteInfo): string {
  const lines = [`**${r.method} ${r.path}**`]

  if (r.authGates.length > 0)    lines.push(`Auth: ${r.authGates.join(", ")}`)
  if (r.authzChecks.length > 0)  lines.push(`Authz: ${r.authzChecks.join(", ")}`)
  if (r.validations.length > 0)  lines.push(`Validation: ${r.validations.join(", ")}`)
  if (r.services.length > 0)     lines.push(`Services: ${r.services.join(", ")}`)
  if (r.hasTransaction)           lines.push("✓ Transaction boundary")

  if (r.findings.length > 0) {
    lines.push("", "**Findings:**")
    for (const f of r.findings) lines.push(`[${f.severity}] ${f.summary}`)
  }

  return lines.join("\n")
}
