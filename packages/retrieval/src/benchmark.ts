import { join } from "path"
import { readdirSync, readFileSync } from "fs"
import yaml from "js-yaml"
import { loadGoldenTrace, scoreRetrieval } from "@kidkender/archmind-scorer"
import type { GoldenTrace } from "@kidkender/archmind-scorer"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { ingestOtlpFile } from "@kidkender/archmind-runtime-ingest"
import { correlateSession, detectNPlusOne, detectSlowQuery } from "@kidkender/archmind-runtime-correlator"
import { retrieve, prune } from "./retrieval-engine.js"
import { naiveRag, compare } from "./naive-rag.js"
import { toIRNodeType } from "@kidkender/archmind-protocol"

// ---- Runtime golden session types ------------------------------------

interface ExpectedRuntimeFinding {
  type:              string
  severity?:         string
  min_count?:        number
  evidence_contains?: string
}

interface RuntimeGoldenSession {
  id:                string
  entrypoint:        string
  otlp_fixture:      string
  expected_findings: ExpectedRuntimeFinding[]
  correlation?: {
    expected_rate_gte?: number
  }
}

export interface RuntimeTraceSnapshot {
  session_id:         string
  entrypoint:         string
  correlation_rate:   number
  runtime_recall:     number
  findings_found:     number
  findings_expected:  number
}

// ---- Public API -------------------------------------------------------

export interface TraceSnapshot {
  entrypoint:        string
  naive_rag_tokens:  number
  naive_rag_files:   number
  r0_tokens:         number
  r0_recall:         number
  r1_tokens:         number
  r1_recall:         number
  compression_r0:    number
  compression_r1:    number
  token_savings_r0:  number   // percent
  token_savings_r1:  number   // percent
  recall_gap:        number   // 1.0 - r0_recall
  recall_gap_reason: "extraction_ceiling" | "retrieval_failure" | "cross_cutting" | "ok"
  missing_high_nodes: string[]
}

export interface BenchmarkSnapshot {
  timestamp:       string
  label:           string
  adapter_ver?:    string   // adapter package version that generated the graphs
  ir_ver?:         string   // IR spec version
  traces:          Record<string, TraceSnapshot>
  runtime_traces?: Record<string, RuntimeTraceSnapshot>
  summary: {
    avg_r0_recall:        number
    avg_compression_r0:   number
    avg_token_savings_r0: number
    total_traces:         number
    avg_runtime_recall?:  number
  }
}

export function runBenchmark(opts: {
  goldenDir:          string
  fixtureDir:         string
  graphs:             Record<string, IntermediateExecutionGraph[]>  // golden_id → extracted graphs
  label?:             string
  adapter_ver?:       string   // adapter version that produced the graphs
  runtimeGoldenDir?:  string   // dir containing runtime golden session YAMLs
  workspaceRoot?:     string   // base path for resolving otlp_fixture paths
}): BenchmarkSnapshot {
  const { goldenDir, fixtureDir, graphs, label = "snapshot", adapter_ver, runtimeGoldenDir, workspaceRoot } = opts

  const traceFiles = readdirSync(goldenDir).filter((f) => f.endsWith(".yaml"))
  const traces: Record<string, TraceSnapshot> = {}

  for (const file of traceFiles) {
    const golden = loadGoldenTrace(join(goldenDir, file))
    const id     = golden.id
    const gs     = graphs[id] ?? []

    // Naive RAG
    const naive = naiveRag(golden, fixtureDir)

    // ArchMind R0
    const r0 = retrieve({ entrypoint: golden.entrypoint }, gs)
    if (!r0) {
      // Cross-cutting or missing entrypoint — skip detailed metrics
      traces[id] = buildSkipSnapshot(golden, naive)
      continue
    }

    // ArchMind R1 (auth focus)
    const r1 = prune(r0, "HIGH")

    const r0Score = scoreRetrieval(golden, r0)
    const r1Score = scoreRetrieval(golden, r1)
    const r0Cmp   = compare(naive, r0.token_estimate, r0Score.combined_recall)
    const r1Cmp   = compare(naive, r1.token_estimate, r1Score.combined_recall)

    const missingHigh = golden.nodes
      .filter((n) => n.retrieval?.relevance === "HIGH")
      .filter((n) => !r0.nodes.some((e) => {
        const es = e.symbol.toLowerCase()
        const gs = n.symbol.toLowerCase()
        return es === gs || es.includes(gs) || gs.includes(es)
      }))
      .map((n) => n.id)

    const recallGapReason = classifyRecallGap(r0Score.combined_recall, missingHigh, golden)

    traces[id] = {
      entrypoint:        golden.entrypoint,
      naive_rag_tokens:  naive.token_estimate,
      naive_rag_files:   naive.files.length,
      r0_tokens:         r0.token_estimate,
      r0_recall:         r0Score.combined_recall,
      r1_tokens:         r1.token_estimate,
      r1_recall:         r1Score.combined_recall,
      compression_r0:    parseFloat(r0Cmp.compression_ratio.toFixed(2)),
      compression_r1:    parseFloat(r1Cmp.compression_ratio.toFixed(2)),
      token_savings_r0:  parseFloat(r0Cmp.token_savings_pct.toFixed(1)),
      token_savings_r1:  parseFloat(r1Cmp.token_savings_pct.toFixed(1)),
      recall_gap:        parseFloat((1 - r0Score.combined_recall).toFixed(2)),
      recall_gap_reason: recallGapReason,
      missing_high_nodes: missingHigh,
    }
  }

  const scored = Object.values(traces).filter((t) => t.recall_gap_reason !== "cross_cutting")
  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0

  // Runtime scoring — optional
  let runtimeTraces: Record<string, RuntimeTraceSnapshot> | undefined
  if (runtimeGoldenDir && workspaceRoot) {
    runtimeTraces = runRuntimeBenchmark(runtimeGoldenDir, workspaceRoot, graphs)
  }

  const runtimeRecalls = runtimeTraces
    ? Object.values(runtimeTraces).map((t) => t.runtime_recall)
    : undefined

  // Derive adapter_ver and ir_ver from any graph in the input if not explicitly provided
  const sampleGraph = Object.values(graphs).flat()[0]
  const resolvedAdapterVer = adapter_ver ?? sampleGraph?.adapter_ver
  const resolvedIrVer      = sampleGraph?.ir_ver

  return {
    timestamp: new Date().toISOString(),
    label,
    ...(resolvedAdapterVer ? { adapter_ver: resolvedAdapterVer } : {}),
    ...(resolvedIrVer      ? { ir_ver: resolvedIrVer }           : {}),
    traces,
    ...(runtimeTraces ? { runtime_traces: runtimeTraces } : {}),
    summary: {
      avg_r0_recall:        parseFloat(avg(scored.map((t) => t.r0_recall)).toFixed(2)),
      avg_compression_r0:   parseFloat(avg(scored.map((t) => t.compression_r0)).toFixed(2)),
      avg_token_savings_r0: parseFloat(avg(scored.map((t) => t.token_savings_r0)).toFixed(1)),
      total_traces:         Object.keys(traces).length,
      ...(runtimeRecalls ? { avg_runtime_recall: parseFloat(avg(runtimeRecalls).toFixed(2)) } : {}),
    },
  }
}

