import type { ExecutionNode, ExecutionEdge } from "@kidkender/archmind-protocol"

// _ANY suffix convention: TASK_DELETE_ANY is elevated over TASK_DELETE.
// Edge direction: elevated → basic (mirroring AUTH-002 golden trace).
export function buildHierarchyEdges(nodes: ExecutionNode[]): ExecutionEdge[] {
  const bySymbol = new Map(nodes.map((n) => [n.symbol, n]))
  const edges: ExecutionEdge[] = []

  for (const node of nodes) {
    if (!node.symbol.endsWith("_ANY")) continue
    const baseSymbol = node.symbol.slice(0, -4) // strip "_ANY"
    const baseNode = bySymbol.get(baseSymbol)
    if (!baseNode) continue

    edges.push({
      from: node.id,
      to: baseNode.id,
      relation: "privilege_hierarchy",
      traceability: "static",
    })
  }

  return edges
}
