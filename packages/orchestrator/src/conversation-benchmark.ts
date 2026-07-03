import { readdirSync } from "fs"
import { join } from "path"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { LLMClient, LLMResponse } from "@kidkender/archmind-llm-client"
import { loadGoldenConversation, scoreConversation } from "@kidkender/archmind-scorer"
import type { GoldenConversation, ConversationScore } from "@kidkender/archmind-scorer"
import { Orchestrator } from "./orchestrator.js"
import type { ConversationContext } from "@kidkender/archmind-protocol"

export interface ConvBenchmarkEntry {
  golden_id: string
  entrypoint: string
  score: ConversationScore
  explanation_failed_turns: number[]
}

export interface ConvBenchmarkSnapshot {
  run_at: string
  llm_mode: string
  entries: ConvBenchmarkEntry[]
  avg_combined_score: number
  all_passed: number
  total: number
}

export async function runConversationBenchmark(
  graphs: IntermediateExecutionGraph[],
  llmClient: LLMClient,
  goldenConvsDir: string,
  llmMode: string
): Promise<ConvBenchmarkSnapshot> {
  const files = readdirSync(goldenConvsDir).filter((f) => f.endsWith(".yaml"))
  const goldens: GoldenConversation[] = files.map((f) =>
    loadGoldenConversation(join(goldenConvsDir, f))
  )

  const orc = new Orchestrator({ graphs, llmClient })
  const entries: ConvBenchmarkEntry[] = []

  for (const golden of goldens) {
    const responses: LLMResponse[] = []
    const failedTurns: number[] = []
    let context: ConversationContext | undefined

    for (const [i, turn] of golden.turns.entries()) {
      const result = await orc.query(golden.entrypoint, turn.query, context)
      context = result.conversation
      responses.push(result.response)
      if (result.explanation_failed) failedTurns.push(i + 1)
    }

    const score = scoreConversation(
      golden.id,
      golden.entrypoint,
      golden.turns,
      responses
    )

    entries.push({
      golden_id: golden.id,
      entrypoint: golden.entrypoint,
      score,
      explanation_failed_turns: failedTurns,
    })
  }

  const total = entries.length
  const all_passed = entries.filter((e) => e.score.all_passed).length
  const avg_combined_score =
    total > 0
      ? entries.reduce((sum, e) => sum + e.score.avg_combined_score, 0) / total
      : 0

  return {
    run_at: new Date().toISOString(),
    llm_mode: llmMode,
    entries,
    avg_combined_score,
    all_passed,
    total,
  }
}
