import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import type { Finding } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

/**
 * Detects when a policy class is referenced in $this->authorize() but the
 * policy file does not exist in the project.
 *
 * This is a structural fact detector — fully deterministic, no LLM required.
 * The graph-augmenter marks missing policies via GraphAnnotation type="missing_policy".
 *
 * Semantic correctness checks (e.g. "is this policy adequate?") are left to
 * the retrieval + reasoning layer — this detector only surfaces verifiable gaps.
 */
export function detectMissingPolicy(
  graph: IntermediateExecutionGraph
): Finding[] {
  const missingAnnotations = graph.annotations.filter(
    (a) => a.type === "missing_policy"
  )
  if (missingAnnotations.length === 0) return []

  return missingAnnotations.map((annotation) => {
    const nodeIds = annotation.nodes ?? []
    const policyNode = graph.nodes.find(
      (n) => nodeIds.includes(n.id) && (n.type === IR_NODE_TYPES.AUTHZ_CHECK || n.type === "policy")
    )
    const ctrlNode = graph.nodes.find(
      (n) => n.type === IR_NODE_TYPES.BUSINESS_HANDLER || n.type === "controller_action"
    )

    const evidence = []
    if (ctrlNode) {
      evidence.push({
        nodeId: ctrlNode.id,
        description: `${ctrlNode.symbol} calls $this->authorize() but the referenced policy class file is missing`,
      })
    }
    for (const nodeId of nodeIds) {
      const node = graph.nodes.find((n) => n.id === nodeId)
      if (node) {
        evidence.push({
          nodeId: node.id,
          description: `Policy node ${node.symbol} has no implementation — file not found`,
          detail: annotation.description,
        })
      }
    }

    return {
      id: `${FINDING_TYPES.MISSING_POLICY}-${stableHash([graph.entrypoint, ...nodeIds])}`,
      type: FINDING_TYPES.MISSING_POLICY,
      severity: "HIGH" as const,
      confidence: "HIGH" as const,
      provenance: {
        detector: FINDING_TYPES.MISSING_POLICY,
        ontology_primitives: ["PolicyNode", "ControllerAction"],
        supporting_nodes: nodeIds,
        supporting_edges: graph.edges
          .filter((e) => nodeIds.includes(e.to) || nodeIds.includes(e.from))
          .map((e) => `${e.from}:${e.relation}:${e.to}`),
      },
      summary: policyNode
        ? `${policyNode.symbol} is referenced but the policy class file does not exist`
        : annotation.description,
      reasoning: [
        {
          type: "missing_class_file",
          note: annotation.description,
        },
        {
          type: "authorization_gap",
          note: "$this->authorize() will throw AuthorizationException at runtime because the policy is not registered",
        },
      ],
      evidence,
      recommendations: [
        `Create the missing policy class: php artisan make:policy ${policyNode?.symbol.split("::")[0] ?? "Policy"}`,
        "Register the policy in AuthServiceProvider::$policies if not using auto-discovery",
        "Verify the policy file location matches Laravel's auto-discovery conventions (app/Policies/)",
      ],
    }
  })
}
