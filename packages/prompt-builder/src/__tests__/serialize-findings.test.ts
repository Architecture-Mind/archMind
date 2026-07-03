import { describe, test, expect } from "@jest/globals"
import type { Finding } from "@kidkender/archmind-explainer"
import { serializeFindings } from "../serialize-findings.js"

const DUP_AUTH_FINDING: Finding = {
  id: "dup-auth-001",
  type: "duplicate_authorization",
  severity: "CRITICAL",
  confidence: "HIGH",
  provenance: {
    detector: "duplicate-authorization",
    ontology_primitives: ["ExecutionOverlap"],
    supporting_nodes: ["mw_2", "pol"],
    supporting_edges: ["mw_2→svc1 [calls]", "pol→svc2 [calls]"],
  },
  summary: "CheckPermission::handle and TaskPolicy::update both call PermissionService::hasPermission(TASK_UPDATE)",
  reasoning: [],
  evidence: [],
  recommendations: [
    "Remove CheckPermission middleware and rely on policy",
    "If middleware gate serves other purpose, remove the permission check from it",
  ],
}

const MEDIUM_FINDING: Finding = {
  id: "priv-001",
  type: "privilege_hierarchy_present",
  severity: "MEDIUM",
  confidence: "MEDIUM",
  provenance: {
    detector: "privilege-hierarchy",
    ontology_primitives: ["PrivilegeHierarchy"],
    supporting_nodes: ["mw_2"],
    supporting_edges: [],
  },
  summary: "No elevated permission separation found",
  reasoning: [],
  evidence: [],
}

describe("serializeFindings", () => {
  test("includes Semantic findings header", () => {
    const out = serializeFindings([DUP_AUTH_FINDING])
    expect(out).toContain("Semantic findings")
  })

  test("includes ranked index [1]", () => {
    const out = serializeFindings([DUP_AUTH_FINDING])
    expect(out).toContain("[1]")
  })

  test("includes finding type in uppercase", () => {
    const out = serializeFindings([DUP_AUTH_FINDING])
    expect(out).toContain("DUPLICATE_AUTHORIZATION")
  })

  test("includes severity", () => {
    const out = serializeFindings([DUP_AUTH_FINDING])
    expect(out).toContain("CRITICAL")
  })

  test("includes confidence", () => {
    const out = serializeFindings([DUP_AUTH_FINDING])
    expect(out).toContain("confidence: HIGH")
  })

  test("includes summary text", () => {
    const out = serializeFindings([DUP_AUTH_FINDING])
    expect(out).toContain("PermissionService::hasPermission")
  })

  test("includes supporting nodes", () => {
    const out = serializeFindings([DUP_AUTH_FINDING])
    expect(out).toContain("mw_2")
    expect(out).toContain("pol")
  })

  test("ranks CRITICAL before MEDIUM", () => {
    const out = serializeFindings([MEDIUM_FINDING, DUP_AUTH_FINDING])
    const criticalPos = out.indexOf("CRITICAL")
    const mediumPos = out.indexOf("MEDIUM")
    expect(criticalPos).toBeLessThan(mediumPos)
  })

  test("MEDIUM findings get [2] rank when CRITICAL is [1]", () => {
    const out = serializeFindings([DUP_AUTH_FINDING, MEDIUM_FINDING])
    expect(out).toContain("[2]")
  })

  test("empty findings returns empty string", () => {
    expect(serializeFindings([])).toBe("")
  })

  test("includes recommendations when present", () => {
    const out = serializeFindings([DUP_AUTH_FINDING])
    expect(out).toContain("Remove CheckPermission")
  })
})
