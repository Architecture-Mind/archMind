import { readFileSync } from "fs"
import { join } from "path"
import type { IntermediateExecutionGraph, ExecutionNode, ExecutionEdge } from "@kidkender/archmind-protocol"

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
  const header = `  ${node.symbol}${argsStr} [${node.type}]${mutatesStr}`
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

export function serializeExecutionPath(graph: IntermediateExecutionGraph, projectRoot?: string): string {
  const symbolById = new Map(graph.nodes.map((n) => [n.id, n.symbol]))
  const header = `Execution path: ${graph.entrypoint}\n`
  // Suppress code snippets for large graphs to keep prompt size manageable
  const effectiveRoot = graph.nodes.length <= SNIPPET_NODE_THRESHOLD ? projectRoot : undefined
  const nodes = "Nodes:\n" + graph.nodes.map((n) => serializeNode(n, effectiveRoot)).join("\n")
  const edges = "Edges:\n" + graph.edges.map((e) => serializeEdge(e, symbolById)).join("\n")
  return `${header}\n${nodes}\n\n${edges}`
}
