import type { IntermediateExecutionGraph, ExecutionNode } from "@kidkender/archmind-protocol"

const NODE_ICONS: Record<string, string> = {
  authentication_gate:  "🔑",
  authorization_check:  "🛡",
  middleware:           "⚙",
  controller_action:    "📋",
  form_request:         "✅",
  policy:               "🔒",
  service_call:         "⚡",
  transaction_boundary: "🔄",
  transactional_write:  "✍",
  transaction_escape:   "⚠",
  tenant_scoped_query:  "🏢",
  unscoped_query:       "❓",
  unscoped_write:       "❌",
  permission:           "🎫",
  runtime_injection:    "💉",
}

function icon(type: string): string {
  return NODE_ICONS[type] ?? "•"
}

function nodeLabel(n: ExecutionNode): string {
  const ic = icon(n.type)
  const sym = n.symbol ?? n.id
  return `${ic} ${sym}  [${n.type}]`
}

export function renderGraph(graph: IntermediateExecutionGraph): string {
  const lines: string[] = []
  lines.push(`${graph.method} ${graph.path}`)

  // Build adjacency: parent → children
  const children = new Map<string, string[]>()
  const hasParent = new Set<string>()
  const nodeMap   = new Map(graph.nodes.map((n) => [n.id, n]))

  for (const e of graph.edges) {
    if (!children.has(e.from)) children.set(e.from, [])
    children.get(e.from)!.push(e.to)
    hasParent.add(e.to)
  }

  // Roots = nodes with no incoming edge
  const roots = graph.nodes.filter((n) => !hasParent.has(n.id))

  function walk(id: string, prefix: string, isLast: boolean): void {
    const n = nodeMap.get(id)
    if (!n) return
    const connector = isLast ? "└─ " : "├─ "
    lines.push(`${prefix}${connector}${nodeLabel(n)}`)
    const kids = children.get(id) ?? []
    const childPrefix = prefix + (isLast ? "   " : "│  ")
    kids.forEach((kid, i) => walk(kid, childPrefix, i === kids.length - 1))
  }

  roots.forEach((r, i) => walk(r.id, "", i === roots.length - 1))

  if (graph.annotations && graph.annotations.length > 0) {
    lines.push("")
    lines.push("Annotations:")
    for (const a of graph.annotations) {
      lines.push(`  ⚠  [${a.type}] ${a.description}`)
    }
  }

  return lines.join("\n")
}
