import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { MUTATION_METHODS } from "@kidkender/archmind-protocol"
import { NodeQuery } from "./node-query.js"
import { EdgeQuery } from "./edge-query.js"
import {
  SecurityQuery,
  TransactionQuery,
  MessagingQuery,
  DataQuery,
  CallsQuery,
} from "./namespaces.js"

/**
 * Fluent query builder for a single IntermediateExecutionGraph.
 *
 * Three layers:
 *   Layer 1  graph.nodes / graph.edges          — raw structural access
 *   Layer 2  query(graph)                        — semantic facts (this class)
 *   Layer 3  detectors                           — combine facts into findings
 *
 * GraphQuery only exposes *facts* about the graph.
 * It never encodes detector logic or combines facts into findings.
 *
 * Usage:
 *   const q = query(graph)
 *
 *   // Low-level
 *   q.nodes().ofType(IR_NODE_TYPES.AUTH_GATE).exists()
 *   q.edges().ofRelation(IR_EDGE_RELATIONS.CALLS).from(nodeId).toArray()
 *
 *   // Namespaced fact accessors
 *   q.security().hasAuthentication()
 *   q.transaction().exists()
 *   q.transaction().hasEscape()
 *   q.messaging().hasDispatch()
 *   q.data().hasTenantContext()
 *   q.calls().count()
 *
 *   // HTTP method fact
 *   q.isMutation()
 */
export class GraphQuery {
  constructor(readonly graph: IntermediateExecutionGraph) {}

  // ---------------------------------------------------------------------------
  // Layer 1 — raw structural entry points
  // ---------------------------------------------------------------------------

  /** Start a node query over all nodes in this graph. */
  nodes(): NodeQuery {
    return new NodeQuery(this.graph, this.graph.nodes)
  }

  /** Start an edge query over all edges in this graph. */
  edges(): EdgeQuery {
    return new EdgeQuery(this.graph, this.graph.edges)
  }

  // ---------------------------------------------------------------------------
  // Layer 2 — namespaced fact accessors
  // ---------------------------------------------------------------------------

  /** Authentication and authorization facts. */
  security(): SecurityQuery {
    return new SecurityQuery(this.graph, this.nodes())
  }

  /** Transaction boundary, write, and escape facts. */
  transaction(): TransactionQuery {
    return new TransactionQuery(this.nodes())
  }

  /** Async dispatch, queue, event, notification, and mail facts. */
  messaging(): MessagingQuery {
    return new MessagingQuery(this.nodes())
  }

  /** Tenant context and data isolation facts. */
  data(): DataQuery {
    return new DataQuery(this.nodes())
  }

  /** Outbound service/dependency call facts. */
  calls(): CallsQuery {
    return new CallsQuery(this.graph, this.nodes())
  }

  // ---------------------------------------------------------------------------
  // HTTP method fact — not namespaced; it is a property of the route itself
  // ---------------------------------------------------------------------------

  /** True if the HTTP method is a mutation (POST / PUT / PATCH / DELETE). */
  isMutation(): boolean {
    return MUTATION_METHODS.has((this.graph.method ?? "").toUpperCase())
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a GraphQuery for a single execution graph. */
export function query(graph: IntermediateExecutionGraph): GraphQuery {
  return new GraphQuery(graph)
}