// ---- Runtime benchmark ------------------------------------------------

function scoreRuntimeFindings(
  detected: ReturnType<typeof detectNPlusOne>,
  expected: ExpectedRuntimeFinding[],
): number {
  if (expected.length === 0) return 1
  const satisfied = expected.filter((ef) =>
    detected.some((df) => {
      if (df.type !== ef.type) return false
      if (ef.evidence_contains && !df.evidence.includes(ef.evidence_contains)) return false
      if (ef.min_count !== undefined && (df.count ?? 0) < ef.min_count) return false
      return true
    }),
  )
  return satisfied.length / expected.length
}

function flattenAllGraphs(
  graphs: Record<string, IntermediateExecutionGraph[]>,
): IntermediateExecutionGraph[] {
  return Object.values(graphs).flat()
}

function runRuntimeBenchmark(
  runtimeGoldenDir: string,
  workspaceRoot: string,
  graphs: Record<string, IntermediateExecutionGraph[]>,
): Record<string, RuntimeTraceSnapshot> {
  const snapshots: Record<string, RuntimeTraceSnapshot> = {}
  const allGraphs = flattenAllGraphs(graphs)
  const files = readdirSync(runtimeGoldenDir).filter((f) => f.endsWith(".yaml"))

  for (const file of files) {
    const raw = readFileSync(join(runtimeGoldenDir, file), "utf-8")
    const session = yaml.load(raw) as RuntimeGoldenSession

    const fixturePath = join(workspaceRoot, session.otlp_fixture)
    let traceSession
    try {
      traceSession = ingestOtlpFile(fixturePath)
    } catch {
      continue
    }

    const graph = allGraphs.find((g) => {
      const norm = (ep: string) => ep.replace(/\{[^}]+\}/g, "{*}")
      return norm(g.entrypoint) === norm(session.entrypoint)
    })
    if (!graph) continue

    const correlated = correlateSession(traceSession, graph)

    const n1Findings    = detectNPlusOne(correlated)
    const slowFindings  = detectSlowQuery(correlated)
    const allFindings   = [...n1Findings, ...slowFindings]

    const runtimeRecall = scoreRuntimeFindings(allFindings, session.expected_findings ?? [])

    snapshots[session.id] = {
      session_id:        session.id,
      entrypoint:        session.entrypoint,
      correlation_rate:  parseFloat(correlated.correlationRate.toFixed(2)),
      runtime_recall:    parseFloat(runtimeRecall.toFixed(2)),
      findings_found:    allFindings.length,
      findings_expected: (session.expected_findings ?? []).length,
    }
  }

  return snapshots
}

// ---- Helpers ----------------------------------------------------------

function classifyRecallGap(
  recall: number,
  missingHighNodes: string[],
  golden: GoldenTrace
): TraceSnapshot["recall_gap_reason"] {
  if (golden.entrypoint.includes("*") || golden.entrypoint.startsWith("ANY")) {
    return "cross_cutting"
  }
  if (recall >= 0.99) return "ok"
  // If missing nodes are all service_call / deeper types that aren't yet extracted
  const DEEPER_IR_TYPES = new Set(["ir:service_call", "ir:permission_constant", "ir:runtime_inject", "ir:runtime_consume"])
  const allMissingAreDeeper = missingHighNodes.every((id) => {
    const node = golden.nodes.find((n) => n.id === id)
    if (!node) return false
    return DEEPER_IR_TYPES.has(toIRNodeType(node.type))
  })
  return allMissingAreDeeper ? "extraction_ceiling" : "retrieval_failure"
}

function buildSkipSnapshot(golden: GoldenTrace, naive: ReturnType<typeof naiveRag>): TraceSnapshot {
  return {
    entrypoint:         golden.entrypoint,
    naive_rag_tokens:   naive.token_estimate,
    naive_rag_files:    naive.files.length,
    r0_tokens:          0,
    r0_recall:          0,
    r1_tokens:          0,
    r1_recall:          0,
    compression_r0:     0,
    compression_r1:     0,
    token_savings_r0:   0,
    token_savings_r1:   0,
    recall_gap:         1,
    recall_gap_reason:  "cross_cutting",
    missing_high_nodes: [],
  }
}
