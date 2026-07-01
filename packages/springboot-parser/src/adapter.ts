import { randomUUID } from "crypto"
import type { IntermediateExecutionGraph, ExecutionNode, ExecutionEdge } from "@kidkender/archmind-protocol"
import type { SemanticAdapter } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES, IR_VERSION } from "@kidkender/archmind-protocol"
import { findJavaFiles, isControllerFile } from "./scanner.js"
import { parseControllerFile } from "./controller-parser.js"
import { emitGraph } from "./ir-emitter.js"
import { buildBaseClassIndex } from "./inheritance-resolver.js"
import { parseSecurityConfigs, matchSecurityRule, type SecurityRule } from "./security-config-parser.js"

export class SpringBootAdapter implements SemanticAdapter {
  parseProject(root: string): IntermediateExecutionGraph[] {
    const allFiles       = findJavaFiles(root)
    const controllerFiles = allFiles.filter(isControllerFile)

    // Build cross-file indices once
    const baseClassIndex = buildBaseClassIndex(allFiles)
    const securityRules  = parseSecurityConfigs(allFiles)

    const graphs: IntermediateExecutionGraph[] = []

    for (const file of controllerFiles) {
      try {
        const methods = parseControllerFile(file, baseClassIndex)
        for (const m of methods) {
          const graph = emitGraph(m)
          injectSecurityNodes(graph, securityRules)
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

function injectSecurityNodes(graph: IntermediateExecutionGraph, rules: SecurityRule[]): void {
  // Only inject if the method has NO per-method auth annotations already
  const hasMethodAuth = graph.nodes.some(
    (n) => n.type === IR_NODE_TYPES.AUTH_GATE || n.type === IR_NODE_TYPES.AUTHZ_CHECK,
  )
  if (hasMethodAuth || rules.length === 0) return

  const rule = matchSecurityRule(graph.path, rules)
  if (!rule || rule.irAuthType === null) return  // public endpoint or no match

  // Find the first node in the execution flow (typically validation gate or handler)
  const firstNode = findFirstFlowNode(graph)
  if (!firstNode) return

  const authId = `sec_${randomUUID().slice(0, 8)}`
  const authNode: ExecutionNode = {
    id:     authId,
    type:   rule.irAuthType,
    symbol: rule.roles.length > 0
      ? `hasRole(${rule.roles.join(", ")})`
      : "isAuthenticated()",
    args:   rule.roles,
  }

  graph.nodes.unshift(authNode)

  const edge: ExecutionEdge = {
    from:          authId,
    to:            firstNode.id,
    relation:      "ir:guards",
    traceability:  "static",
  }
  graph.edges.unshift(edge)
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
