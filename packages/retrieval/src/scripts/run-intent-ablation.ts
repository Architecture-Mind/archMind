#!/usr/bin/env node
/**
 * Phase 18B — Intent Ablation
 *
 * Runs a single Q&A pair under multiple forced intents to diagnose whether
 * QA-B2B-003 failure is in the intent layer, retrieval layer, or fact extraction layer.
 *
 * For each forced intent, computes:
 *   - fact_coverage:      matching expected_facts / total expected_facts
 *   - evidence_precision: % expected_evidence_nodes present in package
 *   - facts_list:         extracted facts and their presence/value
 *
 * No LLM calls — purely structural analysis.
 *
 * Usage (from repo root after building):
 *   node packages/retrieval/dist/scripts/run-intent-ablation.js [qa-id] [project-name]
 *
 * Default: QA-B2B-003 in laravel-b2b-ecommerce
 */
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { readdirSync, readFileSync } from "fs"
import yaml from "js-yaml"
import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from "@kidkender/archmind-laravel-parser"
import { buildEvidencePackage } from "@kidkender/archmind-explainer"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { EvidencePackage } from "@kidkender/archmind-explainer"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const REPO_ROOT  = join(__dirname, "../../../..")

const PROJECT_PATHS: Record<string, string> = {
  "ecomerce-api":          "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/ecomerce-api",
  "laravel-b2b-ecommerce": "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/laravel-b2b-ecommerce",
}

const targetQaId    = process.argv[2] ?? "QA-B2B-003"
const projectName   = process.argv[3] ?? "laravel-b2b-ecommerce"
const projectRoot   = PROJECT_PATHS[projectName]

if (!projectRoot) {
  console.error(`Unknown project: ${projectName}`)
  process.exit(1)
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface ExpectedFact {
  type: string
  present: boolean
}

interface GoldenQA {
  id: string
  route: string
  question: string
  expected_intent: string
  expected_finding: string
  expected_facts?: ExpectedFact[]
  expected_evidence_nodes: Array<{ symbol: string; type: string; role: string }>
  golden_answer: string
}

// ─── Parse project ───────────────────────────────────────────────────────────

console.log(`\nParsing: ${projectRoot}`)
const config = loadProjectConfig(projectRoot)
const { aliasMap, routeFiles } = resolveAliasMap(projectRoot, config)
const allGraphs: IntermediateExecutionGraph[] = []
for (const relFile of routeFiles) {
  const skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap })
  for (const g of skeletons) allGraphs.push(augmentGraph(g, { projectRoot, config }))
}
console.log(`Parsed ${allGraphs.length} graphs\n`)

// ─── Load target Q&A pair ────────────────────────────────────────────────────

const qaDir   = join(REPO_ROOT, "research/golden-qa", projectName)
const qaFiles = readdirSync(qaDir).filter((f) => f.endsWith(".yaml"))
const allQA   = qaFiles.map((f) => yaml.load(readFileSync(join(qaDir, f), "utf-8")) as GoldenQA)

const qa = allQA.find((q) => q.id === targetQaId)
if (!qa) {
  console.error(`Q&A pair not found: ${targetQaId}`)
  console.error(`Available: ${allQA.map((q) => q.id).join(", ")}`)
  process.exit(1)
}

