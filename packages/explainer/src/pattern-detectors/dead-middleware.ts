import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { query } from "@kidkender/archmind-graph-query"
import type { Finding } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

/**
 * Detects middleware (ir:auth_gate) nodes that are registered in the execution
 * graph but have no outgoing edges — meaning they are declared but not actually
 * connected to any downstream node in the request pipeline.
 *
 * A dangling middleware has zero enforcement effect on the route, which can
 * create a false sense of security if the developer assumes it is active.
 */
export function detectDeadMiddleware(
  graph: IntermediateExecutionGraph
): Finding[] {
  const q = query(graph)
  if (!q.security().hasAuthentication()) return []
  const middlewareNodes = q.security().authenticationGates().toArray()

  const outgoingByNode = new Map<string, number>()
  for (const edge of graph.edges) {
    outgoingByNode.set(edge.from, (outgoingByNode.get(edge.from) ?? 0) + 1)
  }

  const deadNodes = middlewareNodes.filter(
    (mw) => (outgoingByNode.get(mw.id) ?? 0) === 0
  )
  if (deadNodes.length === 0) return []

  return deadNodes.map((mw) => ({
    id: `${FINDING_TYPES.DEAD_MIDDLEWARE}-${stableHash([mw.id])}`,
    type: FINDING_TYPES.DEAD_MIDDLEWARE,
    severity: "MEDIUM" as const,
    confidence: "MEDIUM" as const,
    provenance: {
      detector: FINDING_TYPES.DEAD_MIDDLEWARE,
      ontology_primitives: ["AuthGate"],
      supporting_nodes: [mw.id],
      supporting_edges: [],
    },
    summary: `${mw.symbol} is registered as middleware but has no outgoing edges — it may not be actively enforced`,
    reasoning: [
      {
        type: "dangling_middleware",
        nodeId: mw.id,
        symbol: mw.symbol,
        note: "Node present in graph with 0 outgoing edges — disconnected from request pipeline",
      },
    ],
    evidence: [
      {
        nodeId: mw.id,
        description: `${mw.symbol} registered but not connected to any downstream execution node`,
      },
    ],
    uncertainty: [
      {
        kind: "unverifiable_condition" as const,
        description:
          "This middleware may execute at the framework level without an explicit edge in the static graph — verify by checking route/group registration",
      },
    ],
    recommendations: [
      `Verify ${mw.symbol} is explicitly applied to this route or its group`,
      `If no longer needed, remove the middleware declaration to avoid confusion`,
      `Check for typos in middleware alias registration in Kernel.php`,
    ],
  }))
}
