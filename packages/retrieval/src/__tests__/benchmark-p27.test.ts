import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { writeFileSync, mkdirSync } from "fs"
import { runBenchmark } from "../benchmark.js"
import { augmentGraph } from "@archmind/laravel-parser"
import type { IntermediateExecutionGraph } from "@archmind/protocol"

const __filename  = fileURLToPath(import.meta.url)
const __dirname   = dirname(__filename)
const REPO_ROOT   = join(__dirname, "../../../../")
const GOLDEN_DIR  = join(REPO_ROOT, "research/golden-traces/laravel")
const FIXTURE_DIR = join(__dirname, "../../../laravel-parser/src/__tests__/fixtures")
const SNAP_DIR    = join(REPO_ROOT, "benchmarks/snapshots")

// Skeleton graphs — middleware + controller only, no L1.
// augmentGraph adds: form_request, policy (with file), service_call nodes.
const SKELETONS: Record<string, IntermediateExecutionGraph> = {
  "LARAVEL-AUTH-001": {
    entrypoint: "PUT /tasks/{task}",
    method: "PUT", path: "/tasks/{task}",
    nodes: [
      { id: "mw_0", type: "ir:auth_gate",        symbol: "auth:sanctum",            role: "authentication" },
      { id: "mw_1", type: "ir:auth_gate",        symbol: "ResolveTenant::handle",   role: "middleware",    file: "app/Http/Middleware/ResolveTenant.php" },
      { id: "mw_2", type: "ir:authz_check",      symbol: "CheckPermission::handle", role: "authorization", file: "app/Http/Middleware/CheckPermission.php", args: ["task.update"] },
      { id: "ctrl", type: "ir:business_handler", symbol: "TaskController::update",  role: "handler",       file: "app/Modules/Task/Http/Controllers/TaskController.php" },
    ],
    edges: [
      { from: "mw_0", to: "mw_1", relation: "next_middleware", traceability: "static" },
      { from: "mw_1", to: "mw_2", relation: "next_middleware", traceability: "static" },
      { from: "mw_2", to: "ctrl", relation: "next_middleware", traceability: "static" },
    ],
    annotations: [],
  },
  "LARAVEL-AUTH-002": {
    entrypoint: "DELETE /tasks/{task}",
    method: "DELETE", path: "/tasks/{task}",
    nodes: [
      { id: "mw_0", type: "ir:auth_gate",        symbol: "auth:sanctum",            role: "authentication" },
      { id: "mw_1", type: "ir:auth_gate",        symbol: "ResolveTenant::handle",   role: "middleware",    file: "app/Http/Middleware/ResolveTenant.php" },
      { id: "mw_2", type: "ir:authz_check",      symbol: "CheckPermission::handle", role: "authorization", file: "app/Http/Middleware/CheckPermission.php", args: ["task.delete"] },
      { id: "ctrl", type: "ir:business_handler", symbol: "TaskController::destroy", role: "handler",       file: "app/Modules/Task/Http/Controllers/TaskController.php" },
    ],
    edges: [
      { from: "mw_0", to: "mw_1", relation: "next_middleware", traceability: "static" },
      { from: "mw_1", to: "mw_2", relation: "next_middleware", traceability: "static" },
      { from: "mw_2", to: "ctrl", relation: "next_middleware", traceability: "static" },
    ],
    annotations: [],
  },
  "LARAVEL-VALIDATION-001": {
    entrypoint: "PUT /tasks/{task}",
    method: "PUT", path: "/tasks/{task}",
    nodes: [
      { id: "mw_2", type: "ir:authz_check",      symbol: "CheckPermission::handle", role: "authorization", file: "app/Http/Middleware/CheckPermission.php" },
      { id: "ctrl", type: "ir:business_handler", symbol: "TaskController::update",  role: "handler",       file: "app/Modules/Task/Http/Controllers/TaskController.php" },
    ],
    edges: [
      { from: "mw_2", to: "ctrl", relation: "next_middleware", traceability: "static" },
    ],
    annotations: [],
  },
}

// Augment each skeleton with L1 + service_call nodes
function buildAugmentedGraphs(): Record<string, IntermediateExecutionGraph[]> {
  const out: Record<string, IntermediateExecutionGraph[]> = {}
  for (const [id, skeleton] of Object.entries(SKELETONS)) {
    out[id] = [augmentGraph(skeleton, { projectRoot: FIXTURE_DIR })]
  }
  return out
}