const graph = allGraphs.find((g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase())
if (!graph) {
  console.error(`No graph for route: ${qa.route}`)
  process.exit(1)
}

// ─── Ablation variants ───────────────────────────────────────────────────────

const INTENTS = ["auth", "transaction", "validation", "isolation", "runtime", "all"] as const

function computeFactCoverage(pkg: EvidencePackage, expected: ExpectedFact[] | undefined): number {
  if (!expected || expected.length === 0) return 1
  const matched = expected.filter((ef) => {
    const actual = pkg.facts.find((f) => f.type === ef.type)
    if (!actual) return !ef.present
    return actual.present === ef.present
  })
  return matched.length / expected.length
}

function computeEvidencePrecision(pkg: EvidencePackage, expectedNodes: GoldenQA["expected_evidence_nodes"]): number {
  if (expectedNodes.length === 0) return 1
  const evidenceSymbols = pkg.evidence.map((e) => e.symbol.toLowerCase())
  const matched = expectedNodes.filter((n) =>
    evidenceSymbols.some((s) => s === n.symbol.toLowerCase() || s.includes(n.symbol.toLowerCase()))
  )
  return matched.length / expectedNodes.length
}

// ─── Run ablation ────────────────────────────────────────────────────────────

console.log(`=== Intent Ablation: ${qa.id} ===`)
console.log(`Route:    ${qa.route}`)
console.log(`Question: ${qa.question}`)
console.log(`Default intent (auto-detected): ${qa.expected_intent}`)
if (qa.expected_facts?.length) {
  console.log(`Expected facts: ${qa.expected_facts.map((f) => `${f.type}=${f.present}`).join(", ")}`)
}
console.log()

console.log(`${"Intent".padEnd(22)} ${"fact_cov".padEnd(12)} ${"ev_prec".padEnd(12)} ${"facts extracted"}`)
console.log(`${"-".repeat(90)}`)

// First row: actual multi-intent auto-detect (no forceIntent)
{
  const pkg = buildEvidencePackage(qa.question, graph)
  const fact_coverage      = computeFactCoverage(pkg, qa.expected_facts)
  const evidence_precision = computeEvidencePrecision(pkg, qa.expected_evidence_nodes)
  const intentsLabel = pkg.intents
    ? pkg.intents.map((i) => `${i.intent}(${i.score.toFixed(2)})`).join("+")
    : pkg.intent
  const factsLine = pkg.facts.map((f) => `${f.present ? "✓" : "✗"}${f.type}(${f.relevance[0]})`).join(" ")
  console.log(`${"multi-intent [auto]".padEnd(22)} ${fact_coverage.toFixed(2).padEnd(12)} ${evidence_precision.toFixed(2).padEnd(12)} ${factsLine}`)
  console.log(`  active intents: ${intentsLabel}`)
  console.log()
  console.log(`  --- Facts detail (multi-intent) ---`)
  for (const f of pkg.facts) {
    const mark = f.present ? "✓" : "✗"
    const val  = f.value ? ` = ${f.value}` : ""
    console.log(`    [${f.relevance}] ${mark} ${f.type}${val}`)
  }
  console.log()
}

console.log(`${"-".repeat(90)}`)
console.log(`Single-intent forced rows (for comparison):`)
console.log()

for (const intent of INTENTS) {
  const pkg = buildEvidencePackage(qa.question, graph, { forceIntent: intent })
  const fact_coverage      = computeFactCoverage(pkg, qa.expected_facts)
  const evidence_precision = computeEvidencePrecision(pkg, qa.expected_evidence_nodes)

  const marker = intent === qa.expected_intent ? " ← expected" : ""
  const factsLine = pkg.facts
    .map((f) => `${f.present ? "✓" : "✗"}${f.type}`)
    .join(" ")

  console.log(
    `${(intent + marker).padEnd(22)} ${fact_coverage.toFixed(2).padEnd(12)} ${evidence_precision.toFixed(2).padEnd(12)} ${factsLine}`
  )

  // Detail view for the default intent
  if (intent === qa.expected_intent) {
    console.log()
    console.log(`  --- Facts detail (forced intent=${intent}) ---`)
    for (const f of pkg.facts) {
      const mark = f.present ? "✓" : "✗"
      const val  = f.value   ? ` = ${f.value}` : ""
      console.log(`    [${f.relevance}] ${mark} ${f.type}${val}`)
    }
    console.log()
    console.log(`  --- Evidence detail (intent=${intent}) ---`)
    for (const e of pkg.evidence) {
      console.log(`    [${e.role}] ${e.symbol}`)
    }
    console.log()
    console.log(`  --- Finding (intent=${intent}) ---`)
    console.log(`    finding=${pkg.finding}  severity=${pkg.severity}  confidence=${pkg.confidence}`)
    console.log()
  }
}

console.log()
console.log("Diagnosis guide:")
console.log("  fact_cov high + ev_prec high  → representation problem (facts ok, not surfaced to LLM well)")
console.log("  fact_cov low                  → retrieval/extraction problem (facts missing from graph)")
console.log("  fact_cov varies by intent     → intent layer problem (wrong intent selected)")
