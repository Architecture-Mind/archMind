import type { IntermediateExecutionGraph, ConversationContext, ConversationTurn, QueryMode } from "@kidkender/archmind-protocol"
import { MAX_CONVERSATION_TURNS } from "@kidkender/archmind-protocol"
import { explain } from "@kidkender/archmind-explainer"
import { retrieve } from "@kidkender/archmind-retrieval"
import { classifyQuery } from "@kidkender/archmind-explainer"
import { buildPrompt } from "@kidkender/archmind-prompt-builder"
import { validateLLMResponse } from "@kidkender/archmind-llm-client"
import type { LLMClient, LLMResponse } from "@kidkender/archmind-llm-client"
import type { OrchestratorOptions, QueryResult } from "./types.js"

const FOCUS_MAP: Record<string, "auth" | "validation" | "runtime" | "transaction" | "isolation" | "all"> = {
  auth: "auth",
  validation: "validation",
  runtime: "runtime",
  transaction: "transaction",
  isolation: "isolation",
  all: "all",
}

function normalizeEntrypoint(ep: string): string {
  return ep.replace(/\{[^}]+\}/g, "{*}")
}

function trimHistory(turns: ConversationTurn[]): ConversationTurn[] {
  return turns.slice(-MAX_CONVERSATION_TURNS)
}

export class Orchestrator {
  private readonly graphs: IntermediateExecutionGraph[]
  private readonly llmClient: LLMClient

  private readonly projectRoot?: string

  constructor(opts: OrchestratorOptions) {
    this.graphs = opts.graphs
    this.llmClient = opts.llmClient
    this.projectRoot = opts.projectRoot
  }

  async query(
    entrypoint: string,
    userQuery: string,
    context?: ConversationContext,
    mode?: QueryMode
  ): Promise<QueryResult> {
    const graph = this.graphs.find(
      (g) => normalizeEntrypoint(g.entrypoint) === normalizeEntrypoint(entrypoint)
    )
    if (!graph) throw new Error(`No graph found for entrypoint: ${entrypoint}`)

    const queryCtx = classifyQuery(userQuery)
    const focus = FOCUS_MAP[queryCtx.focus] ?? "all"

    const retrieved = retrieve({ entrypoint: graph.entrypoint, focus, query: userQuery }, this.graphs)
    const retrievedGraph: IntermediateExecutionGraph = retrieved
      ? { ...graph, nodes: retrieved.nodes, edges: retrieved.edges }
      : graph

    const findings = explain(graph, userQuery || undefined)
    const history = context ? trimHistory(context.turns) : []

    const prompt = buildPrompt({ query: userQuery, graph: retrievedGraph, findings, history, mode, projectRoot: this.projectRoot })

    let response: LLMResponse
    let explanation_failed = false

    try {
      const callResult = await this.llmClient.call(prompt)
      const validation = validateLLMResponse(callResult.response)
      if (validation.valid) {
        response = callResult.response
      } else {
        const retry = await this.llmClient.call(prompt)
        const retryValidation = validateLLMResponse(retry.response)
        if (retryValidation.valid) {
          response = retry.response
        } else {
          explanation_failed = true
          response = this.fallbackResponse(findings)
        }
      }
    } catch {
      explanation_failed = true
      response = this.fallbackResponse(findings)
    }

    const newTurn: ConversationTurn = { query: userQuery, response }
    const updatedContext: ConversationContext = {
      entrypoint: graph.entrypoint,
      turns: [...(context?.turns ?? []), newTurn],
    }

    return {
      query: userQuery,
      entrypoint: graph.entrypoint,
      response,
      explanation_failed,
      findings_count: findings.length,
      token_estimate: retrieved?.token_estimate ?? estimateTokens(graph),
      conversation: updatedContext,
    }
  }

  private fallbackResponse(findings: ReturnType<typeof explain>): LLMResponse {
    const top = findings[0]
    return {
      finding_type: top?.type ?? "unknown",
      severity: (top?.severity === "INFO" ? "LOW" : top?.severity) ?? "LOW",
      confidence: top?.confidence ?? "LOW",
      explanation: top?.summary ?? "No explanation available.",
      key_nodes: top?.provenance.supporting_nodes ?? [],
      recommendations: top?.recommendations ?? [],
      uncertainty: "Explanation generation failed — showing raw detector output.",
    }
  }
}

function estimateTokens(graph: IntermediateExecutionGraph): number {
  return graph.nodes.length * 20 + graph.edges.length * 10
}
