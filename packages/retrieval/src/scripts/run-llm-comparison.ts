#!/usr/bin/env node
/**
 * Comparative Reasoning Benchmark v2 — LLM comparison
 *
 * Compares two modes for each Q&A pair:
 *   Mode A (naive):    LLM + raw graph node list (no curation)
 *   Mode B (archmind): LLM + curated EvidencePackage
 *
 * Scoring uses an LLM judge that rates each answer 0.0–1.0
 * against the golden_answer for the pair.
 *
 * Metrics per pair:
 *   - reasoning_accuracy_a / reasoning_accuracy_b  (judge score)
 *   - prompt_tokens_a / prompt_tokens_b             (token efficiency)
 *   - latency_ms_a / latency_ms_b                  (response latency)
 *
 * Requires: OPENAI_API_KEY in .env or environment
 *
 * Usage (from repo root):
 *   node --loader ts-node/esm packages/retrieval/src/scripts/run-llm-comparison.ts \
 *     <project-name> [label]
 */
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "fs"
import yaml from "js-yaml"
import OpenAI from "openai"
import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from "@archmind/laravel-parser"
import { buildEvidencePackage } from "@archmind/explainer"
import type { IntermediateExecutionGraph } from "@archmind/protocol"
import type { EvidencePackage } from "@archmind/explainer"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const REPO_ROOT  = join(__dirname, "../../../..")
const SNAP_DIR   = join(REPO_ROOT, "benchmarks/snapshots")

// Load .env from repo root
const envPath = join(REPO_ROOT, ".env")
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
  }
}

// ─── Config ────────────────────────────────────────────────────────────────

const PROJECT_PATHS: Record<string, string> = {
  "ecomerce-api":          "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/ecomerce-api",
  "laravel-b2b-ecommerce": "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/laravel-b2b-ecommerce",
  "crater":                join(REPO_ROOT, "research/corpus/crater"),
}

const projectName = process.argv[2]
const label       = process.argv[3] ?? `${projectName}-llm-v2`

if (!projectName) {
  console.error("Usage: run-llm-comparison.ts <project-name> [label]")
  console.error("Available projects: " + Object.keys(PROJECT_PATHS).join(", "))
  process.exit(1)
}

const projectRoot = PROJECT_PATHS[projectName]
if (!projectRoot) {
  console.error(`Unknown project: ${projectName}. Available: ${Object.keys(PROJECT_PATHS).join(", ")}`)
  process.exit(1)
}

const apiKey = process.env["OPENAI_API_KEY"]
if (!apiKey) {
  console.error("OPENAI_API_KEY is required (set in .env or environment)")
  process.exit(1)
}

const client  = new OpenAI({ apiKey })
const QA_DIR  = join(REPO_ROOT, "research/golden-qa", projectName)
const MODEL   = process.env["OPENAI_MODEL"] ?? "gpt-4o-mini"  // cheaper for candidate answers
const JUDGE   = "gpt-4o"                                        // better reasoning for judge

// ─── Types ─────────────────────────────────────────────────────────────────

interface GoldenQA {
  id: string
  route: string
  question: string
  expected_finding: string
  expected_intent: string
  expected_evidence_nodes: Array<{ symbol: string; type: string; role: string }>
  golden_answer: string
}

interface LLMCallResult {
  answer:           string
  prompt_tokens:    number
  completion_tokens: number
  latency_ms:       number
}

interface JudgeResult {
  score:      number   // 0.0–1.0
  reasoning:  string
}

interface PairResult {
  id:                  string
  route:               string
  question:            string
  mode_a: {
    answer:             string
    prompt_tokens:      number
    completion_tokens:  number
    latency_ms:         number
    judge_score:        number
    judge_reasoning:    string
  }
  mode_b: {
    answer:             string
    prompt_tokens:      number
    completion_tokens:  number
    latency_ms:         number
    judge_score:        number
    judge_reasoning:    string
  }
  delta_score:         number   // mode_b.judge_score - mode_a.judge_score
  token_savings_pct:   number   // (mode_a.prompt_tokens - mode_b.prompt_tokens) / mode_a.prompt_tokens * 100
}

