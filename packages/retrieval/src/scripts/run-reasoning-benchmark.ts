#!/usr/bin/env node
/**
 * Phase 16.5 — Reasoning Benchmark
 *
 * Compares LLM answer quality between two modes for the same Q&A pair:
 *   Mode A: Claude + naive RAG (raw source files)
 *   Mode B: Claude + ArchMind EvidencePackage
 *
 * Scoring uses evidence_precision (structural check, no LLM call):
 *   - Were the expected_evidence_nodes present in the evidence package?
 *   - Was the expected_finding emitted?
 *   - Was the expected_intent detected?
 *
 * Usage (from repo root):
 *   node --loader ts-node/esm packages/retrieval/src/scripts/run-reasoning-benchmark.ts \
 *     <project-root> [label]
 *
 * Example:
 *   node --loader ts-node/esm packages/retrieval/src/scripts/run-reasoning-benchmark.ts \
 *     "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/ecomerce-api" ecomerce-reasoning
 */
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from "fs"
import yaml from "js-yaml"
import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from "@kidkender/archmind-laravel-parser"
import { buildEvidencePackage } from "@kidkender/archmind-explainer"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { EvidencePackage } from "@kidkender/archmind-explainer"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

const REPO_ROOT  = join(__dirname, "../../../..")
const QA_DIR     = join(REPO_ROOT, "research/golden-qa/ecomerce-api")
const SNAP_DIR   = join(REPO_ROOT, "benchmarks/snapshots")

const projectRoot = process.argv[2]
const label       = process.argv[3] ?? "ecomerce-reasoning"

if (!projectRoot) {
  console.error("Usage: run-reasoning-benchmark.ts <project-root> [label]")
  process.exit(1)
}

// ---- Types -----------------------------------------------------------------

interface GoldenQA {
  id: string
  route: string
  question: string
  expected_finding: string
  expected_severity: string
  expected_intent: string
  expected_evidence_nodes: Array<{ symbol: string; type: string; role: string }>
  expected_answer_contains: string[]
  golden_answer: string
}

interface QAResult {
  id: string
  route: string
  question: string
  evidence_precision: number    // % expected_evidence_nodes present in package
  finding_match: boolean        // expected_finding === package.finding
  intent_match: boolean         // expected_intent === package.intent
  score: number                 // composite 0–1
  package: EvidencePackage
}

interface ReasoningSnapshot {
  label: string
  timestamp: string
  project_root: string
  summary: {
    total_qa: number
    avg_score: number
    avg_evidence_precision: number
    finding_match_rate: number
    intent_match_rate: number
  }
  results: QAResult[]
}

// ---- Parse project ---------------------------------------------------------

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

// ---- Load Q&A pairs --------------------------------------------------------

const qaFiles = readdirSync(QA_DIR).filter((f) => f.endsWith(".yaml"))
const qaPairs: GoldenQA[] = qaFiles.map(
  (f) => yaml.load(readFileSync(join(QA_DIR, f), "utf-8")) as GoldenQA
)

console.log(`Loaded ${qaPairs.length} Q&A pairs from ${QA_DIR}\n`)

// ---- Score each pair -------------------------------------------------------

function scorePair(qa: GoldenQA, graphs: IntermediateExecutionGraph[]): QAResult {
  const graph = graphs.find((g) =>
    g.entrypoint?.toLowerCase() === qa.route.toLowerCase()
  )

  if (!graph) {
    console.warn(`  WARN: no graph for route "${qa.route}"`)
    return {
      id: qa.id,
      route: qa.route,
      question: qa.question,
      evidence_precision: 0,
      finding_match: false,
      intent_match: false,
      score: 0,
      package: {
        question: qa.question,
        intent: "all",
        facts: [],
        finding: "none",
        severity: "INFO",
        confidence: "LOW",
        execution_path: [],
        evidence: [],
      },
    }
  }

  const pkg = buildEvidencePackage(qa.question, graph)

  // Evidence precision: how many expected_evidence_nodes are in pkg.evidence
  const evidenceSymbols = new Set(pkg.evidence.map((e) => e.symbol.toLowerCase()))
  const matched = qa.expected_evidence_nodes.filter((n) =>
    evidenceSymbols.has(n.symbol.toLowerCase()) ||
    pkg.evidence.some((e) => e.symbol.toLowerCase().includes(n.symbol.toLowerCase()))
  )
  const evidence_precision = qa.expected_evidence_nodes.length > 0
    ? matched.length / qa.expected_evidence_nodes.length
    : 1

  const finding_match = pkg.finding === qa.expected_finding
  const intent_match  = pkg.intent  === qa.expected_intent

  // Composite score: 50% evidence precision, 30% finding match, 20% intent match
  const score = evidence_precision * 0.5 + (finding_match ? 0.3 : 0) + (intent_match ? 0.2 : 0)

  return { id: qa.id, route: qa.route, question: qa.question, evidence_precision, finding_match, intent_match, score, package: pkg }
}

const results: QAResult[] = []

for (const qa of qaPairs) {
  console.log(`[${qa.id}] "${qa.question}"`)
  const result = scorePair(qa, allGraphs)
  results.push(result)
  console.log(`  finding_match=${result.finding_match}  intent_match=${result.intent_match}  evidence_precision=${result.evidence_precision.toFixed(2)}  score=${result.score.toFixed(3)}`)
  console.log(`  evidence: [${result.package.evidence.map((e) => e.symbol).join(", ")}]`)
  console.log(`  execution_path: [${result.package.execution_path.join(" → ")}]`)
  console.log()
}

// ---- Snapshot --------------------------------------------------------------

const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0

const snapshot: ReasoningSnapshot = {
  label,
  timestamp: new Date().toISOString(),
  project_root: projectRoot,
  summary: {
    total_qa:               results.length,
    avg_score:              avg(results.map((r) => r.score)),
    avg_evidence_precision: avg(results.map((r) => r.evidence_precision)),
    finding_match_rate:     results.filter((r) => r.finding_match).length / results.length,
    intent_match_rate:      results.filter((r) => r.intent_match).length  / results.length,
  },
  results,
}

mkdirSync(SNAP_DIR, { recursive: true })
const outPath = join(SNAP_DIR, `${label}.json`)
writeFileSync(outPath, JSON.stringify(snapshot, null, 2))

console.log(`\n=== Summary ===`)
console.log(`  total_qa              = ${snapshot.summary.total_qa}`)
console.log(`  avg_score             = ${snapshot.summary.avg_score.toFixed(3)}`)
console.log(`  avg_evidence_precision= ${snapshot.summary.avg_evidence_precision.toFixed(3)}`)
console.log(`  finding_match_rate    = ${snapshot.summary.finding_match_rate.toFixed(2)}`)
console.log(`  intent_match_rate     = ${snapshot.summary.intent_match_rate.toFixed(2)}`)
console.log(`\nSaved: ${outPath}`)
