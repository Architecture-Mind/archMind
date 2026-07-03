import { describe, test, expect } from "@jest/globals"
import { extractValidationGateFacts } from "../fact-extraction/validation.js"
import { detectDelegatedValidation } from "../pattern-detectors/delegated-validation.js"
import { FINDING_TYPES } from "../findings/types.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const VALIDATION_001_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "PUT /tasks/{id}",
  method: "PUT",
  path: "/tasks/{id}",
  nodes: [
    {
      id: "update_task_request",
      type: "form_request",
      symbol: "UpdateTaskRequest::authorize",
      role: "validation_only",
    },
    {
      id: "check_permission",
      type: "middleware",
      symbol: "CheckPermission::handle",
      role: "auth_layer_1",
      args: ["task.update"],
    },
    {
      id: "task_policy_update",
      type: "policy",
      symbol: "TaskPolicy::update",
      role: "auth_layer_2",
    },
  ],
  edges: [
    {
      from: "check_permission",
      to: "task_policy_update",
      relation: "auth_chain",
      traceability: "static",
    },
  ],
  annotations: [],
}

describe("extractValidationGateFacts — VALIDATION-001", () => {
  test("extracts fact for form_request node", () => {
    const facts = extractValidationGateFacts(VALIDATION_001_GRAPH)
    expect(facts.length).toBe(1)
    expect(facts[0]!.nodeId).toBe("update_task_request")
  })

  test("delegatesAuthorization=true when role=validation_only", () => {
    const facts = extractValidationGateFacts(VALIDATION_001_GRAPH)
    expect(facts[0]!.delegatesAuthorization).toBe(true)
  })

  test("HIGH confidence when real auth layers present", () => {
    const facts = extractValidationGateFacts(VALIDATION_001_GRAPH)
    expect(facts[0]!.confidence).toBe("HIGH")
  })
})

describe("detectDelegatedValidation — VALIDATION-001", () => {
  test("emits delegated_validation finding", () => {
    const facts = extractValidationGateFacts(VALIDATION_001_GRAPH)
    const authNodeIds = ["check_permission", "task_policy_update"]
    const findings = detectDelegatedValidation(facts, authNodeIds, VALIDATION_001_GRAPH)

    expect(findings.length).toBe(1)
    expect(findings[0]!.type).toBe(FINDING_TYPES.DELEGATED_VALIDATION)
  })

  test("severity is INFO when auth layers present", () => {
    const facts = extractValidationGateFacts(VALIDATION_001_GRAPH)
    const findings = detectDelegatedValidation(facts, ["check_permission", "task_policy_update"], VALIDATION_001_GRAPH)
    expect(findings[0]!.severity).toBe("INFO")
  })

  test("severity is MEDIUM when no auth layers", () => {
    const facts = extractValidationGateFacts(VALIDATION_001_GRAPH)
    const findings = detectDelegatedValidation(facts, [], VALIDATION_001_GRAPH)
    expect(findings[0]!.severity).toBe("MEDIUM")
  })

  test("summary mentions delegation", () => {
    const facts = extractValidationGateFacts(VALIDATION_001_GRAPH)
    const findings = detectDelegatedValidation(facts, ["check_permission", "task_policy_update"], VALIDATION_001_GRAPH)
    expect(findings[0]!.summary).toContain("delegates")
  })

  test("reasoning contains delegation_confirmed step", () => {
    const facts = extractValidationGateFacts(VALIDATION_001_GRAPH)
    const findings = detectDelegatedValidation(facts, ["check_permission"], VALIDATION_001_GRAPH)
    const types = findings[0]!.reasoning.map((r) => r.type)
    expect(types).toContain("delegation_confirmed")
  })

  test("no finding when form_request does real auth check", () => {
    const graph: IntermediateExecutionGraph = {
      entrypoint: "GET /tasks",
      method: "GET",
      path: "/tasks",
      nodes: [{ id: "req", type: "form_request", symbol: "TaskRequest::authorize" }],
      edges: [{ from: "req", to: "policy", relation: "policy_check", traceability: "static" }],
      annotations: [],
    }
    const facts = extractValidationGateFacts(graph)
    const findings = detectDelegatedValidation(facts, [], graph)
    expect(findings).toHaveLength(0)
  })
})
