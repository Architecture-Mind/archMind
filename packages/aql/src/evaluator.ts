// ---------------------------------------------------------------------------
// AQL Evaluator
// Walks an AqlNode AST and applies filters on RouteQuery / GraphQuery.
// ---------------------------------------------------------------------------

import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { queryRoutes, query as graphQuery } from "@kidkender/archmind-graph-query"
import type { AqlNode } from "./parser.js"

// ---------------------------------------------------------------------------
// Predicate registry — maps AQL predicate names → RouteQuery predicates
// ---------------------------------------------------------------------------

type GraphPredicate = (g: ReturnType<typeof graphQuery>) => boolean

const PREDICATES: Record<string, GraphPredicate> = {
  // Authentication
  "auth":              (q) => q.security().hasAuthentication(),
  "authenticated":     (q) => q.security().hasAuthentication(),
  "no-auth":           (q) => !q.security().hasAuthentication(),
  "public":            (q) => !q.security().hasAuthentication(),
  "unauthenticated":   (q) => !q.security().hasAuthentication(),

  // Authorization
  "authorization":     (q) => q.security().hasAuthorization(),
  "policy":            (q) => q.security().hasAuthorization(),
  "no-authorization":  (q) => !q.security().hasAuthorization(),
  "missing-authorization": (q) => q.security().hasAuthentication() && !q.security().hasAuthorization(),
  "no-policy":         (q) => !q.security().hasAuthorization(),

  // HTTP method
  "mutation":          (q) => q.isMutation(),
  "write":             (q) => q.isMutation(),
  "readonly":          (q) => !q.isMutation(),
  "read":              (q) => !q.isMutation(),

  // Transactions
  "transaction":       (q) => q.transaction().exists(),
  "no-transaction":    (q) => !q.transaction().exists(),
  "transaction-escape": (q) => q.transaction().hasEscape(),

  // Tenant isolation
  "tenant-scoped":     (q) => q.data().hasTenantContext(),
  "tenant":            (q) => q.data().hasTenantContext(),
  "unscoped":          (q) => q.data().hasUnscopedAccess(),
  "unscoped-access":   (q) => q.data().hasUnscopedAccess(),

  // Async side-effects
  "async":             (q) => q.messaging().hasDispatch(),
  "async-dispatch":    (q) => q.messaging().hasDispatch(),
  "queue":             (q) => q.messaging().hasDispatch(),
  "event":             (q) => q.messaging().hasDispatch(),
}

// ---------------------------------------------------------------------------
// Expr evaluator — evaluates a single AqlNode against one graph
// ---------------------------------------------------------------------------

function evalExpr(node: AqlNode, g: ReturnType<typeof graphQuery>): boolean {
  switch (node.kind) {
    case "predicate": {
      const fn = PREDICATES[node.name]
      if (!fn) throw new Error(`AQL: unknown predicate "${node.name}"`)
      return fn(g)
    }
    case "and":
      return evalExpr(node.left, g) && evalExpr(node.right, g)
    case "or":
      return evalExpr(node.left, g) || evalExpr(node.right, g)
    case "not":
      return !evalExpr(node.expr, g)
    case "find":
      return evalExpr(node.expr, g)
    case "match":
      return evalMatch(node.path, g)
    default:
      return false
  }
}

// MATCH path evaluation: checks that node types appear in order in the graph.
// Each segment in path maps to a node type substring match.
function evalMatch(path: string[], g: ReturnType<typeof graphQuery>): boolean {
  const nodes = g.graph.nodes
  // For each path segment, find a node whose type or symbol contains it.
  let searchFrom = 0
  for (const segment of path) {
    const seg = segment.toLowerCase()
    const idx = nodes.slice(searchFrom).findIndex(
      (n) =>
        n.type.toLowerCase().includes(seg) ||
        n.symbol.toLowerCase().includes(seg) ||
        (n.role ?? "").toLowerCase().includes(seg)
    )
    if (idx === -1) return false
    searchFrom += idx + 1
  }
  return true
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AqlResult {
  routes:    IntermediateExecutionGraph[]
  count:     number
  entrypoints: string[]
}

/**
 * Execute a parsed AQL AST against a set of execution graphs.
 * Returns the matching graphs.
 */
export function evaluate(
  node: AqlNode,
  graphs: IntermediateExecutionGraph[],
): AqlResult {
  const matched = queryRoutes(graphs)
    .matching((q) => evalExpr(node, q))
    .toArray()

  return {
    routes:      matched,
    count:       matched.length,
    entrypoints: matched.map((g) => g.entrypoint),
  }
}

/** List all known predicate names — useful for tooling/autocomplete. */
export function knownPredicates(): string[] {
  return Object.keys(PREDICATES).sort()
}
