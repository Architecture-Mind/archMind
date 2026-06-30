import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { IR_NODE_TYPES } from "@archmind/protocol"
import { query } from "@archmind/graph-query"
import type { Finding } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

// Threshold: ≥ 5 distinct service classes signals a fat controller.
const FAT_THRESHOLD = 5

export function detectFatController(
  graph: IntermediateExecutionGraph
): Finding[] {
  const q = query(graph)

  const ctrlNode = q.nodes().ofType(IR_NODE_TYPES.BUSINESS_HANDLER).first()
  if (!ctrlNode) return []
  if (q.serviceCallCount() < FAT_THRESHOLD) return []

  const serviceNodes = q.nodes().ofType(IR_NODE_TYPES.SERVICE_CALL).toArray()
  const classes = new Set(serviceNodes.map((n) => n.symbol.split("::")[0]).filter(Boolean))
  if (classes.size < FAT_THRESHOLD) return []

  return [
    {
      id: `${FINDING_TYPES.FAT_CONTROLLER}-${stableHash([ctrlNode.id])}`,
      type: FINDING_TYPES.FAT_CONTROLLER,
      severity: "LOW",
      confidence: "HIGH",
      provenance: {
        detector: FINDING_TYPES.FAT_CONTROLLER,
        ontology_primitives: ["BusinessHandler", "ServiceCall"],
        supporting_nodes: [ctrlNode.id, ...serviceNodes.map((n) => n.id)],
        supporting_edges: graph.edges
          .filter((e) => e.from === ctrlNode.id && e.relation === "ir:calls")
          .map((e) => `${e.from}:${e.relation}:${e.to}`),
      },
      summary: `${ctrlNode.symbol} depends on ${classes.size} distinct services — violates Single Responsibility`,
      reasoning: [
        {
          type: "service_count",
          count: classes.size,
          threshold: FAT_THRESHOLD,
          classes: Array.from(classes),
        },
      ],
      evidence: serviceNodes.map((n) => ({
        nodeId: n.id,
        description: `Service dependency: ${n.symbol}`,
      })),
      recommendations: [
        `Extract ${ctrlNode.symbol} into an Application Service or Use Case class that orchestrates these dependencies`,
        `Group related service calls into higher-level domain services to reduce coupling`,
        `Consider the Facade or Command pattern to encapsulate multi-service workflows`,
      ],
    },
  ]
}
