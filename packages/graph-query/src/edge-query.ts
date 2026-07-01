import type { ExecutionEdge, IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { NodeQuery } from "./node-query.js"

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
  // Node resolution
  // ---------------------------------------------------------------------------

  /** NodeQuery of all to-side nodes of the current edge set. */
  toNodes(): NodeQuery {
    const ids = new Set(this._edges.map((e) => e.to))
    return new NodeQuery(this.graph, this.graph.nodes.filter((n) => ids.has(n.id)))
  }

  /** NodeQuery of all from-side nodes of the current edge set. */
  fromNodes(): NodeQuery {
    const ids = new Set(this._edges.map((e) => e.from))
    return new NodeQuery(this.graph, this.graph.nodes.filter((n) => ids.has(n.id)))
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
