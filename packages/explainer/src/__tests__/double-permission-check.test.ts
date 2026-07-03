import { describe, test, expect, beforeEach } from "@jest/globals"
import { extractAuthorizationFacts } from "../fact-extraction/authorization.js"
import { detectDoublePermissionCheck } from "../pattern-detectors/double-permission-check.js"
import { normalizeAbility } from "../fact-extraction/authorization.js"
import { FINDING_TYPES } from "../findings/types.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

// Graph matching the real tenant-workspace-api shape:
// middleware authorization_check (Permission::TASK_UPDATE) → policy → PermissionService
const REAL_WORLD_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "PUT /tasks/{task}",
  method: "PUT",
  path: "/tasks/{task}",
  nodes: [
    { id: "mw_auth",       type: "authentication_gate", symbol: "auth:sanctum",                   role: "authentication" },
    { id: "mw_perm",       type: "authorization_check", symbol: "permission:Permission::TASK_UPDATE", role: "authorization", args: ["Permission::TASK_UPDATE"] },
    { id: "ctrl",          type: "controller_action",   symbol: "TaskController::update",            role: "handler" },
    { id: "policy",        type: "policy",              symbol: "TaskPolicy::update",                role: "authorization" },
    { id: "perm_service",  type: "service_call",        symbol: "PermissionService::hasPermission",  role: "service" },
  ],
  edges: [
    { from: "mw_auth",  to: "mw_perm",      relation: "next_middleware", traceability: "static" },
    { from: "mw_perm",  to: "ctrl",         relation: "next_middleware", traceability: "static" },
    { from: "ctrl",     to: "policy",       relation: "policy_check",   traceability: "semantic", mechanism: "$this->authorize('update', $task)" },
    { from: "policy",   to: "perm_service", relation: "calls",          traceability: "semantic" },
  ],
  annotations: [],
}

// Graph with no middleware permission check — should emit no finding
const NO_MW_CHECK_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "GET /tasks",
  method: "GET",
  path: "/tasks",
  nodes: [
    { id: "ctrl",   type: "controller_action", symbol: "TaskController::index", role: "handler" },
    { id: "policy", type: "policy",            symbol: "TaskPolicy::viewAny",   role: "authorization" },
    { id: "svc",    type: "service_call",      symbol: "PermissionService::hasPermission", role: "service" },
  ],
  edges: [
    { from: "policy", to: "svc", relation: "calls", traceability: "semantic" },
  ],
  annotations: [],
}

// Graph with middleware check but no policy→PermissionService — should emit no finding
const MW_NO_POLICY_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "DELETE /tasks/{task}",
  method: "DELETE",
  path: "/tasks/{task}",
  nodes: [
    { id: "mw_perm", type: "authorization_check", symbol: "permission:TASK_DELETE", role: "authorization", args: ["TASK_DELETE"] },
    { id: "ctrl",    type: "controller_action",   symbol: "TaskController::destroy", role: "handler" },
  ],
  edges: [
    { from: "mw_perm", to: "ctrl", relation: "next_middleware", traceability: "static" },
  ],
  annotations: [],
}

// ---- normalizeAbility -------------------------------------------------------

describe("normalizeAbility — :: class prefix handling", () => {
  test("Permission::TASK_UPDATE → update", () => {
    expect(normalizeAbility("Permission::TASK_UPDATE")).toBe("update")
  })

  test("Permission::TASK_CREATE → create", () => {
    expect(normalizeAbility("Permission::TASK_CREATE")).toBe("create")
  })

  test("task.update → update (existing behaviour preserved)", () => {
    expect(normalizeAbility("task.update")).toBe("update")
  })

  test("TASK_UPDATE → update (existing behaviour preserved)", () => {
    expect(normalizeAbility("TASK_UPDATE")).toBe("update")
  })

  test("update → update", () => {
    expect(normalizeAbility("update")).toBe("update")
  })
})

// ---- detectDoublePermissionCheck -------------------------------------------

describe("detectDoublePermissionCheck — real-world shape", () => {
  let findings: ReturnType<typeof detectDoublePermissionCheck>

  beforeEach(() => {
    const facts = extractAuthorizationFacts(REAL_WORLD_GRAPH)
    findings = detectDoublePermissionCheck(facts, REAL_WORLD_GRAPH)
  })

  test("emits exactly one finding", () => {
    expect(findings).toHaveLength(1)
  })

  test("finding type is double_permission_check", () => {
    expect(findings[0]!.type).toBe(FINDING_TYPES.DOUBLE_PERMISSION_CHECK)
  })

  test("severity is LOW", () => {
    expect(findings[0]!.severity).toBe("LOW")
  })

  test("confidence is HIGH", () => {
    expect(findings[0]!.confidence).toBe("HIGH")
  })

  test("summary names the permission key and both symbols", () => {
    const summary = findings[0]!.summary
    expect(summary).toContain("Permission::TASK_UPDATE")
    expect(summary).toContain("PermissionService::hasPermission")
    expect(summary).toContain("TaskPolicy::update")
  })

  test("supporting nodes include middleware, policy, and service nodes", () => {
    const nodes = findings[0]!.provenance.supporting_nodes
    expect(nodes).toContain("mw_perm")
    expect(nodes).toContain("policy")
    expect(nodes).toContain("perm_service")
  })

  test("has two evidence entries", () => {
    expect(findings[0]!.evidence).toHaveLength(2)
  })

  test("has two recommendations", () => {
    expect(findings[0]!.recommendations?.length).toBe(2)
  })

  test("reasoning contains double_check_detected step", () => {
    const types = findings[0]!.reasoning.map((r) => r.type)
    expect(types).toContain("double_check_detected")
  })
})

describe("detectDoublePermissionCheck — no finding cases", () => {
  test("no finding when no middleware authorization_check exists", () => {
    const facts = extractAuthorizationFacts(NO_MW_CHECK_GRAPH)
    const findings = detectDoublePermissionCheck(facts, NO_MW_CHECK_GRAPH)
    expect(findings).toHaveLength(0)
  })

  test("no finding when no policy→PermissionService edge exists", () => {
    const facts = extractAuthorizationFacts(MW_NO_POLICY_GRAPH)
    const findings = detectDoublePermissionCheck(facts, MW_NO_POLICY_GRAPH)
    expect(findings).toHaveLength(0)
  })
})
