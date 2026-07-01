import { join } from "path"
import { getRouteHistory, listSnapshots, diffSnapshots, type TopologyDrift } from "@archmind/retrieval"
import { requireProject } from "../utils/parse-project.js"

export function runHistory(flags: Record<string, string>, positional: string[]): void {
  const projectRoot  = requireProject(flags)
  const BASELINE_DIR = flags["baseline-dir"] ?? join(projectRoot, ".archmind", "baselines")
  const json         = "json" in flags

  // archmind history --list
  if ("list" in flags) {
    const snaps = listSnapshots(BASELINE_DIR)
    if (snaps.length === 0) {
      console.log("No snapshots found. Run: archmind snapshot --project .")
      return
    }
    if (json) {
      console.log(JSON.stringify(snaps, null, 2))
      return
    }
    console.log(`Snapshots (${snaps.length}):`)
    for (const s of snaps) {
      const date = new Date(s.captured_at).toLocaleString()
      console.log(`  ${s.id.padEnd(28)}  ${date}  ${s.route_count} routes`)
    }
    return
  }

  // archmind history --diff <from-id> <to-id>
  if ("diff" in flags) {
    const fromId = flags["from"] ?? positional[0]
    const toId   = flags["to"]   ?? positional[1]
    if (!fromId || !toId) {
      console.error("Usage: archmind history --diff --from <snapshot-id> --to <snapshot-id>")
      process.exit(2)
    }
    const result = diffSnapshots(BASELINE_DIR, fromId, toId)
    if (json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    const regressions = result.drifts.filter((d: TopologyDrift) => d.changed)
    console.log(`Diff: ${fromId} → ${toId}`)
    if (result.new_routes.length > 0)     console.log(`  + ${result.new_routes.join("\n  + ")}`)
    if (result.removed_routes.length > 0) console.log(`  - ${result.removed_routes.join("\n  - ")}`)
    for (const d of regressions) {
      console.log(`  ~ ${d.route}`)
      if (d.lost_types.length > 0)   console.log(`      lost:   [${d.lost_types.join(", ")}]`)
      if (d.gained_types.length > 0) console.log(`      gained: [${d.gained_types.join(", ")}]`)
    }
    if (result.ok) console.log("  (no regressions)")
    return
  }

  // archmind history "POST /orders"
  const entrypoint = positional[0] ?? flags["entrypoint"]
  if (!entrypoint) {
    console.error([
      "Usage:",
      "  archmind history --project <path> \"POST /orders\"     Route timeline",
      "  archmind history --project <path> --list              List all snapshots",
      "  archmind history --project <path> --diff --from <id> --to <id>",
    ].join("\n"))
    process.exit(2)
  }

  const hist = getRouteHistory(BASELINE_DIR, entrypoint)

  if (hist.entries.length === 0) {
    console.log(`No history for: ${entrypoint}`)
    console.log("Run: archmind snapshot --project . to start recording.")
    return
  }

  if (json) {
    console.log(JSON.stringify(hist, null, 2))
    return
  }

  console.log(`\nHistory: ${entrypoint}  (${hist.entries.length} snapshot(s))\n`)
  for (const e of hist.entries) {
    const date  = new Date(e.captured_at).toLocaleString()
    const types = e.topology.critical_node_types.join(", ") || "(none)"
    const delta = e.changed_from
      ? `  ⚠  changed — lost: [${e.changed_from.lost_types.join(", ")}]` +
        (e.changed_from.gained_types.length > 0 ? `  gained: [${e.changed_from.gained_types.join(", ")}]` : "")
      : ""
    console.log(`  ${date}  [${types}]${delta}`)
  }
  console.log()
}
