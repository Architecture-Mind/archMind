import type { OtelSpan, TraceSession, CorrelatedSession } from "@kidkender/archmind-protocol"
import { detectNPlusOne } from "../detectors/n-plus-one.js"

const makeSpan = (overrides: Partial<OtelSpan>): OtelSpan => ({
  traceId:           "t1",
  spanId:            "s1",
  name:              "db.query",
  kind:              3,
  startTimeUnixNano: "1000000000",
  endTimeUnixNano:   "1010000000",
  attributes:        {},
  ...overrides,
})

function makeCorrelated(infraSpans: OtelSpan[]): CorrelatedSession {
  const session: TraceSession = {
    sessionId:  "t1",
    entrypoint: "GET /tasks",
    durationMs: 500,
    spans:      [],
    recordedAt: new Date().toISOString(),
  }
  return {
    session,
    correlations:    [],
    correlationRate: 1.0,
    infraSpans,
  }
}

describe("detectNPlusOne", () => {
  test("detects N+1 when same table queried >= threshold times under same parent", () => {
    const spans = Array.from({ length: 10 }, (_, i) =>
      makeSpan({
        spanId:       `db${i}`,
        parentSpanId: "ctrl",
        attributes: {
          "db.system":    "mysql",
          "db.statement": "SELECT * FROM tasks WHERE id = ?",
        },
      }),
    )
    const session = makeCorrelated(spans)
    const findings = detectNPlusOne(session, 5)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.type).toBe("n_plus_one")
    expect(findings[0]!.count).toBe(10)
    expect(findings[0]!.metadata?.["table"]).toBe("tasks")
  })

  test("no finding when count < threshold", () => {
    const spans = Array.from({ length: 3 }, (_, i) =>
      makeSpan({
        spanId:       `db${i}`,
        parentSpanId: "ctrl",
        attributes: {
          "db.system":    "mysql",
          "db.statement": "SELECT * FROM tasks WHERE id = ?",
        },
      }),
    )
    const findings = detectNPlusOne(makeCorrelated(spans), 5)
    expect(findings).toHaveLength(0)
  })

  test("groups by table — two tables with N+1 each produce two findings", () => {
    const taskSpans = Array.from({ length: 6 }, (_, i) =>
      makeSpan({
        spanId:       `task${i}`,
        parentSpanId: "ctrl",
        attributes: { "db.statement": "SELECT * FROM tasks WHERE id = ?" },
      }),
    )
    const commentSpans = Array.from({ length: 7 }, (_, i) =>
      makeSpan({
        spanId:       `comment${i}`,
        parentSpanId: "ctrl",
        attributes: { "db.statement": "SELECT * FROM comments WHERE task_id = ?" },
      }),
    )
    const findings = detectNPlusOne(makeCorrelated([...taskSpans, ...commentSpans]), 5)
    expect(findings).toHaveLength(2)
    const tables = findings.map(f => f.metadata?.["table"]).sort()
    expect(tables).toEqual(["comments", "tasks"])
  })

  test("different parents are grouped separately", () => {
    const ctrl1Spans = Array.from({ length: 6 }, (_, i) =>
      makeSpan({
        spanId:       `c1-db${i}`,
        parentSpanId: "ctrl1",
        attributes: { "db.statement": "SELECT * FROM tasks WHERE id = ?" },
      }),
    )
    const ctrl2Spans = Array.from({ length: 3 }, (_, i) =>
      makeSpan({
        spanId:       `c2-db${i}`,
        parentSpanId: "ctrl2",
        attributes: { "db.statement": "SELECT * FROM tasks WHERE id = ?" },
      }),
    )
    const findings = detectNPlusOne(makeCorrelated([...ctrl1Spans, ...ctrl2Spans]), 5)
    // Only ctrl1 exceeds threshold
    expect(findings).toHaveLength(1)
    expect(findings[0]!.metadata?.["parentSpanId"]).toBe("ctrl1")
  })

  test("severity is high when count >= 10", () => {
    const spans = Array.from({ length: 15 }, (_, i) =>
      makeSpan({
        spanId:       `db${i}`,
        parentSpanId: "ctrl",
        attributes: { "db.statement": "SELECT * FROM tasks WHERE id = ?" },
      }),
    )
    const findings = detectNPlusOne(makeCorrelated(spans), 5)
    expect(findings[0]!.severity).toBe("high")
  })

  test("severity is medium when count < 10 but >= threshold", () => {
    const spans = Array.from({ length: 7 }, (_, i) =>
      makeSpan({
        spanId:       `db${i}`,
        parentSpanId: "ctrl",
        attributes: { "db.statement": "SELECT * FROM tasks WHERE id = ?" },
      }),
    )
    const findings = detectNPlusOne(makeCorrelated(spans), 5)
    expect(findings[0]!.severity).toBe("medium")
  })

  test("spans without db.statement are skipped", () => {
    const spans = Array.from({ length: 10 }, (_, i) =>
      makeSpan({ spanId: `db${i}`, parentSpanId: "ctrl", attributes: { "db.system": "mysql" } }),
    )
    const findings = detectNPlusOne(makeCorrelated(spans), 5)
    expect(findings).toHaveLength(0)
  })
})
