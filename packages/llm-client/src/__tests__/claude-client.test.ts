import { describe, test, expect } from "@jest/globals"
import { ClaudeLLMClient } from "../claude-client.js"
import type { AnthropicMessagesCreate } from "../claude-client.js"
import type { BuiltPrompt } from "@kidkender/archmind-prompt-builder"

const PROMPT: BuiltPrompt = {
  system: "You are a semantic code reasoning engine.",
  user: "User question:\n\"Why is permission checked twice?\"\n\nExecution path: PUT /tasks/{task}\n\nNodes:\n  [authorization_check]  CheckPermission::handle",
  output_instructions: "Respond with JSON: { finding_type, severity, confidence, explanation, key_nodes, recommendations, uncertainty }",
}

const VALID_LLM_JSON = JSON.stringify({
  finding_type: "duplicate_authorization",
  severity: "CRITICAL",
  confidence: "HIGH",
  explanation: "Two permission checks run on every request.",
  key_nodes: ["CheckPermission::handle"],
  recommendations: ["Remove middleware check"],
  uncertainty: null,
})

function makeAdapter(text: string | null, model = "claude-sonnet-4-6"): AnthropicMessagesCreate {
  return {
    create: async () => ({
      content: text !== null ? [{ type: "text", text }] : [],
      model,
      usage: { input_tokens: 200, output_tokens: 150 },
    }),
  }
}

function makeCapturingAdapter(validJson: string): { adapter: AnthropicMessagesCreate; captured: { model: string } } {
  const captured = { model: "" }
  const adapter: AnthropicMessagesCreate = {
    create: async (params) => {
      captured.model = params.model
      return {
        content: [{ type: "text", text: validJson }],
        model: params.model,
        usage: { input_tokens: 100, output_tokens: 80 },
      }
    },
  }
  return { adapter, captured }
}

describe("ClaudeLLMClient", () => {
  test("parses valid JSON response", async () => {
    const client = new ClaudeLLMClient({ messagesAdapter: makeAdapter(VALID_LLM_JSON) })
    const result = await client.call(PROMPT)
    expect(result.response.finding_type).toBe("duplicate_authorization")
    expect(result.response.severity).toBe("CRITICAL")
    expect(result.model).toBe("claude-sonnet-4-6")
    expect(result.input_tokens).toBe(200)
    expect(result.output_tokens).toBe(150)
  })

  test("throws when Claude returns no text content", async () => {
    const client = new ClaudeLLMClient({ messagesAdapter: makeAdapter(null) })
    await expect(client.call(PROMPT)).rejects.toThrow("Claude returned no text content")
  })

  test("throws when Claude returns non-JSON text", async () => {
    const client = new ClaudeLLMClient({ messagesAdapter: makeAdapter("Sorry, I cannot help with that.") })
    await expect(client.call(PROMPT)).rejects.toThrow("not valid JSON")
  })

  test("extracts JSON from markdown code block", async () => {
    const wrapped = "```json\n" + VALID_LLM_JSON + "\n```"
    const client = new ClaudeLLMClient({ messagesAdapter: makeAdapter(wrapped) })
    const result = await client.call(PROMPT)
    expect(result.response.finding_type).toBe("duplicate_authorization")
  })

  test("extracts JSON preceded by prose text", async () => {
    const withProse = "Here is my analysis:\n\n" + VALID_LLM_JSON + "\n\nLet me know if you need more."
    const client = new ClaudeLLMClient({ messagesAdapter: makeAdapter(withProse) })
    const result = await client.call(PROMPT)
    expect(result.response.finding_type).toBe("duplicate_authorization")
  })

  test("uses claude-sonnet-4-6 model by default", async () => {
    const { adapter, captured } = makeCapturingAdapter(VALID_LLM_JSON)
    const client = new ClaudeLLMClient({ messagesAdapter: adapter })
    await client.call(PROMPT)
    expect(captured.model).toBe("claude-sonnet-4-6")
  })

  test("allows overriding the model", async () => {
    const { adapter, captured } = makeCapturingAdapter(VALID_LLM_JSON)
    const client = new ClaudeLLMClient({ messagesAdapter: adapter, model: "claude-haiku-4-5-20251001" })
    await client.call(PROMPT)
    expect(captured.model).toBe("claude-haiku-4-5-20251001")
  })

  test("raw field contains the original Claude text", async () => {
    const client = new ClaudeLLMClient({ messagesAdapter: makeAdapter(VALID_LLM_JSON) })
    const result = await client.call(PROMPT)
    expect(result.raw).toBe(VALID_LLM_JSON)
  })
})
