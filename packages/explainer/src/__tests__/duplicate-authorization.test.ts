import { describe, test, expect, beforeEach } from "@jest/globals"
import { extractAuthorizationFacts } from "../fact-extraction/authorization.js"
import { detectDuplicateAuthorization } from "../pattern-detectors/duplicate-authorization.js"
import { FINDING_TYPES } from "../findings/types.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const AUTH_001_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "PUT /tasks/{id}",
  method: "PUT",
  path: "/tasks/{id}",
  nodes: [
    { id: "sanctum", type: "middleware", symbol: "auth:sanctum" },
    { id: "resolve_tenant", type: "middleware", symbol: "ResolveTenant::handle" },
    { id: "check_permission", type: "middleware", symbol: "CheckPermission::handle", args: ["task.update"] },
    { id: "task_controller_update", type: "controller", symbol: "TaskController::update" },
    { id: "update_task_request", type: "form_request", symbol: "UpdateTaskRequest::authorize" },
    { id: "task_policy_update", type: "policy", symbol: "TaskPolicy::update" },
    { id: "permission_service_1", type: "service_call", symbol: "PermissionService::hasPermission", args: ["TASK_UPDATE"] },
    { id: "permission_service_2", type: "service_call", symbol: "PermissionService::hasPermission", args: ["TASK_UPDATE"] },
  ],
  edges: [
    { from: "sanctum", to: "resolve_tenant", relation: "next_middleware", traceability: "static" },
    { from: "resolve_tenant", to: "check_permission", relation: "next_middleware", traceability: "static" },
    { from: "check_permission", to: "task_controller_update", relation: "next_middleware", traceability: "static" },
    { from: "task_controller_update", to: "update_task_request", relation: "form_request", traceability: "static" },
    { from: "task_controller_update", to: "task_policy_update", relation: "policy_check", traceability: "static", mechanism: "$this->authorize('update', $task)" },
    { from: "check_permission", to: "permission_service_1", relation: "calls", traceability: "static" },
    { from: "task_policy_update", to: "permission_service_2", relation: "calls", traceability: "static" },
  ],
  annotations: [],
}

describe("detectDuplicateAuthorization — AUTH-001", () => {
  let findings: ReturnType<typeof detectDuplicateAuthorization>

  beforeEach(() => {
    const facts = extractAuthorizationFacts(AUTH_001_GRAPH)
    findings = detectDuplicateAuthorization(facts, AUTH_001_GRAPH)
  })

  test("emits at least one duplicate_authorization finding", () => {
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0]!.type).toBe(FINDING_TYPES.DUPLICATE_AUTHORIZATION)
  })

  test("finding covers the 'update' ability", () => {
    const finding = findings.find((f) => f.summary.includes("update"))
    expect(finding).toBeDefined()
  })

  test("finding involves nodes from multiple layers", () => {
    const finding = findings[0]!
    expect(finding.provenance.supporting_nodes.length).toBeGreaterThanOrEqual(2)
  })

  test("finding has reasoning steps", () => {
    const finding = findings[0]!
    expect(finding.reasoning.length).toBeGreaterThan(0)
    const types = finding.reasoning.map((r) => r.type)
    expect(types).toContain("execution_overlap_detected")
  })

  test("finding has evidence entries", () => {
    expect(findings[0]!.evidence.length).toBeGreaterThan(0)
  })

  test("finding has a recommendation", () => {
    expect(findings[0]!.recommendations?.length).toBeGreaterThan(0)
  })

  test("severity is LOW for duplicate auth (informational)", () => {
    expect(findings[0]!.severity).toBe("LOW")
  })
})

describe("detectDuplicateAuthorization — no duplicate", () => {
  test("returns no findings when only one layer checks a permission", () => {
    const graph: IntermediateExecutionGraph = {
      entrypoint: "GET /tasks",
      method: "GET",
      path: "/tasks",
      nodes: [
        { id: "check_permission", type: "middleware", symbol: "CheckPermission::handle", args: ["task.view"] },
      ],
      edges: [],
      annotations: [],
    }

    const facts = extractAuthorizationFacts(graph)
    const findings = detectDuplicateAuthorization(facts, graph)
    expect(findings).toHaveLength(0)
  })
})
