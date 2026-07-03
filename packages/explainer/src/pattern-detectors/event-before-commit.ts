import type { SemanticFact } from "../fact-extraction/types.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import { query } from "@kidkender/archmind-graph-query"
import type { Finding, Evidence, ReasoningStep } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

interface EscapeGroup {
  transactionNodeId: string
  escapeNodeId: string
  escapeSymbol: string
}

function findEscapeGroups(graph: IntermediateExecutionGraph): EscapeGroup[] {
  const q = query(graph)
  // escapes_transaction edges: escape → transaction_boundary
  const escapeEdges = q.edges().ofRelation("escapes_transaction")
  const groups: EscapeGroup[] = []

  for (const edge of escapeEdges.toArray()) {
    const txnNode    = escapeEdges.to(edge.to).toNodes().ofType(IR_NODE_TYPES.TXN_BOUNDARY).first()
    const escapeNode = escapeEdges.from(edge.from).fromNodes().ofType(IR_NODE_TYPES.TXN_ESCAPE).first()
    if (!txnNode || !escapeNode) continue
    groups.push({
      transactionNodeId: txnNode.id,
      escapeNodeId:      escapeNode.id,
      escapeSymbol:      escapeNode.symbol,
    })
  }

  return groups
}

export function detectEventBeforeCommit(
  _facts: SemanticFact[],
  graph: IntermediateExecutionGraph
): Finding[] {
  const q = query(graph)

  // Fast guard: skip if the graph has no transaction escapes at all
  if (!q.transaction().hasEscape()) return []

  const groups  = findEscapeGroups(graph)
  const findings: Finding[] = []

  for (const group of groups) {
    const supportingNodes = [group.transactionNodeId, group.escapeNodeId]

    const reasoning: ReasoningStep[] = [
      {
        type:        "transaction_escape_detected",
        node:        group.escapeNodeId,
        symbol:      group.escapeSymbol,
        description: "Side effect dispatched inside DB::transaction() before commit",
      },
      {
        type:        "rollback_risk",
        description: "If the transaction rolls back, this dispatch has already fired — no compensation path exists",
      },
      {
        type:        "external_state_divergence",
        description: "Listeners or downstream consumers may act on data that is never committed to the database",
      },
    ]

    const evidence: Evidence[] = [
      {
        nodeId:      group.transactionNodeId,
        description: "Transaction boundary — wraps writes that may roll back",
      },
      {
        nodeId:      group.escapeNodeId,
        description: `Escape: ${group.escapeSymbol} fires before commit`,
        detail:      "Dispatched synchronously inside the transaction closure",
      },
    ]

    const escapeName = group.escapeSymbol.split("::")[0] ?? group.escapeSymbol

    findings.push({
      id:         `${FINDING_TYPES.EVENT_BEFORE_COMMIT}-${stableHash(supportingNodes)}`,
      type:       FINDING_TYPES.EVENT_BEFORE_COMMIT,
      severity:   "HIGH",
      confidence: "HIGH",
      provenance: {
        detector:            FINDING_TYPES.EVENT_BEFORE_COMMIT,
        ontology_primitives: ["TransactionEscape", "TransactionBoundary", "RollbackPropagation"],
        supporting_nodes:    supportingNodes,
        supporting_edges:    q.edges()
            .ofRelation("escapes_transaction")
            .toArray()
            .filter((e) => supportingNodes.includes(e.from) || supportingNodes.includes(e.to))
            .map((e) => `${e.from}:${e.relation}:${e.to}`),
      },
      summary: `${group.escapeSymbol} is dispatched inside a transaction before commit — if the transaction rolls back, the dispatch cannot be undone`,
      reasoning,
      evidence,
      uncertainty: [],
      recommendations: [
        `Add ShouldHandleEventsAfterCommit to ${escapeName}'s listener to defer execution until after commit`,
        `Or move ${escapeName}::dispatch() outside the DB::transaction() block`,
        `Or use DB::afterCommit(fn() => ${escapeName}::dispatch(...)) inside the closure`,
      ],
    })
  }

  return findings
}
