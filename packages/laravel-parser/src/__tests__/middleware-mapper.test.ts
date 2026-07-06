import { middlewareToNode } from "../middleware-mapper.js"

describe("middlewareToNode", () => {
  test("auth:sanctum → authentication_gate", () => {
    const node = middlewareToNode("auth:sanctum", 0)
    expect(node.type).toBe("ir:auth_gate")
    expect(node.role).toBe("authentication")
    expect(node.symbol).toBe("auth:sanctum")
    expect(node.id).toBe("mw_0_auth_sanctum")
  })

  test("auth:api → authentication_gate", () => {
    const node = middlewareToNode("auth:api", 0)
    expect(node.type).toBe("ir:auth_gate")
  })

  test("permission:task.update → authorization_check with args", () => {
    const node = middlewareToNode("permission:task.update", 2)
    expect(node.type).toBe("ir:authz_check")
    expect(node.role).toBe("authorization")
    expect(node.args).toEqual(["task.update"])
    expect(node.symbol).toBe("permission:task.update")
  })

  test("permission with pipe → multiple args", () => {
    const node = middlewareToNode("permission:task.view|task.update", 0)
    expect(node.args).toEqual(["task.view", "task.update"])
  })

  test("throttle:60,1 → rate_limiter", () => {
    const node = middlewareToNode("throttle:60,1", 0)
    expect(node.type).toBe("rate_limiter")
    expect(node.role).toBe("rate_limiting")
  })

  test("signed → signature_check", () => {
    const node = middlewareToNode("signed", 0)
    expect(node.type).toBe("signature_check")
    expect(node.role).toBe("authentication")
  })

  test("verified → email_verification", () => {
    const node = middlewareToNode("verified", 0)
    expect(node.type).toBe("email_verification")
  })

  test("class-based: ResolveTenant → middleware with class name", () => {
    const node = middlewareToNode("ResolveTenant", 1)
    expect(node.type).toBe("ir:auth_gate")
    expect(node.symbol).toBe("ResolveTenant")
    expect(node.args).toContain("ResolveTenant")
  })

  test("FQCN: App\\Http\\Middleware\\ResolveTenant → uses short name", () => {
    const node = middlewareToNode("App\\Http\\Middleware\\ResolveTenant", 0)
    expect(node.symbol).toBe("ResolveTenant")
    expect(node.args).toContain("App\\Http\\Middleware\\ResolveTenant")
  })

  test("unknown middleware → honest unknown_middleware node, not a guessed auth_gate", () => {
    const node = middlewareToNode("some-unknown-middleware", 0)
    expect(node.type).toBe("ir:unknown_middleware")
  })

  test("node id is unique by index and name", () => {
    const a = middlewareToNode("auth:sanctum", 0)
    const b = middlewareToNode("auth:sanctum", 1)
    expect(a.id).not.toBe(b.id)
  })
})
