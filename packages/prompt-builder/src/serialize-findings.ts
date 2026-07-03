import type { Finding, Severity } from "@kidkender/archmind-explainer"

const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  INFO: 4,
}

function toDisplayType(type: string): string {
  return type.toUpperCase().replace(/-/g, "_")
}

function serializeFinding(finding: Finding, index: number): string {
  const lines: string[] = []
  lines.push(`[${index}] ${toDisplayType(finding.type)} — ${finding.severity} — confidence: ${finding.confidence}`)
  lines.push(`    ${finding.summary}`)
  if (finding.provenance.supporting_nodes.length > 0) {
    lines.push(`    Supporting nodes: ${finding.provenance.supporting_nodes.join(", ")}`)
  }
  if (finding.provenance.supporting_edges.length > 0) {
    lines.push(`    Supporting edges: ${finding.provenance.supporting_edges.join(", ")}`)
  }
  if (finding.recommendations?.length) {
    lines.push(`    Recommendations:`)
    for (const rec of finding.recommendations) {
      lines.push(`      - ${rec}`)
    }
  }
  return lines.join("\n")
}

export function serializeFindings(findings: Finding[]): string {
  if (findings.length === 0) return ""
  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99)
  )
  const body = sorted.map((f, i) => serializeFinding(f, i + 1)).join("\n\n")
  return `Semantic findings (ranked by severity):\n\n${body}`
}
