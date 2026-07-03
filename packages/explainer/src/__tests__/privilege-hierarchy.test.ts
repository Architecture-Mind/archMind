import { describe, test, expect } from "@jest/globals"
import { detectPrivilegeHierarchy } from "../pattern-detectors/privilege-hierarchy.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const AUTH_002_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "DELETE /tasks/{id}",
  method: "DELETE",
  path: "/tasks/{id}",
  nodes: [
    { id: "sanctum", type: "middleware", symbol: "auth:sanctum" },
    { id: "check_permission", type: "middleware", symbol: "CheckPermission::handle", args: ["task.delete"] },
    { id: "task_controller_destroy", type: "controller", symbol: "TaskController::destroy" },
    { id: "task_policy_delete", type: "policy", symbol: "TaskPolicy::delete" },
    { id: "perm_task_delete", type: "permission", symbol: "Permission::TASK_DELETE" },
    { id: "perm_task_delete_any", type: "permission", symbol: "Permission::TASK_DELETE_ANY" },
  ],
  edges: [
    { from: "sanctum", to: "check_permission", relation: "next_middleware", traceability: "static" },
    { from: "check_permission", to: "task_controller_destroy", relation: "next_middleware", traceability: "static" },
    { from: "task_controller_destroy", to: "task_policy_delete", relation: "policy_check", traceability: "static", mechanism: "$this->authorize('delete', $task)" },
    { from: "task_policy_delete", to: "perm_task_delete", relation: "checks_permission", traceability: "static" },
    { from: "task_policy_delete", to: "perm_task_delete_any", relation: "checks_permission", traceability: "static" },
    { from: "perm_task_delete_any", to: "perm_task_delete", relation: "privilege_hierarchy", traceability: "semantic" },
  ],
  annotations: [],
}

describe("detectPrivilegeHierarchy — AUTH-002", () => {
  test("emits privilege_hierarchy_present finding", () => {
    const findings = detectPrivilegeHierarchy([], AUTH_002_GRAPH)
    expect(findings.length).toBe(1)
    expect(findings[0]!.type).toBe("privilege_hierarchy_present")
  })

  test("severity is MEDIUM (potential inversion bug warrants attention)", () => {
    const findings = detectPrivilegeHierarchy([], AUTH_002_GRAPH)
    expect(findings[0]!.severity).toBe("MEDIUM")
  })

  test("confidence is MEDIUM", () => {
    const findings = detectPrivilegeHierarchy([], AUTH_002_GRAPH)
    expect(findings[0]!.confidence).toBe("MEDIUM")
  })

  test("summary mentions policy and privilege hierarchy", () => {
    const findings = detectPrivilegeHierarchy([], AUTH_002_GRAPH)
    expect(findings[0]!.summary).toContain("privilege hierarchy")
    expect(findings[0]!.summary).toContain("TaskPolicy::delete")
  })

  test("uncertainty field explains condition unverifiability", () => {
    const findings = detectPrivilegeHierarchy([], AUTH_002_GRAPH)
    expect(findings[0]!.uncertainty?.length).toBeGreaterThan(0)
    const unverifiable = findings[0]!.uncertainty!.find((u) => u.kind === "unverifiable_condition")
    expect(unverifiable).toBeDefined()
    expect(unverifiable!.description.toLowerCase()).toContain("condition direction")
  })

  test("recommendations warn about inversion bug", () => {
    const findings = detectPrivilegeHierarchy([], AUTH_002_GRAPH)
    const recs = findings[0]!.recommendations ?? []
    expect(recs.some((r) => r.toLowerCase().includes("inverted"))).toBe(true)
  })

  test("involved nodes include policy and both permissions", () => {
    const findings = detectPrivilegeHierarchy([], AUTH_002_GRAPH)
    const nodes = findings[0]!.provenance.supporting_nodes
    expect(nodes).toContain("task_policy_delete")
    expect(nodes).toContain("perm_task_delete")
    expect(nodes).toContain("perm_task_delete_any")
  })

  test("no finding when no privilege_hierarchy edges", () => {
    const graph: IntermediateExecutionGraph = {
      entrypoint: "GET /tasks",
      method: "GET",
      path: "/tasks",
      nodes: [{ id: "ctrl", type: "controller", symbol: "TaskController::index" }],
      edges: [],
      annotations: [],
    }
    const findings = detectPrivilegeHierarchy([], graph)
    expect(findings).toHaveLength(0)
  })
})
