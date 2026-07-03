import type { RetrievalResult, ExecutionNode, ExecutionEdge } from "@kidkender/archmind-protocol"

// ---- Public API -------------------------------------------------------

export function serialize(result: RetrievalResult): string {
  const body = serializeBody(result.nodes, result.edges, result.pruned)
  return `Execution flow for ${result.entrypoint}:\n${body}\n~${result.token_estimate} tokens`.trimEnd()
}

/** Estimate tokens for a set of nodes+edges using the human-readable format. */
export function estimateSerializedTokens(nodes: ExecutionNode[], edges: ExecutionEdge[]): number {
  return Math.ceil(serializeBody(nodes, edges, false).length / 4)
}

// ---- Core body serialization (no entrypoint header, no token footer) --

function serializeBody(nodes: ExecutionNode[], edges: ExecutionEdge[], pruned: boolean): string {
  const lines: string[] = []

  if (pruned) lines.push("(pruned to relevant nodes only)")
  lines.push("")

  const sections = groupBySemantic(nodes)

  for (const [heading, sectionNodes] of sections) {
    if (sectionNodes.length === 0) continue
    lines.push(`[${heading}]`)
    for (const node of sectionNodes) {
      lines.push(formatNode(node))
    }
    lines.push("")
  }

  const summary = buildExecutionSummary(nodes)
  if (summary) {
    lines.push(summary)
    lines.push("")
  }

  const notable = edges.filter((e) => e.relation !== "next_middleware")
  if (notable.length > 0) {
    lines.push("[CONNECTIONS]")
    for (const e of notable) {
      const via = e.mechanism ? ` via ${e.mechanism}` : ""
      lines.push(`  ${e.from} → ${e.to} (${e.relation}${via})`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

// ---- Grouping ---------------------------------------------------------

type SectionName =
  | "MIDDLEWARE CHAIN"
  | "HANDLER"
  | "VALIDATION"
  | "AUTHORIZATION"
  | "RUNTIME"
  | "OTHER"

const NODE_SECTION: Record<string, SectionName> = {
  // IR types
  "ir:auth_gate":           "MIDDLEWARE CHAIN",
  "ir:authz_check":         "AUTHORIZATION",
  "ir:business_handler":    "HANDLER",
  "ir:validation_gate":     "VALIDATION",
  "ir:permission_constant": "AUTHORIZATION",
  "ir:service_call":        "AUTHORIZATION",
  "ir:runtime_inject":      "RUNTIME",
  "ir:runtime_consume":     "RUNTIME",
  "ir:tenant_context":      "RUNTIME",
  // Legacy types (backward compat)
  middleware:             "MIDDLEWARE CHAIN",
  authentication_gate:    "MIDDLEWARE CHAIN",
  authorization_check:    "MIDDLEWARE CHAIN",
  rate_limiter:           "MIDDLEWARE CHAIN",
  controller:             "HANDLER",
  controller_action:      "HANDLER",
  form_request:           "VALIDATION",
  policy:                 "AUTHORIZATION",
  permission:             "AUTHORIZATION",
  service_call:           "AUTHORIZATION",
  runtime_injection:      "RUNTIME",
}

const SECTION_ORDER: SectionName[] = [
  "MIDDLEWARE CHAIN",
  "HANDLER",
  "VALIDATION",
  "AUTHORIZATION",
  "RUNTIME",
  "OTHER",
]

function groupBySemantic(nodes: ExecutionNode[]): Map<SectionName, ExecutionNode[]> {
  const map = new Map<SectionName, ExecutionNode[]>(
    SECTION_ORDER.map((s) => [s, []])
  )
  for (const node of nodes) {
    const section = NODE_SECTION[node.type] ?? "OTHER"
    map.get(section)!.push(node)
  }
  return map
}

// ---- Execution summary ------------------------------------------------

function buildExecutionSummary(nodes: ExecutionNode[]): string | null {
  const counts: Record<string, number> = {}
  for (const node of nodes) {
    if ((node.occurrenceCount ?? 1) > 1) {
      counts[node.type] = (counts[node.type] ?? 0) + (node.occurrenceCount ?? 1)
    }
  }
  const entries = Object.entries(counts)
  if (entries.length === 0) return null
  const parts = entries.map(([type, count]) => `${count}× ${type}`)
  return `[EXECUTION CHARACTERISTICS]\n  ${parts.join(", ")}`
}

// ---- Node formatting --------------------------------------------------

function formatNode(node: ExecutionNode): string {
  const args = node.args?.length ? ` [${node.args.join(", ")}]` : ""
  const role = node.role ? ` (${node.role})` : ""
  const count = (node.occurrenceCount ?? 1) > 1 ? ` ×${node.occurrenceCount}` : ""
  return `  → ${node.symbol}${args}${role}${count}`
}
