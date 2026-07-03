#!/usr/bin/env node
/**
 * LLM answer quality baseline management CLI.
 *
 * Runs the ArchMind explanation pipeline N times, captures mean ± stddev per
 * trace, and saves or verifies against a stored baseline.
 *
 * Usage:
 *   node manage-llm-baseline.js --project <path> --update [options]
 *   node manage-llm-baseline.js --project <path> --verify [options]
 *
 * Required:
 *   --project <path>          Absolute path to a Laravel project root
 *   --golden-answers <dir>    Directory containing golden answer YAML files
 *   --update | --verify       Mode
 *
 * Optional:
 *   --label <name>            Baseline label, used as filename (default: llm-main)
 *   --runs <n>                Number of benchmark runs (default: 5 for --update, 3 for --verify)
 *   --model <model>           OpenAI model (default: gpt-4.1)
 *
 * Env:
 *   OPENAI_API_KEY            Required
 *
 * Exit codes:
 *   0 — verify passed or update succeeded
 *   1 — verify failed (regression detected) or missing baseline
 */
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { readdirSync } from "fs"
import {
  parseRouteFile,
  augmentGraph,
  loadProjectConfig,
  resolveAliasMap,
} from "@kidkender/archmind-laravel-parser"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { OpenAILLMClient } from "@kidkender/archmind-llm-client"
import {
  captureLLMBaseline,
  verifyLLMBaseline,
  saveLLMBaseline,
  loadLLMBaseline,
} from "../llm-baseline.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const REPO_ROOT  = join(__dirname, "../../../..")
const BASELINE_DIR = join(REPO_ROOT, "benchmarks/baselines")

// ---- Parse args --------------------------------------------------------------

function argAfter(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : undefined
}

const projectRoot    = argAfter("--project")
const goldenAnswers  = argAfter("--golden-answers")
const label          = argAfter("--label") ?? "llm-main"
const model          = argAfter("--model") ?? "gpt-4.1"
const mode           = process.argv.includes("--update") ? "update"
                     : process.argv.includes("--verify") ? "verify"
                     : null

if (!mode || !projectRoot || !goldenAnswers) {
  console.error(
    "Usage: manage-llm-baseline.js --project <path> --golden-answers <dir> " +
    "--update | --verify [--label <name>] [--runs <n>] [--model <model>]"
  )
  process.exit(1)
}

const runsArg = argAfter("--runs")
const runs    = runsArg ? parseInt(runsArg, 10) : (mode === "update" ? 5 : 3)

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  console.error("Error: OPENAI_API_KEY env var is required")
  process.exit(1)
}

// ---- Build graphs ------------------------------------------------------------

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
console.log(`Extracted ${allGraphs.length} execution graphs`)

// Verify golden answers dir has at least one trace
const traceCount = readdirSync(goldenAnswers).filter((f) => f.endsWith(".yaml")).length
if (traceCount === 0) {
  console.error(`No .yaml files found in golden-answers dir: ${goldenAnswers}`)
  process.exit(1)
}
console.log(`Golden answers: ${traceCount} traces in ${goldenAnswers}`)
console.log(`Runs: ${runs}  Mode: ${mode}  Label: ${label}`)
console.log()

// ---- Run ---------------------------------------------------------------------

const llmClient = new OpenAILLMClient({ apiKey, model, maxTokens: 2048 })

console.log(`Capturing LLM baseline (${runs} runs)…`)
const current = await captureLLMBaseline({
  graphs:           allGraphs,
  llmClient,
  goldenAnswersDir: goldenAnswers,
  label,
  project:          projectRoot,
  llmMode:          model,
  runs,
})

console.log()
console.log("Per-trace results:")
for (const [id, e] of Object.entries(current.entries)) {
  console.log(
    `  ${id.padEnd(30)} mean=${e.mean.toFixed(3)}  stddev=${e.stddev.toFixed(3)}` +
    `  min=${e.min.toFixed(3)}  max=${e.max.toFixed(3)}` +
    `  runs=[${e.per_run.map((s) => s.toFixed(2)).join(", ")}]`
  )
}
console.log()
console.log(`avg_mean=${current.avg_mean_score.toFixed(3)}  avg_stddev=${current.avg_stddev.toFixed(3)}`)
console.log()

if (mode === "update") {
  const outPath = saveLLMBaseline(current, BASELINE_DIR)
  console.log(`Baseline saved: ${outPath}`)
  process.exit(0)
}

// mode === "verify"
const stored = loadLLMBaseline(BASELINE_DIR, label)
if (!stored) {
  console.error(`No baseline found at benchmarks/baselines/${label}.json`)
  console.error("Run with --update first to create a baseline.")
  process.exit(1)
}

const result = verifyLLMBaseline(current, stored)

if (result.ok) {
  console.log(`LLM baseline verify PASSED (${label}) — no regressions detected`)
  process.exit(0)
} else {
  console.error(`LLM baseline verify FAILED (${label}) — regressions detected:`)
  for (const d of result.drifts.filter((x) => x.changed)) {
    console.error(`  ${d.golden_id}:`)
    for (const detail of d.details) {
      console.error(`    - ${detail}`)
    }
  }
  console.error()
  console.error("If this regression is intentional, run with --update to accept the new baseline.")
  process.exit(1)
}
