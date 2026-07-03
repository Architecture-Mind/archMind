import type { IntermediateExecutionGraph, EdgeTraceability } from "@kidkender/archmind-protocol"
import type { GoldenTrace } from "@kidkender/archmind-scorer"

function parseEntrypoint(entrypoint: string): { method: string; path: string } {
  const parts = entrypoint.trim().split(/\s+/)
  if (parts.length >= 2) {
    return { method: parts[0]!, path: parts[1]! }
  }
  return { method: "ANY", path: entrypoint }
}

export function goldenTraceToGraph(trace: GoldenTrace): IntermediateExecutionGraph {
  const { method, path } = parseEntrypoint(trace.entrypoint)

  const nodes = trace.nodes.map((n) => ({ ...n }))

  const edges = trace.edges
    .filter((e) => e.to != null)
    .map((e) => {
      const { via, edge_type, ...rest } = e as typeof e & { via?: string; edge_type?: string }
      const traceability: EdgeTraceability = edge_type === "RUNTIME_EDGE" ? "runtime" : "static"
      return {
        ...rest,
        traceability,
        ...(via != null ? { mechanism: via } : {}),
      }
    })

  return {
    entrypoint: trace.entrypoint,
    method,
    path,
    nodes,
    edges,
    annotations: trace.annotations ?? [],
  }
}
