import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { writeFileSync, mkdirSync } from "fs"
import { runBenchmark } from "../benchmark.js"
import { augmentGraph } from "@kidkender/archmind-laravel-parser"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const __filename  = fileURLToPath(import.meta.url)
const __dirname   = dirname(__filename)
const REPO_ROOT   = join(__dirname, "../../../../")
const GOLDEN_DIR  = join(REPO_ROOT, "research/golden-traces/laravel")
const FIXTURE_DIR = join(__dirname, "../../../laravel-parser/src/__tests__/fixtures")
const SNAP_DIR    = join(REPO_ROOT, "benchmarks/snapshots")

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
  "LARAVEL-TXN-001": {
    entrypoint: "POST /tasks",
    method: "POST", path: "/tasks",
    nodes: [
      { id: "mw_0", type: "ir:auth_gate",        symbol: "auth:sanctum",            role: "authentication" },
      { id: "mw_1", type: "ir:auth_gate",        symbol: "ResolveTenant::handle",   role: "middleware",    file: "app/Http/Middleware/ResolveTenant.php" },
      { id: "ctrl", type: "ir:business_handler", symbol: "TaskController::store",   role: "handler",       file: "app/Modules/Task/Http/Controllers/TaskController.php" },
    ],
    edges: [
      { from: "mw_0", to: "mw_1", relation: "next_middleware", traceability: "static" },
      { from: "mw_1", to: "ctrl", relation: "next_middleware", traceability: "static" },
    ],
    annotations: [],
  },
  "LARAVEL-ISO-001": {
    entrypoint: "GET /tasks/{id}",
    method: "GET", path: "/tasks/{id}",
    nodes: [
      { id: "mw_1", type: "ir:auth_gate",        symbol: "ResolveTenant::handle",   role: "middleware",    file: "app/Http/Middleware/ResolveTenant.php" },
      { id: "mw_2", type: "ir:authz_check",      symbol: "CheckPermission::handle", role: "authorization", file: "app/Http/Middleware/CheckPermission.php", args: ["task.view"] },
      { id: "ctrl", type: "ir:business_handler", symbol: "TaskController::show",    role: "handler",       file: "app/Modules/Task/Http/Controllers/TaskController.php" },
    ],
    edges: [
      { from: "mw_1", to: "mw_2", relation: "next_middleware", traceability: "static" },
      { from: "mw_2", to: "ctrl", relation: "next_middleware", traceability: "static" },
    ],
    annotations: [],
  },
  "LARAVEL-API-RESOURCE-001": {
    entrypoint: "GET /v1/invoices/{id}",
    method: "GET", path: "/v1/invoices/{id}",
    nodes: [
      { id: "ctrl", type: "ir:business_handler", symbol: "InvoicesController::show", role: "handler", file: "app/Http/Controllers/InvoicesController.php" },
    ],
    edges: [],
    annotations: [],
  },
  "LARAVEL-QUEUE-JOB-001": {
    entrypoint: "POST /job-orders",
    method: "POST", path: "/job-orders",
    nodes: [
      { id: "ctrl", type: "ir:business_handler", symbol: "JobDispatchController::store", role: "handler", file: "app/Http/Controllers/JobDispatchController.php" },
    ],
    edges: [],
    annotations: [],
  },
  "LARAVEL-NOTIFICATION-001": {
    entrypoint: "POST /notify",
    method: "POST", path: "/notify",
    nodes: [
      { id: "ctrl", type: "ir:business_handler", symbol: "NotificationController::notify", role: "handler", file: "app/Http/Controllers/NotificationController.php" },
    ],
    edges: [],
    annotations: [],
  },
}

function buildAugmentedGraphs(): Record<string, IntermediateExecutionGraph[]> {
  const out: Record<string, IntermediateExecutionGraph[]> = {}
  for (const [id, skeleton] of Object.entries(SKELETONS)) {
    out[id] = [augmentGraph(skeleton, {
      projectRoot: FIXTURE_DIR,
      permissionConstantFiles: ["Permission.php"],
    })]
  }
  return out
}

// ---- tests ---------------------------------------------------------------

