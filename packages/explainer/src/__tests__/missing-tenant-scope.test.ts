import { describe, test, expect } from "@jest/globals"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { detectMissingTenantScope } from "../pattern-detectors/missing-tenant-scope.js"
import { FINDING_TYPES } from "../findings/types.js"

function makeGraph(
  nodes: IntermediateExecutionGraph["nodes"],
  edges: IntermediateExecutionGraph["edges"]
): IntermediateExecutionGraph {
  return {
    entrypoint:  "GET /tasks/{id}",
    method:      "GET",
    path:        "/tasks/{id}",
    annotations: [],
    nodes,
    edges,
  }
}

const BASE_NODES = [
  { id: "ctrl",            type: "controller_action", symbol: "TaskController::show" },
  { id: "tenant_inj",     type: "runtime_injection",  symbol: "app()->instance('tenant', $tenant)", role: "runtime" },
  { id: "unscoped_query", type: "unscoped_query",     symbol: "Task::find", role: "data_access" },
]

const MISSING_EDGE = {
  from:     "unscoped_query",
  to:       "tenant_inj",
  relation: "missing_tenant_scope",
  traceability: "semantic" as const,
}

describe("detectMissingTenantScope", () => {
  test("emits finding when missing_tenant_scope edge exists", () => {
    const graph = makeGraph(BASE_NODES, [MISSING_EDGE])
    const findings = detectMissingTenantScope([], graph)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe(FINDING_TYPES.MISSING_TENANT_SCOPE)
  })

  test("finding severity is CRITICAL", () => {
    const graph = makeGraph(BASE_NODES, [MISSING_EDGE])
    const [f] = detectMissingTenantScope([], graph)
    expect(f.severity).toBe("CRITICAL")
  })

  test("finding confidence is HIGH", () => {
    const graph = makeGraph(BASE_NODES, [MISSING_EDGE])
    const [f] = detectMissingTenantScope([], graph)
    expect(f.confidence).toBe("HIGH")
  })

  test("summary mentions the query symbol", () => {
    const graph = makeGraph(BASE_NODES, [MISSING_EDGE])
    const [f] = detectMissingTenantScope([], graph)
    expect(f.summary).toContain("Task::find")
  })

  test("supporting nodes include both unscoped and injection nodes", () => {
    const graph = makeGraph(BASE_NODES, [MISSING_EDGE])
    const [f] = detectMissingTenantScope([], graph)
    expect(f.provenance.supporting_nodes).toContain("unscoped_query")
    expect(f.provenance.supporting_nodes).toContain("tenant_inj")
  })

  test("supporting edges reference the missing_tenant_scope relation", () => {
    const graph = makeGraph(BASE_NODES, [MISSING_EDGE])
    const [f] = detectMissingTenantScope([], graph)
    expect(f.provenance.supporting_edges.some((e) => e.includes("missing_tenant_scope"))).toBe(true)
  })

  test("uncertainty mentions global scope assumption", () => {
    const graph = makeGraph(BASE_NODES, [MISSING_EDGE])
    const [f] = detectMissingTenantScope([], graph)
    expect(f.uncertainty?.some((u) => u.description.includes("global"))).toBe(true)
  })

  test("recommendations include all three fix options", () => {
    const graph = makeGraph(BASE_NODES, [MISSING_EDGE])
    const [f] = detectMissingTenantScope([], graph)
    expect(f.recommendations).toHaveLength(3)
    expect(f.recommendations?.some((r) => r.includes("tenant_id"))).toBe(true)
    expect(f.recommendations?.some((r) => r.includes("TenantScope"))).toBe(true)
    expect(f.recommendations?.some((r) => r.includes("route model binding"))).toBe(true)
  })

  test("no finding when no missing_tenant_scope edges", () => {
    const graph = makeGraph(BASE_NODES, [
      { from: "ctrl", to: "unscoped_query", relation: "calls", traceability: "static" },
    ])
    const findings = detectMissingTenantScope([], graph)
    expect(findings).toHaveLength(0)
  })

  test("no finding when unscoped node type is wrong", () => {
    const nodes = [
      { id: "ctrl",        type: "controller_action", symbol: "TaskController::show" },
      { id: "tenant_inj", type: "runtime_injection",  symbol: "app()->instance('tenant', $tenant)", role: "runtime" },
      { id: "q",          type: "tenant_scoped_query", symbol: "Task::where", role: "data_access" },
    ]
    const edge = { from: "q", to: "tenant_inj", relation: "missing_tenant_scope", traceability: "semantic" as const }
    const graph = makeGraph(nodes, [edge])
    // q is tenant_scoped_query, not unscoped_query — should not match
    const findings = detectMissingTenantScope([], graph)
    expect(findings).toHaveLength(0)
  })

  test("multiple unscoped queries emit multiple findings", () => {
    const nodes = [
      ...BASE_NODES,
      { id: "unscoped_2", type: "unscoped_query", symbol: "Comment::find", role: "data_access" },
    ]
    const edges = [
      MISSING_EDGE,
      { from: "unscoped_2", to: "tenant_inj", relation: "missing_tenant_scope", traceability: "semantic" as const },
    ]
    const graph = makeGraph(nodes, edges)
    const findings = detectMissingTenantScope([], graph)
    expect(findings).toHaveLength(2)
  })

  test("finding id is stable (same graph → same id)", () => {
    const graph = makeGraph(BASE_NODES, [MISSING_EDGE])
    const [f1] = detectMissingTenantScope([], graph)
    const [f2] = detectMissingTenantScope([], graph)
    expect(f1.id).toBe(f2.id)
  })

  test("empty graph returns no findings", () => {
    const graph = makeGraph([], [])
    expect(detectMissingTenantScope([], graph)).toHaveLength(0)
  })
})
