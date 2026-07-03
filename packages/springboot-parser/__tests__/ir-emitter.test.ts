import { emitGraph } from "../src/ir-emitter.js"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import type { SpringControllerMethod } from "../src/types.js"

function baseMethod(overrides: Partial<SpringControllerMethod> = {}): SpringControllerMethod {
  return {
    filePath:            "OrderController.java",
    className:           "OrderController",
    methodName:          "create",
    kind:                "http",
    httpMethod:          "POST",
    path:                "/orders",
    authAnnotations:     [],
    hasValidation:       false,
    validatedParamTypes: [],
    isTransactional:     false,
    readOnly:            false,
    serviceCalls:        [],
    dataAccessCalls:     [],
    eventPublications:   [],
    asyncCalls:          [],
    mailCalls:           [],
    messagingCalls:      [],
    methodLine:          1,
    ...overrides,
  }
}

describe("emitGraph — entrypoint descriptor", () => {
  test("populates graph.source with a framework-agnostic HTTP entrypoint descriptor", () => {
    const graph = emitGraph(baseMethod({ httpMethod: "POST", path: "/orders" }))
    expect(graph.source).toEqual({
      type:     "http",
      id:       "POST /orders",
      metadata: { method: "POST", path: "/orders" },
    })
  })
})

describe("emitGraph — auth annotation classification", () => {
  test("isAuthOnly annotation emits only an auth_gate node", () => {
    const graph = emitGraph(baseMethod({
      authAnnotations: [{ kind: "preAuthorize", expression: "isAuthenticated()", isAuthOnly: true }],
    }))
    const types = graph.nodes.map((n) => n.type)
    expect(types).toContain(IR_NODE_TYPES.AUTH_GATE)
    expect(types).not.toContain(IR_NODE_TYPES.AUTHZ_CHECK)
  })

  test("a role-based @PreAuthorize implies authentication — emits BOTH auth_gate and authz_check", () => {
    const graph = emitGraph(baseMethod({
      authAnnotations: [{ kind: "preAuthorize", expression: "hasRole('ADMIN')", isAuthOnly: false }],
    }))
    const types = graph.nodes.map((n) => n.type)
    expect(types).toContain(IR_NODE_TYPES.AUTH_GATE)
    expect(types).toContain(IR_NODE_TYPES.AUTHZ_CHECK)

    // auth_gate must guard the authz_check (authenticate before authorize)
    const authGate   = graph.nodes.find((n) => n.type === IR_NODE_TYPES.AUTH_GATE)!
    const authzCheck = graph.nodes.find((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)!
    expect(graph.edges).toContainEqual(
      expect.objectContaining({ from: authGate.id, to: authzCheck.id }),
    )
  })

  test("@Secured role check also implies authentication", () => {
    const graph = emitGraph(baseMethod({
      authAnnotations: [{ kind: "secured", expression: "ROLE_ADMIN", isAuthOnly: false }],
    }))
    const types = graph.nodes.map((n) => n.type)
    expect(types).toContain(IR_NODE_TYPES.AUTH_GATE)
    expect(types).toContain(IR_NODE_TYPES.AUTHZ_CHECK)
  })
})