describe("runBenchmark — P3 semantic baseline (with permission constant extractor)", () => {
  let snapshot: ReturnType<typeof runBenchmark>

  beforeAll(() => {
    const graphs = buildAugmentedGraphs()
    snapshot = runBenchmark({
      goldenDir:  GOLDEN_DIR,
      fixtureDir: FIXTURE_DIR,
      graphs,
      label:      "P3-semantic-baseline",
    })
  })

  test("snapshot covers all 9 traces", () => {
    expect(snapshot.summary.total_traces).toBe(9)
  })

  test("AUTH-001 recall holds >= P2.7 level (>= 0.71)", () => {
    expect(snapshot.traces["LARAVEL-AUTH-001"]!.r0_recall).toBeGreaterThan(0.71)
  })

  test("AUTH-002 recall jumps above P2.7 ceiling (was 0.50, permission nodes now extracted)", () => {
    expect(snapshot.traces["LARAVEL-AUTH-002"]!.r0_recall).toBeGreaterThan(0.50)
  })

  test("AUTH-002 recall reaches at least 0.70 with all 3 HIGH nodes present", () => {
    expect(snapshot.traces["LARAVEL-AUTH-002"]!.r0_recall).toBeGreaterThanOrEqual(0.70)
  })

  test("VALIDATION-001 recall stays >= 0.66", () => {
    expect(snapshot.traces["LARAVEL-VALIDATION-001"]!.r0_recall).toBeGreaterThanOrEqual(0.66)
  })

  test("RUNTIME-001 still classified as cross_cutting", () => {
    expect(snapshot.traces["LARAVEL-RUNTIME-001"]!.recall_gap_reason).toBe("cross_cutting")
  })

  test("TXN-001 recall captures transaction_boundary + escapes (>= 0.70)", () => {
    expect(snapshot.traces["LARAVEL-TXN-001"]!.r0_recall).toBeGreaterThanOrEqual(0.70)
  })

  test("ISO-001 recall covers all high nodes — unscoped_query + tenant_injection (>= 0.80)", () => {
    expect(snapshot.traces["LARAVEL-ISO-001"]!.r0_recall).toBeGreaterThanOrEqual(0.80)
  })

  test("API-RESOURCE-001 recall captures ir:api_resource node (>= 0.50)", () => {
    expect(snapshot.traces["LARAVEL-API-RESOURCE-001"]!.r0_recall).toBeGreaterThanOrEqual(0.50)
  })

  test("QUEUE-JOB-001 recall captures ir:queue_job nodes (>= 0.50)", () => {
    expect(snapshot.traces["LARAVEL-QUEUE-JOB-001"]!.r0_recall).toBeGreaterThanOrEqual(0.50)
  })

  test("NOTIFICATION-001 recall captures ir:notification + ir:mail nodes (>= 0.50)", () => {
    expect(snapshot.traces["LARAVEL-NOTIFICATION-001"]!.r0_recall).toBeGreaterThanOrEqual(0.50)
  })

  test("avg recall improves over P2.7 baseline (was ~0.83)", () => {
    expect(snapshot.summary.avg_r0_recall).toBeGreaterThanOrEqual(0.83)
  })

  test("saves snapshot to benchmarks/snapshots/P3-semantic-baseline.json", () => {
    mkdirSync(SNAP_DIR, { recursive: true })
    const outPath = join(SNAP_DIR, "P3-semantic-baseline.json")
    writeFileSync(outPath, JSON.stringify(snapshot, null, 2))
    expect(snapshot.label).toBe("P3-semantic-baseline")
  })

  test("prints comparison table", () => {
    const col = (s: string | number, w: number) => String(s).padEnd(w)
    console.log("\n  P3 Semantic Baseline (permission constant extractor enabled)")
    console.log("  " + "─".repeat(92))
    console.log(`  ${col("Trace", 24)} ${col("Naive tokens", 14)} ${col("R0 tokens", 11)} ${col("Recall", 8)} ${col("vs P2.7", 8)} Gap`)
    console.log("  " + "─".repeat(92))

    const baseline: Record<string, number> = {
      "LARAVEL-AUTH-001":       0.71,
      "LARAVEL-AUTH-002":       0.50,
      "LARAVEL-VALIDATION-001": 1.00,
      "LARAVEL-TXN-001":        0,
      "LARAVEL-ISO-001":        0,
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
    console.log("  " + "─".repeat(92))
    console.log(`  Avg recall: ${snapshot.summary.avg_r0_recall}  |  Avg compression: ${snapshot.summary.avg_compression_r0}x  |  Avg savings: ${snapshot.summary.avg_token_savings_r0}%`)
    expect(true).toBe(true)
  })
})
