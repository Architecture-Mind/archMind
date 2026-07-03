/**
 * Phase 16.5 — Reasoning Benchmark (structural scoring, no LLM)
 *
 * Validates EvidencePackage quality against golden Q&A pairs:
 *   - expected_finding present
 *   - expected_intent detected
 *   - expected_evidence_nodes in package
 */

import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { readdirSync, readFileSync, existsSync } from "fs"
import yaml from "js-yaml"
import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap } from "@kidkender/archmind-laravel-parser"
import { buildEvidencePackage } from "@kidkender/archmind-explainer"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const REPO_ROOT  = join(__dirname, "../../../..")
const QA_DIR     = join(REPO_ROOT, "research/golden-qa/ecomerce-api")

const ECOMERCE_ROOT = "C:/Users/Admin/Desktop/DuckCode/New folder/laravel/ecomerce-api"

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

const projectAvailable = existsSync(ECOMERCE_ROOT)

describe("Phase 16.5 — Reasoning Benchmark (ecomerce-api)", () => {
  if (!projectAvailable) {
    it.skip("ecomerce-api project not found at expected path", () => {})
    return
  }

  let allGraphs: IntermediateExecutionGraph[] = []

  beforeAll(() => {
    const config = loadProjectConfig(ECOMERCE_ROOT)
    const { aliasMap, routeFiles } = resolveAliasMap(ECOMERCE_ROOT, config)
    for (const relFile of routeFiles) {
      const skeletons = parseRouteFile(join(ECOMERCE_ROOT, relFile), { aliasMap })
      for (const g of skeletons) {
        allGraphs.push(augmentGraph(g, { projectRoot: ECOMERCE_ROOT, config }))
      }
    }
  })

  const qaFiles = readdirSync(QA_DIR).filter((f) => f.endsWith(".yaml"))
  const qaPairs: GoldenQA[] = qaFiles.map(
    (f) => yaml.load(readFileSync(join(QA_DIR, f), "utf-8")) as GoldenQA
  )

  for (const qa of qaPairs) {
    describe(qa.id, () => {
      it(`finds correct graph for route "${qa.route}"`, () => {
        const graph = allGraphs.find((g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase())
        expect(graph).toBeDefined()
      })

      it(`intent detected as "${qa.expected_intent}"`, () => {
        const graph = allGraphs.find((g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase())
        if (!graph) return
        const pkg = buildEvidencePackage(qa.question, graph)
        expect(pkg.intent).toBe(qa.expected_intent)
      })

      it(`top finding is "${qa.expected_finding}"`, () => {
        const graph = allGraphs.find((g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase())
        if (!graph) return
        const pkg = buildEvidencePackage(qa.question, graph)
        expect(pkg.finding).toBe(qa.expected_finding)
      })

      it("expected evidence nodes present in package", () => {
        const graph = allGraphs.find((g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase())
        if (!graph) return
        const pkg = buildEvidencePackage(qa.question, graph)
        const evidenceSymbols = pkg.evidence.map((e) => e.symbol.toLowerCase())

        for (const expected of qa.expected_evidence_nodes) {
          const found = evidenceSymbols.some(
            (s) => s === expected.symbol.toLowerCase() || s.includes(expected.symbol.toLowerCase())
          )
          expect(found).toBe(true)
        }
      })

      it("execution_path is non-empty", () => {
        const graph = allGraphs.find((g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase())
        if (!graph) return
        const pkg = buildEvidencePackage(qa.question, graph)
        expect(pkg.execution_path.length).toBeGreaterThan(0)
      })

      it("facts contain at least one HIGH-relevance entry", () => {
        const graph = allGraphs.find((g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase())
        if (!graph) return
        const pkg = buildEvidencePackage(qa.question, graph)
        expect(pkg.facts.some(f => f.relevance === "high")).toBe(true)
      })
    })
  }

  it("avg evidence_precision across all pairs >= 0.8", () => {
    let total = 0
    let count = 0
    for (const qa of qaPairs) {
      const graph = allGraphs.find((g) => g.entrypoint?.toLowerCase() === qa.route.toLowerCase())
      if (!graph) continue
      const pkg = buildEvidencePackage(qa.question, graph)
      const evidenceSymbols = pkg.evidence.map((e) => e.symbol.toLowerCase())
      const matched = qa.expected_evidence_nodes.filter((n) =>
        evidenceSymbols.some((s) => s === n.symbol.toLowerCase() || s.includes(n.symbol.toLowerCase()))
      )
      total += qa.expected_evidence_nodes.length > 0 ? matched.length / qa.expected_evidence_nodes.length : 1
      count++
    }
    const avg = count > 0 ? total / count : 0
    console.log(`avg_evidence_precision = ${avg.toFixed(3)}`)
    expect(avg).toBeGreaterThanOrEqual(0.8)
  })
})
