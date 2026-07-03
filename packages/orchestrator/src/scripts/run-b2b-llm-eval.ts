#!/usr/bin/env node
/**
 * LLM Answer Quality Benchmark: ArchMind vs Naive RAG — laravel-b2b-ecommerce
 *
 * Covers service chains, payment security, DB transactions, and authorization gaps.
 *
 * Usage (from repo root):
 *   node packages/orchestrator/dist/scripts/run-b2b-llm-eval.js \
 *     <project-root> \
 *     [--golden-answers <dir>] \
 *     [--golden-traces <dir>] \
 *     [--label <name>] \
 *     [--model gpt-4.1]
 *
 * Requires OPENAI_API_KEY env var.
 */
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { readdirSync, writeFileSync, mkdirSync } from "fs"

import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from "@kidkender/archmind-laravel-parser"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { naiveRag } from "@kidkender/archmind-retrieval"
import { OpenAILLMClient } from "@kidkender/archmind-llm-client"
import { loadGoldenAnswer, scoreAnswerWithJudge, loadGoldenTrace } from "@kidkender/archmind-scorer"
import type { GoldenAnswer, AnswerScore, GoldenTrace } from "@kidkender/archmind-scorer"
import { Orchestrator } from "../orchestrator.js"
import { callNaiveRagLLM } from "../naive-rag-llm.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const REPO_ROOT  = join(__dirname, "../../../..")

const SNAP_DIR = join(REPO_ROOT, "benchmarks/snapshots")

// ---- CLI args ---------------------------------------------------------------

const projectRoot = process.argv[2]
if (!projectRoot) {
  console.error("Usage: run-b2b-llm-eval.js <project-root> [--golden-answers <dir>] [--golden-traces <dir>] [--label <name>] [--model gpt-4.1]")
  process.exit(1)
}

function argAfter(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : undefined
}

const GOLDEN_ANSWERS_DIR = argAfter("--golden-answers") ?? join(REPO_ROOT, "research/golden-answers/laravel-b2b-ecommerce")
const GOLDEN_TRACES_DIR  = argAfter("--golden-traces")  ?? join(REPO_ROOT, "research/golden-traces/laravel-b2b-ecommerce")
const label = argAfter("--label") ?? "b2b-llm-eval"
const model = argAfter("--model") ?? "gpt-4.1"

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  console.error("Error: OPENAI_API_KEY env var is required")
  process.exit(1)
}

// ---- Parse project ----------------------------------------------------------

console.log(`Parsing project: ${projectRoot}`)
const config   = loadProjectConfig(projectRoot)
const { aliasMap, routeFiles } = resolveAliasMap(projectRoot, config)

const allGraphs: IntermediateExecutionGraph[] = []
for (const relFile of routeFiles) {
  const skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap })
  for (const g of skeletons) {
    allGraphs.push(augmentGraph(g, { projectRoot, config }))
  }
}
console.log(`Extracted ${allGraphs.length} execution graphs\n`)

// ---- Setup ------------------------------------------------------------------

const llmClient  = new OpenAILLMClient({ apiKey, model, maxTokens: 2048 })
const orchestrator = new Orchestrator({ graphs: allGraphs, llmClient, projectRoot })

// Load golden answers
const goldenAnswerFiles = readdirSync(GOLDEN_ANSWERS_DIR).filter((f) => f.endsWith(".yaml"))
const goldens: GoldenAnswer[] = goldenAnswerFiles.map((f) =>
  loadGoldenAnswer(join(GOLDEN_ANSWERS_DIR, f))
)

// Load golden traces (for naive RAG file list)
const traceMap = new Map<string, GoldenTrace>()
for (const f of readdirSync(GOLDEN_TRACES_DIR).filter((f) => f.endsWith(".yaml"))) {
  const trace = loadGoldenTrace(join(GOLDEN_TRACES_DIR, f))
  traceMap.set(trace.id, trace)
}

// ---- Results ----------------------------------------------------------------

interface EvalRow {
  id: string
  entrypoint: string
  query: string
  archmind: { score: AnswerScore; input_tokens: number; output_tokens: number; failed: boolean }
  naive_rag: { score: AnswerScore; input_tokens: number; output_tokens: number; failed: boolean }
  naive_tokens: number
  archmind_tokens: number
}

const rows: EvalRow[] = []

