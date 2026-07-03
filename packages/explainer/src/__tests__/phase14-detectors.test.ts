import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { detectFatController } from "../pattern-detectors/fat-controller.js"
import { detectExposedReadEndpoint } from "../pattern-detectors/exposed-read-endpoint.js"
import { detectOverAuthorizedRoute } from "../pattern-detectors/over-authorized-route.js"

function baseGraph(overrides: Partial<IntermediateExecutionGraph> = {}): IntermediateExecutionGraph {
  return {
    entrypoint: "GET /test",
    method: "GET",
    path: "/test",
    framework: "laravel",
    adapter_ver: "0.1.0",
    ir_ver: "1.1",
    nodes: [],
    edges: [],
    annotations: [],
    ...overrides,
  }
}

// ---- fat_controller --------------------------------------------------------

describe("detectFatController", () => {
  it("returns empty for controller with < 5 services", () => {
    const graph = baseGraph({
      method: "POST",
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "OrderController::store" },
        { id: "svc1", type: "ir:service_call", symbol: "InventoryService::check" },
        { id: "svc2", type: "ir:service_call", symbol: "PaymentService::charge" },
      ],
      edges: [],
    })
    expect(detectFatController(graph)).toHaveLength(0)
  })

  it("fires when controller has 5+ distinct service classes", () => {
    const graph = baseGraph({
      method: "POST",
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "OrderController::store" },
        { id: "s1", type: "ir:service_call", symbol: "InventoryService::check" },
        { id: "s2", type: "ir:service_call", symbol: "PaymentService::charge" },
        { id: "s3", type: "ir:service_call", symbol: "NotificationService::send" },
        { id: "s4", type: "ir:service_call", symbol: "AuditService::log" },
        { id: "s5", type: "ir:service_call", symbol: "ShippingService::calculate" },
      ],
      edges: [],
    })
    const findings = detectFatController(graph)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("fat_controller")
    expect(findings[0].severity).toBe("LOW")
  })

  it("deduplicates by class name — multiple calls to same service don't inflate count", () => {
    const graph = baseGraph({
      method: "POST",
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::action" },
        { id: "s1", type: "ir:service_call", symbol: "OrderService::create" },
        { id: "s2", type: "ir:service_call", symbol: "OrderService::update" },
        { id: "s3", type: "ir:service_call", symbol: "OrderService::notify" },
        { id: "s4", type: "ir:service_call", symbol: "OrderService::cancel" },
        { id: "s5", type: "ir:service_call", symbol: "OrderService::log" },
      ],
      edges: [],
    })
    // 5 calls but only 1 distinct class → no fat controller
    expect(detectFatController(graph)).toHaveLength(0)
  })
})

// ---- exposed_read_endpoint -------------------------------------------------

describe("detectExposedReadEndpoint", () => {
  it("fires for GET route with service calls and no auth", () => {
    const graph = baseGraph({
      method: "GET",
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "ProductController::index" },
        { id: "svc", type: "ir:service_call", symbol: "ProductService::list" },
      ],
    })
    const findings = detectExposedReadEndpoint(graph)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("exposed_read_endpoint")
    expect(findings[0].severity).toBe("MEDIUM")
  })

  it("does not fire for GET route that has auth:sanctum", () => {
    const graph = baseGraph({
      method: "GET",
      nodes: [
        { id: "mw", type: "ir:auth_gate", symbol: "auth:sanctum" },
        { id: "ctrl", type: "ir:business_handler", symbol: "ProductController::show" },
        { id: "svc", type: "ir:service_call", symbol: "ProductService::find" },
      ],
    })
    expect(detectExposedReadEndpoint(graph)).toHaveLength(0)
  })

  it("does not fire for POST routes", () => {
    const graph = baseGraph({
      method: "POST",
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "ProductController::store" },
        { id: "svc", type: "ir:service_call", symbol: "ProductService::create" },
      ],
    })
    expect(detectExposedReadEndpoint(graph)).toHaveLength(0)
  })

  it("does not fire for GET route with no service calls (purely static)", () => {
    const graph = baseGraph({
      method: "GET",
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "HomeController::index" },
      ],
    })
    expect(detectExposedReadEndpoint(graph)).toHaveLength(0)
  })

  it("fires for GET route with ir:resource node and no auth", () => {
    const graph = baseGraph({
      method: "GET",
      nodes: [
        { id: "ctrl", type: "ir:business_handler", symbol: "ProductController::show" },
        { id: "res", type: "ir:resource", symbol: "Product", role: "accessed_resource" },
      ],
    })
    expect(detectExposedReadEndpoint(graph)).toHaveLength(1)
  })
})

// ---- over_authorized_route -------------------------------------------------

describe("detectOverAuthorizedRoute", () => {
  it("does not fire for route with only 2 auth layers", () => {
    const graph = baseGraph({
      method: "PUT",
      nodes: [
        { id: "mw", type: "ir:auth_gate", symbol: "auth:sanctum" },
        { id: "ctrl", type: "ir:business_handler", symbol: "TaskController::update" },
        { id: "policy", type: "ir:authz_check", symbol: "TaskPolicy::update" },
      ],
    })
    expect(detectOverAuthorizedRoute(graph)).toHaveLength(0)
  })

  it("fires for route with 3 auth layers (middleware + policy + form_request)", () => {
    const graph = baseGraph({
      method: "PUT",
      nodes: [
        { id: "mw", type: "ir:auth_gate", symbol: "auth:sanctum" },
        { id: "ctrl", type: "ir:business_handler", symbol: "TaskController::update" },
        { id: "policy", type: "ir:authz_check", symbol: "TaskPolicy::update" },
        { id: "fr", type: "ir:validation_gate", symbol: "UpdateTaskRequest::authorize" },
      ],
    })
    const findings = detectOverAuthorizedRoute(graph)
    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe("over_authorized_route")
    expect(findings[0].severity).toBe("INFO")
  })

  it("summary mentions all 3 layers", () => {
    const graph = baseGraph({
      method: "PUT",
      nodes: [
        { id: "mw", type: "ir:auth_gate", symbol: "auth:sanctum" },
        { id: "ctrl", type: "ir:business_handler", symbol: "TaskController::update" },
        { id: "policy", type: "ir:authz_check", symbol: "TaskPolicy::update" },
        { id: "fr", type: "ir:validation_gate", symbol: "UpdateTaskRequest::authorize" },
      ],
    })
    const findings = detectOverAuthorizedRoute(graph)
    expect(findings[0].summary).toContain("3 separate layers")
  })
})
