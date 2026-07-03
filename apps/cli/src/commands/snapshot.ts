import { join } from "path"
import {
  captureTopologyBaseline,
  saveTopologyBaseline,
  saveSnapshot,
} from "@kidkender/archmind-retrieval"
import { parseProject, requireProject } from "../utils/parse-project.js"

export function runSnapshot(flags: Record<string, string>): void {
  const projectRoot  = requireProject(flags)
  const label        = flags["label"] ?? "topology-main"
  const BASELINE_DIR = flags["baseline-dir"] ?? join(projectRoot, ".archmind", "baselines")

  const { graphs, routeCount, fileCount } = parseProject(projectRoot)
  console.log(`Parsed ${routeCount} routes from ${fileCount} file(s)`)

  const baseline = captureTopologyBaseline({ graphs, label, projectRoot })

  // Save as current baseline (overwrites)
  saveTopologyBaseline(baseline, BASELINE_DIR)

  // Also append to history
  const histPath = saveSnapshot(baseline, BASELINE_DIR)

  console.log(`Snapshot saved: ${histPath}`)
  console.log(`Routes: ${routeCount}`)
  for (const [route, entry] of Object.entries(baseline.entries)) {
    const types = entry.critical_node_types.length > 0
      ? entry.critical_node_types.join(", ")
      : "(none)"
    console.log(`  ${route.padEnd(55)} [${types}]`)
  }
}
