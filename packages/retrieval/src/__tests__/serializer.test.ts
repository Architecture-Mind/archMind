import { retrieve, prune, serialize } from "../index.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const AUGMENTED_GRAPH: IntermediateExecutionGraph = {
  entrypoint: "PUT /tasks/{task}",
  method:     "PUT",
  path:       "/tasks/{task}",
  nodes: [
    { id: "mw_0",   type: "ir:auth_gate",        symbol: "auth:sanctum",                 role: "authentication" },
    { id: "mw_1",   type: "ir:auth_gate",        symbol: "ResolveTenant::handle",        role: "middleware" },
    { id: "mw_2",   type: "ir:authz_check",      symbol: "CheckPermission::handle",      role: "authorization", args: ["task.update"] },
    { id: "ctrl",   type: "ir:business_handler", symbol: "TaskController::update",       role: "handler" },
    { id: "fr",     type: "ir:validation_gate",  symbol: "UpdateTaskRequest::authorize", role: "validation" },
    { id: "policy", type: "ir:authz_check",      symbol: "TaskPolicy::update",           role: "authorization" },
  ],
  edges: [
    { from: "mw_0", to: "mw_1",   relation: "next_middleware", traceability: "static" },
    { from: "mw_1", to: "mw_2",   relation: "next_middleware", traceability: "static" },
    { from: "mw_2", to: "ctrl",   relation: "next_middleware", traceability: "static" },
    { from: "ctrl", to: "fr",     relation: "form_request",    traceability: "static" },
    { from: "ctrl", to: "policy", relation: "policy_check",    traceability: "semantic", mechanism: "$this->authorize('update', $task)" },
  ],
  annotations: [],
}

describe("serialize — full R0 result", () => {
  let output: string

  beforeAll(() => {
    const result = retrieve({ entrypoint: "PUT /tasks/{task}" }, [AUGMENTED_GRAPH])!
    output = serialize(result)
  })

  test("contains entrypoint header", () => {
    expect(output).toMatch(/Execution flow for PUT \/tasks\/\{task\}/)
  })

  test("contains MIDDLEWARE CHAIN section", () => {
    expect(output).toMatch(/\[MIDDLEWARE CHAIN\]/)
    expect(output).toMatch(/auth:sanctum/)
    expect(output).toMatch(/CheckPermission::handle/)
  })

  test("contains HANDLER section", () => {
    expect(output).toMatch(/\[HANDLER\]/)
    expect(output).toMatch(/TaskController::update/)
  })

  test("contains VALIDATION section", () => {
    expect(output).toMatch(/\[VALIDATION\]/)
    expect(output).toMatch(/UpdateTaskRequest::authorize/)
  })

  test("contains AUTHORIZATION section", () => {
    expect(output).toMatch(/\[AUTHORIZATION\]/)
    expect(output).toMatch(/TaskPolicy::update/)
  })

  test("shows args for CheckPermission", () => {
    expect(output).toMatch(/task\.update/)
  })

  test("shows notable edges (policy_check with mechanism)", () => {
    expect(output).toMatch(/\[CONNECTIONS\]/)
    expect(output).toMatch(/policy_check/)
    expect(output).toMatch(/\$this->authorize/)
  })

  test("ends with token estimate", () => {
    expect(output).toMatch(/~\d+ tokens/)
  })
})

describe("serialize — pruned result", () => {
  test("shows pruned notice when result is pruned", () => {
    const r0     = retrieve({ entrypoint: "PUT /tasks/{task}" }, [AUGMENTED_GRAPH])!
    const pruned = prune(r0, "HIGH")
    const output = serialize(pruned)
    expect(output).toMatch(/pruned/)
  })

  test("does not contain MEDIUM nodes after HIGH prune", () => {
    const r0     = retrieve({ entrypoint: "PUT /tasks/{task}" }, [AUGMENTED_GRAPH])!
    const pruned = prune(r0, "HIGH")
    const output = serialize(pruned)
    // ir:business_handler is MEDIUM — pruned at HIGH threshold
    expect(output).not.toMatch(/TaskController::update/)
    // ir:validation_gate is HIGH — present after HIGH prune
    expect(output).toMatch(/UpdateTaskRequest/)
  })
})

describe("retrieve with focus", () => {
  test("focus:auth returns pruned result", () => {
    const result = retrieve({ entrypoint: "PUT /tasks/{task}", focus: "auth" }, [AUGMENTED_GRAPH])!
    expect(result.pruned).toBe(true)
    const types = result.nodes.map((n) => n.type)
    expect(types).toContain("ir:authz_check")
    expect(types).toContain("ir:validation_gate")  // validation_gate is HIGH — kept at auth focus
    expect(types).not.toContain("ir:business_handler") // business_handler is MEDIUM — pruned
  })

  test("focus:all returns unpruned result", () => {
    const result = retrieve({ entrypoint: "PUT /tasks/{task}", focus: "all" }, [AUGMENTED_GRAPH])!
    expect(result.pruned).toBe(false)
    expect(result.nodes).toHaveLength(6)
  })

  test("focus:auth has fewer tokens than focus:all", () => {
    const auth = retrieve({ entrypoint: "PUT /tasks/{task}", focus: "auth" }, [AUGMENTED_GRAPH])!
    const all  = retrieve({ entrypoint: "PUT /tasks/{task}", focus: "all"  }, [AUGMENTED_GRAPH])!
    expect(auth.token_estimate).toBeLessThan(all.token_estimate)
  })
})
