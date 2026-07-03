import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { scoreRetrieval } from "../retrieval-scorer.js"
import { loadGoldenTrace } from "../golden-trace.js"
import type { RetrievalResult } from "@kidkender/archmind-protocol"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

const GOLDEN = join(__dirname, "../../../../research/golden-traces/laravel")

function goldenFile(id: string): string {
  return join(GOLDEN, `${id}.yaml`)
}

// Skeleton-only retrieval result (no L1 nodes)
const SKELETON_RESULT: RetrievalResult = {
  entrypoint:       "PUT /tasks/{task}",
  nodes: [
    { id: "mw_0", type: "authentication_gate", symbol: "auth:sanctum",           role: "authentication" },
    { id: "mw_1", type: "middleware",          symbol: "ResolveTenant",           role: "middleware" },
    { id: "mw_2", type: "authorization_check", symbol: "CheckPermission::handle", role: "authorization" },
    { id: "ctrl", type: "controller_action",   symbol: "TaskController::update",  role: "handler" },
  ],
  edges:            [],
  token_estimate:   200,
  pruned:           false,
  focus:            "all",
  protocol_version: "1.0.0",
}

// Augmented retrieval result (skeleton + L1 nodes)
const AUGMENTED_RESULT: RetrievalResult = {
  ...SKELETON_RESULT,
  nodes: [
    ...SKELETON_RESULT.nodes,
    { id: "fr",     type: "form_request", symbol: "UpdateTaskRequest::authorize", role: "validation"    },
    { id: "policy", type: "policy",       symbol: "TaskPolicy::update",           role: "authorization" },
  ],
  token_estimate: 350,
}

// ---- scoreRetrieval — not retrieved ---------------------------------

describe("scoreRetrieval — entrypoint not retrieved", () => {
  test("returns retrieved: false and zero recall", () => {
    const golden = loadGoldenTrace(goldenFile("LARAVEL-AUTH-001"))
    const report = scoreRetrieval(golden, null)
    expect(report.retrieved).toBe(false)
    expect(report.combined_recall).toBe(0)
    expect(report.summary).toMatch(/NOT RETRIEVED/)
  })
})

// ---- scoreRetrieval — LARAVEL-AUTH-001 skeleton only ----------------

describe("scoreRetrieval — LARAVEL-AUTH-001 skeleton only", () => {
  let report: ReturnType<typeof scoreRetrieval>

  beforeAll(() => {
    const golden = loadGoldenTrace(goldenFile("LARAVEL-AUTH-001"))
    report = scoreRetrieval(golden, SKELETON_RESULT)
  })

  test("retrieved is true", () => {
    expect(report.retrieved).toBe(true)
  })

  test("check_permission (HIGH) is covered via symbol match", () => {
    // CheckPermission::handle contains "checkpermission" which includes "check_permission" symbol
    expect(report.high_recall).toBeGreaterThan(0)
  })

  test("permission_service nodes (HIGH) are NOT covered — not extracted yet", () => {
    // permission_service_1/2 have symbol PermissionService::hasPermission — not in skeleton
    // So high_recall < 1
    expect(report.high_recall).toBeLessThan(1)
  })

  test("token_estimate is passed through", () => {
    expect(report.token_estimate).toBe(200)
  })

  test("summary contains recall percentages", () => {
    expect(report.summary).toMatch(/retrieval recall/)
    expect(report.summary).toMatch(/tokens/)
  })
})

// ---- scoreRetrieval — LARAVEL-AUTH-001 augmented --------------------

describe("scoreRetrieval — LARAVEL-AUTH-001 augmented (L1 nodes)", () => {
  let report: ReturnType<typeof scoreRetrieval>

  beforeAll(() => {
    const golden = loadGoldenTrace(goldenFile("LARAVEL-AUTH-001"))
    report = scoreRetrieval(golden, AUGMENTED_RESULT)
  })

  test("combined_recall improves over skeleton-only", () => {
    const goldenTrace  = loadGoldenTrace(goldenFile("LARAVEL-AUTH-001"))
    const skeletonReport = scoreRetrieval(goldenTrace, SKELETON_RESULT)
    expect(report.combined_recall).toBeGreaterThanOrEqual(skeletonReport.combined_recall)
  })

  test("medium_recall is 1 — all MEDIUM nodes covered", () => {
    // MEDIUM nodes in AUTH-001: resolve_tenant (MEDIUM), task_controller_update (MEDIUM)
    // Both exist in augmented result
    expect(report.medium_recall).toBe(1)
  })
})
