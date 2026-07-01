import type { SemanticFact } from "../fact-extraction/types.js"
import type { IntermediateExecutionGraph } from "@archmind/protocol"
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

interface PrivilegeHierarchyGroup {
  policyNodeId: string
  policySymbol: string
  basicPermIds: string[]
  elevatedPermIds: string[]
}

function detectHierarchyGroups(
  graph: IntermediateExecutionGraph
): PrivilegeHierarchyGroup[] {
  const groups: PrivilegeHierarchyGroup[] = []

  const q = query(graph)
  const hierarchyEdges = q.edges().ofRelation("privilege_hierarchy").toArray()
  if (hierarchyEdges.length === 0) return groups

  // Find policy nodes that check permissions involved in hierarchy edges
  const hierarchyNodeIds = new Set<string>()
  for (const e of hierarchyEdges) {
    hierarchyNodeIds.add(e.from)
    hierarchyNodeIds.add(e.to)
  }

  const policyNodes = q.nodes().ofType("ir:authz_check", "policy").toArray()

  for (const policy of policyNodes) {
    const permEdges = [
      ...q.edges().from(policy.id).ofRelation("checks_permission").toArray(),
      ...q.edges().from(policy.id).ofRelation("uses_permission").toArray(),
    ].filter((e) => hierarchyNodeIds.has(e.to))

    if (permEdges.length < 2) continue

    const checkedPermIds = permEdges.map((e) => e.to)

    // Classify basic vs elevated using hierarchy edges
    const elevatedIds: string[] = []
    const basicIds: string[] = []

    for (const id of checkedPermIds) {
      const isElevated = hierarchyEdges.some((e) => e.from === id)
      if (isElevated) elevatedIds.push(id)
      else basicIds.push(id)
    }

    groups.push({
      policyNodeId: policy.id,
      policySymbol: policy.symbol,
      basicPermIds: basicIds,
      elevatedPermIds: elevatedIds,
    })
  }

  return groups
}

export function detectPrivilegeHierarchy(
  _facts: SemanticFact[],
  graph: IntermediateExecutionGraph
): Finding[] {
  const q = query(graph)
  if (!q.edges().ofRelation("privilege_hierarchy").exists()) return []
  const groups = detectHierarchyGroups(graph)
  const findings: Finding[] = []

  for (const group of groups) {
    const allPermIds = [...group.basicPermIds, ...group.elevatedPermIds]
    const allNodes = [group.policyNodeId, ...allPermIds]

    const reasoning: ReasoningStep[] = [
      {
        type: "policy_checks_multiple_permissions",
        node: group.policyNodeId,
        symbol: group.policySymbol,
        permissionCount: allPermIds.length,
      },
      {
        type: "privilege_hierarchy_edge_present",
        elevated: group.elevatedPermIds,
        basic: group.basicPermIds,
      },
      {
        type: "condition_logic_unverifiable",
        description:
          "Graph encodes structure but not boolean direction — elevated tier may be accidentally more restrictive",
      },
    ]

    const elevatedNodes = q.nodes().byIds(group.elevatedPermIds).toArray()
    const basicNodes    = q.nodes().byIds(group.basicPermIds).toArray()

    const evidence: Evidence[] = [
      {
        nodeId: group.policyNodeId,
        description: `Policy checks ${allPermIds.length} permission tier(s)`,
      },
      ...elevatedNodes.map((n) => ({
        nodeId: n.id,
        description: `Elevated permission tier — should grant MORE access than basic`,
        detail: n.symbol,
      })),
      ...basicNodes.map((n) => ({
        nodeId: n.id,
        description: `Basic permission tier`,
        detail: n.symbol,
      })),
    ]

    findings.push({
      id: `${FINDING_TYPES.PRIVILEGE_HIERARCHY_PRESENT}-${stableHash(allNodes)}`,
      type: FINDING_TYPES.PRIVILEGE_HIERARCHY_PRESENT,
      severity: "MEDIUM",
      confidence: "MEDIUM",
      provenance: {
        detector: FINDING_TYPES.PRIVILEGE_HIERARCHY_PRESENT,
        ontology_primitives: ["PrivilegeHierarchy"],
        supporting_nodes: allNodes,
        supporting_edges: edgesAmong(graph, allNodes),
      },
      summary: `${group.policySymbol} handles a privilege hierarchy — verify that elevated permission grants MORE access than basic`,
      reasoning,
      evidence,
      uncertainty: [
        ...checkMissingNodes(allNodes, graph),
        {
          kind: "unverifiable_condition" as const,
          description: "Condition direction (hasPermission vs !hasPermission) is not encoded in the execution graph",
        },
      ] satisfies UncertaintyReason[],
      recommendations: [
        `Confirm that hasPermission(${group.elevatedPermIds.join(", ")}) → allow (not deny)`,
        `Common bug: inverted condition causes elevated users to be MORE restricted`,
      ],
    })
  }

  return findings
}
