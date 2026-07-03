import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { LLMResponse, LLMClient } from "@kidkender/archmind-llm-client"
import type { ConversationContext } from "@kidkender/archmind-protocol"

export type { ConversationTurn, ConversationContext, QueryMode } from "@kidkender/archmind-protocol"
export { MAX_CONVERSATION_TURNS } from "@kidkender/archmind-protocol"

export interface OrchestratorOptions {
  graphs: IntermediateExecutionGraph[]
  llmClient: LLMClient
  projectRoot?: string
}

export interface QueryResult {
  query: string
  entrypoint: string
  response: LLMResponse
  explanation_failed: boolean
  findings_count: number
  token_estimate: number
  conversation: ConversationContext
}
