import { describe, test, expect } from "@jest/globals"
import { MockLLMClient } from "../mock-client.js"
import type { BuiltPrompt } from "@kidkender/archmind-prompt-builder"

const PROMPT: BuiltPrompt = {
  system: "You are a semantic code reasoning engine.",
  user: "User question:\n\"Why is permission checked twice?\"\n\nExecution path: PUT /tasks/{task}\n\nNodes:\n  [authorization_check]  CheckPermission::handle",
  output_instructions: "Respond with JSON: { finding_type, severity, confidence, explanation, key_nodes, recommendations, uncertainty }",
}

describe("MockLLMClient", () => {
  test("returns a valid LLMCallResult", async () => {
    const client = new MockLLMClient()
    const result = await client.call(PROMPT)
    expect(result).toHaveProperty("response")
    expect(result).toHaveProperty("raw")
    expect(result).toHaveProperty("model")
    expect(result).toHaveProperty("input_tokens")
    expect(result).toHaveProperty("output_tokens")
  })

  test("response has all required fields", async () => {
    const client = new MockLLMClient()
    const { response } = await client.call(PROMPT)
    expect(response).toHaveProperty("finding_type")
    expect(response).toHaveProperty("severity")
    expect(response).toHaveProperty("confidence")
    expect(response).toHaveProperty("explanation")
    expect(response).toHaveProperty("key_nodes")
    expect(response).toHaveProperty("recommendations")
    expect(response).toHaveProperty("uncertainty")
  })

  test("severity is one of the valid values", async () => {
    const client = new MockLLMClient()
    const { response } = await client.call(PROMPT)
    expect(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).toContain(response.severity)
  })

  test("confidence is one of the valid values", async () => {
    const client = new MockLLMClient()
    const { response } = await client.call(PROMPT)
    expect(["HIGH", "MEDIUM", "LOW"]).toContain(response.confidence)
  })

  test("key_nodes is an array", async () => {
    const client = new MockLLMClient()
    const { response } = await client.call(PROMPT)
    expect(Array.isArray(response.key_nodes)).toBe(true)
  })

  test("recommendations is an array", async () => {
    const client = new MockLLMClient()
    const { response } = await client.call(PROMPT)
    expect(Array.isArray(response.recommendations)).toBe(true)
  })

  test("raw is the JSON stringified response", async () => {
    const client = new MockLLMClient()
    const result = await client.call(PROMPT)
    expect(result.raw).toBe(JSON.stringify(result.response, null, 2))
  })

  test("model is mock", async () => {
    const client = new MockLLMClient()
    const result = await client.call(PROMPT)
    expect(result.model).toBe("mock")
  })

  test("allows overriding the canned response", async () => {
    const override = {
      finding_type: "missing_tenant_scope",
      severity: "CRITICAL" as const,
      confidence: "HIGH" as const,
      explanation: "Task::find does not apply tenant filter.",
      key_nodes: ["Task::find"],
      recommendations: ["Add where('tenant_id', $tenant->id)"],
      uncertainty: null,
    }
    const client = new MockLLMClient(override)
    const { response } = await client.call(PROMPT)
    expect(response.finding_type).toBe("missing_tenant_scope")
    expect(response.explanation).toBe("Task::find does not apply tenant filter.")
  })
})
