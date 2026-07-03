import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { LLMClient } from "@kidkender/archmind-llm-client"
import { runAnswerBenchmark } from "./answer-benchmark.js"
import type { AnswerBenchmarkTrace } from "./answer-benchmark.js"

export interface TraceStats {
  golden_id:   string
  entrypoint:  string
  query:       string
  mean:        number
  stddev:      number
  min:         number
  max:         number
  runs:        number
  per_run:     number[]
}

export interface MultiRunBenchmarkSnapshot {
  run_at:          string
  llm_mode:        string
  runs:            number
  traces:          TraceStats[]
  avg_mean_score:  number
  avg_stddev:      number
  passed:          number   // traces where mean >= 0.7
  total:           number
}

function stddev(values: number[], mean: number): number {
  if (values.length < 2) return 0
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

/**
 * Run the answer benchmark N times and report mean ± stddev per trace.
 * Use this instead of runAnswerBenchmark when you need statistical confidence.
 */
export async function runMultiRunBenchmark(
  graphs: IntermediateExecutionGraph[],
  llmClient: LLMClient,
  goldenAnswersDir: string,
  llmMode: string,
  runs = 5
): Promise<MultiRunBenchmarkSnapshot> {
  // Collect scores per golden_id across all runs
  const scoresByTrace = new Map<string, { trace: AnswerBenchmarkTrace; scores: number[] }>()

  for (let i = 0; i < runs; i++) {
    const snapshot = await runAnswerBenchmark(graphs, llmClient, goldenAnswersDir, llmMode)
    for (const t of snapshot.traces) {
      const entry = scoresByTrace.get(t.golden_id)
      if (entry) {
        entry.scores.push(t.score.combined_score)
      } else {
        scoresByTrace.set(t.golden_id, { trace: t, scores: [t.score.combined_score] })
      }
    }
  }

  const traceStats: TraceStats[] = []
  for (const [, { trace, scores }] of scoresByTrace) {
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length
    traceStats.push({
      golden_id:  trace.golden_id,
      entrypoint: trace.entrypoint,
      query:      trace.query,
      mean:       parseFloat(mean.toFixed(3)),
      stddev:     parseFloat(stddev(scores, mean).toFixed(3)),
      min:        parseFloat(Math.min(...scores).toFixed(3)),
      max:        parseFloat(Math.max(...scores).toFixed(3)),
      runs:       scores.length,
      per_run:    scores.map((s) => parseFloat(s.toFixed(3))),
    })
  }

  const total = traceStats.length
  const passed = traceStats.filter((t) => t.mean >= 0.7).length
  const avg_mean_score = total > 0
    ? parseFloat((traceStats.reduce((s, t) => s + t.mean, 0) / total).toFixed(3))
    : 0
  const avg_stddev = total > 0
    ? parseFloat((traceStats.reduce((s, t) => s + t.stddev, 0) / total).toFixed(3))
    : 0

  return {
    run_at:         new Date().toISOString(),
    llm_mode:       llmMode,
    runs,
    traces:         traceStats,
    avg_mean_score,
    avg_stddev,
    passed,
    total,
  }
}
