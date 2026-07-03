import type { SemanticFact, RuntimeInjectionFact } from "../fact-extraction/types.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { Finding, ReasoningStep, Evidence, UncertaintyReason } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"
import { checkMissingNodes } from "../findings/uncertainty.js"
import { extractRuntimeConsumers } from "../fact-extraction/runtime.js"

function edgesAmong(graph: IntermediateExecutionGraph, nodeIds: string[]): string[] {
  const idSet = new Set(nodeIds)
  return graph.edges
    .filter((e) => idSet.has(e.from) && idSet.has(e.to))
    .map((e) => `${e.from}:${e.relation}:${e.to}`)
}

export function detectHiddenRuntimeDependency(
  facts: SemanticFact[],
  graph: IntermediateExecutionGraph
): Finding[] {
  const runtimeFacts = facts.filter(
    (f): f is RuntimeInjectionFact => f.kind === "runtime_injection"
  )

  const findings: Finding[] = []

  for (const fact of runtimeFacts) {
    const consumers = extractRuntimeConsumers(graph, fact.injectedValue)

    const reasoning: ReasoningStep[] = [
      {
        type: "runtime_injection",
        node: fact.nodeId,
        symbol: fact.symbol,
        injectedKey: fact.injectedValue,
        mechanism: fact.sideEffect,
      },
    ]

    for (const consumer of consumers) {
      reasoning.push({
        type: "runtime_consume",
        node: consumer.nodeId,
        symbol: consumer.symbol,
        consumedKey: consumer.consumedKey,
      })
    }

    reasoning.push({
      type: "implicit_contract_detected",
      description: `Injector must execute before all consumers — enforced only by route group placement`,
    })

    const evidence: Evidence[] = [
      {
        nodeId: fact.nodeId,
        description: `Injects "${fact.injectedValue}" into service container`,
        detail: fact.sideEffect,
      },
      ...consumers.map((c) => ({
        nodeId: c.nodeId,
        description: `Consumes "${c.consumedKey}" from service container`,
        detail: `app('${c.consumedKey}')`,
      })),
    ]

    const allNodes = [fact.nodeId, ...consumers.map((c) => c.nodeId)]

    const uncertainty: UncertaintyReason[] = checkMissingNodes(allNodes, graph)
    if (fact.confidence === "MEDIUM") {
      uncertainty.push({
        kind: "inferred_symbol",
        nodeId: fact.nodeId,
        description: "Injected key inferred from symbol — actual key may differ at runtime",
      })
    }
    if (consumers.length === 0) {
      uncertainty.push({
        kind: "no_consumers_detected",
        description: "No consumers detected via static edges — runtime consumers may exist",
      })
    }

    findings.push({
      id: `${FINDING_TYPES.HIDDEN_RUNTIME_DEPENDENCY}-${stableHash([fact.nodeId, fact.injectedValue, ...consumers.map((c) => c.nodeId)])}`,
      type: FINDING_TYPES.HIDDEN_RUNTIME_DEPENDENCY,
      severity: "HIGH",
      confidence: fact.confidence,
      provenance: {
        detector: FINDING_TYPES.HIDDEN_RUNTIME_DEPENDENCY,
        ontology_primitives: ["RuntimeContract"],
        supporting_nodes: allNodes,
        supporting_edges: edgesAmong(graph, allNodes),
      },
      summary: consumers.length > 0
        ? `"${fact.injectedValue}" is injected at runtime and consumed by ${consumers.length} node(s) — implicit contract not enforced by type system`
        : `"${fact.injectedValue}" is injected at runtime — no static consumers detected`,
      reasoning,
      evidence,
      uncertainty: uncertainty.length > 0 ? uncertainty : undefined,
      recommendations: [
        `Ensure the injector (${fact.nodeId}) is always in the route group middleware stack before any consumer`,
        `Consider constructor injection or service binding to make this dependency explicit`,
      ],
    })
  }

  return findings
}
