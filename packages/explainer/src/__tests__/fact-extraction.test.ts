import { describe, test, expect } from "@jest/globals"
import { extractAuthorizationFacts, normalizeAbility } from "../fact-extraction/authorization.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

describe("normalizeAbility", () => {
  test("dot notation: last segment", () => {
    expect(normalizeAbility("task.update")).toBe("update")
  })

  test("SCREAMING_SNAKE: segment index 1", () => {
    expect(normalizeAbility("TASK_UPDATE")).toBe("update")
  })

  test("SCREAMING_SNAKE with suffix: still segment index 1, not last", () => {
    expect(normalizeAbility("TASK_UPDATE_ANY")).toBe("update")
  })

  test("plain lowercase", () => {
    expect(normalizeAbility("update")).toBe("update")
  })

  test("trim whitespace", () => {
    expect(normalizeAbility("  task.update  ")).toBe("update")
  })
})

describe("extractAuthorizationFacts — AUTH-001 graph", () => {
  const graph: IntermediateExecutionGraph = {
    entrypoint: "PUT /tasks/{id}",
    method: "PUT",
    path: "/tasks/{id}",
    nodes: [
      { id: "sanctum", type: "middleware", symbol: "auth:sanctum" },
      { id: "resolve_tenant", type: "middleware", symbol: "ResolveTenant::handle" },
      {
        id: "check_permission",
        type: "middleware",
        symbol: "CheckPermission::handle",
        args: ["task.update"],
      },
      { id: "task_controller_update", type: "controller", symbol: "TaskController::update" },
      { id: "update_task_request", type: "form_request", symbol: "UpdateTaskRequest::authorize" },
      { id: "task_policy_update", type: "policy", symbol: "TaskPolicy::update" },
      {
        id: "permission_service_1",
        type: "service_call",
        symbol: "PermissionService::hasPermission",
        args: ["TASK_UPDATE"],
      },
      {
        id: "permission_service_2",
        type: "service_call",
        symbol: "PermissionService::hasPermission",
        args: ["TASK_UPDATE"],
      },
    ],
    edges: [
      { from: "sanctum", to: "resolve_tenant", relation: "next_middleware", traceability: "static" },
      { from: "resolve_tenant", to: "check_permission", relation: "next_middleware", traceability: "static", side_effect: "injects app('tenant')" },
      { from: "check_permission", to: "task_controller_update", relation: "next_middleware", traceability: "static" },
      { from: "task_controller_update", to: "update_task_request", relation: "form_request", traceability: "static" },
      { from: "task_controller_update", to: "task_policy_update", relation: "policy_check", traceability: "static", mechanism: "$this->authorize('update', $task)" },
      { from: "check_permission", to: "permission_service_1", relation: "calls", traceability: "static" },
      { from: "task_policy_update", to: "permission_service_2", relation: "calls", traceability: "static" },
    ],
    annotations: [],
  }

  test("extracts authorization facts from authorization-relevant nodes", () => {
    const facts = extractAuthorizationFacts(graph)
    expect(facts.length).toBeGreaterThan(0)
    expect(facts.every((f) => f.kind === "authorization_check")).toBe(true)
  })

  test("check_permission: middleware layer, ability=update, HIGH confidence", () => {
    const facts = extractAuthorizationFacts(graph)
    const f = facts.find((f) => f.nodeId === "check_permission")
    expect(f).toBeDefined()
    expect(f!.layer).toBe("middleware")
    expect(f!.ability).toBe("update")
    expect(f!.confidence).toBe("HIGH")
  })

  test("task_policy_update: policy layer", () => {
    const facts = extractAuthorizationFacts(graph)
    const f = facts.find((f) => f.nodeId === "task_policy_update")
    expect(f).toBeDefined()
    expect(f!.layer).toBe("policy")
  })

  test("permission_service_1: service layer, ability=update", () => {
    const facts = extractAuthorizationFacts(graph)
    const f = facts.find((f) => f.nodeId === "permission_service_1")
    expect(f).toBeDefined()
    expect(f!.layer).toBe("service")
    expect(f!.ability).toBe("update")
  })

  test("non-auth nodes are excluded", () => {
    const facts = extractAuthorizationFacts(graph)
    const ids = new Set(facts.map((f) => f.nodeId))
    expect(ids.has("task_controller_update")).toBe(false)
    expect(ids.has("update_task_request")).toBe(false)
  })
})
