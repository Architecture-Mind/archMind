import { describe, test, expect } from "@jest/globals"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { Finding } from "@kidkender/archmind-explainer"
import { buildPrompt } from "../build-prompt.js"

const GRAPH: IntermediateExecutionGraph = {
  entrypoint: "PUT /tasks/{task}",
  method: "PUT",
  path: "/tasks/{task}",
  annotations: [],
  nodes: [
    { id: "mw_2", type: "authorization_check", symbol: "CheckPermission::handle", role: "authorization" },
    { id: "ctrl", type: "controller_action",   symbol: "TaskController::update",  role: "handler" },
    { id: "pol",  type: "policy",              symbol: "TaskPolicy::update",      role: "authorization" },
  ],
  edges: [
    { from: "mw_2", to: "ctrl", relation: "next_middleware", traceability: "static" },
    { from: "ctrl", to: "pol",  relation: "policy_check",    traceability: "semantic" },
  ],
}

const FINDING: Finding = {
  id: "dup-auth-001",
  type: "duplicate_authorization",
  severity: "CRITICAL",
  confidence: "HIGH",
  provenance: {
    detector: "duplicate-authorization",
    ontology_primitives: ["ExecutionOverlap"],
    supporting_nodes: ["mw_2", "pol"],
    supporting_edges: [],
  },
  summary: "CheckPermission and TaskPolicy both check the same permission",
  reasoning: [],
  evidence: [],
  recommendations: ["Remove middleware check"],
}

describe("buildPrompt", () => {
  test("returns an object with system, user, and output_instructions fields", () => {
    const p = buildPrompt({ query: "Why is permission checked twice?", graph: GRAPH, findings: [FINDING] })
    expect(p).toHaveProperty("system")
    expect(p).toHaveProperty("user")
    expect(p).toHaveProperty("output_instructions")
  })

  test("user block contains the query", () => {
    const p = buildPrompt({ query: "Why is permission checked twice?", graph: GRAPH, findings: [FINDING] })
    expect(p.user).toContain("Why is permission checked twice?")
  })

  test("user block contains execution path section", () => {
    const p = buildPrompt({ query: "Why is permission checked twice?", graph: GRAPH, findings: [FINDING] })
    expect(p.user).toContain("Execution path")
  })

  test("user block contains semantic findings section", () => {
    const p = buildPrompt({ query: "Why is permission checked twice?", graph: GRAPH, findings: [FINDING] })
    expect(p.user).toContain("Semantic findings")
  })

  test("system block mentions semantic reasoning constraint", () => {
    const p = buildPrompt({ query: "q", graph: GRAPH, findings: [] })
    expect(p.system.toLowerCase()).toContain("only")
  })

  test("output_instructions references the JSON schema fields", () => {
    const p = buildPrompt({ query: "q", graph: GRAPH, findings: [FINDING] })
    expect(p.output_instructions).toContain("finding_type")
    expect(p.output_instructions).toContain("explanation")
    expect(p.output_instructions).toContain("recommendations")
  })

  test("combined toString includes all sections in order", () => {
    const p = buildPrompt({ query: "Why?", graph: GRAPH, findings: [FINDING] })
    const full = p.system + p.user + p.output_instructions
    const systemPos  = full.indexOf(p.system)
    const userPos    = full.indexOf("Why?")
    const outputPos  = full.indexOf("finding_type")
    expect(systemPos).toBeLessThan(userPos)
    expect(userPos).toBeLessThan(outputPos)
  })

  test("no findings → findings section is omitted from user block", () => {
    const p = buildPrompt({ query: "q", graph: GRAPH, findings: [] })
    expect(p.user).not.toContain("Semantic findings")
  })

  test("finding with uncertainty → uncertainty block is included", () => {
    const findingWithUncertainty: Finding = {
      ...FINDING,
      uncertainty: [{ kind: "unverifiable_condition", description: "may diverge at runtime" }],
    }
    const p = buildPrompt({ query: "q", graph: GRAPH, findings: [findingWithUncertainty] })
    expect(p.user).toContain("Uncertainty")
  })
})
