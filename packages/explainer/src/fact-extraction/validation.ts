import type { IntermediateExecutionGraph, ExecutionNode } from "@kidkender/archmind-protocol"
import type { ValidationGateFact } from "./types.js"

function isValidationGateNode(node: ExecutionNode): boolean {
  const t = node.type.toLowerCase()
  return t === "ir:validation_gate" || t === "form_request"
}

// A form_request delegates authorization when:
// - role is "validation_only" (explicit)
// - OR no outgoing edges to policy/auth nodes exist (implicit)
function detectsDelegation(
  node: ExecutionNode,
  graph: IntermediateExecutionGraph
): boolean {
  if (node.role === "validation_only") return true

  const outgoing = graph.edges.filter((e) => e.from === node.id)
  const hasAuthEdge = outgoing.some(
    (e) =>
      e.relation === "policy_check" ||
      e.relation === "auth_chain" ||
      e.relation === "authorization_check"
  )
  return !hasAuthEdge
}

function hasRealAuthLayers(graph: IntermediateExecutionGraph): boolean {
  return graph.nodes.some((n) => {
    const t = n.type.toLowerCase()
    return (
      // IR types
      t === "ir:auth_gate" ||
      t === "ir:authz_check" ||
      // Legacy types
      t === "policy" ||
      t === "authorization_check" ||
      t === "authentication_gate" ||
      (t === "middleware" && n.args && n.args.length > 0)
    )
  })
}

export function extractValidationGateFacts(
  graph: IntermediateExecutionGraph
): ValidationGateFact[] {
  const facts: ValidationGateFact[] = []
  const realAuthPresent = hasRealAuthLayers(graph)

  for (const node of graph.nodes) {
    if (!isValidationGateNode(node)) continue

    const delegatesAuthorization = detectsDelegation(node, graph)

    facts.push({
      kind: "validation_gate",
      nodeId: node.id,
      symbol: node.symbol,
      validatesInput: true,
      delegatesAuthorization,
      layer: "form_request",
      confidence: realAuthPresent && delegatesAuthorization ? "HIGH" : "MEDIUM",
    })
  }

  return facts
}
