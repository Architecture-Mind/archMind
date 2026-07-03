import type { TraceSession, IntermediateExecutionGraph, OtelSpan } from "@kidkender/archmind-protocol"
import { correlateSession, spansForNode, infraUnderNode } from "../correlate.js"

const makeSpan = (overrides: Partial<OtelSpan>): OtelSpan => ({
  traceId:           "t1",
  spanId:            "s1",
  name:              "test",
  kind:              1,
  startTimeUnixNano: "1000000000",
  endTimeUnixNano:   "2000000000",
  attributes:        {},
  ...overrides,
})

const GRAPH: IntermediateExecutionGraph = {
  entrypoint: "PUT /tasks/{id}",
  method:     "PUT",
  path:       "/tasks/{id}",
  nodes: [
    { id: "ctrl", type: "controller", symbol: "TaskController::update" },
    { id: "mw1",  type: "middleware", symbol: "CheckPermission::handle" },
    { id: "svc",  type: "service_call", symbol: "PermissionService::hasPermission" },
  ],
  edges:       [],
  annotations: [],
}

function makeSession(spans: OtelSpan[]): TraceSession {
  return {
    sessionId:  "t1",
    entrypoint: "PUT /tasks/{id}",
    durationMs: 200,
    spans,
    recordedAt: new Date().toISOString(),
  }
}

describe("correlateSession", () => {
  test("exact_symbol strategy matches span.name === node.symbol", () => {
    const spans = [
      makeSpan({ name: "PUT /tasks/{id}", attributes: { "http.route": "PUT /tasks/{id}" } }),
      makeSpan({ spanId: "s2", name: "TaskController::update", parentSpanId: "s1" }),
    ]
    const session = makeSession(spans)
    const result = correlateSession(session, GRAPH)

    const ctrl = result.correlations.find(c => c.span.spanId === "s2")!
    expect(ctrl.nodeId).toBe("ctrl")
    expect(ctrl.strategy).toBe("exact_symbol")
    expect(ctrl.confidence).toBe("exact")
  })

  test("namespace_function strategy from code.namespace + code.function", () => {
    const spans = [
      makeSpan({ name: "PUT /tasks/{id}", attributes: { "http.route": "PUT /tasks/{id}" } }),
      makeSpan({
        spanId:       "s2",
        name:         "middleware: CheckPermission",
        parentSpanId: "s1",
        attributes: {
          "code.namespace": "App\\Http\\Middleware\\CheckPermission",
          "code.function":  "handle",
        },
      }),
    ]
    const result = correlateSession(makeSession(spans), GRAPH)
    const mw = result.correlations.find(c => c.span.spanId === "s2")!
    expect(mw.nodeId).toBe("mw1")
    expect(mw.strategy).toBe("namespace_function")
  })

  test("middleware_name strategy from middleware.name attribute", () => {
    const spans = [
      makeSpan({ name: "PUT /tasks/{id}", attributes: { "http.route": "PUT /tasks/{id}" } }),
      makeSpan({
        spanId:       "s2",
        name:         "middleware: CheckPermission",
        parentSpanId: "s1",
        attributes:   { "middleware.name": "CheckPermission" },
      }),
    ]
    const result = correlateSession(makeSession(spans), GRAPH)
    const mw = result.correlations.find(c => c.span.spanId === "s2")!
    expect(mw.nodeId).toBe("mw1")
    expect(mw.strategy).toBe("middleware_name")
  })

  test("unmatched span gets confidence=none and nodeId=null", () => {
    const spans = [
      makeSpan({ name: "PUT /tasks/{id}", attributes: { "http.route": "PUT /tasks/{id}" } }),
      makeSpan({ spanId: "s2", name: "UnknownService::doSomething", parentSpanId: "s1" }),
    ]
    const result = correlateSession(makeSession(spans), GRAPH)
    const unknown = result.correlations.find(c => c.span.spanId === "s2")!
    expect(unknown.nodeId).toBeNull()
    expect(unknown.confidence).toBe("none")
  })

  test("db.query spans go into infraSpans not correlations", () => {
    const spans = [
      makeSpan({ name: "PUT /tasks/{id}", attributes: { "http.route": "PUT /tasks/{id}" } }),
      makeSpan({ spanId: "db1", name: "db.query", parentSpanId: "s1" }),
    ]
    const result = correlateSession(makeSession(spans), GRAPH)
    expect(result.correlations).toHaveLength(0)
    expect(result.infraSpans).toHaveLength(1)
  })

  test("correlationRate is 1.0 when all candidates matched", () => {
    const spans = [
      makeSpan({ name: "PUT /tasks/{id}", attributes: { "http.route": "PUT /tasks/{id}" } }),
      makeSpan({ spanId: "s2", name: "TaskController::update", parentSpanId: "s1" }),
    ]
    const result = correlateSession(makeSession(spans), GRAPH)
    expect(result.correlationRate).toBe(1.0)
  })
})

describe("spansForNode", () => {
  test("returns spans matched to a specific nodeId", () => {
    const spans = [
      makeSpan({ name: "PUT /tasks/{id}", attributes: { "http.route": "PUT /tasks/{id}" } }),
      makeSpan({ spanId: "s2", name: "TaskController::update", parentSpanId: "s1" }),
      makeSpan({ spanId: "s3", name: "PermissionService::hasPermission", parentSpanId: "s2" }),
    ]
    const result = correlateSession(makeSession(spans), GRAPH)
    const ctrlSpans = spansForNode(result, "ctrl")
    expect(ctrlSpans.map(s => s.spanId)).toEqual(["s2"])
  })
})

describe("infraUnderNode", () => {
  test("returns infra spans whose parent is a span matched to the node", () => {
    const spans = [
      makeSpan({ name: "PUT /tasks/{id}", attributes: { "http.route": "PUT /tasks/{id}" } }),
      makeSpan({ spanId: "s2", name: "TaskController::update", parentSpanId: "s1" }),
      makeSpan({ spanId: "db1", name: "db.query", parentSpanId: "s2" }),
    ]
    const result = correlateSession(makeSession(spans), GRAPH)
    const infra = infraUnderNode(result, "ctrl")
    expect(infra.map(s => s.spanId)).toEqual(["db1"])
  })
})
