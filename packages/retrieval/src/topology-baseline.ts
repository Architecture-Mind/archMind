import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { CRITICAL_NODE_TYPES } from "./retrieval-baseline.js"

// Node types whose GAIN (appearance) is a regression — e.g. an unscoped write
// appearing means tenant isolation was removed from a previously-scoped operation.
export const DANGER_NODE_TYPES: ReadonlyArray<string> = [
  "ir:unscoped_write",
  "ir:unscoped_query",
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopologyBaselineEntry {
  route:               string
  critical_node_types: string[]   // intersection with CRITICAL_NODE_TYPES
  node_count:          number
}

export interface TopologyBaseline {
  captured_at:  string
  label:        string
  project_root: string
  entries:      Record<string, TopologyBaselineEntry>  // keyed by "METHOD /path"
}

export interface TopologyDrift {
  route:           string
  changed:         boolean
  lost_types:      string[]
  gained_types:    string[]
}

export interface TopologyVerifyResult {
  ok:              boolean
  drifts:          TopologyDrift[]
  new_routes:      string[]
  removed_routes:  string[]
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Capture topology baseline from a set of execution graphs.
 * Pass all graphs for a project (all routes).
 */
export function captureTopologyBaseline(opts: {
  graphs:      IntermediateExecutionGraph[]
  label:       string
  projectRoot: string
}): TopologyBaseline {
  const { graphs, label, projectRoot } = opts
  const entries: Record<string, TopologyBaselineEntry> = {}

  for (const graph of graphs) {
    const key = graph.entrypoint
    const presentTypes = new Set(graph.nodes.map((n) => n.type))
    const critical = CRITICAL_NODE_TYPES.filter((t) => presentTypes.has(t))

    // Merge if same route appears in multiple graphs (different route files)
    const existing = entries[key]
    if (existing) {
      const merged = new Set([...existing.critical_node_types, ...critical])
      existing.critical_node_types = [...merged].sort()
      existing.node_count = Math.max(existing.node_count, graph.nodes.length)
    } else {
      entries[key] = {
        route:               graph.entrypoint,
        critical_node_types: [...critical].sort(),
        node_count:          graph.nodes.length,
      }
    }
  }

  return {
    captured_at:  new Date().toISOString(),
    label,
    project_root: projectRoot,
    entries,
  }
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Compare a freshly-captured topology baseline against a stored one.
 *
 * - Lost critical node types → changed = true (topology regression)
 * - Gained critical node types → changed = false (informational)
 * - New routes → reported separately, not as changed
 * - Removed routes → reported separately as changed
 */
export function verifyTopologyBaseline(
  current: TopologyBaseline,
  stored:  TopologyBaseline
): TopologyVerifyResult {
  const drifts:         TopologyDrift[] = []
  const new_routes:     string[]        = []
  const removed_routes: string[]        = []

  const allRoutes = new Set([
    ...Object.keys(current.entries),
    ...Object.keys(stored.entries),
  ])

  for (const route of allRoutes) {
    const curr = current.entries[route]
    const prev = stored.entries[route]

    if (!prev) {
      new_routes.push(route)
      continue
    }
    if (!curr) {
      removed_routes.push(route)
      continue
    }

    const prevSet = new Set(prev.critical_node_types)
    const currSet = new Set(curr.critical_node_types)

    const lost_types   = [...prevSet].filter((t) => !currSet.has(t))
    const gained_types = [...currSet].filter((t) => !prevSet.has(t))

    // Gain of a danger type (e.g. unscoped_write) is also a regression
    const dangerGained = gained_types.filter((t) => DANGER_NODE_TYPES.includes(t))

    if (lost_types.length > 0 || gained_types.length > 0) {
      drifts.push({
        route,
        changed:     lost_types.length > 0 || dangerGained.length > 0,
        lost_types,
        gained_types,
      })
    }
  }

  const hasRegressions =
    drifts.some((d) => d.changed) || removed_routes.length > 0

  return {
    ok: !hasRegressions,
    drifts,
    new_routes,
    removed_routes,
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function saveTopologyBaseline(baseline: TopologyBaseline, dir: string): string {
  mkdirSync(dir, { recursive: true })
  const outPath = join(dir, `${baseline.label}.json`)
  writeFileSync(outPath, JSON.stringify(baseline, null, 2))
  return outPath
}

export function loadTopologyBaseline(dir: string, label: string): TopologyBaseline | null {
  const p = join(dir, `${label}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf-8")) as TopologyBaseline
}
