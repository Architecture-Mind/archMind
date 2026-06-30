import type { ExecutionEdge, IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

/**
 * Fluent builder for querying edges in a single execution graph.
 *
 * Example:
 *   eq.ofRelation(IR_EDGE_RELATIONS.CALLS).from(ctrlNodeId).toArray()
 *   eq.between("ir:auth_gate", "ir:business_handler").exists()
 */
export class EdgeQuery {
  constructor(
    private readonly graph: IntermediateExecutionGraph,
    private readonly _edges: ExecutionEdge[],
  ) {}

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------

  /** Keep edges whose relation matches. */
  ofRelation(relation: string): EdgeQuery {
    return new EdgeQuery(
      this.graph,
      this._edges.filter((e) => e.relation === relation),
    )
  }

  /** Keep edges whose `from` node id matches. */
  from(nodeId: string): EdgeQuery {
    return new EdgeQuery(
      this.graph,
      this._edges.filter((e) => e.from === nodeId),
    )
  }

  /** Keep edges whose `to` node id matches. */
  to(nodeId: string): EdgeQuery {
    return new EdgeQuery(
      this.graph,
      this._edges.filter((e) => e.to === nodeId),
    )
  }

  /**
   * Keep edges that connect a node of `fromType` to a node of `toType`.
   * Type strings are matched as-is (use IR_NODE_TYPES constants).
   */
  between(fromType: string, toType: string): EdgeQuery {
    const kept = this._edges.filter((e) => {
      const fromNode = this.graph.nodes.find((n) => n.id === e.from)
      const toNode   = this.graph.nodes.find((n) => n.id === e.to)
      return fromNode?.type === fromType && toNode?.type === toType
    })
    return new EdgeQuery(this.graph, kept)
  }

  // ---------------------------------------------------------------------------
  // Terminals
  // ---------------------------------------------------------------------------

  exists(): boolean {
    return this._edges.length > 0
  }

  count(): number {
    return this._edges.length
  }

  toArray(): ExecutionEdge[] {
    return this._edges.slice()
  }
}
