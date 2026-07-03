import { describe, test, expect } from "@jest/globals"
import { extractRuntimeInjectionFacts } from "../fact-extraction/runtime.js"
import { detectHiddenRuntimeDependency } from "../pattern-detectors/hidden-runtime-dependency.js"
import { FINDING_TYPES } from "../findings/types.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const RUNTIME_001_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "ANY /tasks/*",
  method: "GET",
  path: "/tasks/*",
  nodes: [
    {
      id: "resolve_tenant",
      type: "middleware",
      symbol: "ResolveTenant::handle",
    },
    {
      id: "container_instance",
      type: "runtime_injection",
      symbol: "app()->instance('tenant', $tenant)",
    },
    {
      id: "task_controller",
      type: "controller",
      symbol: "TaskController",
    },
    {
      id: "require_feature",
      type: "middleware",
      symbol: "RequireFeature::handle",
    },
  ],
  edges: [
    {
      from: "resolve_tenant",
      to: "container_instance",
      relation: "runtime_inject",
      traceability: "runtime",
      mechanism: "app()->instance('tenant', $tenant)",
    },
    {
      from: "container_instance",
      to: "task_controller",
      relation: "runtime_consume",
      traceability: "runtime",
      mechanism: "app('tenant')",
    },
    {
      from: "container_instance",
      to: "require_feature",
      relation: "runtime_consume",
      traceability: "runtime",
      mechanism: "app('tenant')",
    },
  ],
  annotations: [],
}

describe("extractRuntimeInjectionFacts — RUNTIME-001", () => {
  test("extracts fact for runtime_injection node", () => {
    const facts = extractRuntimeInjectionFacts(RUNTIME_001_GRAPH)
    expect(facts.length).toBe(1)
    expect(facts[0]!.nodeId).toBe("container_instance")
  })

  test("extracts injected key 'tenant'", () => {
    const facts = extractRuntimeInjectionFacts(RUNTIME_001_GRAPH)
    expect(facts[0]!.injectedValue).toBe("tenant")
  })

  test("HIGH confidence when key extracted from mechanism", () => {
    const facts = extractRuntimeInjectionFacts(RUNTIME_001_GRAPH)
    expect(facts[0]!.confidence).toBe("HIGH")
  })
})

describe("detectHiddenRuntimeDependency — RUNTIME-001", () => {
  test("emits hidden_runtime_dependency finding", () => {
    const facts = extractRuntimeInjectionFacts(RUNTIME_001_GRAPH)
    const findings = detectHiddenRuntimeDependency(facts, RUNTIME_001_GRAPH)

    expect(findings.length).toBe(1)
    expect(findings[0]!.type).toBe(FINDING_TYPES.HIDDEN_RUNTIME_DEPENDENCY)
  })

  test("severity is HIGH", () => {
    const facts = extractRuntimeInjectionFacts(RUNTIME_001_GRAPH)
    const findings = detectHiddenRuntimeDependency(facts, RUNTIME_001_GRAPH)
    expect(findings[0]!.severity).toBe("HIGH")
  })

  test("summary mentions injected key and consumer count", () => {
    const facts = extractRuntimeInjectionFacts(RUNTIME_001_GRAPH)
    const findings = detectHiddenRuntimeDependency(facts, RUNTIME_001_GRAPH)
    expect(findings[0]!.summary).toContain("tenant")
    expect(findings[0]!.summary).toContain("2")
  })

  test("reasoning contains implicit_contract_detected step", () => {
    const facts = extractRuntimeInjectionFacts(RUNTIME_001_GRAPH)
    const findings = detectHiddenRuntimeDependency(facts, RUNTIME_001_GRAPH)
    const types = findings[0]!.reasoning.map((r) => r.type)
    expect(types).toContain("implicit_contract_detected")
  })

  test("has recommendations", () => {
    const facts = extractRuntimeInjectionFacts(RUNTIME_001_GRAPH)
    const findings = detectHiddenRuntimeDependency(facts, RUNTIME_001_GRAPH)
    expect(findings[0]!.recommendations?.length).toBeGreaterThan(0)
  })

  test("no finding when no runtime_injection nodes", () => {
    const graph: IntermediateExecutionGraph = {
      entrypoint: "GET /ping",
      method: "GET",
      path: "/ping",
      nodes: [{ id: "ctrl", type: "controller", symbol: "PingController::index" }],
      edges: [],
      annotations: [],
    }
    const facts = extractRuntimeInjectionFacts(graph)
    const findings = detectHiddenRuntimeDependency(facts, graph)
    expect(findings).toHaveLength(0)
  })
})
