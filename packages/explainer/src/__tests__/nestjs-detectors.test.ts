/**
 * NestJS detector parity tests.
 *
 * Proves that framework-agnostic detectors fire identically on NestJS IR graphs
 * as they do on Laravel IR graphs. Each test uses a synthetic NestJS-shaped
 * IntermediateExecutionGraph (framework: "nestjs") and asserts the expected finding.
 */

import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { extractFacts } from "../fact-extraction/index.js"
import { detect } from "../pattern-detectors/index.js"
import { detectFatController } from "../pattern-detectors/fat-controller.js"
import { detectMissingAuthorization } from "../pattern-detectors/missing-authorization.js"
import { detectExposedReadEndpoint } from "../pattern-detectors/exposed-read-endpoint.js"
import { detectSynchronousMail } from "../pattern-detectors/synchronous-mail.js"
import { detectOverAuthorizedRoute } from "../pattern-detectors/over-authorized-route.js"

function nestjsGraph(
  overrides: Partial<IntermediateExecutionGraph> = {}
): IntermediateExecutionGraph {
  return {
    entrypoint: "GET /test",
    method: "GET",
    path: "/test",
    framework: "nestjs",
    adapter_ver: "0.3.0",
    ir_ver: "1.4",
    nodes: [],
    edges: [],
    annotations: [],
    ...overrides,
  }
}

// ── fat_controller ────────────────────────────────────────────────────────────

describe("NestJS: detectFatController", () => {
  it("fires when NestJS controller has 5+ distinct injected services", () => {
    const graph = nestjsGraph({
      method: "POST",
      path: "/orders",
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "OrderController::create", role: "handler" },
        { id: "s1", type: "ir:service_call", symbol: "InventoryService::check", role: "service" },
        { id: "s2", type: "ir:service_call", symbol: "PaymentService::charge", role: "service" },
        { id: "s3", type: "ir:service_call", symbol: "NotificationService::send", role: "service" },
        { id: "s4", type: "ir:service_call", symbol: "AuditService::log", role: "service" },
        { id: "s5", type: "ir:service_call", symbol: "ShippingService::calculate", role: "service" },
      ],
      edges: [
        { from: "ctrl", to: "s1", relation: "calls", traceability: "semantic" },
        { from: "ctrl", to: "s2", relation: "calls", traceability: "semantic" },
        { from: "ctrl", to: "s3", relation: "calls", traceability: "semantic" },
        { from: "ctrl", to: "s4", relation: "calls", traceability: "semantic" },
        { from: "ctrl", to: "s5", relation: "calls", traceability: "semantic" },
      ],
    })
    const findings = detectFatController(graph)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("fat_controller")
  })

  it("does not fire for NestJS controller with 3 services", () => {
    const graph = nestjsGraph({
      method: "POST",
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "UserController::create", role: "handler" },
        { id: "s1", type: "ir:service_call", symbol: "UserService::create", role: "service" },
        { id: "s2", type: "ir:service_call", symbol: "MailService::welcome", role: "service" },
        { id: "s3", type: "ir:service_call", symbol: "AuditService::log", role: "service" },
      ],
      edges: [],
    })
    expect(detectFatController(graph)).toHaveLength(0)
  })
})

// ── missing_authorization ────────────────────────────────────────────────────

