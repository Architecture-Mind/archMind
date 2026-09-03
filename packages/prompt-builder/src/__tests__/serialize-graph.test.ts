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

  test("serializes edge from → to using resolved symbols, not raw node ids", () => {
    const out = serializeExecutionPath(AUTH_GRAPH)
    expect(out).toContain("TaskController::update →")
    expect(out).toContain("→ TaskPolicy::update")
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

// ---- IR v1.5 Phase 3: transaction scope -----------------------------------
// A mutating node with no ir:wraps edge pointing at it is NOT inside any
// transaction — that absence must be a visible, positive statement (see
// research/semantic-ir/v1.5-semantic-fidelity-plan.md, Phase 3).

describe("serializeExecutionPath — transaction scope (IR v1.5 Phase 3)", () => {
  const TXN_GRAPH: IntermediateExecutionGraph = {
    entrypoint: "DELETE /users/{user}",
    method: "DELETE",
    path: "/users/{user}",
    annotations: [],
    nodes: [
      { id: "ctrl", type: "ir:business_handler", symbol: "UserController::destroy", role: "handler" },
      { id: "unwrapped", type: "ir:service_call", symbol: "User::apiTokens()->delete", role: "service", mutates: true },
      { id: "txn",  type: "ir:txn_boundary",      symbol: "DB::transaction", role: "atomicity" },
      { id: "wrapped", type: "ir:txn_write",      symbol: "AuditLog::create", role: "persistence", mutates: true },
    ],
    edges: [
      { from: "ctrl", to: "unwrapped", relation: "calls",             traceability: "static" },
      { from: "ctrl", to: "txn",       relation: "opens_transaction", traceability: "static" },
      { from: "txn",  to: "wrapped",   relation: "ir:wraps",          traceability: "static" },
    ],
  }

  test("lists a mutating node with no ir:wraps edge as unwrapped", () => {
    const out = serializeExecutionPath(TXN_GRAPH)
    expect(out).toContain("Unwrapped mutations (no transaction boundary):")
    expect(out).toContain("User::apiTokens()->delete [ir:service_call] — NOT wrapped in a transaction")
  })

  test("does NOT list a mutating node that has an ir:wraps edge", () => {
    const out = serializeExecutionPath(TXN_GRAPH)
    const unwrappedSection = out.split("Unwrapped mutations")[1] ?? ""
    expect(unwrappedSection).not.toContain("AuditLog::create")
  })

  test("omits the Unwrapped mutations section entirely when nothing is unwrapped", () => {
    const fullyWrapped: IntermediateExecutionGraph = {
      ...TXN_GRAPH,
      nodes: TXN_GRAPH.nodes.filter((n) => n.id !== "unwrapped"),
      edges: TXN_GRAPH.edges.filter((e) => e.to !== "unwrapped"),
    }
    const out = serializeExecutionPath(fullyWrapped)
    expect(out).not.toContain("Unwrapped mutations")
  })
})
