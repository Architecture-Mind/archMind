import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { IR_NODE_TYPES } from "@archmind/protocol"
import { query } from "@kidkender/archmind-graph-query"
import type { Finding } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

function extractClassName(symbol: string): string {
  return symbol.split("::")[0] ?? symbol
}

/**
 * Detects circular service dependencies in the execution graph.
 *
 * Node IDs are scoped by caller: svc_ServiceA_method_callerNodeId
 * A cycle exists when the same class name appears as both caller and callee
 * in the ir:calls edge chain: ServiceA → ServiceB → ServiceA.
 *
 * Operates at the class-name level (not node ID) to handle the fact that
 * each call site produces a unique node ID.
 */
export function detectCircularDependency(
  graph: IntermediateExecutionGraph
): Finding[] {
  const q = query(graph)
  const serviceNodes = q.nodes().ofType(IR_NODE_TYPES.SERVICE_CALL).toArray()
  if (serviceNodes.length < 2) return []

  const nodeById = q.nodes().toMap()

  // Build class-level adjacency: className → Set<className it calls>
  const classAdj = new Map<string, Set<string>>()
  const classNodes = new Map<string, string[]>() // className → nodeIds

  for (const svc of serviceNodes) {
    const cls = extractClassName(svc.symbol)
    if (!classAdj.has(cls)) classAdj.set(cls, new Set())
    if (!classNodes.has(cls)) classNodes.set(cls, [])
    classNodes.get(cls)!.push(svc.id)
  }

  for (const edge of graph.edges) {
    if (edge.relation !== "ir:calls") continue
    const fromNode = nodeById.get(edge.from)
    const toNode   = nodeById.get(edge.to)
    if (!fromNode || !toNode) continue
    if (
      fromNode.type !== IR_NODE_TYPES.SERVICE_CALL ||
      toNode.type   !== IR_NODE_TYPES.SERVICE_CALL
    ) continue

    const fromClass = extractClassName(fromNode.symbol)
    const toClass   = extractClassName(toNode.symbol)
    if (fromClass !== toClass) {
      classAdj.get(fromClass)?.add(toClass)
    }
  }

  // DFS cycle detection at class level
  const visited  = new Set<string>()
  const onStack  = new Set<string>()
  const cycles: string[][] = []

  function dfs(cls: string, path: string[]): void {
    visited.add(cls)
    onStack.add(cls)

    for (const neighbor of classAdj.get(cls) ?? []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, [...path, neighbor])
      } else if (onStack.has(neighbor)) {
        const cycleStart = path.indexOf(neighbor)
        const cycle = cycleStart >= 0 ? path.slice(cycleStart) : [...path, neighbor]
        // Avoid duplicate cycle reports (same set of classes)
        const cycleKey = [...cycle].sort().join(",")
        if (!cycles.some((c) => [...c].sort().join(",") === cycleKey)) {
          cycles.push(cycle)
        }
      }
    }

    onStack.delete(cls)
  }

  for (const cls of classAdj.keys()) {
    if (!visited.has(cls)) dfs(cls, [cls])
  }

  if (cycles.length === 0) return []

  return cycles.map((cycle) => {
    const involvedNodeIds = cycle.flatMap((cls) => classNodes.get(cls) ?? [])
    const cycleStr = [...cycle, cycle[0]].join(" → ")

    return {
      id: `${FINDING_TYPES.CIRCULAR_DEPENDENCY}-${stableHash(cycle)}`,
      type: FINDING_TYPES.CIRCULAR_DEPENDENCY,
      severity: "HIGH" as const,
      confidence: "MEDIUM" as const,
      provenance: {
        detector: FINDING_TYPES.CIRCULAR_DEPENDENCY,
        ontology_primitives: ["ServiceCall"],
        supporting_nodes: involvedNodeIds,
        supporting_edges: graph.edges
          .filter(
            (e) =>
              e.relation === "ir:calls" &&
              involvedNodeIds.includes(e.from) &&
              involvedNodeIds.includes(e.to)
          )
          .map((e) => `${e.from}:${e.relation}:${e.to}`),
      },
      summary: `Circular service dependency detected: ${cycleStr}`,
      reasoning: [
        {
          type: "cycle",
          classes: cycle,
          chain: cycleStr,
          note: "Circular dependencies prevent clean unit testing, cause unclear ownership, and risk infinite recursion",
        },
      ],
      evidence: involvedNodeIds
        .map((id) => nodeById.get(id))
        .filter(Boolean)
        .map((n) => ({
          nodeId: n!.id,
          description: `Service class ${extractClassName(n!.symbol)} is part of circular dependency chain`,
        })),
      recommendations: [
        `Break the cycle by introducing an event or message (EventEmitter, Queue job) between ${cycle[0]} and ${cycle[cycle.length - 1]}`,
        `Apply Dependency Inversion: extract an interface that both classes depend on instead of each other`,
        `Consider whether ${cycle[0]} and ${cycle[cycle.length - 1]} should be merged into a single domain service`,
      ],
    }
  })
}