interface ComparisonSnapshot {
  label:      string
  timestamp:  string
  project:    string
  model:      string
  judge:      string
  summary: {
    total_pairs:          number
    avg_score_a:          number
    avg_score_b:          number
    avg_delta:            number
    avg_token_savings_pct: number
    archmind_wins:        number
    naive_wins:           number
    ties:                 number
  }
  results: PairResult[]
}

// ─── Build prompts ─────────────────────────────────────────────────────────

function buildNaivePrompt(question: string, graph: IntermediateExecutionGraph): string {
  const nodeList = graph.nodes.map((n) =>
    `- [${n.type}] ${n.symbol}${n.role ? ` (${n.role})` : ""}`
  ).join("\n")

  return `You are a Laravel security expert. Answer the following question about this route.

Route: ${graph.entrypoint}

Graph nodes (raw):
${nodeList}

Question: ${question}

Answer concisely and accurately based on the graph data above.`
}

const FINDING_DESCRIPTIONS: Record<string, string> = {
  resource_unprotected:    "resource accessed via route-model-binding has no per-resource ownership check (authentication may still exist)",
  resource_mismatch:       "authorization check guards a different resource than the one accessed by the handler",
  missing_authorization:   "no authentication or authorization gate on the route",
  missing_policy:          "controller calls authorize() but the Policy class does not exist",
  fat_controller:          "controller action injects many services directly — possible SRP violation",
  exposed_read_endpoint:   "GET endpoint with business logic has no authentication",
  over_authorized_route:   "route has many overlapping authorization layers",
  sensitive_field_exposed: "API resource serializer includes fields that should not be public (e.g. internal tokens, surrogate keys)",
  synchronous_mail:        "mail is sent synchronously inside the request cycle — blocks HTTP response until SMTP completes",
  api_resource_unprotected:"API resource endpoint has no authentication gate",
  queue_job:               "a background job is dispatched — PDF/email generation is async and does not block the response",
  none:                    "no specific security issue detected",
}

// Max execution path length shown in prompt. Longer paths are truncated.
const MAX_PATH_NODES = 6

function buildArchmindPrompt(question: string, pkg: EvidencePackage): string {
  // Sort facts: high relevance first, then present before absent within same tier
  const sortedFacts = [...pkg.facts].sort((a, b) => {
    const tier = { high: 0, medium: 1, low: 2 }
    const t = tier[a.relevance] - tier[b.relevance]
    if (t !== 0) return t
    return (b.present ? 1 : 0) - (a.present ? 1 : 0)
  })

  // Collect HIGH-relevance fact values to detect duplicates in LOW facts
  const highValueSet = new Set(
    sortedFacts
      .filter((f) => f.relevance === "high" && f.value)
      .map((f) => f.value!)
  )

  const factsText = sortedFacts
    .filter((f) => {
      // Drop LOW-relevance present facts whose value is already captured by a HIGH fact
      if (f.relevance === "low" && f.present && f.value && highValueSet.has(f.value)) return false
      return true
    })
    .map((f) => {
      const mark = f.present ? "✓" : "✗"
      const val  = f.value ? ` = ${f.value}` : ""
      return `  ${mark} ${f.type}${val}`
    }).join("\n")

  // Dedup evidence by (symbol, role): repeated entries become "symbol (×N)"
  const evidenceMap = new Map<string, { item: typeof pkg.evidence[0]; count: number }>()
  for (const e of pkg.evidence) {
    const key = `${e.role}|${e.symbol}`
    const existing = evidenceMap.get(key)
    if (existing) existing.count++
    else evidenceMap.set(key, { item: e, count: 1 })
  }
  const evidenceList = [...evidenceMap.values()].map(({ item: e, count }) => {
    const detail = e.detail ? ` | ${e.detail}` : ""
    const times  = count > 1 ? ` (×${count})` : ""
    return `- [${e.role}] ${e.symbol}${detail}${times}`
  }).join("\n")

  // Cap execution path to avoid token bloat on complex routes
  const path = pkg.execution_path
  const pathText = path.length === 0
    ? "(unavailable)"
    : path.length <= MAX_PATH_NODES
      ? path.join(" → ")
      : `${path.slice(0, MAX_PATH_NODES).join(" → ")} … (+${path.length - MAX_PATH_NODES} more)`

  const findingDesc = FINDING_DESCRIPTIONS[pkg.finding] ?? pkg.finding
  const findingLine = pkg.finding !== "none"
    ? `Detected issue: ${pkg.finding} — ${findingDesc} (${pkg.severity})`
    : `No specific issue detected.`

  return `You are a Laravel security expert. Answer the following question using the structured evidence below.

Question: ${question}
Intent: ${pkg.intent}
${findingLine}

Facts (✓ = present, ✗ = absent):
${factsText}

Execution path: ${pathText}

Execution nodes:
${evidenceList}

Answer concisely and accurately. Use the facts above — do not invent information not supported by the evidence.`
}

