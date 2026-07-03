import { InlayHint, InlayHintKind, MarkupContent } from "vscode-languageserver"
import type { RouteInfo, FindingInfo } from "@kidkender/archmind-protocol"

export function buildInlayHints(routes: RouteInfo[]): InlayHint[] {
  return routes.map(route => ({
    position:     { line: Math.max(0, route.line - 2), character: 10000 },
    label:        buildLabel(route),
    kind:         InlayHintKind.Parameter,
    paddingLeft:  true,
    paddingRight: false,
    tooltip:      buildTooltip(route),
  }))
}

function buildLabel(r: RouteInfo): string {
  const parts: string[] = []

  if (r.isPublic) {
    parts.push("🌐 public")
  } else if (r.authGates.length > 0) {
    parts.push(`🔒 ${r.authGates.join(", ")}`)
  } else {
    parts.push("⚠ no-auth")
  }

  if (r.validations.length > 0) parts.push(`⓪ ${r.validations[0]}`)
  if (r.services.length > 0)    parts.push(r.services.join(", "))
  if (r.hasTransaction)          parts.push("⟲ txn")

  const critical = r.findings.filter(f => f.severity === "CRITICAL" || f.severity === "HIGH")
  if (critical.length > 0) parts.push(`⛔ ${critical[0].type}`)

  return parts.join("  ")
}

const FINDING_DOCS: Record<string, string> = {
  missing_authorization:  "Route is reachable but has **no authentication or authorization guard**. Any caller — authenticated or not — can invoke this handler.",
  exposed_read_endpoint:  "Public GET endpoint executes **business logic without auth**. Data may leak to unauthenticated callers.",
  no_rate_limiting:       "No throttle/rate-limit guard detected. Endpoint is vulnerable to **brute-force or abuse**.",
  fat_controller:         "Controller calls **5+ services** — consider extracting an application-layer service to keep the handler focused.",
}

const SEVERITY_ICON: Record<string, string> = {
  CRITICAL: "🔴",
  HIGH:     "🟠",
  MEDIUM:   "🟡",
  LOW:      "🔵",
  INFO:     "⚪",
}

function buildFindingBlock(f: FindingInfo): string {
  const icon = SEVERITY_ICON[f.severity] ?? "⚪"
  const doc  = FINDING_DOCS[f.type]
  const lines = [`${icon} **[${f.severity}] ${f.type}**`, `> ${f.summary}`]
  if (doc) lines.push("", doc)
  return lines.join("\n")
}

function buildTooltip(r: RouteInfo): MarkupContent {
  const sections: string[] = []

  // Header
  sections.push(`### ${r.method} ${r.path}`)

  // Security summary
  const secLines: string[] = []
  if (r.isPublic)                secLines.push("🌐 Public route (no auth required)")
  else if (r.authGates.length)   secLines.push(`🔒 Auth: ${r.authGates.join(", ")}`)
  else                           secLines.push("⚠️ No authentication guard")
  if (r.authzChecks.length)      secLines.push(`🛡 Authz: ${r.authzChecks.join(", ")}`)
  if (r.validations.length)      secLines.push(`✅ Validation: ${r.validations.join(", ")}`)
  if (r.services.length)         secLines.push(`⚙️ Services: ${r.services.join(", ")}`)
  if (r.hasTransaction)          secLines.push("⟲ Runs inside a transaction boundary")
  sections.push(secLines.join("\n"))

  // Findings
  if (r.findings.length > 0) {
    sections.push("---")
    sections.push("**Findings**")
    sections.push(r.findings.map(buildFindingBlock).join("\n\n"))
  }

  return { kind: "markdown", value: sections.join("\n\n") }
}
