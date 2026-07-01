import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import type { TopologyBaseline, TopologyBaselineEntry } from "./topology-baseline.js"
import { verifyTopologyBaseline } from "./topology-baseline.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SnapshotMeta {
  id:           string   // ISO timestamp slug, e.g. "2026-07-01T12-00-00"
  captured_at:  string   // full ISO string
  label:        string
  route_count:  number
}

export interface RouteHistoryEntry {
  snapshot_id:   string
  captured_at:   string
  topology:      TopologyBaselineEntry
  changed_from?: {
    lost_types:   string[]
    gained_types: string[]
  }
}

export interface RouteHistory {
  entrypoint: string
  entries:    RouteHistoryEntry[]
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const HISTORY_DIR_NAME = "history"

function historyDir(snapshotBaseDir: string): string {
  return join(snapshotBaseDir, HISTORY_DIR_NAME)
}

function snapshotId(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z")
}

export function saveSnapshot(
  baseline:        TopologyBaseline,
  snapshotBaseDir: string,
): string {
  const dir = historyDir(snapshotBaseDir)
  mkdirSync(dir, { recursive: true })
  const id   = snapshotId(new Date(baseline.captured_at))
  const path = join(dir, `${id}.json`)
  writeFileSync(path, JSON.stringify({ ...baseline, snapshot_id: id }, null, 2))
  return path
}

export function listSnapshots(snapshotBaseDir: string): SnapshotMeta[] {
  const dir = historyDir(snapshotBaseDir)
  if (!existsSync(dir)) return []

  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf-8")) as TopologyBaseline & { snapshot_id?: string }
      return {
        id:          raw.snapshot_id ?? f.replace(".json", ""),
        captured_at: raw.captured_at,
        label:       raw.label,
        route_count: Object.keys(raw.entries).length,
      }
    })
}

export function loadSnapshot(snapshotBaseDir: string, id: string): TopologyBaseline | null {
  const path = join(historyDir(snapshotBaseDir), `${id}.json`)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, "utf-8")) as TopologyBaseline
}

// ---------------------------------------------------------------------------
// Route history query
// ---------------------------------------------------------------------------

/**
 * Return the history of a single route across all stored snapshots, in
 * chronological order. Each entry describes the topology at that point in time
 * and what changed relative to the previous snapshot.
 */
export function getRouteHistory(
  snapshotBaseDir: string,
  entrypoint:      string,
): RouteHistory {
  const dir = historyDir(snapshotBaseDir)
  if (!existsSync(dir)) return { entrypoint, entries: [] }

  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
  const entries: RouteHistoryEntry[] = []
  let prev: TopologyBaselineEntry | undefined

  for (const f of files) {
    const snap = JSON.parse(readFileSync(join(dir, f), "utf-8")) as TopologyBaseline & { snapshot_id?: string }
    const entry = snap.entries[entrypoint]
    if (!entry) continue

    const historyEntry: RouteHistoryEntry = {
      snapshot_id:  snap.snapshot_id ?? f.replace(".json", ""),
      captured_at:  snap.captured_at,
      topology:     entry,
    }

    if (prev) {
      const prevSet = new Set(prev.critical_node_types)
      const currSet = new Set(entry.critical_node_types)
      const lost    = [...prevSet].filter((t) => !currSet.has(t))
      const gained  = [...currSet].filter((t) => !prevSet.has(t))
      if (lost.length > 0 || gained.length > 0) {
        historyEntry.changed_from = { lost_types: lost, gained_types: gained }
      }
    }

    entries.push(historyEntry)
    prev = entry
  }

  return { entrypoint, entries }
}

/**
 * Diff two snapshots by ID and return a TopologyVerifyResult.
 */
export function diffSnapshots(
  snapshotBaseDir: string,
  fromId:          string,
  toId:            string,
) {
  const from = loadSnapshot(snapshotBaseDir, fromId)
  const to   = loadSnapshot(snapshotBaseDir, toId)
  if (!from) throw new Error(`Snapshot not found: ${fromId}`)
  if (!to)   throw new Error(`Snapshot not found: ${toId}`)
  return verifyTopologyBaseline(to, from)
}
