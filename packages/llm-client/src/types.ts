import type { BuiltPrompt } from "@kidkender/archmind-prompt-builder"

export interface LLMResponse {
  finding_type: string
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
  confidence: "HIGH" | "MEDIUM" | "LOW"
  explanation: string
  key_nodes: string[]
  recommendations: string[]
  uncertainty: string | null
}

export interface LLMCallResult {
  response: LLMResponse
  raw: string
  model: string
  input_tokens: number
  output_tokens: number
}

export interface LLMClient {
  call(prompt: BuiltPrompt): Promise<LLMCallResult>
}

export interface ValidationError {
  field: string
  reason: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

export interface JudgeClient {
  judge(system: string, user: string): Promise<string>
}
