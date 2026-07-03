import type { BuiltPrompt } from "@kidkender/archmind-prompt-builder"
import type { LLMClient, LLMCallResult, LLMResponse } from "./types.js"

const DEFAULT_RESPONSE: LLMResponse = {
  finding_type: "duplicate_authorization",
  severity: "CRITICAL",
  confidence: "HIGH",
  explanation: "The route runs two independent permission checks for the same operation. Both `CheckPermission::handle` (middleware) and `TaskPolicy::update` (policy) call `PermissionService::hasPermission` with the same arguments on every request.\n\nThis creates redundant database or cache lookups and an implicit contract: if one check changes but the other does not, authorization behavior silently diverges.",
  key_nodes: ["CheckPermission::handle", "TaskPolicy::update", "PermissionService::hasPermission"],
  recommendations: [
    "Remove the CheckPermission middleware and rely solely on the policy check via $this->authorize().",
    "If the middleware serves another purpose, remove the permission check from it.",
  ],
  uncertainty: null,
}

export class MockLLMClient implements LLMClient {
  private readonly cannedResponse: LLMResponse

  constructor(override?: Partial<LLMResponse>) {
    this.cannedResponse = override ? { ...DEFAULT_RESPONSE, ...override } : DEFAULT_RESPONSE
  }

  async call(_prompt: BuiltPrompt): Promise<LLMCallResult> {
    const raw = JSON.stringify(this.cannedResponse, null, 2)
    return {
      response: this.cannedResponse,
      raw,
      model: "mock",
      input_tokens: 0,
      output_tokens: 0,
    }
  }
}
