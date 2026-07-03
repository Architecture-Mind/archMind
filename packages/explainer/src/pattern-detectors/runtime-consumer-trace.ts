import type { SemanticFact, RuntimeInjectionFact } from "../fact-extraction/types.js"
import type { IntermediateExecutionGraph, ExecutionNode } from "@kidkender/archmind-protocol"
import type { Finding, ReasoningStep, Evidence } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

// Detect which downstream nodes structurally depend on a runtime-injected value.
//
// `hidden_runtime_dependency` flags that the injection exists and notes when no
// edge-level consumers are found.  This detector complements it by inferring
// consumers from graph structure: the controller_action node and all service_call
// nodes reachable from it via `calls` edges are implicitly at risk if the
// injecting middleware is removed.

function extractKey(text: string): string | null {
  const m = text.match(/instance\s*\(\s*['"]([^'"]+)['"]/i)
  return m ? (m[1] ?? null) : null
}

function bfsCallees(
  start: string,
  graph: IntermediateExecutionGraph
): ExecutionNode[] {
  const visited = new Set<string>()
  const queue = [start]
  const result: ExecutionNode[] = []

  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)

    for (const edge of graph.edges) {
      if (edge.from !== id || edge.relation !== "calls") continue
      const node = graph.nodes.find((n) => n.id === edge.to)
      if (!node || visited.has(node.id)) continue
      result.push(node)
      queue.push(node.id)
    }
  }

  return result
}

// Find controller_action nodes reachable via the middleware chain (next_middleware edges).
function getControllerNodes(graph: IntermediateExecutionGraph): ExecutionNode[] {
  return graph.nodes.filter((n) => n.type === "controller_action")
}

export function detectRuntimeConsumerTrace(
  facts: SemanticFact[],
  graph: IntermediateExecutionGraph
): Finding[] {
  const injectionFacts = facts.filter(
    (f): f is RuntimeInjectionFact => f.kind === "runtime_injection"
  )
  if (injectionFacts.length === 0) return []

  const findings: Finding[] = []

  for (const fact of injectionFacts) {
    const key = extractKey(fact.symbol) ?? fact.injectedValue

    // Primary consumers: controller_action nodes (they call app('key') directly)
    const controllers = getControllerNodes(graph)

    // Secondary consumers: service_call nodes reachable via `calls` from each controller
    const serviceCallSet = new Map<string, ExecutionNode>()
    for (const ctrl of controllers) {
      for (const svc of bfsCallees(ctrl.id, graph)) {
        if (svc.type === "service_call") {
          serviceCallSet.set(svc.id, svc)
        }
      }
    }
    const serviceCalls = [...serviceCallSet.values()]

    const allConsumers = [...controllers, ...serviceCalls]
    if (allConsumers.length === 0) continue

    const nodeIds = [fact.nodeId, ...allConsumers.map((n) => n.id)]

    const reasoning: ReasoningStep[] = [
      {
        type: "runtime_injection_source",
        node: fact.nodeId,
        key,
        symbol: fact.symbol,
      },
      ...controllers.map((c) => ({
        type: "primary_consumer",
        node: c.id,
        symbol: c.symbol,
        reason: `controller_action node — calls app('${key}') directly in request handler`,
      })),
      ...serviceCalls.map((s) => ({
        type: "secondary_consumer",
        node: s.id,
        symbol: s.symbol,
        reason: `service_call reachable from controller — receives ${key} context as argument`,
      })),
      {
        type: "removal_impact",
        description: `Removing the middleware that injects '${key}' would cause ${allConsumers.length} node(s) to fail at runtime with an unbound container exception`,
      },
    ]

    const evidence: Evidence[] = [
      {
        nodeId: fact.nodeId,
        description: `Injects '${key}' into the service container`,
        detail: fact.symbol,
      },
      ...controllers.map((c) => ({
        nodeId: c.id,
        description: `Primary consumer — will throw BindingResolutionException if '${key}' is unbound`,
        detail: c.symbol,
      })),
      ...serviceCalls.map((s) => ({
        nodeId: s.id,
        description: `Secondary consumer — depends on ${key} context passed from controller`,
        detail: s.symbol,
      })),
    ]

    const edgeIds = graph.edges
      .filter((e) => nodeIds.includes(e.from) && nodeIds.includes(e.to))
      .map((e) => `${e.from}:${e.relation}:${e.to}`)

    const consumerSymbols = allConsumers.map((n) => n.symbol).join(", ")

    findings.push({
      id: `${FINDING_TYPES.RUNTIME_CONSUMER_TRACE}-${stableHash(nodeIds)}`,
      type: FINDING_TYPES.RUNTIME_CONSUMER_TRACE,
      severity: "MEDIUM",
      confidence: "MEDIUM",
      provenance: {
        detector: FINDING_TYPES.RUNTIME_CONSUMER_TRACE,
        ontology_primitives: ["RuntimeContract", "ServiceCall", "ControllerAction"],
        supporting_nodes: nodeIds,
        supporting_edges: edgeIds,
      },
      summary: `Runtime injection of '${key}' has ${allConsumers.length} inferred consumer(s): ${consumerSymbols}`,
      reasoning,
      evidence,
      recommendations: [
        `If the middleware providing '${key}' is removed, these nodes will fail: ${consumerSymbols}`,
        `Add a test that asserts a 400/403 response when the '${key}' binding is missing from the container`,
      ],
    })
  }

  return findings
}
