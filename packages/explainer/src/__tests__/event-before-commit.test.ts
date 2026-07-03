import { describe, test, expect } from "@jest/globals"
import { detectEventBeforeCommit } from "../pattern-detectors/event-before-commit.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

function makeGraph(overrides: Partial<IntermediateExecutionGraph> = {}): IntermediateExecutionGraph {
  return {
    entrypoint: "POST /tasks",
    method: "POST",
    path: "/tasks",
    nodes: [],
    edges: [],
    annotations: [],
    ...overrides,
  }
}

const TXN_GRAPH: IntermediateExecutionGraph = makeGraph({
  nodes: [
    { id: "ctrl",    type: "controller_action",  symbol: "TaskController::store",  role: "handler" },
    { id: "txn",     type: "transaction_boundary", symbol: "DB::transaction",       role: "atomicity" },
    { id: "write",   type: "transactional_write",  symbol: "Task::create",          role: "persistence" },
    { id: "escape",  type: "transaction_escape",   symbol: "TaskCreated::dispatch", role: "side_effect" },
  ],
  edges: [
    { from: "ctrl",   to: "txn",    relation: "opens_transaction",  traceability: "static" },
    { from: "txn",    to: "write",  relation: "within_transaction",  traceability: "static" },
    { from: "txn",    to: "escape", relation: "within_transaction",  traceability: "static" },
    { from: "escape", to: "txn",   relation: "escapes_transaction", traceability: "static" },
  ],
})

describe("detectEventBeforeCommit", () => {
  test("detects one finding for single escape", () => {
    const findings = detectEventBeforeCommit([], TXN_GRAPH)
    expect(findings).toHaveLength(1)
  })

  test("finding type is event_before_commit", () => {
    const findings = detectEventBeforeCommit([], TXN_GRAPH)
    expect(findings[0]!.type).toBe("event_before_commit")
  })

  test("severity is HIGH", () => {
    const findings = detectEventBeforeCommit([], TXN_GRAPH)
    expect(findings[0]!.severity).toBe("HIGH")
  })

  test("confidence is HIGH", () => {
    const findings = detectEventBeforeCommit([], TXN_GRAPH)
    expect(findings[0]!.confidence).toBe("HIGH")
  })

  test("supporting_nodes includes transaction and escape", () => {
    const findings = detectEventBeforeCommit([], TXN_GRAPH)
    const nodes = findings[0]!.provenance.supporting_nodes
    expect(nodes).toContain("txn")
    expect(nodes).toContain("escape")
  })

  test("summary mentions escaped symbol", () => {
    const findings = detectEventBeforeCommit([], TXN_GRAPH)
    expect(findings[0]!.summary).toContain("TaskCreated::dispatch")
  })

  test("recommendations include ShouldHandleEventsAfterCommit", () => {
    const findings = detectEventBeforeCommit([], TXN_GRAPH)
    const recs = findings[0]!.recommendations ?? []
    expect(recs.some((r) => r.includes("ShouldHandleEventsAfterCommit"))).toBe(true)
  })

  test("no findings when no transaction_escape nodes present", () => {
    const graph = makeGraph({
      nodes: [
        { id: "txn",   type: "transaction_boundary", symbol: "DB::transaction", role: "atomicity" },
        { id: "write", type: "transactional_write",  symbol: "Task::create",    role: "persistence" },
      ],
      edges: [
        { from: "txn", to: "write", relation: "within_transaction", traceability: "static" },
      ],
    })
    const findings = detectEventBeforeCommit([], graph)
    expect(findings).toHaveLength(0)
  })

  test("no findings when escapes_transaction edge is missing", () => {
    const graph = makeGraph({
      nodes: [
        { id: "txn",    type: "transaction_boundary", symbol: "DB::transaction",       role: "atomicity" },
        { id: "escape", type: "transaction_escape",   symbol: "TaskCreated::dispatch", role: "side_effect" },
      ],
      edges: [
        { from: "txn", to: "escape", relation: "within_transaction", traceability: "static" },
        // missing: escapes_transaction edge from escape → txn
      ],
    })
    const findings = detectEventBeforeCommit([], graph)
    expect(findings).toHaveLength(0)
  })

  test("detects multiple escapes in same transaction as separate findings", () => {
    const graph = makeGraph({
      nodes: [
        { id: "txn",     type: "transaction_boundary", symbol: "DB::transaction",          role: "atomicity" },
        { id: "escape1", type: "transaction_escape",   symbol: "TaskCreated::dispatch",     role: "side_effect" },
        { id: "escape2", type: "transaction_escape",   symbol: "ProcessReport::dispatch",   role: "side_effect" },
      ],
      edges: [
        { from: "txn",     to: "escape1", relation: "within_transaction",  traceability: "static" },
        { from: "escape1", to: "txn",     relation: "escapes_transaction", traceability: "static" },
        { from: "txn",     to: "escape2", relation: "within_transaction",  traceability: "static" },
        { from: "escape2", to: "txn",     relation: "escapes_transaction", traceability: "static" },
      ],
    })
    const findings = detectEventBeforeCommit([], graph)
    expect(findings).toHaveLength(2)
  })

  test("finding id is stable across calls", () => {
    const id1 = detectEventBeforeCommit([], TXN_GRAPH)[0]!.id
    const id2 = detectEventBeforeCommit([], TXN_GRAPH)[0]!.id
    expect(id1).toBe(id2)
  })

  test("empty graph returns no findings", () => {
    expect(detectEventBeforeCommit([], makeGraph())).toHaveLength(0)
  })
})