function buildJudgePrompt(question: string, goldenAnswer: string, candidateAnswer: string): string {
  return `You are an expert code reviewer evaluating an answer about Laravel security.

Question: ${question}

Golden Answer (ground truth):
${goldenAnswer}

Candidate Answer:
${candidateAnswer}

Rate the candidate answer from 0.0 to 1.0 based on:
- Factual accuracy (does it identify the correct security issue?)
- Completeness (does it cover the key points in the golden answer?)
- Specificity (does it mention specific classes/methods where relevant?)

Respond ONLY with a JSON object:
{"score": <0.0 to 1.0>, "reasoning": "<one sentence>"}`
}

// ─── LLM calls ─────────────────────────────────────────────────────────────

async function callLLM(prompt: string, model: string): Promise<LLMCallResult> {
  const start = Date.now()
  const response = await client.chat.completions.create({
    model,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  })
  const latency_ms = Date.now() - start

  const answer = response.choices[0]?.message?.content ?? ""

  return {
    answer,
    prompt_tokens:     response.usage?.prompt_tokens     ?? 0,
    completion_tokens: response.usage?.completion_tokens ?? 0,
    latency_ms,
  }
}

async function callJudge(
  question: string,
  goldenAnswer: string,
  candidateAnswer: string
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(question, goldenAnswer, candidateAnswer)
  const result = await callLLM(prompt, JUDGE)

  try {
    const parsed = JSON.parse(result.answer.match(/\{[\s\S]*\}/)?.[0] ?? "{}")
    return {
      score:     Math.min(1, Math.max(0, Number(parsed.score) || 0)),
      reasoning: String(parsed.reasoning || ""),
    }
  } catch {
    // If judge response is malformed, score 0 conservatively
    return { score: 0, reasoning: "judge parse error" }
  }
}

// ─── Parse project ─────────────────────────────────────────────────────────

console.log(`Parsing project: ${projectRoot}`)
const config = loadProjectConfig(projectRoot)
const { aliasMap, routeFiles } = resolveAliasMap(projectRoot, config)

const allGraphs: IntermediateExecutionGraph[] = []
for (const relFile of routeFiles) {
  const skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap })
  for (const g of skeletons) {
    allGraphs.push(augmentGraph(g, { projectRoot, config }))
  }
}
console.log(`Extracted ${allGraphs.length} graphs\n`)

// ─── Load Q&A pairs ─────────────────────────────────────────────────────────

const qaFiles = readdirSync(QA_DIR).filter((f) => f.endsWith(".yaml"))
const qaPairs: GoldenQA[] = qaFiles.map(
  (f) => yaml.load(readFileSync(join(QA_DIR, f), "utf-8")) as GoldenQA
)
console.log(`Loaded ${qaPairs.length} Q&A pairs\n`)

// ─── Run comparison ─────────────────────────────────────────────────────────

const results: PairResult[] = []

