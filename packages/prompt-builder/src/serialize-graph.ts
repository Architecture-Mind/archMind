import { readFileSync } from "fs"
import { join } from "path"
import type { IntermediateExecutionGraph, ExecutionNode, ExecutionEdge } from "@kidkender/archmind-protocol"
import { IR_EDGE_RELATIONS } from "@kidkender/archmind-protocol"

function extractMethodSnippet(fileContent: string, methodName: string, maxLines = 25): string | null {
  const lines = fileContent.split("\n")
  const methodRegex = new RegExp(`function\\s+${methodName}\\s*\\(`)
  const startIdx = lines.findIndex((l) => methodRegex.test(l))
  if (startIdx === -1) return null
  return lines.slice(startIdx, startIdx + maxLines).join("\n")
}

function loadCodeSlice(node: ExecutionNode, projectRoot: string): string | null {
  if (!node.file) return null
  const parts = node.symbol.split("::")
  const methodName = parts.length === 2 ? parts[1] : null
  if (!methodName) return null
  try {
    const content = readFileSync(join(projectRoot, node.file), "utf-8")
    return extractMethodSnippet(content, methodName)
  } catch {
    return null
  }
}

// Skip code snippets when graph is large to stay within prompt budget
const SNIPPET_NODE_THRESHOLD = 20

function serializeNode(node: ExecutionNode, projectRoot?: string): string {
  const argsStr = node.args?.length ? `(${node.args.join(", ")})` : ""
  const mutatesStr = node.mutates ? " [MUTATES]" : ""
  // node.detail carries semantic info a symbol/type alone can't (e.g. the
  // request-param name driving an ir:conditional_branch, or the actual
  // condition an ir:guard_clause checks). Dropping it silently starves the
  // LLM of exactly the fact it needs — confirmed via live gpt-4o re-run:
  // the graph had the right node, but without this line the model couldn't
  // tell "!empty($newOwnerId)" was about content ownership at all.
  const detailStr = node.detail ? `\n    detail: ${node.detail}` : ""
  const header = `  ${node.symbol}${argsStr} [${node.type}]${mutatesStr}${detailStr}`
  if (!projectRoot) return header
  const snippet = loadCodeSlice(node, projectRoot)
  if (!snippet) return header
  const indented = snippet.split("\n").map((l) => `    ${l}`).join("\n")
  return `${header}\n  Source:\n${indented}`
}

function serializeEdge(edge: ExecutionEdge, symbolById: Map<string, string>): string {
  const from = symbolById.get(edge.from) ?? edge.from
  const to   = symbolById.get(edge.to)   ?? edge.to
  const via  = (edge as { via?: string }).via ? `  via: ${(edge as { via?: string }).via}` : ""
  return `  ${from} → ${to}  [${edge.relation}]${via}`
}

// Nodes wrapped by a transaction boundary have an incoming ir:wraps edge
// (see graph-augmenter's addTransactionNodes). A mutating node with no such
// edge is NOT inside any transaction — that absence must be a visible,
// positive statement rather than something the LLM has to infer (IR v1.5 Phase 3).
function serializeUnwrappedMutations(graph: IntermediateExecutionGraph): string | null {
  const wrappedIds = new Set(
    graph.edges.filter((e) => e.relation === IR_EDGE_RELATIONS.WRAPS).map((e) => e.to)
  )
  const unwrapped = graph.nodes.filter((n) => n.mutates && !wrappedIds.has(n.id))
  if (unwrapped.length === 0) return null

  const lines = unwrapped.map((n) => `  ${n.symbol} [${n.type}] — NOT wrapped in a transaction`)
  return "Unwrapped mutations (no transaction boundary):\n" + lines.join("\n")
}

export function serializeExecutionPath(graph: IntermediateExecutionGraph, projectRoot?: string): string {
  const symbolById = new Map(graph.nodes.map((n) => [n.id, n.symbol]))
  const header = `Execution path: ${graph.entrypoint}\n`
  // Suppress code snippets for large graphs to keep prompt size manageable
  const effectiveRoot = graph.nodes.length <= SNIPPET_NODE_THRESHOLD ? projectRoot : undefined
  const nodes = "Nodes:\n" + graph.nodes.map((n) => serializeNode(n, effectiveRoot)).join("\n")
  const edges = "Edges:\n" + graph.edges.map((e) => serializeEdge(e, symbolById)).join("\n")
  const unwrappedSection = serializeUnwrappedMutations(graph)
  return `${header}\n${nodes}\n\n${edges}${unwrappedSection ? `\n\n${unwrappedSection}` : ""}`
}
