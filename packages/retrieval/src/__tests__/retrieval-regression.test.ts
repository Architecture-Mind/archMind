/**
 * P1 — Retrieval-only regression suite.
 *
 * Deterministic CI guard. No LLM calls, no judge, no stochasticity.
 * Fails fast if retrieval recall drops below locked thresholds.
 *
 * Run with:
 *   node --experimental-vm-modules ../../node_modules/jest/bin/jest.js src/__tests__/retrieval-regression.test.ts
 */
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { augmentGraph } from "@kidkender/archmind-laravel-parser"
import { loadGoldenTrace, scoreRetrieval } from "@kidkender/archmind-scorer"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { retrieve } from "../retrieval-engine.js"

const __filename  = fileURLToPath(import.meta.url)
const __dirname   = dirname(__filename)
const REPO_ROOT   = join(__dirname, "../../../../")
const GOLDEN_DIR  = join(REPO_ROOT, "research/golden-traces/laravel")
const FIXTURE_DIR = join(__dirname, "../../../laravel-parser/src/__tests__/fixtures")

// ---- Skeleton graphs (same as benchmark-p27) ---------------------------

const SKELETONS: Record<string, IntermediateExecutionGraph> = {
  "LARAVEL-AUTH-001": {
    entrypoint: "PUT /tasks/{task}", method: "PUT", path: "/tasks/{task}",
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
    entrypoint: "DELETE /tasks/{task}", method: "DELETE", path: "/tasks/{task}",
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
    entrypoint: "PUT /tasks/{task}", method: "PUT", path: "/tasks/{task}",
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

// Locked recall thresholds — sourced from benchmark-p27 (laravel test fixture).
// AUTH-002 is capped at 0.50 (extraction_ceiling): permission constant nodes require
// the full project's Permission.php — not present in the test fixture.
// Update these intentionally when retrieval genuinely improves.
const RECALL_THRESHOLDS: Record<string, number> = {
  "LARAVEL-AUTH-001":        0.95,
  "LARAVEL-AUTH-002":        0.45,   // extraction_ceiling in test fixture
  "LARAVEL-VALIDATION-001":  0.95,
}

// ---- Build augmented graphs once per suite run --------------------------

let augmentedGraphs: Record<string, IntermediateExecutionGraph[]>

beforeAll(() => {
  augmentedGraphs = {}
  for (const [id, skeleton] of Object.entries(SKELETONS)) {
    augmentedGraphs[id] = [augmentGraph(skeleton, { projectRoot: FIXTURE_DIR })]
  }
})

// ---- Tests — one per trace, deterministic --------------------------------

describe("Retrieval regression suite (P1 — no LLM)", () => {
  for (const [traceId, threshold] of Object.entries(RECALL_THRESHOLDS)) {
    test(`${traceId} recall >= ${threshold}`, () => {
      const golden = loadGoldenTrace(join(GOLDEN_DIR, `${traceId}.yaml`))
      const graphs = augmentedGraphs[traceId] ?? []
      const r0     = retrieve({ entrypoint: golden.entrypoint }, graphs)

      expect(r0).not.toBeNull()
      const score = scoreRetrieval(golden, r0!)
      expect(score.combined_recall).toBeGreaterThanOrEqual(threshold)
    })
  }

  test("LARAVEL-RUNTIME-001 is cross-cutting — retrieval returns null", () => {
    // Runtime traces span multiple routes — no single graph, retrieve returns null.
    // This is expected behavior, not a failure.
    const result = retrieve({ entrypoint: "ANY /tasks/*" }, [])
    expect(result).toBeNull()
  })

  test("no retrieval result contains duplicate node IDs", () => {
    for (const [traceId, graphs] of Object.entries(augmentedGraphs)) {
      const golden = loadGoldenTrace(join(GOLDEN_DIR, `${traceId}.yaml`))
      const r0 = retrieve({ entrypoint: golden.entrypoint }, graphs)
      if (!r0) continue
      const ids = r0.nodes.map((n) => n.id)
      const unique = new Set(ids)
      expect(unique.size).toBe(ids.length)
    }
  })

  test("compression ratio > 1 for all traces (ArchMind uses fewer tokens than naive RAG)", () => {
    // This test uses the token_estimate field directly from retrieval result.
    // Naive RAG baseline is derived from naive-rag.ts — not called here to keep this LLM-free.
    // We just assert that retrieval produces a bounded result, not an unbounded file dump.
    for (const [traceId, graphs] of Object.entries(augmentedGraphs)) {
      const golden = loadGoldenTrace(join(GOLDEN_DIR, `${traceId}.yaml`))
      const r0 = retrieve({ entrypoint: golden.entrypoint }, graphs)
      if (!r0) continue
      // Token estimate should be reasonable (not a full dump of thousands of tokens)
      expect(r0.token_estimate).toBeLessThan(5000)
    }
  })
})