for (const qa of qaPairs) {
  const graph = allGraphs.find(
    (g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase()
  )
  if (!graph) {
    console.warn(`  SKIP [${qa.id}]: no graph for route "${qa.route}"`)
    continue
  }

  console.log(`[${qa.id}] "${qa.question}"`)

  // Mode A: naive (raw graph)
  const promptA = buildNaivePrompt(qa.question, graph)
  const resultA = await callLLM(promptA, MODEL)
  const judgeA  = await callJudge(qa.question, qa.golden_answer, resultA.answer)

  // Mode B: ArchMind evidence package
  const pkg     = buildEvidencePackage(qa.question, graph)
  const promptB = buildArchmindPrompt(qa.question, pkg)
  const resultB = await callLLM(promptB, MODEL)
  const judgeB  = await callJudge(qa.question, qa.golden_answer, resultB.answer)

  const delta          = judgeB.score - judgeA.score
  const tokenSavingsPct = resultA.prompt_tokens > 0
    ? ((resultA.prompt_tokens - resultB.prompt_tokens) / resultA.prompt_tokens) * 100
    : 0

  console.log(`  Mode A (naive):    score=${judgeA.score.toFixed(3)}  tokens=${resultA.prompt_tokens}  ${judgeA.reasoning}`)
  console.log(`  Mode B (archmind): score=${judgeB.score.toFixed(3)}  tokens=${resultB.prompt_tokens}  ${judgeB.reasoning}`)
  console.log(`  delta=${delta >= 0 ? "+" : ""}${delta.toFixed(3)}  token_savings=${tokenSavingsPct.toFixed(1)}%\n`)

  results.push({
    id:    qa.id,
    route: qa.route,
    question: qa.question,
    mode_a: { answer: resultA.answer, prompt_tokens: resultA.prompt_tokens, completion_tokens: resultA.completion_tokens, latency_ms: resultA.latency_ms, judge_score: judgeA.score, judge_reasoning: judgeA.reasoning },
    mode_b: { answer: resultB.answer, prompt_tokens: resultB.prompt_tokens, completion_tokens: resultB.completion_tokens, latency_ms: resultB.latency_ms, judge_score: judgeB.score, judge_reasoning: judgeB.reasoning },
    delta_score:       delta,
    token_savings_pct: tokenSavingsPct,
  })
}

// ─── Snapshot ───────────────────────────────────────────────────────────────

const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0

const snapshot: ComparisonSnapshot = {
  label,
  timestamp:  new Date().toISOString(),
  project:    projectName,
  model:      MODEL,
  judge:      JUDGE,
  summary: {
    total_pairs:          results.length,
    avg_score_a:          avg(results.map((r) => r.mode_a.judge_score)),
    avg_score_b:          avg(results.map((r) => r.mode_b.judge_score)),
    avg_delta:            avg(results.map((r) => r.delta_score)),
    avg_token_savings_pct: avg(results.map((r) => r.token_savings_pct)),
    archmind_wins:        results.filter((r) => r.delta_score > 0.05).length,
    naive_wins:           results.filter((r) => r.delta_score < -0.05).length,
    ties:                 results.filter((r) => Math.abs(r.delta_score) <= 0.05).length,
  },
  results,
}

mkdirSync(SNAP_DIR, { recursive: true })
const outPath = join(SNAP_DIR, `${label}.json`)
writeFileSync(outPath, JSON.stringify(snapshot, null, 2))

console.log("=== Summary ===")
console.log(`  total_pairs           = ${snapshot.summary.total_pairs}`)
console.log(`  avg_score_a (naive)   = ${snapshot.summary.avg_score_a.toFixed(3)}`)
console.log(`  avg_score_b (archmind)= ${snapshot.summary.avg_score_b.toFixed(3)}`)
console.log(`  avg_delta             = ${snapshot.summary.avg_delta >= 0 ? "+" : ""}${snapshot.summary.avg_delta.toFixed(3)}`)
console.log(`  avg_token_savings     = ${snapshot.summary.avg_token_savings_pct.toFixed(1)}%`)
console.log(`  archmind_wins=${snapshot.summary.archmind_wins}  naive_wins=${snapshot.summary.naive_wins}  ties=${snapshot.summary.ties}`)
console.log(`\nSaved: ${outPath}`)
