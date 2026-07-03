import type { SemanticFact } from "../fact-extraction/types.js"
import type { IntermediateExecutionGraph, ExecutionNode } from "@kidkender/archmind-protocol"
import { query } from "@kidkender/archmind-graph-query"
import type { Finding, ReasoningStep, Evidence } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

// Detect: middleware authorization_check gates on permission X, then a policy
// calls PermissionService for the same route — meaning the permission may be
// evaluated twice (once in middleware, once inside the policy).
//
// This is often intentional as a fast-fail guard before policy evaluation,
// but should be documented. If the policy always rechecks, the middleware
// gate may be redundant.

function isPermissionServiceNode(node: ExecutionNode): boolean {
  const sym = node.symbol.toLowerCase()
  return (
    node.type === "service_call" &&
    (sym.includes("permissionservice") || sym.includes("haspermission"))
  )
}

export function detectDoublePermissionCheck(
  _facts: SemanticFact[],
  graph: IntermediateExecutionGraph
): Finding[] {
  const q = query(graph)

  // middleware authorization_check nodes with an explicit permission arg
  const middlewareChecks = q.nodes().ofType("authorization_check").toArray()
    .filter((n) => n.args && n.args.length > 0)
  if (middlewareChecks.length === 0) return []

  // policy → PermissionService edges
  const policyServicePairs: Array<{ policy: ExecutionNode; permService: ExecutionNode }> = []
  for (const policy of q.nodes().ofType("policy").toArray()) {
    for (const svc of q.edges().from(policy.id).toNodes().toArray()) {
      if (isPermissionServiceNode(svc)) {
        policyServicePairs.push({ policy, permService: svc })
      }
    }
  }
  if (policyServicePairs.length === 0) return []

  const findings: Finding[] = []

  for (const mwNode of middlewareChecks) {
    for (const { policy, permService } of policyServicePairs) {
      const permKey = mwNode.args![0]!
      const nodeIds = [mwNode.id, policy.id, permService.id]

      const reasoning: ReasoningStep[] = [
        {
          type: "middleware_permission_gate",
          node: mwNode.id,
          symbol: mwNode.symbol,
          permission: permKey,
        },
        {
          type: "policy_permission_recheck",
          node: policy.id,
          symbol: policy.symbol,
          via: permService.symbol,
        },
        {
          type: "double_check_detected",
          description: `Middleware gates on "${permKey}" before the request reaches the controller. ${policy.symbol} then calls ${permService.symbol} — the same permission may be evaluated a second time.`,
        },
      ]

      const evidence: Evidence[] = [
        {
          nodeId: mwNode.id,
          description: `Middleware checks "${permKey}" — request is rejected early if the user lacks this permission`,
          detail: mwNode.symbol,
        },
        {
          nodeId: policy.id,
          description: `${policy.symbol} calls ${permService.symbol} — rechecks permission inside the policy layer`,
          detail: permService.symbol,
        },
      ]

      const edgeIds = graph.edges
        .filter((e) => nodeIds.includes(e.from) && nodeIds.includes(e.to))
        .map((e) => `${e.from}:${e.relation}:${e.to}`)

      findings.push({
        id: `${FINDING_TYPES.DOUBLE_PERMISSION_CHECK}-${stableHash(nodeIds)}`,
        type: FINDING_TYPES.DOUBLE_PERMISSION_CHECK,
        severity: "LOW",
        confidence: "HIGH",
        provenance: {
          detector: FINDING_TYPES.DOUBLE_PERMISSION_CHECK,
          ontology_primitives: ["AuthorizationCheck", "PolicyCheck", "PermissionService"],
          supporting_nodes: nodeIds,
          supporting_edges: edgeIds,
        },
        summary: `"${permKey}" is checked in middleware then rechecked via ${permService.symbol} inside ${policy.symbol}`,
        reasoning,
        evidence,
        recommendations: [
          `If ${policy.symbol} always rechecks the same permission, the middleware gate on "${permKey}" may be redundant — the policy alone is sufficient`,
          `If the middleware is intentional as a fast-fail (cheaper than a full policy evaluation), document this explicitly in route comments`,
        ],
      })
    }
  }

  return findings
}
