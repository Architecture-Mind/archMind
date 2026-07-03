import { describe, test, expect } from "@jest/globals"
import { extractAuthorizationFacts } from "../fact-extraction/authorization.js"
import { detectMissingAuthorization } from "../pattern-detectors/missing-authorization.js"
import { FINDING_TYPES } from "../findings/types.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

// Mirrors DELETE /products/{product} in ecomerce-api:
// auth:sanctum present, no policy, no authorization_check
const AUTH_ONLY_DELETE: IntermediateExecutionGraph = {
  entrypoint: "DELETE /products/{product}",
  method: "DELETE",
  path: "/products/{product}",
  nodes: [
    { id: "mw_0_auth_sanctum", type: "authentication_gate", symbol: "auth:sanctum", role: "authentication" },
    { id: "ctrl_product_destroy", type: "controller_action", symbol: "ProductController::destroy", role: "controller" },
  ],
  edges: [
    { from: "mw_0_auth_sanctum", to: "ctrl_product_destroy", relation: "next_middleware", traceability: "static" },
  ],
  annotations: [],
}

// Properly authorized: has policy node
const AUTHORIZED_DELETE: IntermediateExecutionGraph = {
  entrypoint: "DELETE /products/{product}",
  method: "DELETE",
  path: "/products/{product}",
  nodes: [
    { id: "mw_0_auth_sanctum", type: "authentication_gate", symbol: "auth:sanctum", role: "authentication" },
    { id: "ctrl_product_destroy", type: "controller_action", symbol: "ProductController::destroy", role: "controller" },
    { id: "policy_product_delete", type: "policy", symbol: "ProductPolicy::delete", role: "authorization" },
  ],
  edges: [
    { from: "mw_0_auth_sanctum", to: "ctrl_product_destroy", relation: "next_middleware", traceability: "static" },
    { from: "ctrl_product_destroy", to: "policy_product_delete", relation: "policy_check", traceability: "semantic" },
  ],
  annotations: [],
}

// GET route — should NOT fire (reads don't require authorization)
const AUTH_ONLY_GET: IntermediateExecutionGraph = {
  entrypoint: "GET /products",
  method: "GET",
  path: "/products",
  nodes: [
    { id: "mw_0_auth_sanctum", type: "authentication_gate", symbol: "auth:sanctum", role: "authentication" },
    { id: "ctrl_product_index", type: "controller_action", symbol: "ProductController::index", role: "controller" },
  ],
  edges: [
    { from: "mw_0_auth_sanctum", to: "ctrl_product_index", relation: "next_middleware", traceability: "static" },
  ],
  annotations: [],
}

// No auth at all — should NOT fire (different problem)
const UNAUTHENTICATED_DELETE: IntermediateExecutionGraph = {
  entrypoint: "DELETE /products/{product}",
  method: "DELETE",
  path: "/products/{product}",
  nodes: [
    { id: "ctrl_product_destroy", type: "controller_action", symbol: "ProductController::destroy", role: "controller" },
  ],
  edges: [],
  annotations: [],
}

describe("detectMissingAuthorization", () => {
  test("fires HIGH finding for auth-only DELETE", () => {
    const facts = extractAuthorizationFacts(AUTH_ONLY_DELETE)
    const findings = detectMissingAuthorization(facts, AUTH_ONLY_DELETE)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.type).toBe(FINDING_TYPES.MISSING_AUTHORIZATION)
    expect(findings[0]!.severity).toBe("HIGH")
    expect(findings[0]!.confidence).toBe("HIGH")
  })

  test("summary mentions the HTTP method and path", () => {
    const facts = extractAuthorizationFacts(AUTH_ONLY_DELETE)
    const findings = detectMissingAuthorization(facts, AUTH_ONLY_DELETE)
    expect(findings[0]!.summary).toContain("DELETE")
    expect(findings[0]!.summary).toContain("/products/{product}")
  })

  test("provides recommendations", () => {
    const facts = extractAuthorizationFacts(AUTH_ONLY_DELETE)
    const findings = detectMissingAuthorization(facts, AUTH_ONLY_DELETE)
    expect(findings[0]!.recommendations!.length).toBeGreaterThan(0)
  })

  test("does NOT fire when policy node is present", () => {
    const facts = extractAuthorizationFacts(AUTHORIZED_DELETE)
    const findings = detectMissingAuthorization(facts, AUTHORIZED_DELETE)
    expect(findings).toHaveLength(0)
  })

  test("does NOT fire for GET routes", () => {
    const facts = extractAuthorizationFacts(AUTH_ONLY_GET)
    const findings = detectMissingAuthorization(facts, AUTH_ONLY_GET)
    expect(findings).toHaveLength(0)
  })

  test("does NOT fire when route has no authentication at all", () => {
    const facts = extractAuthorizationFacts(UNAUTHENTICATED_DELETE)
    const findings = detectMissingAuthorization(facts, UNAUTHENTICATED_DELETE)
    expect(findings).toHaveLength(0)
  })
})
