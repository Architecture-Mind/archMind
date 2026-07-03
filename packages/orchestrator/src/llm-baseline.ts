import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { LLMClient } from "@kidkender/archmind-llm-client"
import { runMultiRunBenchmark } from "./multi-run-benchmark.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LLMBaselineEntry {
  golden_id:  string
  entrypoint: string
  query:      string
  mean:       number
  stddev:     number
  min:        number
  max:        number
  runs:       number
  per_run:    number[]
}

export interface LLMBaseline {
  captured_at:    string
  label:          string
  project:        string
  llm_mode:       string
  entries:        Record<string, LLMBaselineEntry>
  avg_mean_score: number
  avg_stddev:     number
}

export interface LLMBaselineDrift {
  golden_id: string
  changed:   boolean
  details:   string[]
}

export interface LLMBaselineVerifyResult {
  ok:     boolean
  drifts: LLMBaselineDrift[]
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Run the LLM answer benchmark N times and capture mean ± stddev per trace.
 * Uses rule-based scoring (scoreAnswer) — no LLM judge calls, but still
 * requires an LLM client for ArchMind's explanation generation.
 */
export async function captureLLMBaseline(opts: {
  graphs:          IntermediateExecutionGraph[]
  llmClient:       LLMClient
  goldenAnswersDir: string
  label:           string
  project:         string
  llmMode:         string
  runs?:           number
}): Promise<LLMBaseline> {
  const { graphs, llmClient, goldenAnswersDir, label, project, llmMode, runs = 5 } = opts

  const snapshot = await runMultiRunBenchmark(graphs, llmClient, goldenAnswersDir, llmMode, runs)

  const entries: Record<string, LLMBaselineEntry> = {}
  for (const trace of snapshot.traces) {
    entries[trace.golden_id] = {
      golden_id:  trace.golden_id,
      entrypoint: trace.entrypoint,
      query:      trace.query,
      mean:       trace.mean,
      stddev:     trace.stddev,
      min:        trace.min,
      max:        trace.max,
      runs:       trace.runs,
      per_run:    trace.per_run,
    }
  }

  return {
    captured_at:    new Date().toISOString(),
    label,
    project,
    llm_mode:       llmMode,
    entries,
    avg_mean_score: snapshot.avg_mean_score,
    avg_stddev:     snapshot.avg_stddev,
  }
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

// Absolute floor: always flag if mean drops more than this regardless of stored stddev.
const MEAN_DROP_FLOOR = 0.05

/**
 * Compare a freshly-captured baseline against a stored one.
 *
 * Adaptive threshold — adapts to how stable each trace was at capture time:
 *   flag when: mean_drop > max(MEAN_DROP_FLOOR, stored_stddev)
 *
 * This avoids false positives for high-variance traces while still catching
 * real regressions in stable traces.
 *
 * Also flags reliability regressions (stddev more than doubles).
 */
export function verifyLLMBaseline(
  current: LLMBaseline,
  stored:  LLMBaseline
): LLMBaselineVerifyResult {
  const drifts: LLMBaselineDrift[] = []

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

    // Score regression — adaptive threshold
    const meanDrop = prev.mean - curr.mean
    const threshold = Math.max(MEAN_DROP_FLOOR, prev.stddev)
    if (meanDrop > threshold) {
      details.push(
        `score regression: mean dropped ${meanDrop.toFixed(3)} ` +
        `(${prev.mean.toFixed(3)} → ${curr.mean.toFixed(3)}, ` +
        `threshold=${threshold.toFixed(3)} = max(${MEAN_DROP_FLOOR}, stored_stddev=${prev.stddev.toFixed(3)}))`
      )
    }

    // Reliability regression — stddev more than doubled and is above noise floor
    if (curr.stddev > prev.stddev * 2 && curr.stddev > 0.10) {
      details.push(
        `reliability regression: stddev more than doubled ` +
        `(${prev.stddev.toFixed(3)} → ${curr.stddev.toFixed(3)})`
      )
    }

    const changed = details.length > 0
    if (changed) drifts.push({ golden_id: id, changed, details })
  }

  return {
    ok:     drifts.filter((d) => d.changed).length === 0,
    drifts,
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

export function saveLLMBaseline(baseline: LLMBaseline, dir: string): string {
  mkdirSync(dir, { recursive: true })
  const outPath = join(dir, `${baseline.label}.json`)
  writeFileSync(outPath, JSON.stringify(baseline, null, 2))
  return outPath
}

export function loadLLMBaseline(dir: string, label: string): LLMBaseline | null {
  const p = join(dir, `${label}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8")) as LLMBaseline
}