for (const golden of goldens) {
  console.log(`─── ${golden.id} ───`)
  console.log(`    ${golden.entrypoint}`)
  console.log(`    "${golden.query}"`)

  // ArchMind path
  let archmindScore: AnswerScore
  let archmindIn = 0
  let archmindOut = 0
  let archmindFailed = false
  let archmindTokens = 0

  try {
    const result = await orchestrator.query(golden.entrypoint, golden.query)
    archmindScore = await scoreAnswerWithJudge(golden, result.response, llmClient)
    archmindTokens = result.token_estimate
    archmindFailed = result.explanation_failed
    console.log(`    [ArchMind] finding=${result.response.finding_type} score=${archmindScore.combined_score.toFixed(2)} passed=${archmindScore.passed}`)
  } catch (err) {
    console.error(`    [ArchMind] ERROR: ${err}`)
    archmindScore = failScore(golden.id, golden.entrypoint)
    archmindFailed = true
  }

  // Naive RAG path
  let naiveScore: AnswerScore
  let naiveIn = 0
  let naiveOut = 0
  let naiveFailed = false
  let naiveTokens = 0

  const goldenTraceId = golden.golden_trace_id
  const trace = traceMap.get(goldenTraceId)
  if (!trace) {
    console.error(`    [NaiveRAG] golden trace not found: ${goldenTraceId}`)
    naiveScore = failScore(golden.id, golden.entrypoint)
    naiveFailed = true
  } else {
    try {
      const naiveResult = naiveRag(trace, projectRoot)
      naiveTokens = naiveResult.token_estimate
      const callResult = await callNaiveRagLLM(naiveResult, golden.query, llmClient)
      naiveScore = await scoreAnswerWithJudge(golden, callResult.response, llmClient)
      naiveIn  = callResult.input_tokens
      naiveOut = callResult.output_tokens
      console.log(`    [NaiveRAG] finding=${callResult.response.finding_type} score=${naiveScore.combined_score.toFixed(2)} passed=${naiveScore.passed}`)
    } catch (err) {
      console.error(`    [NaiveRAG] ERROR: ${err}`)
      naiveScore = failScore(golden.id, golden.entrypoint)
      naiveFailed = true
    }
  }

  rows.push({
    id: golden.id,
    entrypoint: golden.entrypoint,
    query: golden.query,
    archmind: { score: archmindScore, input_tokens: archmindIn, output_tokens: archmindOut, failed: archmindFailed },
    naive_rag: { score: naiveScore, input_tokens: naiveIn, output_tokens: naiveOut, failed: naiveFailed },
    naive_tokens: naiveTokens,
    archmind_tokens: archmindTokens,
  })
  console.log()
}

// ---- Summary ---------------------------------------------------------------

const avgArchmind = rows.reduce((s, r) => s + r.archmind.score.combined_score, 0) / rows.length
const avgNaive    = rows.reduce((s, r) => s + r.naive_rag.score.combined_score, 0) / rows.length
const passArchmind = rows.filter((r) => r.archmind.score.passed).length
const passNaive    = rows.filter((r) => r.naive_rag.score.passed).length

console.log("═══════════════════════════════════════════════════════")
console.log("  COMPARISON: ArchMind vs Naive RAG — laravel-b2b-ecommerce")
console.log("═══════════════════════════════════════════════════════")
console.log(`  Model: ${model}`)
console.log(`  Traces: ${rows.length}`)
console.log()
console.log(`  ArchMind  avg_score=${avgArchmind.toFixed(3)}  passed=${passArchmind}/${rows.length}`)
console.log(`  NaiveRAG  avg_score=${avgNaive.toFixed(3)}  passed=${passNaive}/${rows.length}`)
console.log()

for (const row of rows) {
  const delta = row.archmind.score.combined_score - row.naive_rag.score.combined_score
  const sign  = delta >= 0 ? "+" : ""
  const compression = row.naive_tokens > 0
    ? `${(row.naive_tokens / Math.max(row.archmind_tokens, 1)).toFixed(1)}x compression`
    : "n/a"
  console.log(`  ${row.id}`)
  console.log(`    ArchMind : ${row.archmind.score.combined_score.toFixed(3)} (passed=${row.archmind.score.passed})`)
  console.log(`    NaiveRAG : ${row.naive_rag.score.combined_score.toFixed(3)} (passed=${row.naive_rag.score.passed})`)
  console.log(`    Delta    : ${sign}${delta.toFixed(3)}  ${compression}`)
  console.log()
}

// ---- Save snapshot ----------------------------------------------------------

const snapshot = {
  run_at: new Date().toISOString(),
  model,
  project: projectRoot,
  summary: {
    total: rows.length,
    archmind: { avg_score: avgArchmind, passed: passArchmind },
    naive_rag: { avg_score: avgNaive, passed: passNaive },
    delta: avgArchmind - avgNaive,
  },
  traces: rows.map((r) => ({
    id: r.id,
    entrypoint: r.entrypoint,
    archmind_score: r.archmind.score.combined_score,
    archmind_passed: r.archmind.score.passed,
    naive_score: r.naive_rag.score.combined_score,
    naive_passed: r.naive_rag.score.passed,
    delta: r.archmind.score.combined_score - r.naive_rag.score.combined_score,
    naive_tokens: r.naive_tokens,
    archmind_tokens: r.archmind_tokens,
  })),
}

mkdirSync(SNAP_DIR, { recursive: true })
const outPath = join(SNAP_DIR, `${label}.json`)
writeFileSync(outPath, JSON.stringify(snapshot, null, 2))
console.log(`Saved: ${outPath}`)

// ---- Helpers ----------------------------------------------------------------

function failScore(goldenId: string, entrypoint: string): AnswerScore {
  return {
    golden_id: goldenId,
    entrypoint,
    finding_type: { pass: false, expected: "", actual: "" },
    severity: { pass: false, expected: "", actual: "" },
    key_nodes: { total: 0, matched: 0, recall: 0, missing: [] },
    explanation: { total: 0, matched: 0, coverage: 0, missing: [] },
    recommendations: { total_groups: 0, matched_groups: 0, coverage: 0, missing_groups: [] },
    combined_score: 0,
    passed: false,
  }
}
