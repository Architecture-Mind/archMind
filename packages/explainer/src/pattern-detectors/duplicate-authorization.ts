import type { SemanticFact, AuthorizationCheckFact } from "../fact-extraction/types.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { query } from "@kidkender/archmind-graph-query"
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

export function detectDuplicateAuthorization(
  facts: SemanticFact[],
  graph: IntermediateExecutionGraph
): Finding[] {
  // Fast guard: need at least some auth presence to have duplicates
  if (!query(graph).security().hasAuthentication()) return []

  const authFacts = facts.filter(
    (f): f is AuthorizationCheckFact => f.kind === "authorization_check"
  )

  // Group by normalized ability; only HIGH/MEDIUM confidence facts are meaningful
  const byAbility = new Map<string, AuthorizationCheckFact[]>()

  for (const fact of authFacts) {
    if (!fact.ability || fact.confidence === "LOW") continue
    const key = fact.ability
    const group = byAbility.get(key) ?? []
    group.push(fact)
    byAbility.set(key, group)
  }

  const findings: Finding[] = []

  for (const [ability, group] of byAbility) {
    const layers = [...new Set(group.map((f) => f.layer))]
    if (layers.length < 2) continue   // need ≥2 different layers to be duplicate

    const nodeIds = group.map((f) => f.nodeId)

    const reasoning: ReasoningStep[] = group.map((f) => ({
      type: "authorization_check",
      node: f.nodeId,
      symbol: f.symbol,
      permission: f.permission,
      ability,
      layer: f.layer,
      confidence: f.confidence,
    }))

    reasoning.push({
      type: "execution_overlap_detected",
      layers,
      ability,
    })

    const evidence: Evidence[] = group.map((f) => ({
      nodeId: f.nodeId,
      description: `${f.layer} layer checks permission for "${ability}"`,
      detail: f.permission ?? undefined,
    }))

    const uncertainty: UncertaintyReason[] = checkMissingNodes(nodeIds, graph)
    const mediumFacts = group.filter((f) => f.confidence === "MEDIUM")
    for (const f of mediumFacts) {
      uncertainty.push({
        kind: "low_fact_confidence",
        nodeId: f.nodeId,
        description: `Authorization check at "${f.nodeId}" inferred semantically (no explicit permission arg)`,
      })
    }

    findings.push({
      id: `${FINDING_TYPES.DUPLICATE_AUTHORIZATION}-${stableHash([...nodeIds, ability])}`,
      type: FINDING_TYPES.DUPLICATE_AUTHORIZATION,
      severity: "LOW",
      confidence: group.every((f) => f.confidence === "HIGH") ? "HIGH" : "MEDIUM",
      provenance: {
        detector: FINDING_TYPES.DUPLICATE_AUTHORIZATION,
        ontology_primitives: ["AuthorizationCheck", "ExecutionOverlap"],
        supporting_nodes: nodeIds,
        supporting_edges: edgesAmong(graph, nodeIds),
      },
      summary: `Permission "${ability}" is checked in ${layers.length} layers: ${layers.join(", ")}`,
      reasoning,
      evidence,
      uncertainty: uncertainty.length > 0 ? uncertainty : undefined,
      recommendations: [
        `Consider consolidating "${ability}" authorization to a single layer (typically policy or middleware)`,
      ],
    })
  }

  return findings
}