describe("NestJS: detectMissingAuthorization", () => {
  it("fires for POST with JwtAuthGuard but no RolesGuard/authz_check", () => {
    const graph = nestjsGraph({
      method: "POST",
      path: "/admin/users",
      nodes: [
        { id: "mw_0", type: "ir:auth_gate", symbol: "JwtAuthGuard", role: "authentication" },
        { id: "ctrl", type: "ir:business_handler", symbol: "AdminController::createUser", role: "handler" },
      ],
      edges: [
        { from: "mw_0", to: "ctrl", relation: "next_middleware", traceability: "static" },
      ],
    })
    const facts = extractFacts(graph)
    const findings = detectMissingAuthorization(facts, graph)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("missing_authorization")
    expect(findings[0].severity).toBe("HIGH")
  })

  it("does not fire when RolesGuard (ir:authz_check) is present", () => {
    const graph = nestjsGraph({
      method: "POST",
      path: "/admin/users",
      nodes: [
        { id: "mw_0", type: "ir:auth_gate",   symbol: "JwtAuthGuard", role: "authentication" },
        { id: "mw_1", type: "ir:authz_check", symbol: "RolesGuard",   role: "authorization" },
        { id: "ctrl", type: "ir:business_handler", symbol: "AdminController::createUser", role: "handler" },
      ],
      edges: [
        { from: "mw_0", to: "mw_1", relation: "next_middleware", traceability: "static" },
        { from: "mw_1", to: "ctrl", relation: "next_middleware", traceability: "static" },
      ],
    })
    const facts = extractFacts(graph)
    expect(detectMissingAuthorization(facts, graph)).toHaveLength(0)
  })

  it("does not fire for GET routes (read-only)", () => {
    const graph = nestjsGraph({
      method: "GET",
      path: "/users",
      nodes: [
        { id: "mw_0", type: "ir:auth_gate", symbol: "JwtAuthGuard", role: "authentication" },
        { id: "ctrl", type: "ir:business_handler", symbol: "UserController::findAll", role: "handler" },
      ],
      edges: [{ from: "mw_0", to: "ctrl", relation: "next_middleware", traceability: "static" }],
    })
    const facts = extractFacts(graph)
    expect(detectMissingAuthorization(facts, graph)).toHaveLength(0)
  })
})

// ── exposed_read_endpoint ─────────────────────────────────────────────────────

describe("NestJS: detectExposedReadEndpoint", () => {
  it("fires for GET with service calls and no auth guard", () => {
    const graph = nestjsGraph({
      method: "GET",
      path: "/public/orders",
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "OrderController::findAll", role: "handler" },
        { id: "s1",   type: "ir:service_call",     symbol: "OrderService::findAll",   role: "service" },
      ],
      edges: [{ from: "ctrl", to: "s1", relation: "calls", traceability: "semantic" }],
    })
    const findings = detectExposedReadEndpoint(graph)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("exposed_read_endpoint")
  })

  it("does not fire when JwtAuthGuard protects the GET route", () => {
    const graph = nestjsGraph({
      method: "GET",
      path: "/orders",
      nodes: [
        { id: "mw_0", type: "ir:auth_gate", symbol: "JwtAuthGuard", role: "authentication" },
        { id: "ctrl", type: "ir:business_handler", symbol: "OrderController::findAll", role: "handler" },
        { id: "s1",   type: "ir:service_call",     symbol: "OrderService::findAll",   role: "service" },
      ],
      edges: [
        { from: "mw_0", to: "ctrl", relation: "next_middleware", traceability: "static" },
        { from: "ctrl", to: "s1",   relation: "calls",           traceability: "semantic" },
      ],
    })
    expect(detectExposedReadEndpoint(graph)).toHaveLength(0)
  })
})

// ── synchronous_mail ──────────────────────────────────────────────────────────

describe("NestJS: detectSynchronousMail", () => {
  it("fires when MailerService sends synchronously (queued:false)", () => {
    const graph = nestjsGraph({
      method: "POST",
      path: "/users",
      nodes: [
        { id: "mw_0", type: "ir:auth_gate", symbol: "JwtAuthGuard", role: "authentication" },
        { id: "ctrl", type: "ir:business_handler", symbol: "UserController::create", role: "handler" },
        {
          id: "mail_0",
          type: "ir:mail",
          symbol: "sendMail",
          role: "side_effect",
          detail: JSON.stringify({ queued: false }),
        },
      ],
      edges: [
        { from: "mw_0",   to: "ctrl",   relation: "next_middleware", traceability: "static" },
        { from: "ctrl",   to: "mail_0", relation: "dispatches",      traceability: "static" },
      ],
    })
    const findings = detectSynchronousMail(graph)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("synchronous_mail")
  })
})

