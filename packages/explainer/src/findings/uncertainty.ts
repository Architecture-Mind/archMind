import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { Confidence, UncertaintyReason } from "./types.js"

const CONFIDENCE_RANK: Record<Confidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 }

export function minConfidence(confidences: Confidence[]): Confidence {
  if (confidences.length === 0) return "MEDIUM"
  let min: Confidence = "HIGH"
  for (const c of confidences) {
    if (CONFIDENCE_RANK[c] < CONFIDENCE_RANK[min]) min = c
  }
  return min
}

export function checkMissingNodes(
  nodeIds: string[],
  graph: IntermediateExecutionGraph
): UncertaintyReason[] {
  const present = new Set(graph.nodes.map((n) => n.id))
  return nodeIds
    .filter((id) => !present.has(id))
    .map((id) => ({
      kind: "missing_node" as const,
      nodeId: id,
      description: `Node "${id}" is referenced in provenance but not present in the graph`,
    }))
}
