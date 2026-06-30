import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { IR_NODE_TYPES } from "@archmind/protocol"
import { query } from "@archmind/graph-query"
import type { Finding } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

// 3+ separate auth enforcement points signals over-engineering or
// authorization logic spread across too many layers.
const LAYER_THRESHOLD = 3

/**
 * Detects routes with excessive authorization layers — middleware auth gate +
 * explicit policy check + FormRequest::authorize all present simultaneously.
 *
 * A single route shouldn't need 3+ separate places enforcing authorization.
 * This often indicates auth logic has grown organically without a clear owner,
 * making it fragile and hard to audit.
 */
export function detectOverAuthorizedRoute(
  graph: IntermediateExecutionGraph
): Finding[] {
  const q = query(graph)
  const ctrlNode = q.nodes().ofType(IR_NODE_TYPES.BUSINESS_HANDLER).first()
  if (!ctrlNode) return []

  const authGates      = q.security().authenticationGates().toArray()
  const authzChecks    = q.security().authorizationChecks().toArray()
  const validationGates = q.nodes().ofType(IR_NODE_TYPES.VALIDATION_GATE).toArray()

  // Count distinct auth layers
  const layers: Array<{ label: string; nodes: typeof authGates }> = []
  if (authGates.length > 0)       layers.push({ label: "auth middleware", nodes: authGates })
  if (authzChecks.length > 0)     layers.push({ label: "policy/Gate check", nodes: authzChecks })
  if (validationGates.length > 0) layers.push({ label: "FormRequest::authorize", nodes: validationGates })

  if (layers.length < LAYER_THRESHOLD) return []

  const allAuthNodes = [...authGates, ...authzChecks, ...validationGates]

  return [
    {
      id: `${FINDING_TYPES.OVER_AUTHORIZED_ROUTE}-${stableHash([ctrlNode.id])}`,
      type: FINDING_TYPES.OVER_AUTHORIZED_ROUTE,
      severity: "INFO",
      confidence: "HIGH",
      provenance: {
        detector: FINDING_TYPES.OVER_AUTHORIZED_ROUTE,
        ontology_primitives: ["AuthGate", "AuthzCheck", "ValidationGate"],
        supporting_nodes: [ctrlNode.id, ...allAuthNodes.map((n) => n.id)],
        supporting_edges: [],
      },
      summary: `${ctrlNode.symbol} enforces authorization in ${layers.length} separate layers — middleware, policy, and FormRequest all present`,
      reasoning: layers.map((l) => ({
        type: "auth_layer",
        label: l.label,
        nodes: l.nodes.map((n) => n.symbol),
      })),
      evidence: allAuthNodes.map((n) => ({
        nodeId: n.id,
        description: `Auth layer: ${n.symbol} (${n.type})`,
      })),
      recommendations: [
        `Consolidate authorization into a single layer — prefer a Policy class as the canonical place`,
        `Middleware should handle authentication (who are you?), Policy should handle authorization (what can you do?)`,
        `Remove redundant checks that are already covered by another layer in the same request`,
      ],
    },
  ]
}
