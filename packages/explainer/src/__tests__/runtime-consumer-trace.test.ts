import { describe, test, expect, beforeEach } from "@jest/globals"
import { extractFacts } from "../fact-extraction/index.js"
import { detectRuntimeConsumerTrace } from "../pattern-detectors/runtime-consumer-trace.js"
import { FINDING_TYPES } from "../findings/types.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

// Mirrors real tenant-workspace-api shape for PUT /tasks/{task}
const TASK_UPDATE_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "PUT /tasks/{task}",
  method: "PUT",
  path: "/tasks/{task}",
  nodes: [
    { id: "mw_auth",      type: "authentication_gate", symbol: "auth:sanctum",                    role: "authentication" },
    { id: "mw_tenant",    type: "middleware",          symbol: "ResolveTenant",                   role: "middleware" },
    { id: "mw_perm",      type: "authorization_check", symbol: "permission:Permission::TASK_UPDATE", role: "authorization", args: ["Permission::TASK_UPDATE"] },
    { id: "ctrl",         type: "controller_action",   symbol: "TaskController::update",           role: "handler" },
    { id: "svc_get",      type: "service_call",        symbol: "TaskService::getTask",             role: "service" },
    { id: "svc_update",   type: "service_call",        symbol: "TaskService::updateTask",          role: "service" },
    { id: "tenant_inj",   type: "runtime_injection",   symbol: "app()->instance('tenant', $tenant)", role: "runtime" },
  ],
  edges: [
    { from: "mw_auth",   to: "mw_tenant",  relation: "next_middleware", traceability: "static" },
    { from: "mw_tenant", to: "mw_perm",    relation: "next_middleware", traceability: "static" },
    { from: "mw_perm",   to: "ctrl",       relation: "next_middleware", traceability: "static" },
    { from: "ctrl",      to: "svc_get",    relation: "calls",          traceability: "semantic" },
    { from: "ctrl",      to: "svc_update", relation: "calls",          traceability: "semantic" },
  ],
  annotations: [],
}

// Graph with no runtime_injection — should produce no finding
const NO_INJECTION_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "GET /plans",
  method: "GET",
  path: "/plans",
  nodes: [
    { id: "ctrl", type: "controller_action", symbol: "PlanController::index", role: "handler" },
  ],
  edges: [],
  annotations: [],
}

// Graph with injection but no controller/service downstream — no consumers
const INJECTION_NO_CONSUMERS_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "PUT /isolated",
  method: "PUT",
  path: "/isolated",
  nodes: [
    { id: "inj", type: "runtime_injection", symbol: "app()->instance('context', $ctx)", role: "runtime" },
  ],
  edges: [],
  annotations: [],
}

describe("detectRuntimeConsumerTrace — task update graph", () => {
  let findings: ReturnType<typeof detectRuntimeConsumerTrace>

  beforeEach(() => {
    const facts = extractFacts(TASK_UPDATE_GRAPH)
    findings = detectRuntimeConsumerTrace(facts, TASK_UPDATE_GRAPH)
  })

  test("emits exactly one finding", () => {
    expect(findings).toHaveLength(1)
  })

  test("finding type is runtime_consumer_trace", () => {
    expect(findings[0]!.type).toBe(FINDING_TYPES.RUNTIME_CONSUMER_TRACE)
  })

  test("severity is MEDIUM", () => {
    expect(findings[0]!.severity).toBe("MEDIUM")
  })

  test("summary names the injected key", () => {
    expect(findings[0]!.summary).toContain("tenant")
  })

  test("summary names the consumer count", () => {
    // 1 controller + 2 service calls = 3 consumers
    expect(findings[0]!.summary).toContain("3")
  })

  test("supporting nodes include injector, controller, and both service calls", () => {
    const nodes = findings[0]!.provenance.supporting_nodes
    expect(nodes).toContain("tenant_inj")
    expect(nodes).toContain("ctrl")
    expect(nodes).toContain("svc_get")
    expect(nodes).toContain("svc_update")
  })

  test("evidence lists injector and all consumers", () => {
    // injector + 1 ctrl + 2 service = 4 evidence entries
    expect(findings[0]!.evidence.length).toBe(4)
  })

  test("reasoning contains removal_impact step", () => {
    const types = findings[0]!.reasoning.map((r) => r.type)
    expect(types).toContain("removal_impact")
  })

  test("removal_impact mentions all consumers count", () => {
    const impact = findings[0]!.reasoning.find((r) => r.type === "removal_impact")
    expect(String(impact?.description)).toContain("3 node(s)")
  })

  test("recommendations mention BindingResolutionException", () => {
    const recs = findings[0]!.recommendations?.join(" ") ?? ""
    expect(recs).toContain("TaskController::update")
    expect(recs).toContain("TaskService::getTask")
    expect(recs).toContain("TaskService::updateTask")
  })

  test("has two recommendations", () => {
    expect(findings[0]!.recommendations).toHaveLength(2)
  })
})

describe("detectRuntimeConsumerTrace — no finding cases", () => {
  test("returns no findings when no runtime_injection exists", () => {
    const facts = extractFacts(NO_INJECTION_GRAPH)
    const findings = detectRuntimeConsumerTrace(facts, NO_INJECTION_GRAPH)
    expect(findings).toHaveLength(0)
  })

  test("returns no findings when injection has no downstream controller or service", () => {
    const facts = extractFacts(INJECTION_NO_CONSUMERS_GRAPH)
    const findings = detectRuntimeConsumerTrace(facts, INJECTION_NO_CONSUMERS_GRAPH)
    expect(findings).toHaveLength(0)
  })
})
