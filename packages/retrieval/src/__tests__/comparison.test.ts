import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { retrieve, prune, serialize, naiveRag, compare } from "../index.js"
import { loadGoldenTrace, scoreRetrieval } from "@kidkender/archmind-scorer"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const __filename  = fileURLToPath(import.meta.url)
const __dirname   = dirname(__filename)
const GOLDEN_DIR  = join(__dirname, "../../../../research/golden-traces/laravel")
const FIXTURE_DIR = join(__dirname, "../../../laravel-parser/src/__tests__/fixtures")

// Augmented extracted graph for AUTH-001 (skeleton + L1 nodes)
const AUTH_001_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "PUT /tasks/{task}",
  method:     "PUT",
  path:       "/tasks/{task}",
  nodes: [
    { id: "mw_0", type: "ir:auth_gate",        symbol: "auth:sanctum",                 role: "authentication" },
    { id: "mw_1", type: "ir:auth_gate",        symbol: "ResolveTenant::handle",        role: "middleware",
      file: "app/Http/Middleware/ResolveTenant.php" },
    { id: "mw_2", type: "ir:authz_check",      symbol: "CheckPermission::handle",      role: "authorization",
      args: ["task.update"], file: "app/Http/Middleware/CheckPermission.php" },
    { id: "ctrl", type: "ir:business_handler", symbol: "TaskController::update",       role: "handler",
      file: "app/Modules/Task/Http/Controllers/TaskController.php" },
    { id: "fr",   type: "ir:validation_gate",  symbol: "UpdateTaskRequest::authorize", role: "validation",
      file: "app/Modules/Task/Requests/UpdateTaskRequest.php" },
    { id: "pol",  type: "ir:authz_check",      symbol: "TaskPolicy::update",           role: "authorization",
      file: "app/Policies/TaskPolicy.php" },
  ],
  edges: [
    { from: "mw_0", to: "mw_1", relation: "next_middleware", traceability: "static" },
    { from: "mw_1", to: "mw_2", relation: "next_middleware", traceability: "static" },
    { from: "mw_2", to: "ctrl", relation: "next_middleware", traceability: "static" },
    { from: "ctrl", to: "fr",   relation: "form_request",    traceability: "static" },
    { from: "ctrl", to: "pol",  relation: "policy_check",    traceability: "semantic",
      mechanism: "$this->authorize('update', $task)" },
  ],
  annotations: [],
}

// ---- Naive RAG baseline -------------------------------------------

describe("Naive RAG baseline — LARAVEL-AUTH-001", () => {
  const golden = loadGoldenTrace(join(GOLDEN_DIR, "LARAVEL-AUTH-001.yaml"))
  const naive  = naiveRag(golden, FIXTURE_DIR)

  test("reads at least 4 fixture files", () => {
    expect(naive.files.length).toBeGreaterThanOrEqual(4)
  })

  test("produces non-empty content", () => {
    expect(naive.content.length).toBeGreaterThan(0)
  })

  test("token_estimate is substantial (all file contents)", () => {
    expect(naive.token_estimate).toBeGreaterThan(200)
  })
})

// ---- ArchMind vs Naive RAG comparison ----------------------------

describe("ArchMind vs Naive RAG — LARAVEL-AUTH-001", () => {
  const golden     = loadGoldenTrace(join(GOLDEN_DIR, "LARAVEL-AUTH-001.yaml"))
  const naive      = naiveRag(golden, FIXTURE_DIR)

  const r0         = retrieve({ entrypoint: "PUT /tasks/{task}" }, [AUTH_001_GRAPH])!
  const r1Auth     = retrieve({ entrypoint: "PUT /tasks/{task}", focus: "auth" }, [AUTH_001_GRAPH])!

  const r0Score    = scoreRetrieval(golden, r0)
  const r1Score    = scoreRetrieval(golden, r1Auth)

  const r0Cmp      = compare(naive, r0.token_estimate,    r0Score.combined_recall)
  const r1Cmp      = compare(naive, r1Auth.token_estimate, r1Score.combined_recall)

  test("ArchMind R0 uses fewer tokens than naive RAG", () => {
    expect(r0.token_estimate).toBeLessThan(naive.token_estimate)
  })

  test("ArchMind R1 (auth focus) uses even fewer tokens than R0", () => {
    expect(r1Auth.token_estimate).toBeLessThan(r0.token_estimate)
  })

  test("R0 compression ratio > 2x vs naive RAG", () => {
    expect(r0Cmp.compression_ratio).toBeGreaterThan(2)
  })

  test("R1 compression ratio > R0 compression ratio", () => {
    expect(r1Cmp.compression_ratio).toBeGreaterThan(r0Cmp.compression_ratio)
  })

  test("logs benchmark table", () => {
    const rows = [
      ["System",        "Files/Nodes", "Tokens",                       "Recall"],
      ["Naive RAG",     `${naive.files.length} files`, `${naive.token_estimate}`, "1.00 (dumps all)"],
      ["ArchMind R0",   `${r0.nodes.length} nodes`,    `${r0.token_estimate}`,    r0Score.combined_recall.toFixed(2)],
      ["ArchMind R1",   `${r1Auth.nodes.length} nodes`, `${r1Auth.token_estimate}`, r1Score.combined_recall.toFixed(2)],
    ]
    const col = (s: string, w: number) => s.padEnd(w)
    console.log("\n  ArchMind vs Naive RAG — LARAVEL-AUTH-001 (PUT /tasks/{task})")
    console.log("  " + "-".repeat(66))
    for (const [sys, fn, tok, rec] of rows) {
      console.log(`  ${col(sys, 18)} ${col(fn, 14)} ${col(tok, 10)} ${rec}`)
    }
    console.log("  " + "-".repeat(66))
    console.log(`  R0 compression: ${r0Cmp.compression_ratio.toFixed(1)}x  |  token savings: ${r0Cmp.token_savings_pct.toFixed(0)}%`)
    console.log(`  R1 compression: ${r1Cmp.compression_ratio.toFixed(1)}x  |  token savings: ${r1Cmp.token_savings_pct.toFixed(0)}%`)
    expect(true).toBe(true) // always pass — this test is for reporting
  })
})

// ---- Serializer output sample ------------------------------------

describe("Serializer output — sanity check", () => {
  test("serialize(R1 auth) is concise and readable", () => {
    const result = retrieve({ entrypoint: "PUT /tasks/{task}", focus: "auth" }, [AUTH_001_GRAPH])!
    const output = serialize(result)
    // Should contain key sections
    expect(output).toMatch(/MIDDLEWARE CHAIN|AUTHORIZATION/)
    // Should NOT contain MEDIUM-only nodes (business_handler = MEDIUM, pruned by auth focus)
    expect(output).not.toMatch(/TaskController::update/)
    // Token count should be shown
    expect(output).toMatch(/~\d+ tokens/)
  })
})
