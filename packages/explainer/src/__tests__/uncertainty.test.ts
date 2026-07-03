import { describe, test, expect } from "@jest/globals"
import { minConfidence, checkMissingNodes } from "../findings/uncertainty.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const EMPTY_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "GET /ping",
  method: "GET",
  path: "/ping",
  nodes: [{ id: "ctrl", type: "controller", symbol: "PingController::index" }],
  edges: [],
  annotations: [],
}

describe("minConfidence", () => {
  test("returns HIGH when all confidences are HIGH", () => {
    expect(minConfidence(["HIGH", "HIGH", "HIGH"])).toBe("HIGH")
  })

  test("returns MEDIUM when mix of HIGH and MEDIUM", () => {
    expect(minConfidence(["HIGH", "MEDIUM"])).toBe("MEDIUM")
  })

  test("returns LOW when any confidence is LOW", () => {
    expect(minConfidence(["HIGH", "MEDIUM", "LOW"])).toBe("LOW")
  })

  test("returns LOW when only LOW", () => {
    expect(minConfidence(["LOW"])).toBe("LOW")
  })

  test("returns MEDIUM when empty (safe default)", () => {
    expect(minConfidence([])).toBe("MEDIUM")
  })
})

describe("checkMissingNodes", () => {
  test("returns empty array when all nodes are present", () => {
    const reasons = checkMissingNodes(["ctrl"], EMPTY_GRAPH)
    expect(reasons).toHaveLength(0)
  })

  test("returns missing_node reason for absent node", () => {
    const reasons = checkMissingNodes(["ctrl", "ghost"], EMPTY_GRAPH)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]!.kind).toBe("missing_node")
    expect((reasons[0]! as { kind: "missing_node"; nodeId: string }).nodeId).toBe("ghost")
  })

  test("description names the missing node", () => {
    const reasons = checkMissingNodes(["phantom"], EMPTY_GRAPH)
    expect(reasons[0]!.description).toContain("phantom")
  })

  test("returns one reason per missing node", () => {
    const reasons = checkMissingNodes(["a", "b", "ctrl"], EMPTY_GRAPH)
    expect(reasons).toHaveLength(2)
    const ids = reasons.map((r) => (r as { kind: string; nodeId: string }).nodeId)
    expect(ids).toContain("a")
    expect(ids).toContain("b")
  })

  test("returns empty array when nodeIds is empty", () => {
    expect(checkMissingNodes([], EMPTY_GRAPH)).toHaveLength(0)
  })
})

describe("UncertaintyReason discriminated union narrowing", () => {
  test("unverifiable_condition has only description", () => {
    const r = { kind: "unverifiable_condition" as const, description: "cannot verify" }
    if (r.kind === "unverifiable_condition") {
      expect(r.description).toBe("cannot verify")
    }
  })

  test("missing_node has nodeId and description", () => {
    const r = { kind: "missing_node" as const, nodeId: "x", description: "node x missing" }
    if (r.kind === "missing_node") {
      expect(r.nodeId).toBe("x")
      expect(r.description).toBe("node x missing")
    }
  })

  test("low_fact_confidence has nodeId and description", () => {
    const r = { kind: "low_fact_confidence" as const, nodeId: "y", description: "low confidence" }
    if (r.kind === "low_fact_confidence") {
      expect(r.nodeId).toBe("y")
    }
  })

  test("inferred_symbol has nodeId and description", () => {
    const r = { kind: "inferred_symbol" as const, nodeId: "z", description: "inferred" }
    if (r.kind === "inferred_symbol") {
      expect(r.nodeId).toBe("z")
    }
  })

  test("no_consumers_detected has only description", () => {
    const r = { kind: "no_consumers_detected" as const, description: "no consumers" }
    if (r.kind === "no_consumers_detected") {
      expect(r.description).toBe("no consumers")
    }
  })
})
