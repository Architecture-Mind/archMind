import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { IR_NODE_TYPES } from "@archmind/protocol"
import { query } from "@kidkender/archmind-graph-query"
import type { Finding } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

interface ResourceDetail {
  fields?:          string[]
  sensitiveFields?: string[]
  isCollection?:    boolean
}

function parseDetail(raw: string | undefined): ResourceDetail | null {
  if (!raw) return null
  try { return JSON.parse(raw) as ResourceDetail } catch { return null }
}

/**
 * Detects endpoints that return a structured API resource (ir:api_resource)
 * without any authentication or authorization gate in the execution path.
 *
 * This is complementary to exposed_read_endpoint: where that detector fires
 * on service-call activity, this fires on response shape — so it catches
 * lightweight handlers (model-only, no service class) that still expose
 * structured data via a resource class.
 *
 * Not fired if exposed_read_endpoint would already fire (service calls present),
 * to avoid duplicate findings.
 */
export function detectApiResourceUnprotected(
  graph: IntermediateExecutionGraph
): Finding[] {
  const q = query(graph)
  const ctrlNode = q.nodes().ofType(IR_NODE_TYPES.BUSINESS_HANDLER).first()
  if (!ctrlNode) return []

  const resourceNodes = q.nodes().ofType("ir:api_resource").toArray()
  if (resourceNodes.length === 0) return []

  if (q.security().hasAuthentication() || q.security().hasAuthorization()) return []

  // Skip if exposed_read_endpoint would already fire (service calls present on GET)
  const hasServiceCalls = q.calls().count() > 0
  const isReadMethod    = ["GET", "HEAD"].includes(graph.method?.toUpperCase() ?? "")
  if (hasServiceCalls && isReadMethod) return []

  const findings: Finding[] = []

  for (const resNode of resourceNodes) {
    const detail   = parseDetail(resNode.detail)
    const fields   = detail?.fields ?? []
    const isCol    = detail?.isCollection ?? false
    const label    = isCol ? "collection" : "single resource"
    const fieldStr = fields.length > 0 ? `${fields.length} field(s): ${fields.slice(0, 5).join(", ")}${fields.length > 5 ? "…" : ""}` : "unknown fields"

    findings.push({
      id:         `${FINDING_TYPES.API_RESOURCE_UNPROTECTED}-${stableHash([ctrlNode.id, resNode.id])}`,
      type:       FINDING_TYPES.API_RESOURCE_UNPROTECTED,
      severity:   "HIGH",
      confidence: "HIGH",
      provenance: {
        detector:            FINDING_TYPES.API_RESOURCE_UNPROTECTED,
        ontology_primitives: ["ApiResource", "MissingAuthGate"],
        supporting_nodes:    [ctrlNode.id, resNode.id],
        supporting_edges:    graph.edges
          .filter((e) => e.from === ctrlNode.id && e.to === resNode.id)
          .map((e) => `${e.from}:${e.relation}:${e.to}`),
      },
      summary: `${ctrlNode.symbol} returns ${resNode.symbol} (${label}, ${fieldStr}) without authentication`,
      reasoning: [
        {
          type:    "no_auth_gate",
          note:    "No ir:auth_gate or ir:authz_check in execution path",
        },
        {
          type:    "structured_data_exposed",
          resource: resNode.symbol,
          fields,
          is_collection: isCol,
        },
        {
          type:        "data_enumeration_risk",
          description: "Unauthenticated callers can enumerate this resource and extract its full field structure",
        },
      ],
      evidence: [
        {
          nodeId:      resNode.id,
          description: `${resNode.symbol} exposes ${fieldStr}`,
          detail:      detail ? JSON.stringify(detail) : undefined,
        },
        {
          nodeId:      ctrlNode.id,
          description: `${ctrlNode.symbol} is accessible without authentication`,
        },
      ],
      uncertainty: [
        {
          kind:        "unverifiable_condition" as const,
          description: "Some endpoints are intentionally public — confirm this resource should require authentication",
        },
      ],
      recommendations: [
        `Add authentication middleware (auth:sanctum or equivalent) to protect this endpoint`,
        `If this endpoint is intentionally public, restrict the resource fields to non-sensitive data only`,
        `Consider returning a PublicResource class with a reduced field set for unauthenticated callers`,
      ],
    })
  }

  return findings
}
