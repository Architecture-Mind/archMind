import { join } from "path"
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { loadGoldenTrace, scoreRetrieval } from "@kidkender/archmind-scorer"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { retrieve } from "./retrieval-engine.js"
import { naiveRag } from "./naive-rag.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Node types whose presence/absence is semantically significant for regression detection.
// When any of these disappear from a route's graph vs. the stored baseline, the verify
// step flags it as a topology regression (historical-absence detection).
export const CRITICAL_NODE_TYPES: ReadonlyArray<string> = [
  "ir:auth_gate",
  "ir:authz_check",
  "ir:validation_gate",
  "ir:txn_boundary",
  "ir:scoped_query",
  "ir:unscoped_query",
  "ir:unscoped_write",
]

export interface RetrievalBaselineEntry {
  route:                string
  retrieved_node_ids:   string[]   // in retrieval order — drift here = behavior change
  critical_node_types:  string[]   // intersection of present types with CRITICAL_NODE_TYPES
  node_count:           number
  compression_ratio:    number
  token_count:          number
  recall:               number
}

export interface RetrievalBaseline {
  captured_at:  string
  label:        string
  entries:      Record<string, RetrievalBaselineEntry>   // keyed by golden_id
}

export interface BaselineDrift {
  golden_id:   string
  changed:     boolean
  details:     string[]
}

export interface BaselineVerifyResult {
  ok:      boolean
  drifts:  BaselineDrift[]
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Run retrieval over all golden traces and capture a snapshot of the retrieval
 * layer (node IDs, ordering, compression, token counts, recall).
 */
export function captureBaseline(opts: {
  goldenDir:  string
  fixtureDir: string
  graphs:     Record<string, IntermediateExecutionGraph[]>
  label?:     string
}): RetrievalBaseline {
  const { goldenDir, fixtureDir, graphs, label = "baseline" } = opts
  const entries: Record<string, RetrievalBaselineEntry> = {}

  const traceFiles = readdirSync(goldenDir).filter((f) => f.endsWith(".yaml"))
  for (const file of traceFiles) {
    const golden = loadGoldenTrace(join(goldenDir, file))
    const gs     = graphs[golden.id] ?? []
    const r0     = retrieve({ entrypoint: golden.entrypoint }, gs)
    if (!r0) continue

    const naive  = naiveRag(golden, fixtureDir)
    const score  = scoreRetrieval(golden, r0)
    const ratio  = naive.token_estimate > 0 ? naive.token_estimate / r0.token_estimate : 1

    const presentTypes = new Set(r0.nodes.map((n) => n.type))
    entries[golden.id] = {
      route:               golden.entrypoint,
      retrieved_node_ids:  r0.nodes.map((n) => n.id),
      critical_node_types: CRITICAL_NODE_TYPES.filter((t) => presentTypes.has(t)),
      node_count:          r0.nodes.length,
      compression_ratio:   parseFloat(ratio.toFixed(2)),
      token_count:         r0.token_estimate,
      recall:              parseFloat(score.combined_recall.toFixed(3)),
    }
  }

  return {
    captured_at: new Date().toISOString(),
    label,
    entries,
  }
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

const RECALL_REGRESSION_THRESHOLD    = 0.05   // flag if recall drops > 5%
const COMPRESSION_REGRESSION_THRESHOLD = 0.20  // flag if compression drops > 20%

/**
 * Compare a freshly-captured baseline against a stored one.
 * Returns ok=true when no meaningful drift is detected.
 *
 * Tiered locking:
 *   - node_id SET change   → always flagged (retrieval content changed)
 *   - node ordering change → flagged (LLM may reason differently)
 *   - recall regression    → flagged if drop > 5%
 *   - compression change   → flagged if drop > 20%
 *   - token count change   → informational only
 */
export function verifyBaseline(
  current: RetrievalBaseline,
  stored:  RetrievalBaseline
): BaselineVerifyResult {
  const drifts: BaselineDrift[] = []

  const allIds = new Set([
    ...Object.keys(current.entries),
    ...Object.keys(stored.entries),
  ])

  for (const id of allIds) {
    const curr = current.entries[id]
    const prev = stored.entries[id]
    const details: string[] = []

    if (!prev) {
      details.push("new trace — no stored baseline to compare against")
      drifts.push({ golden_id: id, changed: false, details })
      continue
    }
    if (!curr) {
      details.push("trace present in stored baseline but missing from current run")
      drifts.push({ golden_id: id, changed: true, details })
      continue
    }

    // Node set change
    const currSet = new Set(curr.retrieved_node_ids)
    const prevSet = new Set(prev.retrieved_node_ids)
    const added   = curr.retrieved_node_ids.filter((n) => !prevSet.has(n))
    const removed = prev.retrieved_node_ids.filter((n) => !currSet.has(n))
    if (added.length > 0) details.push(`nodes added: [${added.join(", ")}]`)
    if (removed.length > 0) details.push(`nodes removed: [${removed.join(", ")}]`)

    // Ordering change (when set is same)
    if (added.length === 0 && removed.length === 0) {
      const orderChanged = curr.retrieved_node_ids.some((n, i) => n !== prev.retrieved_node_ids[i])
      if (orderChanged) details.push("node ordering changed")
    }

    // Critical node type disappearance (topology regression)
    const prevCritical = new Set(prev.critical_node_types ?? [])
    const currCritical = new Set(curr.critical_node_types ?? [])
    const lostTypes = [...prevCritical].filter((t) => !currCritical.has(t))
    if (lostTypes.length > 0) {
      details.push(`critical node types removed: [${lostTypes.join(", ")}]`)
    }

    // Recall regression
    const recallDrop = prev.recall - curr.recall
    if (recallDrop > RECALL_REGRESSION_THRESHOLD) {
      details.push(`recall dropped ${recallDrop.toFixed(3)} (${prev.recall} → ${curr.recall})`)
    }

    // Compression regression
    const compDrop = (prev.compression_ratio - curr.compression_ratio) / (prev.compression_ratio || 1)
    if (compDrop > COMPRESSION_REGRESSION_THRESHOLD) {
      details.push(`compression dropped ${(compDrop * 100).toFixed(1)}% (${prev.compression_ratio}x → ${curr.compression_ratio}x)`)
    }

    const changed = details.length > 0
    if (changed) drifts.push({ golden_id: id, changed, details })
  }

  return {
    ok: drifts.filter((d) => d.changed).length === 0,
    drifts,
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

export function saveBaseline(baseline: RetrievalBaseline, dir: string): string {
  mkdirSync(dir, { recursive: true })
  const outPath = join(dir, `${baseline.label}.json`)
  writeFileSync(outPath, JSON.stringify(baseline, null, 2))
  return outPath
}

export function loadBaseline(dir: string, label: string): RetrievalBaseline | null {
  const p = join(dir, `${label}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8")) as RetrievalBaseline
}
