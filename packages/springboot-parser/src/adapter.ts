import { randomUUID } from "crypto"
import type { IntermediateExecutionGraph, ExecutionNode, ExecutionEdge } from "@kidkender/archmind-protocol"
import type { SemanticAdapter } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES, IR_EDGE_RELATIONS, IR_VERSION } from "@kidkender/archmind-protocol"
import { findJavaFiles, isEntrypointFile } from "./scanner.js"
import { parseControllerFile } from "./controller-parser.js"
import { emitGraph } from "./ir-emitter.js"
import { buildBaseClassIndex } from "./inheritance-resolver.js"
import { parseSecurityConfigs, matchSecurityRule, moduleRootOf, type SecurityRule } from "./security-config-parser.js"
import { buildServiceTransactionIndex, type ServiceTransactionIndex } from "./service-transaction-index.js"

export class SpringBootAdapter implements SemanticAdapter {
  parseProject(root: string): IntermediateExecutionGraph[] {
    const allFiles       = findJavaFiles(root)
    const controllerFiles = allFiles.filter(isEntrypointFile)

    // Build cross-file indices once
    const baseClassIndex = buildBaseClassIndex(allFiles)
    const securityRules  = parseSecurityConfigs(allFiles)
    const txnIndex        = buildServiceTransactionIndex(allFiles)

    const graphs: IntermediateExecutionGraph[] = []

    for (const file of controllerFiles) {
      try {
        const methods = parseControllerFile(file, baseClassIndex)
        const controllerModule = moduleRootOf(file)
        for (const m of methods) {
          const graph = emitGraph(m, root)
          injectSecurityNodes(graph, securityRules, controllerModule)
          injectServiceTransactionNodes(graph, txnIndex, controllerModule)
          graphs.push(graph)
        }
      } catch {
        // skip files that fail to parse
      }
    }

    return graphs
  }
}

export function parseSpringBootProject(root: string): IntermediateExecutionGraph[] {
  return new SpringBootAdapter().parseProject(root)
}

// ---------------------------------------------------------------------------
// Post-emit: inject auth/authz nodes derived from SecurityFilterChain rules
// ---------------------------------------------------------------------------

function injectSecurityNodes(graph: IntermediateExecutionGraph, rules: SecurityRule[], controllerModule: string): void {
  // Only inject if the method has NO per-method auth annotations already —
  // including an unrecognized-but-known-to-exist one (ir:unknown_middleware).
  // Guessing a SecurityFilterChain-derived gate on top of an unknown method-level
  // annotation would overwrite an honest "don't know" with a confident wrong guess.
  const hasMethodAuth = graph.nodes.some(
    (n) => n.type === IR_NODE_TYPES.AUTH_GATE ||
           n.type === IR_NODE_TYPES.AUTHZ_CHECK ||
           n.type === IR_NODE_TYPES.UNKNOWN_MIDDLEWARE,
  )
  if (hasMethodAuth || rules.length === 0) return

  const rule = matchSecurityRule(graph.path, rules, controllerModule)
  if (!rule || rule.irAuthTypes.length === 0) return  // public endpoint or no match

  // Find the first node in the execution flow (typically validation gate or handler)
  const firstNode = findFirstFlowNode(graph)
  if (!firstNode) return

  // Inject one node per auth type, chained in declared order
  // (e.g. [auth_gate, authz_check] -> auth_gate -> authz_check -> firstNode).
  // Build from firstNode backward so edges point the right way.
  let targetId = firstNode.id
  for (const irType of [...rule.irAuthTypes].reverse()) {
    const authId = `sec_${randomUUID().slice(0, 8)}`
    const authNode: ExecutionNode = {
      id:     authId,
      type:   irType,
      symbol: irType === "ir:authz_check" && rule.roles.length > 0
        ? `hasRole(${rule.roles.join(", ")})`
        : "isAuthenticated()",
      args:   rule.roles,
    }
    graph.nodes.unshift(authNode)

    const edge: ExecutionEdge = {
      from:          authId,
      to:            targetId,
      relation:      "ir:guards",
      traceability:  "static",
    }
    graph.edges.unshift(edge)
    targetId = authId
  }
}

// ---------------------------------------------------------------------------
// Post-emit: inject a txn_boundary node before service calls whose resolved
// service method carries @Transactional (Spring convention puts it on the
// *Impl class, not the controller — see service-transaction-index.ts).
// ---------------------------------------------------------------------------

function injectServiceTransactionNodes(graph: IntermediateExecutionGraph, txnIndex: ServiceTransactionIndex, controllerModule: string): void {
  const serviceCallNodes = graph.nodes.filter((n) => n.type === IR_NODE_TYPES.SERVICE_CALL)

  for (const svcNode of serviceCallNodes) {
    const sep = svcNode.symbol.indexOf("::")
    if (sep === -1) continue
    const fieldType = svcNode.symbol.slice(0, sep)
    const method    = svcNode.symbol.slice(sep + 2)
    if (!txnIndex.isTransactional(fieldType, method, controllerModule)) continue

    const incoming = graph.edges.filter((e) => e.to === svcNode.id)
    if (incoming.length === 0) continue

    const txnId = `svctxn_${randomUUID().slice(0, 8)}`
    const txnNode: ExecutionNode = {
      id:     txnId,
      type:   IR_NODE_TYPES.TXN_BOUNDARY,
      symbol: `@Transactional (${svcNode.symbol})`,
    }
    graph.nodes.push(txnNode)

    for (const e of incoming) e.to = txnId

    graph.edges.push({
      from:         txnId,
      to:           svcNode.id,
      relation:     IR_EDGE_RELATIONS.CALLS,
      traceability: "static",
    })
  }
}

/**
 * Find the node that comes first in the execution flow — the node with no
 * incoming edges (or the validation gate, which is the conventional entry point).
 */
function findFirstFlowNode(graph: IntermediateExecutionGraph): ExecutionNode | null {
  if (graph.nodes.length === 0) return null

  const toIds = new Set(graph.edges.map((e) => e.to))
  // Prefer a validation gate or business handler with no incoming edges
  const roots = graph.nodes.filter((n) => !toIds.has(n.id))

  // Prefer validation gate, then handler, then any root
  return (
    roots.find((n) => n.type === IR_NODE_TYPES.VALIDATION_GATE) ??
    roots.find((n) => n.type === IR_NODE_TYPES.BUSINESS_HANDLER) ??
    roots[0] ??
    graph.nodes[0]
  )
}
