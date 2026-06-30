import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { IR_NODE_TYPES } from "@archmind/protocol"
import { query } from "@archmind/graph-query"
import type { Finding } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

const READ_METHODS = new Set(["GET", "HEAD"])

/**
 * Detects GET/HEAD routes with no authentication layer that still invoke
 * service calls or execute business logic — suggesting business data is
 * publicly readable without any access control.
 *
 * Intentionally not fired for routes with only static/list endpoints that
 * are genuinely public (e.g. product catalog). The signal is ir:service_call
 * nodes that imply business orchestration, not just simple model reads.
 */
export function detectExposedReadEndpoint(
  graph: IntermediateExecutionGraph
): Finding[] {
  const method = graph.method?.toUpperCase() ?? ""
  if (!READ_METHODS.has(method)) return []

  // Must have a controller
  const q = query(graph)
  const ctrlNode = q.nodes().ofType(IR_NODE_TYPES.BUSINESS_HANDLER).first()
  if (!ctrlNode) return []

  // Skip if any auth or authz gate present
  if (q.security().hasAuthentication() || q.security().hasAuthorization()) return []

  // Only fire if there are service calls or resource nodes (business data access)
  const serviceCalls = q.nodes().ofType(IR_NODE_TYPES.SERVICE_CALL).toArray()
  const resources    = q.data().resources().toArray()
  if (serviceCalls.length === 0 && resources.length === 0) return []

  const dataNodes = [...serviceCalls, ...resources]

  return [
    {
      id: `${FINDING_TYPES.EXPOSED_READ_ENDPOINT}-${stableHash([ctrlNode.id, method])}`,
      type: FINDING_TYPES.EXPOSED_READ_ENDPOINT,
      severity: "MEDIUM",
      confidence: "MEDIUM",
      provenance: {
        detector: FINDING_TYPES.EXPOSED_READ_ENDPOINT,
        ontology_primitives: ["BusinessHandler", "ServiceCall"],
        supporting_nodes: [ctrlNode.id, ...dataNodes.map((n) => n.id)],
        supporting_edges: [],
      },
      summary: `${method} ${graph.path ?? ""} is publicly accessible and invokes business logic — no authentication required`,
      reasoning: [
        {
          type: "read_method",
          method,
          note: "GET/HEAD routes may intentionally be public (e.g. product catalog) — verify intent",
        },
        {
          type: "no_auth_gate",
          note: "No ir:auth_gate middleware present in execution path",
        },
        {
          type: "business_data_accessed",
          service_count: serviceCalls.length,
          resource_count: resources.length,
        },
      ],
      evidence: [
        {
          nodeId: ctrlNode.id,
          description: `${ctrlNode.symbol} executes without any authentication gate`,
        },
        ...dataNodes.map((n) => ({
          nodeId: n.id,
          description: `${n.symbol} is invoked on a public endpoint`,
        })),
      ],
      uncertainty: [
        {
          kind: "unverifiable_condition" as const,
          description: "Some read endpoints are intentionally public — confirm this route should require authentication",
        },
      ],
      recommendations: [
        `If this endpoint should be restricted, add auth:sanctum (or equivalent) middleware`,
        `If intentionally public, document it with an explicit @public annotation or route comment`,
        `Consider rate-limiting public business data endpoints to prevent scraping`,
      ],
    },
  ]
}
