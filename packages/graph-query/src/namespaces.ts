import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES, IR_EDGE_RELATIONS } from "@kidkender/archmind-protocol"
import { NodeQuery } from "./node-query.js"

// ---------------------------------------------------------------------------
// SecurityQuery — authentication and authorization facts
// ---------------------------------------------------------------------------

export class SecurityQuery {
  constructor(
    private readonly graph: IntermediateExecutionGraph,
    private readonly allNodes: NodeQuery,
  ) {}

  /** True if any auth_gate node exists (middleware authentication). */
  hasAuthentication(): boolean {
    return this.allNodes.ofType(IR_NODE_TYPES.AUTH_GATE).exists()
  }

  /** True if any authz_check node exists (policy / role check). */
  hasAuthorization(): boolean {
    return this.allNodes.ofType(IR_NODE_TYPES.AUTHZ_CHECK).exists()
  }

  /** All auth_gate nodes. */
  authenticationGates(): NodeQuery {
    return this.allNodes.ofType(IR_NODE_TYPES.AUTH_GATE)
  }

  /** All authz_check nodes. */
  authorizationChecks(): NodeQuery {
    return this.allNodes.ofType(IR_NODE_TYPES.AUTHZ_CHECK)
  }
}

// ---------------------------------------------------------------------------
// TransactionQuery — transaction boundary, writes, escapes
// ---------------------------------------------------------------------------

export class TransactionQuery {
  constructor(private readonly allNodes: NodeQuery) {}

  /** True if any txn_boundary node exists. */
  exists(): boolean {
    return this.allNodes.ofType(IR_NODE_TYPES.TXN_BOUNDARY).exists()
  }

  /** True if any txn_escape node exists (side-effect dispatched inside txn). */
  hasEscape(): boolean {
    return this.allNodes.ofType(IR_NODE_TYPES.TXN_ESCAPE).exists()
  }

  /** All txn_boundary nodes. */
  boundaries(): NodeQuery {
    return this.allNodes.ofType(IR_NODE_TYPES.TXN_BOUNDARY)
  }

  /** All txn_write nodes. */
  writes(): NodeQuery {
    return this.allNodes.ofType(IR_NODE_TYPES.TXN_WRITE)
  }

  /** All txn_escape nodes. */
  escapes(): NodeQuery {
    return this.allNodes.ofType(IR_NODE_TYPES.TXN_ESCAPE)
  }
}

// ---------------------------------------------------------------------------
// MessagingQuery — async dispatch, queues, events
// ---------------------------------------------------------------------------

export class MessagingQuery {
  constructor(private readonly allNodes: NodeQuery) {}

  /** True if any queue_job or event_dispatch node exists. */
  hasDispatch(): boolean {
    return (
      this.allNodes.ofType(IR_NODE_TYPES.QUEUE_JOB).exists() ||
      this.allNodes.ofType(IR_NODE_TYPES.EVENT_DISPATCH).exists()
    )
  }

  /** All queue_job nodes. */
  queueJobs(): NodeQuery {
    return this.allNodes.ofType(IR_NODE_TYPES.QUEUE_JOB)
  }

  /** All event_dispatch nodes. */
  eventDispatches(): NodeQuery {
    return this.allNodes.ofType(IR_NODE_TYPES.EVENT_DISPATCH)
  }

  /** All notification nodes. */
  notifications(): NodeQuery {
    return this.allNodes.ofType(IR_NODE_TYPES.NOTIFICATION)
  }

  /** All mail nodes. */
  mails(): NodeQuery {
    return this.allNodes.ofType(IR_NODE_TYPES.MAIL)
  }
}

// ---------------------------------------------------------------------------
// DataQuery — tenant isolation, scoped / unscoped access
// ---------------------------------------------------------------------------

export class DataQuery {
  constructor(private readonly allNodes: NodeQuery) {}

  /** True if any tenant_context node exists. */
  hasTenantContext(): boolean {
    return this.allNodes.ofType(IR_NODE_TYPES.TENANT_CONTEXT).exists()
  }

  /** True if any unscoped_query or unscoped_write node exists. */
  hasUnscopedAccess(): boolean {
    return (
      this.allNodes.ofType(IR_NODE_TYPES.UNSCOPED_QUERY).exists() ||
      this.allNodes.ofType(IR_NODE_TYPES.UNSCOPED_WRITE).exists()
    )
  }

  /** All unscoped_query nodes. */
  unscopedQueries(): NodeQuery {
    return this.allNodes.ofType(IR_NODE_TYPES.UNSCOPED_QUERY)
  }

  /** All unscoped_write nodes. */
  unscopedWrites(): NodeQuery {
    return this.allNodes.ofType(IR_NODE_TYPES.UNSCOPED_WRITE)
  }

  /** All resource nodes. */
  resources(): NodeQuery {
    return this.allNodes.ofType(IR_NODE_TYPES.RESOURCE)
  }
}

// ---------------------------------------------------------------------------
// CallsQuery — service/repository/gateway dependencies
// ---------------------------------------------------------------------------

export class CallsQuery {
  constructor(
    private readonly graph: IntermediateExecutionGraph,
    private readonly allNodes: NodeQuery,
  ) {}

  /**
   * Number of distinct dependency classes (by class name prefix before "::").
   * Counts service_call nodes — the primary outbound dependency type.
   */
  count(): number {
    const services = this.allNodes.ofType(IR_NODE_TYPES.SERVICE_CALL).toArray()
    const classes  = new Set(services.map((n) => n.symbol.split("::")[0]).filter(Boolean))
    return classes.size
  }

  /** All service_call nodes. */
  toArray(): NodeQuery {
    return this.allNodes.ofType(IR_NODE_TYPES.SERVICE_CALL)
  }

  /** All service_call nodes whose symbol contains `className`. */
  ofClass(className: string): NodeQuery {
    return this.allNodes.ofType(IR_NODE_TYPES.SERVICE_CALL).withSymbol(className)
  }

  /** All ir:calls edges from the business_handler node. */
  edges(): ReturnType<NodeQuery["toArray"]> {
    const ctrl = this.allNodes.ofType(IR_NODE_TYPES.BUSINESS_HANDLER).first()
    if (!ctrl) return []
    return this.graph.edges
      .filter((e) => e.from === ctrl.id && e.relation === IR_EDGE_RELATIONS.CALLS)
      .map((e) => this.graph.nodes.find((n) => n.id === e.to))
      .filter((n): n is NonNullable<typeof n> => n !== undefined)
  }
}
