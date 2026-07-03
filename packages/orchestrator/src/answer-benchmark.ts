import { readdirSync } from "fs"
import { join } from "path"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { LLMClient } from "@kidkender/archmind-llm-client"
import { loadGoldenAnswer, scoreAnswer } from "@kidkender/archmind-scorer"
import type { GoldenAnswer, AnswerScore } from "@kidkender/archmind-scorer"
import { Orchestrator } from "./orchestrator.js"

export interface AnswerBenchmarkTrace {
  golden_id: string
  entrypoint: string
  query: string
  score: AnswerScore
  explanation_failed: boolean
}

export interface AnswerBenchmarkSnapshot {
  run_at: string
  llm_mode: string
  traces: AnswerBenchmarkTrace[]
  avg_combined_score: number
  passed: number
  total: number
}

export async function runAnswerBenchmark(
  graphs: IntermediateExecutionGraph[],
  llmClient: LLMClient,
  goldenAnswersDir: string,
  llmMode: string
): Promise<AnswerBenchmarkSnapshot> {
  const files = readdirSync(goldenAnswersDir).filter((f) => f.endsWith(".yaml"))
  const goldens: GoldenAnswer[] = files.map((f) =>
    loadGoldenAnswer(join(goldenAnswersDir, f))
  )

  const orc = new Orchestrator({ graphs, llmClient })
  const traces: AnswerBenchmarkTrace[] = []

  for (const golden of goldens) {
    const result = await orc.query(golden.entrypoint, golden.query)
    const score = scoreAnswer(golden, result.response)
    traces.push({
      golden_id: golden.id,
      entrypoint: golden.entrypoint,
      query: golden.query,
      score,
      explanation_failed: result.explanation_failed,
    })
  }

  const total = traces.length
  const passed = traces.filter((t) => t.score.passed).length
  const avg_combined_score =
    total > 0
      ? traces.reduce((sum, t) => sum + t.score.combined_score, 0) / total
      : 0

  return {
    run_at: new Date().toISOString(),
    llm_mode: llmMode,
    traces,
    avg_combined_score,
    passed,
    total,
  }
}
