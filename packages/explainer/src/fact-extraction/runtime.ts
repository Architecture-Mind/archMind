import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { RuntimeInjectionFact } from "./types.js"

// Extract the container key from injection mechanism
// e.g. "app()->instance('tenant', $tenant)" → "tenant"
function extractInjectedKey(text: string): string | null {
  const match = text.match(/instance\s*\(\s*['"]([^'"]+)['"]/i)
  return match ? (match[1] ?? null) : null
}

// Extract consumed key from consumer mechanism
// e.g. "app('tenant')" → "tenant"
function extractConsumedKey(text: string): string | null {
  const match = text.match(/app\s*\(\s*['"]([^'"]+)['"]\s*\)/i)
  return match ? (match[1] ?? null) : null
}

export function extractRuntimeInjectionFacts(
  graph: IntermediateExecutionGraph
): RuntimeInjectionFact[] {
  const facts: RuntimeInjectionFact[] = []

  for (const node of graph.nodes) {
    const t = node.type.toLowerCase()
    if (t !== "runtime_injection" && t !== "ir:runtime_inject" && t !== "ir:runtime_consume") continue

    const injectEdge = graph.edges.find(
      (e) => e.to === node.id && (e.relation === "runtime_inject" || e.relation === "side_effect")
    )
    const mechanism = injectEdge?.mechanism ?? node.symbol
    const injectedValue = extractInjectedKey(mechanism) ?? mechanism

    const sideEffect =
      injectEdge?.side_effect ??
      injectEdge?.mechanism ??
      node.symbol

    facts.push({
      kind: "runtime_injection",
      nodeId: node.id,
      symbol: node.symbol,
      injectedValue,
      sideEffect,
      confidence: injectedValue !== mechanism ? "HIGH" : "MEDIUM",
    })
  }

  return facts
}

// Extract consumers: nodes that receive runtime-injected values
export interface RuntimeConsumerInfo {
  nodeId: string
  symbol: string
  consumedKey: string
}

export function extractRuntimeConsumers(
  graph: IntermediateExecutionGraph,
  injectedKey: string
): RuntimeConsumerInfo[] {
  const consumers: RuntimeConsumerInfo[] = []

  for (const edge of graph.edges) {
    if (
      edge.relation !== "runtime_consume" &&
      edge.relation !== "runtime_inject" &&
      edge.relation !== "next_middleware"
    ) continue

    const key = extractConsumedKey(edge.mechanism ?? "")
    if (!key || key !== injectedKey) continue

    const node = graph.nodes.find((n) => n.id === edge.to)
    if (!node) continue

    consumers.push({
      nodeId: node.id,
      symbol: node.symbol,
      consumedKey: key,
    })
  }

  return consumers
}