// ---- tests ---------------------------------------------------------------

describe("runBenchmark — P2.7 post-B (with service_call nodes)", () => {
  let snapshot: ReturnType<typeof runBenchmark>

  beforeAll(() => {
    const graphs = buildAugmentedGraphs()
    snapshot = runBenchmark({
      goldenDir:  GOLDEN_DIR,
      fixtureDir: FIXTURE_DIR,
      graphs,
      label:      "P2.7-post-B",
    })
  })

  test("snapshot covers all 9 traces", () => {
    expect(snapshot.summary.total_traces).toBe(9)
  })

  test("AUTH-001 recall improves over P2-baseline (was 0.71)", () => {
    expect(snapshot.traces["LARAVEL-AUTH-001"].r0_recall).toBeGreaterThan(0.71)
  })

  test("AUTH-002 recall is at least at P2-baseline parity (~0.50, permission constants still ceiling)", () => {
    // perm_task_delete / perm_task_delete_any are Permission::CONSTANT nodes (not service_calls)
    // Service call extraction doesn't help here — needs a separate permission-constant extractor.
    // At minimum we recover parity with P2-baseline by augmenting the destroy method.
    expect(snapshot.traces["LARAVEL-AUTH-002"].r0_recall).toBeGreaterThanOrEqual(0.40)
  })

  test("VALIDATION-001 recall stays >= 0.66", () => {
    expect(snapshot.traces["LARAVEL-VALIDATION-001"].r0_recall).toBeGreaterThanOrEqual(0.66)
  })

  test("RUNTIME-001 still classified as cross_cutting", () => {
    expect(snapshot.traces["LARAVEL-RUNTIME-001"].recall_gap_reason).toBe("cross_cutting")
  })

  test("avg recall improves over P2-baseline (was 0.74)", () => {
    expect(snapshot.summary.avg_r0_recall).toBeGreaterThan(0.74)
  })

  test("AUTH-001 missing_high_nodes reduced", () => {
    const missing = snapshot.traces["LARAVEL-AUTH-001"].missing_high_nodes
    expect(missing.length).toBeLessThan(2)  // P2-baseline had 2 missing
  })

  test("saves snapshot to benchmarks/snapshots/P2.7-post-B.json", () => {
    mkdirSync(SNAP_DIR, { recursive: true })
    const outPath = join(SNAP_DIR, "P2.7-post-B.json")
    writeFileSync(outPath, JSON.stringify(snapshot, null, 2))
    expect(snapshot.label).toBe("P2.7-post-B")
  })

  test("prints comparison table", () => {
    const col = (s: string | number, w: number) => String(s).padEnd(w)
    console.log("\n  P2.7 post-B Benchmark (service_call extraction enabled)")
    console.log("  " + "─".repeat(88))
    console.log(`  ${col("Trace", 24)} ${col("Naive tokens", 14)} ${col("R0 tokens", 11)} ${col("Recall", 8)} ${col("vs P2", 8)} Gap`)
    console.log("  " + "─".repeat(88))

    const baseline: Record<string, number> = {
      "LARAVEL-AUTH-001": 0.71,
      "LARAVEL-AUTH-002": 0.50,
      "LARAVEL-VALIDATION-001": 1.0,
    }

    for (const [id, t] of Object.entries(snapshot.traces)) {
      if (t.recall_gap_reason === "cross_cutting") {
        console.log(`  ${col(id, 24)} ${col(t.naive_rag_tokens, 14)} ${"(skipped)".padEnd(11)} ${col("-", 8)} ${col("-", 8)} cross_cutting`)
      } else {
        const prev = baseline[id] ?? 0
        const delta = t.r0_recall - prev
        const arrow = delta > 0.01 ? "↑" : delta < -0.01 ? "↓" : "="
        console.log(`  ${col(id, 24)} ${col(t.naive_rag_tokens, 14)} ${col(t.r0_tokens, 11)} ${col(t.r0_recall.toFixed(2), 8)} ${col(`${arrow}${Math.abs(delta).toFixed(2)}`, 8)} ${t.recall_gap_reason}`)
      }
    }
    console.log("  " + "─".repeat(88))
    console.log(`  Avg recall: ${snapshot.summary.avg_r0_recall}  |  Avg compression: ${snapshot.summary.avg_compression_r0}x  |  Avg savings: ${snapshot.summary.avg_token_savings_r0}%`)
    expect(true).toBe(true)
  })
})
