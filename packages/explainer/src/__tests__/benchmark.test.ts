import { describe, test, expect } from "@jest/globals"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { loadGoldenTrace } from "@kidkender/archmind-scorer"
import { explain } from "../index.js"
import { goldenTraceToGraph } from "../benchmark/graph-builder.js"
import { scoreExplainer } from "../benchmark/scorer.js"
import { runExplainerBenchmark } from "../benchmark/runner.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

const TRACES_DIR = join(
  __dirname,
  "../../../..",
  "research/golden-traces/laravel"
)

const TRACE_FILES = [
  join(TRACES_DIR, "LARAVEL-AUTH-001.yaml"),
  join(TRACES_DIR, "LARAVEL-AUTH-002.yaml"),
  join(TRACES_DIR, "LARAVEL-VALIDATION-001.yaml"),
  join(TRACES_DIR, "LARAVEL-RUNTIME-001.yaml"),
  join(TRACES_DIR, "LARAVEL-NOTIFICATION-001.yaml"),
  join(TRACES_DIR, "LARAVEL-API-RESOURCE-001.yaml"),
]

describe("goldenTraceToGraph", () => {
  test("converts AUTH-001 to a valid graph", () => {
    const trace = loadGoldenTrace(TRACE_FILES[0]!)
    const graph = goldenTraceToGraph(trace)
    expect(graph.method).toBe("PUT")
    expect(graph.path).toBe("/tasks/{id}")
    expect(graph.nodes.length).toBe(trace.nodes.length)
  })

  test("filters null-to edges from VALIDATION-001", () => {
    const trace = loadGoldenTrace(TRACE_FILES[2]!)
    const graph = goldenTraceToGraph(trace)
    const nullEdges = graph.edges.filter((e) => e.to == null)
    expect(nullEdges).toHaveLength(0)
  })

  test("maps RUNTIME_EDGE to runtime traceability", () => {
    const trace = loadGoldenTrace(TRACE_FILES[3]!)
    const graph = goldenTraceToGraph(trace)
    const runtimeEdges = graph.edges.filter((e) => e.traceability === "runtime")
    expect(runtimeEdges.length).toBeGreaterThan(0)
  })

  test("preserves extra node fields (role, returns, key, consumes_key)", () => {
    const trace = loadGoldenTrace(TRACE_FILES[2]!)
    const graph = goldenTraceToGraph(trace)
    const req = graph.nodes.find((n) => n.id === "update_task_request") as unknown as Record<string, unknown>
    expect(req).toBeDefined()
    expect(req!["role"]).toBe("validation_only")
  })
})

describe("scoreExplainer", () => {
  test("recall is 1 when all expected types are found", () => {
    const findings = [{ type: "duplicate_authorization", provenance: { supporting_nodes: ["a", "b"] } }] as never
    const expected = [{ type: "duplicate_authorization", required_nodes: ["a", "b"] }]
    const { recall } = scoreExplainer(findings, expected)
    expect(recall).toBe(1)
  })

  test("recall is 0 when no expected types are found", () => {
    const { recall } = scoreExplainer([], [{ type: "duplicate_authorization", required_nodes: [] }])
    expect(recall).toBe(0)
  })

  test("recall is 1 and node_coverage is 1 when expected is empty", () => {
    const { recall, node_coverage } = scoreExplainer([], [])
    expect(recall).toBe(1)
    expect(node_coverage).toBe(1)
  })
})

describe("explainer benchmark — recall ≥ 1.0 on all traces", () => {
  for (const file of TRACE_FILES) {
    const trace = loadGoldenTrace(file)
    const expected = trace.expected_findings ?? []

    test(`${trace.id}: recall = 1`, () => {
      const graph = goldenTraceToGraph(trace)
      const findings = explain(graph)
      const { recall, misses } = scoreExplainer(findings, expected)
      expect(misses).toHaveLength(0)
      expect(recall).toBe(1)
    })
  }
})

describe("explainer benchmark — ID stability", () => {
  for (const file of TRACE_FILES) {
    const trace = loadGoldenTrace(file)

    test(`${trace.id}: finding IDs are stable across two runs`, () => {
      const graph = goldenTraceToGraph(trace)
      const run1 = explain(graph).map((f) => f.id).sort()
      const run2 = explain(graph).map((f) => f.id).sort()
      expect(run1).toEqual(run2)
    })
  }
})

describe("runExplainerBenchmark", () => {
  test("avg_recall is 1 across all traces", () => {
    const snapshot = runExplainerBenchmark(TRACE_FILES)
    expect(snapshot.avg_recall).toBe(1)
  })

  test("snapshot contains one entry per trace file", () => {
    const snapshot = runExplainerBenchmark(TRACE_FILES)
    expect(snapshot.traces).toHaveLength(TRACE_FILES.length)
  })
})

describe("explainer benchmark — ranking (expected_top_finding)", () => {
  for (const file of TRACE_FILES) {
    const trace = loadGoldenTrace(file)
    const expectedTop = trace.expected_top_finding

    if (expectedTop == null) continue

    test(`${trace.id}: findings[0].type === "${expectedTop}"`, () => {
      const graph = goldenTraceToGraph(trace)
      const findings = explain(graph)
      expect(findings.length).toBeGreaterThan(0)
      expect(findings[0]!.type).toBe(expectedTop)
    })
  }
})
