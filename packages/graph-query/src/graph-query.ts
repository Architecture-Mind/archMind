import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES, MUTATION_METHODS } from "@kidkender/archmind-protocol"
import { NodeQuery } from "./node-query.js"
import { EdgeQuery } from "./edge-query.js"

/**
 * Fluent query builder for a single IntermediateExecutionGraph.
 *
 * Create via the `query()` factory:
 *   const q = query(graph)
 *
 * Low-level:
 *   q.nodes().ofType(IR_NODE_TYPES.AUTH_GATE).exists()
 *   q.edges().ofRelation(IR_EDGE_RELATIONS.CALLS).from(nodeId).toArray()
 *
 * High-level semantic shortcuts:
 *   q.hasAuth()
 *   q.hasTransaction()
 *   q.isAuthenticatedMutation()
 */
export class GraphQuery {
  constructor(readonly graph: IntermediateExecutionGraph) {}

  // ---------------------------------------------------------------------------
  // Low-level entry points
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
  // Semantic predicates — replace boilerplate boolean checks in detectors
  // ---------------------------------------------------------------------------

  /** True if any auth_gate (middleware authentication) node exists. */
  hasAuth(): boolean {
    return this.nodes().ofType(IR_NODE_TYPES.AUTH_GATE).exists()
  }

  /** True if any authz_check (policy / role check) node exists. */
  hasAuthorization(): boolean {
    return this.nodes().ofType(IR_NODE_TYPES.AUTHZ_CHECK).exists()
  }

  /** True if any txn_boundary node exists. */
  hasTransaction(): boolean {
    return this.nodes().ofType(IR_NODE_TYPES.TXN_BOUNDARY).exists()
  }

  /** True if any tenant_context node exists. */
  hasTenantContext(): boolean {
    return this.nodes().ofType(IR_NODE_TYPES.TENANT_CONTEXT).exists()
  }

  /** True if any unscoped_query or unscoped_write node exists. */
  hasUnscopedAccess(): boolean {
    return (
      this.nodes().ofType(IR_NODE_TYPES.UNSCOPED_QUERY).exists() ||
      this.nodes().ofType(IR_NODE_TYPES.UNSCOPED_WRITE).exists()
    )
  }

  /** True if any txn_escape node exists (side-effect inside transaction). */
  hasTransactionEscape(): boolean {
    return this.nodes().ofType(IR_NODE_TYPES.TXN_ESCAPE).exists()
  }

  /** True if the HTTP method is a mutation (POST / PUT / PATCH / DELETE). */
  isMutation(): boolean {
    return MUTATION_METHODS.has((this.graph.method ?? "").toUpperCase())
  }

  /**
   * True if the route is authenticated but NOT authorized.
   * Classic missing-authorization pattern.
   */
  isAuthenticatedMutation(): boolean {
    return this.isMutation() && this.hasAuth() && !this.hasAuthorization()
  }

  /**
   * True if the route has a tenant context but also has unscoped data access.
   * Classic missing-tenant-scope pattern.
   */
  hasTenantIsolationRisk(): boolean {
    return this.hasTenantContext() && this.hasUnscopedAccess()
  }

  /** True if any queue_job or event_dispatch node exists. */
  hasAsyncDispatch(): boolean {
    return (
      this.nodes().ofType(IR_NODE_TYPES.QUEUE_JOB).exists() ||
      this.nodes().ofType(IR_NODE_TYPES.EVENT_DISPATCH).exists()
    )
  }

  /** Number of distinct service class names called by the controller. */
  serviceCallCount(): number {
    const services = this.nodes().ofType(IR_NODE_TYPES.SERVICE_CALL).toArray()
    const classes = new Set(services.map((n) => n.symbol.split("::")[0]).filter(Boolean))
    return classes.size
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a GraphQuery for a single execution graph. */
export function query(graph: IntermediateExecutionGraph): GraphQuery {
  return new GraphQuery(graph)
}
