import { describe, test, expect } from "@jest/globals"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { serializeExecutionPath } from "../serialize-graph.js"

const AUTH_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "PUT /tasks/{task}",
  method: "PUT",
  path: "/tasks/{task}",
  annotations: [],
  nodes: [
    { id: "mw_0", type: "authentication_gate",  symbol: "auth:sanctum",            role: "authentication" },
    { id: "mw_2", type: "authorization_check",  symbol: "CheckPermission::handle", role: "authorization", args: ["task.update"] },
    { id: "ctrl", type: "controller_action",    symbol: "TaskController::update",  role: "handler" },
    { id: "pol",  type: "policy",               symbol: "TaskPolicy::update",      role: "authorization" },
    { id: "svc1", type: "service_call",         symbol: "PermissionService::hasPermission", role: "service", args: ["TASK_UPDATE"] },
    { id: "svc2", type: "service_call",         symbol: "PermissionService::hasPermission", role: "service", args: ["TASK_UPDATE"] },
  ],
  edges: [
    { from: "mw_0",  to: "mw_2",  relation: "next_middleware", traceability: "static" },
    { from: "mw_2",  to: "ctrl",  relation: "next_middleware", traceability: "static" },
    { from: "ctrl",  to: "pol",   relation: "policy_check",    traceability: "semantic" },
    { from: "mw_2",  to: "svc1",  relation: "calls",           traceability: "static" },
    { from: "pol",   to: "svc2",  relation: "calls",           traceability: "static" },
  ],
}

describe("serializeExecutionPath", () => {
  test("includes entrypoint header", () => {
    const out = serializeExecutionPath(AUTH_GRAPH)
    expect(out).toContain("PUT /tasks/{task}")
  })

  test("includes Nodes section", () => {
    const out = serializeExecutionPath(AUTH_GRAPH)
    expect(out).toContain("Nodes:")
  })

  test("includes Edges section", () => {
    const out = serializeExecutionPath(AUTH_GRAPH)
    expect(out).toContain("Edges:")
  })

  test("serializes node type in brackets", () => {
    const out = serializeExecutionPath(AUTH_GRAPH)
    expect(out).toContain("[authorization_check]")
    expect(out).toContain("[policy]")
  })

  test("serializes node symbol", () => {
    const out = serializeExecutionPath(AUTH_GRAPH)
    expect(out).toContain("CheckPermission::handle")
    expect(out).toContain("TaskPolicy::update")
  })

  test("serializes edge relation in brackets", () => {
    const out = serializeExecutionPath(AUTH_GRAPH)
    expect(out).toContain("[policy_check]")
    expect(out).toContain("[next_middleware]")
  })

  test("serializes edge from → to", () => {
    const out = serializeExecutionPath(AUTH_GRAPH)
    expect(out).toContain("ctrl →")
    expect(out).toContain("→ pol")
  })

  test("includes args when present on node", () => {
    const out = serializeExecutionPath(AUTH_GRAPH)
    expect(out).toContain("task.update")
  })

  test("renders [MUTATES] marker for nodes with mutates: true (IR v1.5 Phase 2)", () => {
    const graph: IntermediateExecutionGraph = {
      ...AUTH_GRAPH,
      nodes: [
        ...AUTH_GRAPH.nodes,
        { id: "svc3", type: "service_call", symbol: "User::apiTokens()->delete", role: "service", mutates: true },
      ],
    }
    const out = serializeExecutionPath(graph)
    expect(out).toContain("User::apiTokens()->delete [service_call] [MUTATES]")
  })

  test("does not render [MUTATES] marker for non-mutating nodes", () => {
    const out = serializeExecutionPath(AUTH_GRAPH)
    expect(out).not.toContain("[MUTATES]")
  })
})
