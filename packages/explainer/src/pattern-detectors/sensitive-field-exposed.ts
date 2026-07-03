import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import { query } from "@kidkender/archmind-graph-query"
import type { Finding } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

interface ResourceDetail {
  fields?:           string[]
  sensitiveFields?:  string[]
  conditionalFields?: string[]
  isCollection?:     boolean
}

function parseDetail(raw: unknown): ResourceDetail | null {
  if (!raw) return null
  if (typeof raw === "object") return raw as ResourceDetail
  try { return JSON.parse(raw as string) as ResourceDetail } catch { return null }
}

/**
 * Detects ir:api_resource nodes that expose sensitive fields (tokens, passwords,
 * secrets, internal notes, etc.) in their toArray() output.
 *
 * Sensitive fields are flagged by the resource-parser when a field key matches
 * known sensitive patterns (token, password, secret, key, hash, internal).
 */
export function detectSensitiveFieldExposed(
  graph: IntermediateExecutionGraph
): Finding[] {
  const findings: Finding[] = []

  const q = query(graph)
  const ctrlNode = q.nodes().ofType(IR_NODE_TYPES.BUSINESS_HANDLER).first()
  if (!ctrlNode) return []

  const resourceNodes = q.nodes().ofType("ir:api_resource").toArray()

  for (const resNode of resourceNodes) {
    const detail = parseDetail(resNode.detail)
    if (!detail?.sensitiveFields?.length) continue

    const sensitive = detail.sensitiveFields

    findings.push({
      id:         `${FINDING_TYPES.SENSITIVE_FIELD_EXPOSED}-${stableHash([resNode.id])}`,
      type:       FINDING_TYPES.SENSITIVE_FIELD_EXPOSED,
      severity:   "HIGH",
      confidence: "HIGH",
      provenance: {
        detector:            FINDING_TYPES.SENSITIVE_FIELD_EXPOSED,
        ontology_primitives: ["ApiResource", "SensitiveField"],
        supporting_nodes:    [ctrlNode.id, resNode.id],
        supporting_edges:    graph.edges
          .filter((e) => e.from === ctrlNode.id && e.to === resNode.id)
          .map((e) => `${e.from}:${e.relation}:${e.to}`),
      },
      summary: `${resNode.symbol} serializes ${sensitive.length} sensitive field(s): ${sensitive.join(", ")}`,
      reasoning: [
        {
          type:            "sensitive_fields_detected",
          resource:        resNode.symbol,
          sensitive_fields: sensitive,
          all_fields:      detail.fields ?? [],
        },
        {
          type:        "data_exposure_risk",
          description: "Sensitive fields serialized in API responses may be consumed by clients or logged in transit",
        },
      ],
      evidence: [
        {
          nodeId:      resNode.id,
          description: `${resNode.symbol} toArray() output includes: ${sensitive.join(", ")}`,
          detail:      `All fields: ${(detail.fields ?? []).join(", ")}`,
        },
        {
          nodeId:      ctrlNode.id,
          description: `${ctrlNode.symbol} returns this resource`,
        },
      ],
      recommendations: [
        `Remove ${sensitive.join(", ")} from ${resNode.symbol}::toArray() unless required by the client`,
        `Use $this->when(false, fn() => ...) or conditional fields to hide sensitive data from unauthorized callers`,
        `If the field is required for some callers, use a separate resource class (e.g. AdminUserResource) with elevated-access guards`,
      ],
    })
  }

  return findings
}
