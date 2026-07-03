import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { scoreTrace, findMatchingGraph } from "../scorer.js"
import { loadGoldenTrace } from "../golden-trace.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

// Path to golden traces in the research directory (relative to package)
const GOLDEN = join(__dirname, "../../../../research/golden-traces/laravel")

function goldenFile(id: string): string {
  return join(GOLDEN, `${id}.yaml`)
}

// ---- Minimal test graphs -------------------------------------------

const AUTH_001_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "PUT /tasks/{task}",
  method:     "PUT",
  path:       "/tasks/{task}",
  nodes: [
    { id: "mw_0_auth_sanctum",            type: "authentication_gate", symbol: "auth:sanctum",            role: "authentication" },
    { id: "mw_1_resolvetenant",           type: "middleware",          symbol: "ResolveTenant",           role: "middleware",     args: ["ResolveTenant"] },
    { id: "mw_2_permission_task_update",  type: "authorization_check", symbol: "permission:task.update",  role: "authorization",  args: ["task.update"] },
    { id: "ctrl_taskcontroller_update",   type: "controller_action",   symbol: "TaskController::update",  role: "handler" },
  ],
  edges: [
    { from: "mw_0_auth_sanctum",           to: "mw_1_resolvetenant",          relation: "next_middleware", traceability: "static" },
    { from: "mw_1_resolvetenant",          to: "mw_2_permission_task_update",  relation: "next_middleware", traceability: "static" },
    { from: "mw_2_permission_task_update", to: "ctrl_taskcontroller_update",   relation: "next_middleware", traceability: "static" },
  ],
  annotations: [],
}

// ---- findMatchingGraph -----------------------------------------------

describe("findMatchingGraph", () => {
  test("matches route with different parameter name (id vs task)", () => {
    const golden = loadGoldenTrace(goldenFile("LARAVEL-AUTH-001"))
    const result = findMatchingGraph(golden, [AUTH_001_GRAPH])
    expect(result).not.toBeNull()
    expect(result?.entrypoint).toBe("PUT /tasks/{task}")
  })

  test("returns null when no route matches", () => {
    const golden = loadGoldenTrace(goldenFile("LARAVEL-AUTH-001"))
    const unrelated: IntermediateExecutionGraph = {
      ...AUTH_001_GRAPH,
      entrypoint: "GET /unrelated",
      method: "GET",
      path: "/unrelated",
    }
    expect(findMatchingGraph(golden, [unrelated])).toBeNull()
  })
})

// ---- scoreTrace — LARAVEL-AUTH-001 -----------------------------------

describe("scoreTrace — LARAVEL-AUTH-001", () => {
  let report: ReturnType<typeof scoreTrace>

  beforeAll(() => {
    const golden = loadGoldenTrace(goldenFile("LARAVEL-AUTH-001"))
    report = scoreTrace(golden, [AUTH_001_GRAPH])
  })

  test("route is found", () => {
    expect(report.route_found).toBe(true)
  })

  test("skeleton recall is 100%", () => {
    expect(report.skeleton.recall).toBe(1)
    expect(report.skeleton.matched).toBe(4)
    expect(report.skeleton.total).toBe(4)
  })

  test("all skeleton nodes have a match", () => {
    for (const m of report.skeleton.matches) {
      expect(m.extracted_id).not.toBeNull()
    }
  })

  test("sanctum matched by exact symbol", () => {
    const m = report.skeleton.matches.find((m) => m.golden_id === "sanctum")
    expect(m?.match_reason).toBe("exact symbol")
  })

  test("check_permission matched (middleware ↔ authorization_check via token)", () => {
    const m = report.skeleton.matches.find((m) => m.golden_id === "check_permission")
    expect(m?.extracted_id).not.toBeNull()
  })

  test("deeper nodes are classified correctly", () => {
    expect(report.deeper.total).toBe(4)
    expect(report.deeper.nodes).toContain("update_task_request")
    expect(report.deeper.nodes).toContain("task_policy_update")
  })
})

// ---- scoreTrace — LARAVEL-AUTH-001 with L1 augmentation -------------

describe("scoreTrace — LARAVEL-AUTH-001 with L1 nodes", () => {
  const AUTH_001_AUGMENTED: IntermediateExecutionGraph = {
    ...AUTH_001_GRAPH,
    nodes: [
      ...AUTH_001_GRAPH.nodes,
      { id: "fr_updatetaskrequest", type: "form_request",  symbol: "UpdateTaskRequest::authorize", role: "validation"    },
      { id: "policy_taskpolicy_update", type: "policy",    symbol: "TaskPolicy::update",           role: "authorization" },
    ],
  }

  let report: ReturnType<typeof scoreTrace>

  beforeAll(() => {
    const golden = loadGoldenTrace(goldenFile("LARAVEL-AUTH-001"))
    report = scoreTrace(golden, [AUTH_001_AUGMENTED])
  })

  test("deeper matched is 2", () => {
    expect(report.deeper.matched).toBe(2)
  })

  test("deeper recall is 0.5 (2/4 nodes covered)", () => {
    expect(report.deeper.recall).toBe(0.5)
  })

  test("update_task_request is matched", () => {
    const m = report.deeper.matches.find((m) => m.golden_id === "update_task_request")
    expect(m?.extracted_id).not.toBeNull()
  })

  test("task_policy_update is matched", () => {
    const m = report.deeper.matches.find((m) => m.golden_id === "task_policy_update")
    expect(m?.extracted_id).not.toBeNull()
  })

  test("skeleton recall is still 100%", () => {
    expect(report.skeleton.recall).toBe(1)
  })

  test("summary includes deeper recall", () => {
    expect(report.summary).toMatch(/deeper/)
  })
})

// ---- scoreTrace — route not found -----------------------------------

describe("scoreTrace — route not found", () => {
  test("returns route_found: false with descriptive summary", () => {
    const golden = loadGoldenTrace(goldenFile("LARAVEL-AUTH-001"))
    const report = scoreTrace(golden, [])
    expect(report.route_found).toBe(false)
    expect(report.skeleton.recall).toBe(0)
    expect(report.summary).toMatch(/not found/i)
  })
})

// ---- scoreTrace — cross-cutting (LARAVEL-RUNTIME-001) ---------------

describe("scoreTrace — LARAVEL-RUNTIME-001 cross-cutting concern", () => {
  test("skips with descriptive reason for wildcard entrypoint", () => {
    const golden = loadGoldenTrace(goldenFile("LARAVEL-RUNTIME-001"))
    const report = scoreTrace(golden, [AUTH_001_GRAPH])
    expect(report.route_found).toBe(false)
    expect(report.summary).toMatch(/cross-cutting|skip/i)
  })
})

// ---- scoreTrace — LARAVEL-VALIDATION-001 ----------------------------

describe("scoreTrace — LARAVEL-VALIDATION-001", () => {
  test("check_permission skeleton node is matched", () => {
    const golden = loadGoldenTrace(goldenFile("LARAVEL-VALIDATION-001"))
    const report = scoreTrace(golden, [AUTH_001_GRAPH])
    expect(report.route_found).toBe(true)
    expect(report.skeleton.recall).toBe(1)
  })
})
