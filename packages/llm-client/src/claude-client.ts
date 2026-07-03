import Anthropic from "@anthropic-ai/sdk"
import type { BuiltPrompt } from "@kidkender/archmind-prompt-builder"
import type { LLMClient, LLMCallResult, LLMResponse, JudgeClient } from "./types.js"

export interface AnthropicMessagesCreate {
  create(params: {
    model: string
    max_tokens: number
    system: string
    messages: Array<{ role: string; content: string }>
    temperature?: number
  }): Promise<{
    content: Array<{ type: string; text?: string }>
    model: string
    usage: { input_tokens: number; output_tokens: number }
  }>
}

export interface ClaudeLLMClientOptions {
  apiKey?: string
  model?: string
  maxTokens?: number
  /** Inject a custom Anthropic messages adapter — used for testing */
  messagesAdapter?: AnthropicMessagesCreate
}

const DEFAULT_MODEL = "claude-sonnet-4-6"
const DEFAULT_MAX_TOKENS = 1024

function extractJson(text: string): string {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlock) return codeBlock[1].trim()
  const firstBrace = text.indexOf("{")
  const lastBrace = text.lastIndexOf("}")
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1)
  }
  return text.trim()
}

export class ClaudeLLMClient implements LLMClient, JudgeClient {
  private readonly messages: AnthropicMessagesCreate
  private readonly model: string
  private readonly maxTokens: number

  constructor(opts: ClaudeLLMClientOptions) {
    this.messages = opts.messagesAdapter ?? (new Anthropic({ apiKey: opts.apiKey }).messages as unknown as AnthropicMessagesCreate)
    this.model = opts.model ?? DEFAULT_MODEL
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  }

  async judge(system: string, user: string): Promise<string> {
    const message = await this.messages.create({
      model: this.model,
      max_tokens: 256,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }],
    })
    const textBlock = message.content.find((b) => b.type === "text" && b.text !== undefined)
    return textBlock?.text ?? ""
  }

  async call(prompt: BuiltPrompt): Promise<LLMCallResult> {
    const userContent = `${prompt.user}\n\n${prompt.output_instructions}`

    const message = await this.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: prompt.system,
      messages: [{ role: "user", content: userContent }],
    })

    const textBlock = message.content.find((b) => b.type === "text" && b.text !== undefined)
    if (!textBlock?.text) {
      throw new Error("Claude returned no text content")
    }

    const rawText = textBlock.text
    const jsonStr = extractJson(rawText)
    let parsed: LLMResponse
    try {
      parsed = JSON.parse(jsonStr) as LLMResponse
    } catch {
      throw new Error(`Claude response is not valid JSON: ${rawText.slice(0, 200)}`)
    }

    return {
      response: parsed,
      raw: rawText,
      model: message.model,
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
    }
  }
}
