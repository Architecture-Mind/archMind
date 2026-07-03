import { describe, test, expect } from "@jest/globals"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { MockLLMClient } from "@kidkender/archmind-llm-client"
import { Orchestrator } from "../orchestrator.js"

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

describe("Orchestrator", () => {
  test("query returns a QueryResult", async () => {
    const orc = new Orchestrator({ graphs: [AUTH_GRAPH], llmClient: new MockLLMClient() })
    const result = await orc.query("PUT /tasks/{task}", "Why is permission checked twice?")
    expect(result).toHaveProperty("query")
    expect(result).toHaveProperty("entrypoint")
    expect(result).toHaveProperty("response")
    expect(result).toHaveProperty("explanation_failed")
    expect(result).toHaveProperty("findings_count")
    expect(result).toHaveProperty("token_estimate")
  })

  test("entrypoint matches the graph", async () => {
    const orc = new Orchestrator({ graphs: [AUTH_GRAPH], llmClient: new MockLLMClient() })
    const result = await orc.query("PUT /tasks/{task}", "Why is permission checked twice?")
    expect(result.entrypoint).toBe("PUT /tasks/{task}")
  })

  test("response has valid structure from mock client", async () => {
    const orc = new Orchestrator({ graphs: [AUTH_GRAPH], llmClient: new MockLLMClient() })
    const result = await orc.query("PUT /tasks/{task}", "Why is permission checked twice?")
    expect(result.explanation_failed).toBe(false)
    expect(result.response.finding_type).toBe("duplicate_authorization")
    expect(result.response.severity).toBe("CRITICAL")
  })

  test("findings_count reflects detected findings", async () => {
    const orc = new Orchestrator({ graphs: [AUTH_GRAPH], llmClient: new MockLLMClient() })
    const result = await orc.query("PUT /tasks/{task}", "Why is permission checked twice?")
    expect(result.findings_count).toBeGreaterThanOrEqual(0)
  })

  test("token_estimate is a positive number", async () => {
    const orc = new Orchestrator({ graphs: [AUTH_GRAPH], llmClient: new MockLLMClient() })
    const result = await orc.query("PUT /tasks/{task}", "Why is permission checked twice?")
    expect(result.token_estimate).toBeGreaterThan(0)
  })

  test("unknown entrypoint throws", async () => {
    const orc = new Orchestrator({ graphs: [AUTH_GRAPH], llmClient: new MockLLMClient() })
    await expect(orc.query("GET /unknown", "anything")).rejects.toThrow()
  })

  test("empty query still runs pipeline", async () => {
    const orc = new Orchestrator({ graphs: [AUTH_GRAPH], llmClient: new MockLLMClient() })
    const result = await orc.query("PUT /tasks/{task}", "")
    expect(result).toHaveProperty("response")
  })

  test("query string is preserved in result", async () => {
    const orc = new Orchestrator({ graphs: [AUTH_GRAPH], llmClient: new MockLLMClient() })
    const result = await orc.query("PUT /tasks/{task}", "Why permission twice?")
    expect(result.query).toBe("Why permission twice?")
  })
})
