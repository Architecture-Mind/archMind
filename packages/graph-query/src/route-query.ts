import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { GraphQuery, query } from "./graph-query.js"

/**
 * Fluent builder for querying across a collection of execution graphs (routes).
 *
 * Create via the `queryRoutes()` factory:
 *   const rq = queryRoutes(graphs)
 *
 * Example:
 *   queryRoutes(graphs)
 *     .withAuth()
 *     .withoutTransaction()
 *     .toArray()
 *
 *   queryRoutes(graphs)
 *     .isMutation()
 *     .withoutAuthorization()
 *     .count()
 */
export class RouteQuery {
  constructor(private readonly _graphs: IntermediateExecutionGraph[]) {}

  // ---------------------------------------------------------------------------
  // Filters — each returns a new RouteQuery with a narrowed set
  // ---------------------------------------------------------------------------

  withAuth(): RouteQuery {
    return this._filter((q) => q.security().hasAuthentication())
  }

  withoutAuth(): RouteQuery {
    return this._filter((q) => !q.security().hasAuthentication())
  }

  withAuthorization(): RouteQuery {
    return this._filter((q) => q.security().hasAuthorization())
  }

  withoutAuthorization(): RouteQuery {
    return this._filter((q) => !q.security().hasAuthorization())
  }

  withTransaction(): RouteQuery {
    return this._filter((q) => q.transaction().exists())
  }

  withoutTransaction(): RouteQuery {
    return this._filter((q) => !q.transaction().exists())
  }

  withTenantContext(): RouteQuery {
    return this._filter((q) => q.data().hasTenantContext())
  }

  withUnscopedAccess(): RouteQuery {
    return this._filter((q) => q.data().hasUnscopedAccess())
  }

  withTransactionEscape(): RouteQuery {
    return this._filter((q) => q.transaction().hasEscape())
  }

  withAsyncDispatch(): RouteQuery {
    return this._filter((q) => q.messaging().hasDispatch())
  }

  isMutation(): RouteQuery {
    return this._filter((q) => q.isMutation())
  }

  isReadOnly(): RouteQuery {
    return this._filter((q) => !q.isMutation())
  }

  /**
   * Escape hatch — apply any predicate on the underlying GraphQuery.
   * Use when built-in methods don't cover the case.
   *
   * Example:
   *   .matching(q => q.nodes().ofType(IR_NODE_TYPES.MAIL).count() > 1)
   */
  matching(predicate: (q: GraphQuery) => boolean): RouteQuery {
    return this._filter(predicate)
  }

  // ---------------------------------------------------------------------------
  // Terminals
  // ---------------------------------------------------------------------------

  toArray(): IntermediateExecutionGraph[] {
    return this._graphs.slice()
  }

  count(): number {
    return this._graphs.length
  }

  /** Map each matched graph using the full GraphQuery API. */
  map<T>(fn: (q: GraphQuery, graph: IntermediateExecutionGraph) => T): T[] {
    return this._graphs.map((g) => fn(query(g), g))
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _filter(predicate: (q: GraphQuery) => boolean): RouteQuery {
    return new RouteQuery(this._graphs.filter((g) => predicate(query(g))))
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a RouteQuery for a collection of execution graphs. */
export function queryRoutes(graphs: IntermediateExecutionGraph[]): RouteQuery {
  return new RouteQuery(graphs)
}
