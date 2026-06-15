import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { writeFileSync, readFileSync, mkdirSync } from "fs"
import { runBenchmark } from "../benchmark.js"
import type { IntermediateExecutionGraph } from "@archmind/protocol"

const __filename  = fileURLToPath(import.meta.url)
const __dirname   = dirname(__filename)
const REPO_ROOT   = join(__dirname, "../../../../")
const GOLDEN_DIR  = join(REPO_ROOT, "research/golden-traces/laravel")
const FIXTURE_DIR = join(__dirname, "../../../laravel-parser/src/__tests__/fixtures")
const SNAP_DIR    = join(REPO_ROOT, "benchmarks/snapshots")

// Extracted graphs for traces that can be matched
const GRAPHS: Record<string, IntermediateExecutionGraph[]> = {
  "LARAVEL-AUTH-001": [{
    entrypoint: "PUT /tasks/{task}",
    method: "PUT", path: "/tasks/{task}",
    nodes: [
      { id: "mw_0", type: "ir:auth_gate",        symbol: "auth:sanctum",                 role: "authentication" },
      { id: "mw_1", type: "ir:auth_gate",        symbol: "ResolveTenant::handle",        role: "middleware",     file: "app/Http/Middleware/ResolveTenant.php" },
      { id: "mw_2", type: "ir:authz_check",      symbol: "CheckPermission::handle",      role: "authorization",  file: "app/Http/Middleware/CheckPermission.php", args: ["task.update"] },
      { id: "ctrl", type: "ir:business_handler", symbol: "TaskController::update",       role: "handler",        file: "app/Modules/Task/Http/Controllers/TaskController.php" },
      { id: "fr",   type: "ir:validation_gate",  symbol: "UpdateTaskRequest::authorize", role: "validation",     file: "app/Modules/Task/Requests/UpdateTaskRequest.php" },
      { id: "pol",  type: "ir:authz_check",      symbol: "TaskPolicy::update",           role: "authorization",  file: "app/Policies/TaskPolicy.php" },
    ],
    edges: [
      { from: "mw_0", to: "mw_1", relation: "next_middleware", traceability: "static" },
      { from: "mw_1", to: "mw_2", relation: "next_middleware", traceability: "static" },
      { from: "mw_2", to: "ctrl", relation: "next_middleware", traceability: "static" },
      { from: "ctrl", to: "fr",   relation: "form_request",    traceability: "static" },
      { from: "ctrl", to: "pol",  relation: "policy_check",    traceability: "semantic", mechanism: "$this->authorize('update', $task)" },
    ],
    annotations: [],
  }],
  "LARAVEL-AUTH-002": [{
    entrypoint: "DELETE /tasks/{task}",
    method: "DELETE", path: "/tasks/{task}",
    nodes: [
      { id: "mw_0", type: "ir:auth_gate",        symbol: "auth:sanctum",              role: "authentication" },
      { id: "mw_1", type: "ir:auth_gate",        symbol: "ResolveTenant::handle",     role: "middleware" },
      { id: "mw_2", type: "ir:authz_check",      symbol: "CheckPermission::handle",   role: "authorization", args: ["task.delete"] },
      { id: "ctrl", type: "ir:business_handler", symbol: "TaskController::destroy",   role: "handler" },
      { id: "pol",  type: "ir:authz_check",      symbol: "TaskPolicy::delete",        role: "authorization" },
    ],
    edges: [
      { from: "mw_0", to: "mw_1", relation: "next_middleware", traceability: "static" },
      { from: "mw_1", to: "mw_2", relation: "next_middleware", traceability: "static" },
      { from: "mw_2", to: "ctrl", relation: "next_middleware", traceability: "static" },
      { from: "ctrl", to: "pol",  relation: "policy_check",    traceability: "semantic" },
    ],
    annotations: [],
  }],
  "LARAVEL-VALIDATION-001": [{
    entrypoint: "PUT /tasks/{task}",
    method: "PUT", path: "/tasks/{task}",
    nodes: [
      { id: "mw_2", type: "ir:authz_check",      symbol: "CheckPermission::handle",      role: "authorization" },
      { id: "ctrl", type: "ir:business_handler", symbol: "TaskController::update",       role: "handler" },
      { id: "fr",   type: "ir:validation_gate",  symbol: "UpdateTaskRequest::authorize", role: "validation" },
      { id: "pol",  type: "ir:authz_check",      symbol: "TaskPolicy::update",           role: "authorization" },
    ],
    edges: [
      { from: "mw_2", to: "ctrl", relation: "next_middleware", traceability: "static" },
      { from: "ctrl", to: "fr",   relation: "form_request",    traceability: "static" },
      { from: "ctrl", to: "pol",  relation: "policy_check",    traceability: "semantic" },
    ],
    annotations: [],
  }],
  // LARAVEL-RUNTIME-001 is cross-cutting (ANY /tasks/*) — no matching graph
}

