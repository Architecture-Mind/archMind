import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { detectSensitiveFieldExposed } from "../pattern-detectors/sensitive-field-exposed.js"
import { detectSynchronousMail } from "../pattern-detectors/synchronous-mail.js"
import { detectApiResourceUnprotected } from "../pattern-detectors/api-resource-unprotected.js"

function base(overrides: Partial<IntermediateExecutionGraph> = {}): IntermediateExecutionGraph {
  return {
    entrypoint: "GET /test",
    method: "GET",
    path: "/test",
    framework: "laravel",
    adapter_ver: "0.1.0",
    ir_ver: "1.4",
    nodes: [],
    edges: [],
    annotations: [],
    ...overrides,
  }
}

// ---- sensitive_field_exposed ------------------------------------------------

describe("detectSensitiveFieldExposed", () => {
  it("returns empty when no api_resource nodes", () => {
    const g = base({ nodes: [{ id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::show" }] })
    expect(detectSensitiveFieldExposed(g)).toHaveLength(0)
  })

  it("returns empty when sensitiveFields is empty", () => {
    const g = base({
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::show" },
        { id: "res",  type: "ir:api_resource",     symbol: "UserResource::toArray",
          detail: JSON.stringify({ fields: ["id", "name"], sensitiveFields: [] }) },
      ],
    })
    expect(detectSensitiveFieldExposed(g)).toHaveLength(0)
  })

  it("fires when sensitiveFields is non-empty", () => {
    const g = base({
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "UserController::show" },
        { id: "res",  type: "ir:api_resource",     symbol: "UserResource::toArray",
          detail: JSON.stringify({ fields: ["id", "name", "token"], sensitiveFields: ["token"] }) },
      ],
      edges: [{ from: "ctrl", to: "res", relation: "ir:returns", traceability: "static" as const }],
    })
    const findings = detectSensitiveFieldExposed(g)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("sensitive_field_exposed")
    expect(findings[0].severity).toBe("HIGH")
    expect(findings[0].summary).toContain("token")
  })

  it("fires once per resource node with sensitive fields", () => {
    const g = base({
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::index" },
        { id: "r1",   type: "ir:api_resource",     symbol: "UserResource::toArray",
          detail: JSON.stringify({ sensitiveFields: ["password"] }) },
        { id: "r2",   type: "ir:api_resource",     symbol: "TokenResource::toArray",
          detail: JSON.stringify({ sensitiveFields: ["token", "secret"] }) },
      ],
      edges: [],
    })
    expect(detectSensitiveFieldExposed(g)).toHaveLength(2)
  })

  it("includes all sensitive field names in summary", () => {
    const g = base({
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::show" },
        { id: "res",  type: "ir:api_resource",     symbol: "OrderResource::toArray",
          detail: JSON.stringify({ sensitiveFields: ["api_key", "internal_notes"] }) },
      ],
      edges: [],
    })
    const f = detectSensitiveFieldExposed(g)[0]
    expect(f.summary).toContain("api_key")
    expect(f.summary).toContain("internal_notes")
  })
})

// ---- synchronous_mail -------------------------------------------------------

describe("detectSynchronousMail", () => {
  it("returns empty when no ir:mail nodes", () => {
    const g = base({ nodes: [{ id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::store" }] })
    expect(detectSynchronousMail(g)).toHaveLength(0)
  })

  it("returns empty when mail is queued", () => {
    const g = base({
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::store" },
        { id: "mail", type: "ir:mail",             symbol: "WelcomeMail::build",
          detail: JSON.stringify({ className: "WelcomeMail", queued: true }) },
      ],
    })
    expect(detectSynchronousMail(g)).toHaveLength(0)
  })

  it("fires when mail is synchronous (queued=false)", () => {
    const g = base({
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "OrderController::store" },
        { id: "mail", type: "ir:mail",             symbol: "OrderConfirmationMail::build",
          detail: JSON.stringify({ className: "OrderConfirmationMail", queued: false }) },
      ],
      edges: [{ from: "ctrl", to: "mail", relation: "ir:sends", traceability: "static" as const }],
    })
    const findings = detectSynchronousMail(g)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("synchronous_mail")
    expect(findings[0].severity).toBe("MEDIUM")
    expect(findings[0].summary).toContain("OrderConfirmationMail")
    expect(findings[0].summary).toContain("SMTP")
  })

  it("fires once per synchronous mail node", () => {
    const g = base({
      nodes: [
        { id: "ctrl",  type: "ir:business_handler", symbol: "Ctrl::store" },
        { id: "mail1", type: "ir:mail", symbol: "WelcomeMail::build",
          detail: JSON.stringify({ className: "WelcomeMail", queued: false }) },
        { id: "mail2", type: "ir:mail", symbol: "AdminAlertMail::build",
          detail: JSON.stringify({ className: "AdminAlertMail", queued: false }) },
      ],
      edges: [],
    })
    expect(detectSynchronousMail(g)).toHaveLength(2)
  })

  it("recommendations include queue() alternative", () => {
    const g = base({
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::store" },
        { id: "mail", type: "ir:mail", symbol: "WelcomeMail::build",
          detail: JSON.stringify({ className: "WelcomeMail", queued: false }) },
      ],
      edges: [],
    })
    const f = detectSynchronousMail(g)[0]
    expect(f.recommendations?.some((r) => r.includes("queue"))).toBe(true)
  })
})

