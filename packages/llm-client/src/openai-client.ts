import OpenAI from "openai"
import type { BuiltPrompt } from "@kidkender/archmind-prompt-builder"
import type { LLMClient, LLMCallResult, LLMResponse, JudgeClient } from "./types.js"

export interface OpenAIChatCreate {
  create(params: {
    model: string
    max_tokens: number
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
    temperature?: number
  }): Promise<{
    choices: Array<{ message: { content: string | null } }>
    model: string
    usage: { prompt_tokens: number; completion_tokens: number } | null | undefined
  }>
}

export interface OpenAILLMClientOptions {
  apiKey?: string
  model?: string
  maxTokens?: number
  baseURL?: string
  /** Inject a custom chat completions adapter — used for testing */
  chatAdapter?: OpenAIChatCreate
}

const DEFAULT_MODEL = "gpt-4o"
const DEFAULT_MAX_TOKENS = 1024
const MAX_RETRIES = 3

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      const isRetryable = /connection|network|econnreset|etimedout|socket/i.test(msg)
      if (!isRetryable) throw err
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
  throw lastErr
}

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

export class OpenAILLMClient implements LLMClient, JudgeClient {
  private readonly chat: OpenAIChatCreate
  private readonly model: string
  private readonly maxTokens: number

  constructor(opts: OpenAILLMClientOptions) {
    this.chat =
      opts.chatAdapter ??
      (new OpenAI({ apiKey: opts.apiKey?.trim(), baseURL: opts.baseURL }).chat.completions as unknown as OpenAIChatCreate)
    this.model = opts.model ?? DEFAULT_MODEL
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
  }

  async judge(system: string, user: string): Promise<string> {
    const completion = await withRetry(() => this.chat.create({
      model: this.model,
      max_tokens: 256,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }))
    return completion.choices[0]?.message.content ?? ""
  }

  async call(prompt: BuiltPrompt): Promise<LLMCallResult> {
    const userContent = `${prompt.user}\n\n${prompt.output_instructions}`

    const completion = await withRetry(() => this.chat.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: userContent },
      ],
    }))

    const text = completion.choices[0]?.message.content
    if (!text) {
      throw new Error("OpenAI returned no text content")
    }

    const jsonStr = extractJson(text)
    let parsed: LLMResponse
    try {
      parsed = JSON.parse(jsonStr) as LLMResponse
    } catch {
      throw new Error(`OpenAI response is not valid JSON: ${text.slice(0, 200)}`)
    }

    return {
      response: parsed,
      raw: text,
      model: completion.model,
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    }
  }
}
