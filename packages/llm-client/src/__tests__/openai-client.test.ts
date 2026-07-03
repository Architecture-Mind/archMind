import { describe, test, expect } from "@jest/globals"
import { OpenAILLMClient } from "../openai-client.js"
import type { OpenAIChatCreate } from "../openai-client.js"
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

function makeAdapter(text: string | null, model = "gpt-4o"): OpenAIChatCreate {
  return {
    create: async () => ({
      choices: [{ message: { content: text } }],
      model,
      usage: { prompt_tokens: 200, completion_tokens: 150 },
    }),
  }
}

function makeCapturingAdapter(validJson: string): { adapter: OpenAIChatCreate; captured: { model: string } } {
  const captured = { model: "" }
  const adapter: OpenAIChatCreate = {
    create: async (params) => {
      captured.model = params.model
      return {
        choices: [{ message: { content: validJson } }],
        model: params.model,
        usage: { prompt_tokens: 100, completion_tokens: 80 },
      }
    },
  }
  return { adapter, captured }
}

describe("OpenAILLMClient", () => {
  test("parses valid JSON response", async () => {
    const client = new OpenAILLMClient({ chatAdapter: makeAdapter(VALID_LLM_JSON) })
    const result = await client.call(PROMPT)
    expect(result.response.finding_type).toBe("duplicate_authorization")
    expect(result.response.severity).toBe("CRITICAL")
    expect(result.model).toBe("gpt-4o")
    expect(result.input_tokens).toBe(200)
    expect(result.output_tokens).toBe(150)
  })

  test("throws when OpenAI returns no text content", async () => {
    const client = new OpenAILLMClient({ chatAdapter: makeAdapter(null) })
    await expect(client.call(PROMPT)).rejects.toThrow("OpenAI returned no text content")
  })

  test("throws when OpenAI returns non-JSON text", async () => {
    const client = new OpenAILLMClient({ chatAdapter: makeAdapter("Sorry, I cannot help with that.") })
    await expect(client.call(PROMPT)).rejects.toThrow("not valid JSON")
  })

  test("extracts JSON from markdown code block", async () => {
    const wrapped = "```json\n" + VALID_LLM_JSON + "\n```"
    const client = new OpenAILLMClient({ chatAdapter: makeAdapter(wrapped) })
    const result = await client.call(PROMPT)
    expect(result.response.finding_type).toBe("duplicate_authorization")
  })

  test("extracts JSON preceded by prose text", async () => {
    const withProse = "Here is my analysis:\n\n" + VALID_LLM_JSON + "\n\nLet me know if you need more."
    const client = new OpenAILLMClient({ chatAdapter: makeAdapter(withProse) })
    const result = await client.call(PROMPT)
    expect(result.response.finding_type).toBe("duplicate_authorization")
  })

  test("uses gpt-4o model by default", async () => {
    const { adapter, captured } = makeCapturingAdapter(VALID_LLM_JSON)
    const client = new OpenAILLMClient({ chatAdapter: adapter })
    await client.call(PROMPT)
    expect(captured.model).toBe("gpt-4o")
  })

  test("allows overriding the model", async () => {
    const { adapter, captured } = makeCapturingAdapter(VALID_LLM_JSON)
    const client = new OpenAILLMClient({ chatAdapter: adapter, model: "gpt-4o-mini" })
    await client.call(PROMPT)
    expect(captured.model).toBe("gpt-4o-mini")
  })

  test("raw field contains the original OpenAI text", async () => {
    const client = new OpenAILLMClient({ chatAdapter: makeAdapter(VALID_LLM_JSON) })
    const result = await client.call(PROMPT)
    expect(result.raw).toBe(VALID_LLM_JSON)
  })

  test("returns zero tokens when usage is null", async () => {
    const adapter: OpenAIChatCreate = {
      create: async () => ({
        choices: [{ message: { content: VALID_LLM_JSON } }],
        model: "gpt-4o",
        usage: null,
      }),
    }
    const client = new OpenAILLMClient({ chatAdapter: adapter })
    const result = await client.call(PROMPT)
    expect(result.input_tokens).toBe(0)
    expect(result.output_tokens).toBe(0)
  })

  test("sends system message as system role", async () => {
    const captured: Array<{ role: string; content: string }> = []
    const adapter: OpenAIChatCreate = {
      create: async (params) => {
        captured.push(...params.messages)
        return {
          choices: [{ message: { content: VALID_LLM_JSON } }],
          model: "gpt-4o",
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }
      },
    }
    const client = new OpenAILLMClient({ chatAdapter: adapter })
    await client.call(PROMPT)
    expect(captured[0].role).toBe("system")
    expect(captured[0].content).toBe(PROMPT.system)
    expect(captured[1].role).toBe("user")
  })
})
