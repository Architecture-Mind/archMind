import type { ExecutionNode, IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { toIRNodeType } from "@kidkender/archmind-protocol"

/**
 * Fluent builder for querying nodes in a single execution graph.
 * Each method returns a new NodeQuery — the original is never mutated.
 *
 * Example:
 *   nq.ofType(IR_NODE_TYPES.AUTH_GATE).exists()
 *   nq.ofType(IR_NODE_TYPES.SERVICE_CALL).withSymbol("OrderService").toArray()
 */
export class NodeQuery {
  constructor(
    private readonly graph: IntermediateExecutionGraph,
    private readonly _nodes: ExecutionNode[],
  ) {}

  // ---------------------------------------------------------------------------
  // Filters — each returns a new NodeQuery with a narrowed set
  // ---------------------------------------------------------------------------

  /**
   * Keep nodes whose IR-normalised type matches any of the given types.
   * Handles legacy type strings automatically via toIRNodeType().
   */
  ofType(...types: string[]): NodeQuery {
    const normalised = new Set(types.map(toIRNodeType))
    return new NodeQuery(
      this.graph,
      this._nodes.filter((n) => normalised.has(toIRNodeType(n.type))),
    )
  }

  /** Keep nodes whose symbol contains `substr` (case-insensitive). */
  withSymbol(substr: string): NodeQuery {
    const needle = substr.toLowerCase()
    return new NodeQuery(
      this.graph,
      this._nodes.filter((n) => n.symbol.toLowerCase().includes(needle)),
    )
  }

  /** Keep nodes matching a given role hint. */
  withRole(role: string): NodeQuery {
    return new NodeQuery(
      this.graph,
      this._nodes.filter((n) => n.role === role),
    )
  }

  /**
   * Keep nodes that have at least one outgoing edge of the given relation
   * pointing to a node in `targets`.
   */
  connectedTo(targets: NodeQuery, relation?: string): NodeQuery {
    const targetIds = new Set(targets.toArray().map((n) => n.id))
    const kept = this._nodes.filter((n) =>
      this.graph.edges.some(
        (e) =>
          e.from === n.id &&
          targetIds.has(e.to) &&
          (relation === undefined || e.relation === relation),
      ),
    )
    return new NodeQuery(this.graph, kept)
  }

  /**
   * Keep nodes reachable from any node in `sources` following directed edges,
   * traversing up to `maxDepth` hops (default: unlimited).
   */
  reachableFrom(sources: NodeQuery, maxDepth = Infinity): NodeQuery {
    const visited = new Set<string>()
    const queue: Array<{ id: string; depth: number }> = sources
      .toArray()
      .map((n) => ({ id: n.id, depth: 0 }))

    while (queue.length > 0) {
      const item = queue.shift()!
      if (visited.has(item.id)) continue
      visited.add(item.id)
      if (item.depth >= maxDepth) continue

      for (const edge of this.graph.edges) {
        if (edge.from === item.id && !visited.has(edge.to)) {
          queue.push({ id: edge.to, depth: item.depth + 1 })
        }
      }
    }

    // exclude the source nodes themselves
    const sourceIds = new Set(sources.toArray().map((n) => n.id))
    return new NodeQuery(
      this.graph,
      this._nodes.filter((n) => visited.has(n.id) && !sourceIds.has(n.id)),
    )
  }

  /** Narrow to nodes whose IDs are in the given array. */
  byIds(ids: string[]): NodeQuery {
    const idSet = new Set(ids)
    return new NodeQuery(this.graph, this._nodes.filter((n) => idSet.has(n.id)))
  }

  // ---------------------------------------------------------------------------
  // Terminals
  // ---------------------------------------------------------------------------

  exists(): boolean {
    return this._nodes.length > 0
  }

  count(): number {
    return this._nodes.length
  }

  first(): ExecutionNode | undefined {
    return this._nodes[0]
  }

  /** Find a single node by exact ID, or undefined. */
  byId(id: string): ExecutionNode | undefined {
    return this._nodes.find((n) => n.id === id)
  }

  toArray(): ExecutionNode[] {
    return this._nodes.slice()
  }

  /** Build an id→node map for efficient lookup. */
  toMap(): Map<string, ExecutionNode> {
    return new Map(this._nodes.map((n) => [n.id, n]))
  }
}