// ── over_authorized_route ─────────────────────────────────────────────────────

describe("NestJS: detectOverAuthorizedRoute", () => {
  it("fires when all 3 distinct layer types present (auth_gate + authz_check + validation_gate)", () => {
    // Detector counts distinct LAYER TYPES, not node count:
    //   1. ir:auth_gate      → "auth middleware"
    //   2. ir:authz_check    → "policy/Gate check"
    //   3. ir:validation_gate → "FormRequest::authorize" (DTO validation in NestJS)
    const graph = nestjsGraph({
      method: "DELETE",
      path: "/admin/resources/:id",
      nodes: [
        { id: "mw_0", type: "ir:auth_gate",       symbol: "JwtAuthGuard",   role: "authentication" },
        { id: "mw_1", type: "ir:authz_check",     symbol: "RolesGuard",     role: "authorization" },
        { id: "mw_2", type: "ir:validation_gate", symbol: "DeleteResourceDto", role: "validation" },
        { id: "ctrl", type: "ir:business_handler", symbol: "AdminController::delete", role: "handler" },
      ],
      edges: [
        { from: "mw_0", to: "mw_1", relation: "next_middleware", traceability: "static" },
        { from: "mw_1", to: "ctrl", relation: "next_middleware", traceability: "static" },
        { from: "ctrl", to: "mw_2", relation: "validates",       traceability: "static" },
      ],
    })
    const findings = detectOverAuthorizedRoute(graph)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("over_authorized_route")
  })
})

// ── full pipeline (detect) ────────────────────────────────────────────────────

describe("NestJS: full detect() pipeline", () => {
  it("returns fat_controller finding via detect() for NestJS graph", () => {
    const graph = nestjsGraph({
      method: "POST",
      path: "/checkout",
      nodes: [
        { id: "mw_0", type: "ir:auth_gate", symbol: "JwtAuthGuard", role: "authentication" },
        { id: "ctrl", type: "ir:business_handler", symbol: "CheckoutController::process", role: "handler" },
        { id: "s1", type: "ir:service_call", symbol: "CartService::validate", role: "service" },
        { id: "s2", type: "ir:service_call", symbol: "InventoryService::reserve", role: "service" },
        { id: "s3", type: "ir:service_call", symbol: "PaymentService::charge", role: "service" },
        { id: "s4", type: "ir:service_call", symbol: "OrderService::create", role: "service" },
        { id: "s5", type: "ir:service_call", symbol: "NotificationService::send", role: "service" },
      ],
      edges: [
        { from: "mw_0", to: "ctrl", relation: "next_middleware", traceability: "static" },
        { from: "ctrl", to: "s1",   relation: "calls", traceability: "semantic" },
        { from: "ctrl", to: "s2",   relation: "calls", traceability: "semantic" },
        { from: "ctrl", to: "s3",   relation: "calls", traceability: "semantic" },
        { from: "ctrl", to: "s4",   relation: "calls", traceability: "semantic" },
        { from: "ctrl", to: "s5",   relation: "calls", traceability: "semantic" },
      ],
    })
    const facts = extractFacts(graph)
    const findings = detect(facts, graph)
    expect(findings.some(f => f.type === "fat_controller")).toBe(true)
  })

  it("returns missing_authorization via detect() for POST with auth but no authz", () => {
    const graph = nestjsGraph({
      method: "PUT",
      path: "/users/:id",
      nodes: [
        { id: "mw_0", type: "ir:auth_gate", symbol: "JwtAuthGuard", role: "authentication" },
        { id: "ctrl", type: "ir:business_handler", symbol: "UserController::update", role: "handler" },
      ],
      edges: [{ from: "mw_0", to: "ctrl", relation: "next_middleware", traceability: "static" }],
    })
    const facts = extractFacts(graph)
    const findings = detect(facts, graph)
    expect(findings.some(f => f.type === "missing_authorization")).toBe(true)
  })
})
