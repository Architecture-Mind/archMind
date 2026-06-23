/**
 * NestJS adapter benchmark runner.
 * Loads all NestJS golden traces, scores recall against live projects,
 * and saves a snapshot JSON to benchmarks/snapshots/.
 *
 * Usage: node --loader ts-node/esm src/benchmark.ts
 * Or build first: npm run build && node dist/benchmark.js
 */
import { join, dirname, relative } from "path"
import { fileURLToPath } from "url"
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs"
import yaml from "js-yaml"
import { parseNestJSProject } from "./adapter.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname = .../packages/nestjs-parser/src  (or dist after build)
const REPO_ROOT    = join(__dirname, "../../../")
const TRACES_ROOT  = join(REPO_ROOT, "research/golden-traces")
const SNAPSHOT_DIR = join(REPO_ROOT, "benchmarks/snapshots")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GoldenNode {
  id: string
  type: string
  symbol: string
  retrieval: { relevance: "HIGH" | "MEDIUM" | "LOW" }
}

interface GoldenTrace {
  id: string
  entrypoint: string
  framework: string
  source_project: string
  adapter_version?: string
  retrieval?: { query?: string }
  nodes: GoldenNode[]
}

interface TraceResult {
  traceId:       string
  entrypoint:    string
  sourceProject: string
  recall:        number
  highMatched:   number
  highTotal:     number
  skipped:       boolean
  skipReason?:   string
}

export interface NestJSBenchmarkSnapshot {
  snapshotId:    string
  createdAt:     string
  adapterVersion: string
  irVersion:     string
  results:       TraceResult[]
  avgRecall:     number
  tracesRun:     number
  tracesSkipped: number
}

// ---------------------------------------------------------------------------
// Project root map — add new projects here as they're onboarded
// ---------------------------------------------------------------------------

const PROJECT_ROOTS: Record<string, string> = {
  "IPFS-api":       "C:/Users/Admin/Desktop/DuckCode/Backend/IPFS-api",
  "education-api":  "C:/Users/Admin/Desktop/DuckCode/Node/education-api",
  "marketplace-nft-server": "C:/Users/Admin/Desktop/DuckCode/Node/marketplace-nft-server",
  "storage-metadata-nft":   "C:/Users/Admin/Desktop/DuckCode/Node/storage-metadata-nft",
}

// ---------------------------------------------------------------------------
// Trace loading
// ---------------------------------------------------------------------------

function loadNestJSTraces(): GoldenTrace[] {
  const traces: GoldenTrace[] = []
  for (const dir of readdirSync(TRACES_ROOT)) {
    const traceDir = join(TRACES_ROOT, dir)
    for (const file of readdirSync(traceDir)) {
      if (!file.endsWith(".yaml")) continue
      const raw = yaml.load(readFileSync(join(traceDir, file), "utf8")) as GoldenTrace
      if (raw.framework === "nestjs") traces.push(raw)
    }
  }
  return traces
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function normalizeEp(ep: string): string {
  return ep.replace(/\{[^}]+\}/g, "{*}").replace(/:([a-zA-Z_]+)/g, "{*}")
}

function scoreRecall(
  trace: GoldenTrace,
  graphs: IntermediateExecutionGraph[]
): { recall: number; highMatched: number; highTotal: number } {
  const graph = graphs.find(
    g => normalizeEp(g.entrypoint) === normalizeEp(trace.entrypoint)
  )
  if (!graph) return { recall: 0, highMatched: 0, highTotal: 0 }

  const highNodes = trace.nodes.filter(n => n.retrieval.relevance === "HIGH")
  if (!highNodes.length) return { recall: 1, highMatched: 0, highTotal: 0 }

  let matched = 0
  for (const golden of highNodes) {
    const hit = graph.nodes.find(n =>
      n.symbol.toLowerCase().includes(golden.symbol.toLowerCase()) ||
      golden.symbol.toLowerCase().includes(n.symbol.toLowerCase())
    )
    if (hit) matched++
  }

  return {
    recall: matched / highNodes.length,
    highMatched: matched,
    highTotal: highNodes.length,
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function runNestJSBenchmark(snapshotId?: string): NestJSBenchmarkSnapshot {
  const traces = loadNestJSTraces()
  const results: TraceResult[] = []

  // Parse each project once, cache by project root
  const graphCache = new Map<string, IntermediateExecutionGraph[]>()

  for (const trace of traces) {
    const projectRoot = PROJECT_ROOTS[trace.source_project]

    if (!projectRoot || !existsSync(projectRoot)) {
      results.push({
        traceId:       trace.id,
        entrypoint:    trace.entrypoint,
        sourceProject: trace.source_project,
        recall:        0,
        highMatched:   0,
        highTotal:     0,
        skipped:       true,
        skipReason:    projectRoot ? "project_not_found" : "no_project_root_mapping",
      })
      continue
    }

    if (!graphCache.has(projectRoot)) {
      graphCache.set(projectRoot, parseNestJSProject(projectRoot))
    }

    const graphs = graphCache.get(projectRoot)!
    const { recall, highMatched, highTotal } = scoreRecall(trace, graphs)

    results.push({
      traceId:       trace.id,
      entrypoint:    trace.entrypoint,
      sourceProject: trace.source_project,
      recall,
      highMatched,
      highTotal,
      skipped:       false,
    })
  }

  const ran     = results.filter(r => !r.skipped)
  const skipped = results.filter(r => r.skipped)
  const avgRecall = ran.length
    ? ran.reduce((s, r) => s + r.recall, 0) / ran.length
    : 0

  // Derive adapter version from a live graph if available, else fallback
  const sampleGraph = Array.from(graphCache.values()).flat()[0]
  const adapterVersion = sampleGraph?.adapter_ver ?? "0.2.0"
  const irVersion      = sampleGraph?.ir_ver ?? "1.0"

  const id = snapshotId ?? `nestjs-${new Date().toISOString().slice(0, 10)}`

  const snapshot: NestJSBenchmarkSnapshot = {
    snapshotId:    id,
    createdAt:     new Date().toISOString(),
    adapterVersion,
    irVersion,
    results,
    avgRecall,
    tracesRun:     ran.length,
    tracesSkipped: skipped.length,
  }

  mkdirSync(SNAPSHOT_DIR, { recursive: true })
  writeFileSync(
    join(SNAPSHOT_DIR, `${id}.json`),
    JSON.stringify(snapshot, null, 2),
    "utf8"
  )

  return snapshot
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === "") {
  const snapshot = runNestJSBenchmark(process.argv[2])
  console.log(`\nNestJS Adapter Benchmark — ${snapshot.snapshotId}`)
  console.log("─".repeat(60))
  for (const r of snapshot.results) {
    const icon = r.skipped ? "–" : r.recall >= 1.0 ? "✓" : "✗"
    const label = r.skipped ? `SKIP (${r.skipReason})` : `recall=${r.recall.toFixed(2)} (${r.highMatched}/${r.highTotal})`
    console.log(`  ${icon} ${r.traceId.padEnd(38)} ${label}`)
  }
  console.log("─".repeat(60))
  console.log(`    Avg recall : ${snapshot.avgRecall.toFixed(2)}`)
  console.log(`    Traces run : ${snapshot.tracesRun}`)
  console.log(`    Skipped    : ${snapshot.tracesSkipped}`)
  console.log(`    Snapshot   : benchmarks/snapshots/${snapshot.snapshotId}.json`)
}
