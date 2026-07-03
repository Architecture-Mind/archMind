import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { SemanticFact } from "./types.js"
import { extractAuthorizationFacts } from "./authorization.js"
import { extractValidationGateFacts } from "./validation.js"
import { extractRuntimeInjectionFacts } from "./runtime.js"

export function extractFacts(graph: IntermediateExecutionGraph): SemanticFact[] {
  return [
    ...extractAuthorizationFacts(graph),
    ...extractValidationGateFacts(graph),
    ...extractRuntimeInjectionFacts(graph),
  ]
}

export * from "./types.js"
export { normalizeAbility } from "./authorization.js"
