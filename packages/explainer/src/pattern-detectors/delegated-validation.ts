import type { SemanticFact, ValidationGateFact } from "../fact-extraction/types.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { Finding, ReasoningStep, Evidence, UncertaintyReason } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"
import { checkMissingNodes } from "../findings/uncertainty.js"

function edgesAmong(graph: IntermediateExecutionGraph, nodeIds: string[]): string[] {
  const idSet = new Set(nodeIds)
  return graph.edges
    .filter((e) => idSet.has(e.from) && idSet.has(e.to))
    .map((e) => `${e.from}:${e.relation}:${e.to}`)
}

export function detectDelegatedValidation(
  facts: SemanticFact[],
  authNodeIds: string[],
  graph: IntermediateExecutionGraph
): Finding[] {
  const gateFacts = facts.filter(
    (f): f is ValidationGateFact =>
      f.kind === "validation_gate" && f.delegatesAuthorization
  )

  if (gateFacts.length === 0) return []

  const findings: Finding[] = []

  for (const gate of gateFacts) {
    const nodeIds = [gate.nodeId, ...authNodeIds]

    const reasoning: ReasoningStep[] = [
      {
        type: "form_request_passthrough",
        node: gate.nodeId,
        symbol: gate.symbol,
        delegatesAuthorization: true,
      },
    ]

    if (authNodeIds.length > 0) {
      reasoning.push({
        type: "real_auth_layers_present",
        nodes: authNodeIds,
        count: authNodeIds.length,
      })
      reasoning.push({
        type: "delegation_confirmed",
        description: "FormRequest::authorize() intentionally defers to upstream auth layers",
      })
    } else {
      reasoning.push({
        type: "delegation_unverified",
        description: "No upstream auth layers detected — delegation may be unintentional",
      })
    }

    const evidence: Evidence[] = [
      {
        nodeId: gate.nodeId,
        description: authNodeIds.length > 0
          ? `${gate.symbol} delegates authorization to upstream auth layer(s)`
          : `${gate.symbol} has no outgoing auth edges and no upstream auth layers detected`,
      },
      ...authNodeIds.map((id) => ({
        nodeId: id,
        description: "Real authorization layer present in this request path",
      })),
    ]

    const uncertainty: UncertaintyReason[] = checkMissingNodes(nodeIds, graph)
    if (gate.confidence === "MEDIUM") {
      uncertainty.push({
        kind: "low_fact_confidence",
        nodeId: gate.nodeId,
        description: "Authorization delegation inferred from graph structure, not explicit annotation",
      })
    }

    const severity = authNodeIds.length > 0 ? "INFO" as const : "MEDIUM" as const
    const confidence = gate.confidence

    findings.push({
      id: `${FINDING_TYPES.DELEGATED_VALIDATION}-${stableHash(nodeIds)}`,
      type: FINDING_TYPES.DELEGATED_VALIDATION,
      severity,
      confidence,
      provenance: {
        detector: FINDING_TYPES.DELEGATED_VALIDATION,
        ontology_primitives: ["DelegatedAuthorization"],
        supporting_nodes: nodeIds,
        supporting_edges: edgesAmong(graph, nodeIds),
      },
      summary: authNodeIds.length > 0
        ? `${gate.symbol} delegates authorization to ${authNodeIds.length} upstream layer(s)`
        : `${gate.symbol} returns true with no upstream auth layers detected`,
      reasoning,
      evidence,
      uncertainty: uncertainty.length > 0 ? uncertainty : undefined,
      recommendations: authNodeIds.length === 0
        ? [`Verify that authorization for this endpoint is enforced elsewhere`]
        : undefined,
    })
  }

  return findings
}
