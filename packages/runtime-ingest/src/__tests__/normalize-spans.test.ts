import type { OtelSpan } from "@kidkender/archmind-protocol"
import {
  isInfraSpan,
  isRootSpan,
  extractEntrypoint,
  computeDurationMs,
  partitionSpans,
  normalizeAttributes,
} from "../normalize-spans.js"

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

describe("isInfraSpan", () => {
  test.each([
    ["db.query",       true],
    ["redis.get",      true],
    ["queue.dispatch", true],
    ["cache.get",      true],
    ["aws.s3.get",     true],
    ["TaskController::update", false],
    ["middleware: CheckPermission", false],
  ])("%s → %s", (name, expected) => {
    expect(isInfraSpan(makeSpan({ name }))).toBe(expected)
  })
})

describe("isRootSpan", () => {
  test("no parentSpanId → root", () => {
    expect(isRootSpan(makeSpan({}))).toBe(true)
  })
  test("has parentSpanId → not root", () => {
    expect(isRootSpan(makeSpan({ parentSpanId: "parent1" }))).toBe(false)
  })
})

describe("extractEntrypoint", () => {
  test("returns http.route from root span", () => {
    const spans = [
      makeSpan({ attributes: { "http.route": "PUT /tasks/{id}" } }),
    ]
    expect(extractEntrypoint(spans)).toBe("PUT /tasks/{id}")
  })

  test("falls back to span name if no http.route", () => {
    const spans = [makeSpan({ name: "GET /users" })]
    expect(extractEntrypoint(spans)).toBe("GET /users")
  })

  test("returns unknown when no spans", () => {
    expect(extractEntrypoint([])).toBe("unknown")
  })
})

describe("computeDurationMs", () => {
  test("computes duration from root span", () => {
    const spans = [
      makeSpan({ startTimeUnixNano: "0", endTimeUnixNano: "500000000" }),
    ]
    expect(computeDurationMs(spans)).toBe(500)
  })
})

describe("normalizeAttributes", () => {
  test("derives http.route from span name for HTTP spans", () => {
    const spans = [makeSpan({ name: "GET /users/{id}", attributes: {} })]
    const result = normalizeAttributes(spans)
    expect(result[0]!.attributes["http.route"]).toBe("GET /users/{id}")
  })

  test("does not override existing http.route", () => {
    const spans = [makeSpan({ name: "GET /other", attributes: { "http.route": "GET /users/{id}" } })]
    const result = normalizeAttributes(spans)
    expect(result[0]!.attributes["http.route"]).toBe("GET /users/{id}")
  })

  test("does not modify original span (immutable)", () => {
    const original = makeSpan({ name: "GET /foo", attributes: {} })
    normalizeAttributes([original])
    expect(original.attributes["http.route"]).toBeUndefined()
  })
})

describe("partitionSpans", () => {
  test("partitions into root, candidates, and infra", () => {
    const spans = [
      makeSpan({ spanId: "root", name: "PUT /tasks/{id}" }),
      makeSpan({ spanId: "ctrl", name: "TaskController::update", parentSpanId: "root" }),
      makeSpan({ spanId: "db1",  name: "db.query", parentSpanId: "ctrl" }),
    ]
    const { root, candidates, infra } = partitionSpans(spans)
    expect(root?.spanId).toBe("root")
    expect(candidates.map(s => s.spanId)).toEqual(["ctrl"])
    expect(infra.map(s => s.spanId)).toEqual(["db1"])
  })
})
