import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { detectDeadMiddleware } from "../pattern-detectors/dead-middleware.js"
import { detectCircularDependency } from "../pattern-detectors/circular-dependency.js"

function baseGraph(overrides: Partial<IntermediateExecutionGraph> = {}): IntermediateExecutionGraph {
  return {
    entrypoint: "GET /test",
    method: "GET",
    path: "/test",
    framework: "laravel",
    adapter_ver: "0.1.0",
    ir_ver: "1.1",
    nodes: [],
    edges: [],
    annotations: [],
    ...overrides,
  }
}

// ---- dead_middleware ----------------------------------------------------------

describe("detectDeadMiddleware", () => {
  it("returns empty when no middleware nodes", () => {
    const graph = baseGraph({
      nodes: [{ id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::index" }],
      edges: [],
    })
    expect(detectDeadMiddleware(graph)).toHaveLength(0)
  })

  it("returns empty when middleware has outgoing edge", () => {
    const graph = baseGraph({
      nodes: [
        { id: "mw", type: "ir:auth_gate", symbol: "auth:sanctum" },
        { id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::index" },
      ],
      edges: [{ from: "mw", to: "ctrl", relation: "ir:guards", traceability: "static" as const }],
    })
    expect(detectDeadMiddleware(graph)).toHaveLength(0)
  })

  it("fires when middleware has no outgoing edges", () => {
    const graph = baseGraph({
      nodes: [
        { id: "mw", type: "ir:auth_gate", symbol: "auth:sanctum" },
        { id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::index" },
      ],
      edges: [],
    })
    const findings = detectDeadMiddleware(graph)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("dead_middleware")
    expect(findings[0].severity).toBe("MEDIUM")
    expect(findings[0].summary).toContain("auth:sanctum")
  })

  it("reports each dangling middleware separately", () => {
    const graph = baseGraph({
      nodes: [
        { id: "mw1", type: "ir:auth_gate", symbol: "auth:sanctum" },
        { id: "mw2", type: "ir:auth_gate", symbol: "throttle:api" },
        { id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::index" },
      ],
      edges: [],
    })
    const findings = detectDeadMiddleware(graph)
    expect(findings).toHaveLength(2)
  })

  it("only flags middleware with zero outgoing edges — not those with any edge", () => {
    const graph = baseGraph({
      nodes: [
        { id: "mw1", type: "ir:auth_gate", symbol: "auth:sanctum" },
        { id: "mw2", type: "ir:auth_gate", symbol: "throttle:api" },
        { id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::index" },
      ],
      edges: [{ from: "mw1", to: "ctrl", relation: "ir:guards", traceability: "static" as const }],
    })
    const findings = detectDeadMiddleware(graph)
    expect(findings).toHaveLength(1)
    expect(findings[0].summary).toContain("throttle:api")
  })
})

// ---- circular_dependency -----------------------------------------------------

describe("detectCircularDependency", () => {
  it("returns empty for graph with no service nodes", () => {
    const graph = baseGraph({
      nodes: [{ id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::index" }],
      edges: [],
    })
    expect(detectCircularDependency(graph)).toHaveLength(0)
  })

  it("returns empty for linear service chain with no cycle", () => {
    const graph = baseGraph({
      nodes: [
        { id: "s1", type: "ir:service_call", symbol: "OrderService::process" },
        { id: "s2", type: "ir:service_call", symbol: "PaymentService::charge" },
      ],
      edges: [{ from: "s1", to: "s2", relation: "ir:calls", traceability: "static" as const }],
    })
    expect(detectCircularDependency(graph)).toHaveLength(0)
  })

  it("fires for A → B → A circular dependency", () => {
    const graph = baseGraph({
      nodes: [
        { id: "s1", type: "ir:service_call", symbol: "OrderService::process" },
        { id: "s2", type: "ir:service_call", symbol: "PaymentService::charge" },
        { id: "s3", type: "ir:service_call", symbol: "OrderService::validate" },
      ],
      edges: [
        { from: "s1", to: "s2", relation: "ir:calls", traceability: "static" as const },
        { from: "s2", to: "s3", relation: "ir:calls", traceability: "static" as const },
      ],
    })
    const findings = detectCircularDependency(graph)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("circular_dependency")
    expect(findings[0].severity).toBe("HIGH")
    expect(findings[0].summary).toContain("OrderService")
    expect(findings[0].summary).toContain("PaymentService")
  })

  it("does not fire when same-class nodes have no ir:calls edges between services", () => {
    const graph = baseGraph({
      nodes: [
        { id: "s1", type: "ir:service_call", symbol: "OrderService::a" },
        { id: "s2", type: "ir:service_call", symbol: "OrderService::b" },
      ],
      edges: [],
    })
    expect(detectCircularDependency(graph)).toHaveLength(0)
  })

  it("ignores non-ir:calls edges between service nodes", () => {
    const graph = baseGraph({
      nodes: [
        { id: "s1", type: "ir:service_call", symbol: "ServiceA::x" },
        { id: "s2", type: "ir:service_call", symbol: "ServiceB::y" },
        { id: "s3", type: "ir:service_call", symbol: "ServiceA::z" },
      ],
      edges: [
        { from: "s1", to: "s2", relation: "ir:precedes", traceability: "static" as const },
        { from: "s2", to: "s3", relation: "ir:precedes", traceability: "static" as const },
      ],
    })
    expect(detectCircularDependency(graph)).toHaveLength(0)
  })
})
