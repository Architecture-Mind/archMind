import type { IntermediateExecutionGraph, ExecutionNode } from "@kidkender/archmind-protocol"

// ---- Indexed node types -----------------------------------------------

/**
 * Node types included in the dependency index.
 * ir:service_call covers synchronous service dependencies.
 * Side-effect types cover async dispatch, mail, resources, and notifications.
 */
const INDEXED_TYPES = new Set([
  "ir:service_call",
  "ir:queue_job",
  "ir:event_dispatch",
  "ir:api_resource",
  "ir:notification",
  "ir:mail",
])

// ---- Public API -------------------------------------------------------

export interface DependencyIndex {
  /**
   * Maps exact symbol → entrypoints that reference it.
   * e.g. "OrderService::create" → Set{ "POST /orders", "POST /admin/orders" }
   * e.g. "GenerateInvoicePdfJob" → Set{ "POST /api/v1/invoices" }
   */
  bySymbol: Map<string, Set<string>>

  /**
   * Maps class name (no method) → entrypoints that reference any method on it.
   * e.g. "OrderService" → Set{ "POST /orders", "GET /orders/{id}", ... }
   * Derived automatically from bySymbol at build time.
   */
  byClass: Map<string, Set<string>>

  /** entrypoint → full graph, for callers that need graph context */
  graphsByEntrypoint: Map<string, IntermediateExecutionGraph>
}

export interface DependencyHit {
  entrypoint: string
  graph:      IntermediateExecutionGraph
  /** nodes in this graph whose symbol matches the query */
  matchingNodes: ExecutionNode[]
}

/**
 * Build a cross-route dependency index from a set of augmented graphs.
 *
 * Indexes service_call nodes plus all IR v1.4 side-effect types:
 * ir:queue_job, ir:event_dispatch, ir:api_resource, ir:notification, ir:mail.
 *
 * Key: node.symbol (e.g. "OrderService::create" or "GenerateInvoicePdfJob"),
 * NOT node.id — id is caller-scoped and would explode the index.
 */
export function buildDependencyIndex(
  graphs: IntermediateExecutionGraph[]
): DependencyIndex {
  const bySymbol  = new Map<string, Set<string>>()
  const byClass   = new Map<string, Set<string>>()
  const graphsByEntrypoint = new Map<string, IntermediateExecutionGraph>()

  for (const graph of graphs) {
    graphsByEntrypoint.set(graph.entrypoint, graph)

    for (const node of graph.nodes) {
      if (!INDEXED_TYPES.has(node.type)) continue

      const symbol = node.symbol
      const cls    = symbol.split("::")[0]
      if (!cls) continue

      if (!bySymbol.has(symbol)) bySymbol.set(symbol, new Set())
      bySymbol.get(symbol)!.add(graph.entrypoint)

      if (!byClass.has(cls)) byClass.set(cls, new Set())
      byClass.get(cls)!.add(graph.entrypoint)
    }
  }

  return { bySymbol, byClass, graphsByEntrypoint }
}

/**
 * Query which routes depend on a symbol.
 *
 * Supports:
 *   "OrderService::create"  — exact method match
 *   "OrderService"          — all methods on the class (uses byClass index)
 *
 * Returns hits sorted by entrypoint for deterministic output.
 */
export function queryDependents(
  index: DependencyIndex,
  symbol: string
): DependencyHit[] {
  const isExact = symbol.includes("::")
  const entrypoints: Set<string> = isExact
    ? (index.bySymbol.get(symbol) ?? new Set())
    : (index.byClass.get(symbol) ?? new Set())

  const hits: DependencyHit[] = []

  for (const ep of entrypoints) {
    const graph = index.graphsByEntrypoint.get(ep)
    if (!graph) continue

    const matchingNodes = graph.nodes.filter((n) => {
      if (!INDEXED_TYPES.has(n.type)) return false
      if (isExact) return n.symbol === symbol
      return n.symbol === symbol || n.symbol.startsWith(`${symbol}::`)
    })

    hits.push({ entrypoint: ep, graph, matchingNodes })
  }

  return hits.sort((a, b) => a.entrypoint.localeCompare(b.entrypoint))
}

/**
 * Summarise the dependency index — useful for smoke scripts and diagnostics.
 */
export function indexStats(index: DependencyIndex): {
  totalSymbols:   number
  totalClasses:   number
  totalRoutes:    number
  topSymbols:     { symbol: string; routeCount: number }[]
} {
  const topSymbols = [...index.bySymbol.entries()]
    .map(([symbol, eps]) => ({ symbol, routeCount: eps.size }))
    .sort((a, b) => b.routeCount - a.routeCount)
    .slice(0, 10)

  return {
    totalSymbols: index.bySymbol.size,
    totalClasses: index.byClass.size,
    totalRoutes:  index.graphsByEntrypoint.size,
    topSymbols,
  }
}