// ---- benchmark tests -------------------------------------------------

describe("runBenchmark — P2 baseline", () => {
  let snapshot: ReturnType<typeof runBenchmark>

  beforeAll(() => {
    snapshot = runBenchmark({
      goldenDir:  GOLDEN_DIR,
      fixtureDir: FIXTURE_DIR,
      graphs:     GRAPHS,
      label:      "P2-baseline",
    })
  })

  test("snapshot covers all 9 traces", () => {
    expect(snapshot.summary.total_traces).toBe(9)
  })

  test("AUTH-001 has extraction_ceiling recall gap", () => {
    expect(snapshot.traces["LARAVEL-AUTH-001"].recall_gap_reason).toBe("extraction_ceiling")
  })

  test("RUNTIME-001 is classified as cross_cutting", () => {
    expect(snapshot.traces["LARAVEL-RUNTIME-001"].recall_gap_reason).toBe("cross_cutting")
  })

  test("avg R0 recall >= 0.5", () => {
    expect(snapshot.summary.avg_r0_recall).toBeGreaterThanOrEqual(0.5)
  })

  test("avg compression > 2x", () => {
    expect(snapshot.summary.avg_compression_r0).toBeGreaterThan(2)
  })

  test("saves snapshot to benchmarks/snapshots/P2-baseline.json", () => {
    mkdirSync(SNAP_DIR, { recursive: true })
    const outPath = join(SNAP_DIR, "P2-baseline.json")
    writeFileSync(outPath, JSON.stringify(snapshot, null, 2))
    const saved = JSON.parse(readFileSync(outPath, "utf-8"))
    expect(saved.label).toBe("P2-baseline")
    expect(saved.summary.total_traces).toBe(9)
  })

  test("prints benchmark table", () => {
    const col = (s: string | number, w: number) => String(s).padEnd(w)
    console.log("\n  P2 Baseline Benchmark")
    console.log("  " + "─".repeat(80))
    console.log(`  ${col("Trace", 24)} ${col("Naive tokens", 14)} ${col("R0 tokens", 11)} ${col("Recall", 8)} Gap reason`)
    console.log("  " + "─".repeat(80))
    for (const [id, t] of Object.entries(snapshot.traces)) {
      if (t.recall_gap_reason === "cross_cutting") {
        console.log(`  ${col(id, 24)} ${col(t.naive_rag_tokens, 14)} ${"(skipped)".padEnd(11)} ${col("-", 8)} cross_cutting`)
      } else {
        console.log(`  ${col(id, 24)} ${col(t.naive_rag_tokens, 14)} ${col(t.r0_tokens, 11)} ${col(t.r0_recall.toFixed(2), 8)} ${t.recall_gap_reason}`)
      }
    }
    console.log("  " + "─".repeat(80))
    console.log(`  Avg recall: ${snapshot.summary.avg_r0_recall}  |  Avg compression: ${snapshot.summary.avg_compression_r0}x  |  Avg savings: ${snapshot.summary.avg_token_savings_r0}%`)
    expect(true).toBe(true)
  })
})
