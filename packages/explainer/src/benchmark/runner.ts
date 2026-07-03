import { loadGoldenTrace } from "@kidkender/archmind-scorer"
import { explain } from "../index.js"
import { goldenTraceToGraph } from "./graph-builder.js"
import { scoreExplainer } from "./scorer.js"
import type { ExplainerBenchmarkSnapshot, ExplainerTraceSnapshot } from "./types.js"

export function runExplainerBenchmark(traceFiles: string[]): ExplainerBenchmarkSnapshot {
  const traces: ExplainerTraceSnapshot[] = traceFiles.map((file) => {
    const trace = loadGoldenTrace(file)
    const graph = goldenTraceToGraph(trace)
    const findings = explain(graph)
    const expected = trace.expected_findings ?? []
    const { recall, node_coverage, hits, misses } = scoreExplainer(findings, expected)

    return {
      trace_id: trace.id,
      recall,
      node_coverage,
      finding_count: findings.length,
      expected_count: expected.length,
      hits,
      misses,
    }
  })

  const avg_recall =
    traces.length === 0 ? 1 : traces.reduce((sum, t) => sum + t.recall, 0) / traces.length

  return {
    run_at: new Date().toISOString(),
    traces,
    avg_recall,
  }
}