// ---- api_resource_unprotected -----------------------------------------------

describe("detectApiResourceUnprotected", () => {
  it("returns empty when no api_resource nodes", () => {
    const g = base({ nodes: [{ id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::show" }] })
    expect(detectApiResourceUnprotected(g)).toHaveLength(0)
  })

  it("returns empty when auth_gate is present", () => {
    const g = base({
      nodes: [
        { id: "mw",   type: "ir:auth_gate",       symbol: "auth:sanctum" },
        { id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::show" },
        { id: "res",  type: "ir:api_resource",    symbol: "OrderResource::toArray",
          detail: JSON.stringify({ fields: ["id", "total"] }) },
      ],
      edges: [],
    })
    expect(detectApiResourceUnprotected(g)).toHaveLength(0)
  })

  it("returns empty when authz_check is present", () => {
    const g = base({
      nodes: [
        { id: "pol",  type: "ir:authz_check",      symbol: "OrderPolicy::view" },
        { id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::show" },
        { id: "res",  type: "ir:api_resource",     symbol: "OrderResource::toArray",
          detail: JSON.stringify({ fields: ["id"] }) },
      ],
      edges: [],
    })
    expect(detectApiResourceUnprotected(g)).toHaveLength(0)
  })

  it("fires when api_resource is returned with no auth", () => {
    const g = base({
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "OrderController::show" },
        { id: "res",  type: "ir:api_resource",     symbol: "OrderResource::toArray",
          detail: JSON.stringify({ fields: ["id", "status", "total"], sensitiveFields: [] }) },
      ],
      edges: [{ from: "ctrl", to: "res", relation: "ir:returns", traceability: "static" as const }],
    })
    const findings = detectApiResourceUnprotected(g)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("api_resource_unprotected")
    expect(findings[0].severity).toBe("HIGH")
    expect(findings[0].summary).toContain("OrderResource")
  })

  it("skips when service calls present on GET (exposed_read_endpoint already fires)", () => {
    const g = base({
      method: "GET",
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::show" },
        { id: "svc",  type: "ir:service_call",     symbol: "OrderService::find" },
        { id: "res",  type: "ir:api_resource",     symbol: "OrderResource::toArray",
          detail: JSON.stringify({ fields: ["id"] }) },
      ],
      edges: [],
    })
    expect(detectApiResourceUnprotected(g)).toHaveLength(0)
  })

  it("fires on POST with api_resource and no auth (not deduplicated by exposed_read_endpoint)", () => {
    const g = base({
      method: "POST",
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::store" },
        { id: "svc",  type: "ir:service_call",     symbol: "OrderService::create" },
        { id: "res",  type: "ir:api_resource",     symbol: "OrderResource::toArray",
          detail: JSON.stringify({ fields: ["id", "status"] }) },
      ],
      edges: [],
    })
    const findings = detectApiResourceUnprotected(g)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("api_resource_unprotected")
  })

  it("summary includes field count", () => {
    const g = base({
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::show" },
        { id: "res",  type: "ir:api_resource",     symbol: "UserResource::toArray",
          detail: JSON.stringify({ fields: ["id", "name", "email"], sensitiveFields: [] }) },
      ],
      edges: [],
    })
    const f = detectApiResourceUnprotected(g)[0]
    expect(f.summary).toContain("3 field(s)")
  })
})
