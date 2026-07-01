import type { SemanticFact } from "../fact-extraction/types.js"
import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { query } from "@kidkender/archmind-graph-query"
import type { Finding, Evidence, ReasoningStep } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

interface UnscopedQueryGroup {
  unscopedNodeId: string
  unscopedSymbol: string
  injectionNodeId: string
}

function findUnscopedGroups(graph: IntermediateExecutionGraph): UnscopedQueryGroup[] {
  const q = query(graph)
  // missing_tenant_scope edges: unscoped_query → runtime_injection
  const missingEdges = q.edges().ofRelation("missing_tenant_scope")
  const groups: UnscopedQueryGroup[] = []

  for (const edge of missingEdges.toArray()) {
    const unscopedNode  = missingEdges.from(edge.from).fromNodes().ofType("unscoped_query").first()
    const injectionNode = missingEdges.to(edge.to).toNodes().ofType("runtime_injection").first()
    if (!unscopedNode || !injectionNode) continue
    groups.push({
      unscopedNodeId:  unscopedNode.id,
      unscopedSymbol:  unscopedNode.symbol,
      injectionNodeId: injectionNode.id,
    })
  }

  return groups
}

export function detectMissingTenantScope(
  _facts: SemanticFact[],
  graph: IntermediateExecutionGraph
): Finding[] {
  const q = query(graph)

  // Fast guards: need both tenant context and unscoped access to fire
  if (!q.data().hasTenantContext()) return []
  if (!q.data().hasUnscopedAccess()) return []

  const groups   = findUnscopedGroups(graph)
  const findings: Finding[] = []

  for (const group of groups) {
    const supportingNodes = [group.unscopedNodeId, group.injectionNodeId]

    const reasoning: ReasoningStep[] = [
      {
        type:        "tenant_context_present",
        node:        group.injectionNodeId,
        description: "Tenant is resolved and injected into the container — this is a tenant-scoped route",
      },
      {
        type:        "unscoped_query_detected",
        node:        group.unscopedNodeId,
        symbol:      group.unscopedSymbol,
        description: "Model query executes without a tenant constraint — returns rows from any tenant",
      },
      {
        type:        "boundary_violation",
        description: "An authenticated user can access another tenant's data by supplying a valid but cross-tenant ID",
      },
    ]

    const [modelClass, operation] = group.unscopedSymbol.split("::")

    const evidence: Evidence[] = [
      {
        nodeId:      group.injectionNodeId,
        description: "Tenant injected into container — confirms this route is tenant-scoped",
      },
      {
        nodeId:      group.unscopedNodeId,
        description: `${group.unscopedSymbol} fetches by ID with no tenant constraint`,
        detail:      "Raw ID lookup across all tenants — authorization (policy) only checks permission, not tenancy",
      },
    ]

    findings.push({
      id:         `${FINDING_TYPES.MISSING_TENANT_SCOPE}-${stableHash(supportingNodes)}`,
      type:       FINDING_TYPES.MISSING_TENANT_SCOPE,
      severity:   "CRITICAL",
      confidence: "HIGH",
      provenance: {
        detector:            FINDING_TYPES.MISSING_TENANT_SCOPE,
        ontology_primitives: ["UnscopedQuery", "TenantBoundaryViolation", "GlobalScopeAssumption"],
        supporting_nodes:    supportingNodes,
        supporting_edges:    graph.edges
          .filter(
            (e) =>
              e.relation === "missing_tenant_scope" &&
              (supportingNodes.includes(e.from) || supportingNodes.includes(e.to))
          )
          .map((e) => `${e.from}:${e.relation}:${e.to}`),
      },
      summary: `${group.unscopedSymbol} fetches by raw ID with no tenant constraint — any authenticated user can access another tenant's ${modelClass ?? "model"} by guessing the ID`,
      reasoning,
      evidence,
      uncertainty: [
        {
          kind:        "unverifiable_condition",
          description: `If ${modelClass} has a registered global TenantScope (via booted() or AppServiceProvider), ${operation ?? "find"} is automatically scoped and this finding does not apply — global scopes are not visible at the call site`,
        },
      ],
      recommendations: [
        `Option A: ${modelClass}::where('tenant_id', app('tenant')->id)->${operation ?? "findOrFail"}($id)`,
        `Option B: Add a global TenantScope to ${modelClass}'s booted() method`,
        `Option C: Use scoped route model binding in AppServiceProvider`,
      ],
    })
  }

  return findings
}
