import type { SemanticFact, AuthorizationCheckFact } from "../fact-extraction/types.js"
import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { IR_NODE_TYPES, MUTATION_METHODS } from "@archmind/protocol"
import type { Finding, Evidence } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

/**
 * Detects mutation routes (POST/PUT/PATCH/DELETE) that have an authentication
 * gate but no authorization layer (policy or authorization_check node).
 *
 * Pattern: route is protected (you must be logged in) but anyone logged in
 * can perform the mutation — no ownership or role check exists.
 */
export function detectMissingAuthorization(
  facts: SemanticFact[],
  graph: IntermediateExecutionGraph
): Finding[] {
  const ctrlNode = graph.nodes.find(
    (n) => n.type === IR_NODE_TYPES.BUSINESS_HANDLER || n.type === "controller_action"
  )
  if (!ctrlNode) return []

  // Only fire on mutation methods
  const method = graph.method?.toUpperCase() ?? ""
  if (!MUTATION_METHODS.has(method)) return []

  const authFacts = facts.filter(
    (f): f is AuthorizationCheckFact => f.kind === "authorization_check"
  )

  const hasAuthGate = authFacts.some((f) => f.layer === "middleware")
  if (!hasAuthGate) return [] // unauthenticated route — different problem

  const hasAuthorization = authFacts.some(
    (f) => f.layer === "policy" || f.layer === "service"
  )
  if (hasAuthorization) return [] // properly authorized

  // Also check for authorization_check nodes directly (middleware role check)
  const hasAuthzNode = graph.nodes.some(
    (n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK || n.type === "authorization_check"
  )
  if (hasAuthzNode) return []

  const gateFact = authFacts.find((f) => f.layer === "middleware")!
  const evidence: Evidence[] = [
    {
      nodeId: gateFact.nodeId,
      description: `${gateFact.symbol} authenticates the request but no authorization layer (policy or role check) follows`,
    },
    {
      nodeId: ctrlNode.id,
      description: `${ctrlNode.symbol} executes without verifying the caller has permission for this specific resource`,
    },
  ]

  return [
    {
      id: `${FINDING_TYPES.MISSING_AUTHORIZATION}-${stableHash([ctrlNode.id, method])}`,
      type: FINDING_TYPES.MISSING_AUTHORIZATION,
      severity: "HIGH",
      confidence: "HIGH",
      provenance: {
        detector: FINDING_TYPES.MISSING_AUTHORIZATION,
        ontology_primitives: ["AuthenticationGate", "ControllerAction"],
        supporting_nodes: [gateFact.nodeId, ctrlNode.id],
        supporting_edges: graph.edges
          .filter((e) => e.from === gateFact.nodeId || e.to === ctrlNode.id)
          .map((e) => `${e.from}:${e.relation}:${e.to}`),
      },
      summary: `${method} ${graph.path ?? ""} is authenticated but not authorized — any logged-in user can perform this mutation`,
      reasoning: [
        {
          type: "mutation_method",
          method,
          note: "Mutation routes require both authentication AND authorization",
        },
        {
          type: "authentication_present",
          nodeId: gateFact.nodeId,
          symbol: gateFact.symbol,
        },
        {
          type: "authorization_absent",
          note: "No policy node, no authorization_check node, no role-check middleware found in graph",
        },
      ],
      evidence,
      recommendations: [
        `Add a Policy or Gate check in ${ctrlNode.symbol} to verify the caller owns or has rights to this resource`,
        `Consider adding role-based middleware (e.g. admin-only) if this action should be restricted by role`,
      ],
    },
  ]
}
