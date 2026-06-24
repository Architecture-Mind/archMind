/**
 * DTOSchema wiring integration test.
 *
 * Proves that parseNestJSProject() enriches ir:validation_gate nodes with
 * parsed field schema from class-validator annotated DTO classes.
 */

import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { parseNestJSProject } from "../adapter.js"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "dto-schema")

describe("DTOSchema wiring — validation_gate detail", () => {
  let vgNode: ReturnType<typeof parseNestJSProject>[0]["nodes"][0] | undefined

  beforeAll(() => {
    const graphs = parseNestJSProject(FIXTURES)
    const g = graphs.find(g => g.method === "POST" && g.path === "/users")
    vgNode = g?.nodes.find(n => n.type === "ir:validation_gate")
  })

  test("POST /users has a validation_gate node", () => {
    expect(vgNode).toBeDefined()
    expect(vgNode?.symbol).toBe("CreateUserDto")
  })

  test("validation_gate node has detail with fields array", () => {
    expect(vgNode?.detail).toBeDefined()
    const detail = JSON.parse(vgNode!.detail!)
    expect(Array.isArray(detail.fields)).toBe(true)
    expect(detail.fields.length).toBeGreaterThan(0)
  })

  test("fields include email with IsEmail rule", () => {
    const detail = JSON.parse(vgNode!.detail!)
    const emailField = detail.fields.find((f: { name: string }) => f.name === "email")
    expect(emailField).toBeDefined()
    expect(emailField.rules.some((r: { kind: string }) => r.kind === "email")).toBe(true)
  })

  test("fields include password with minLength=8 rule", () => {
    const detail = JSON.parse(vgNode!.detail!)
    const pwField = detail.fields.find((f: { name: string }) => f.name === "password")
    expect(pwField).toBeDefined()
    expect(pwField.rules.some((r: { kind: string; value?: number }) => r.kind === "minLength" && r.value === 8)).toBe(true)
  })

  test("validation_gate node has file path set", () => {
    expect(vgNode?.file).toBeDefined()
    expect(vgNode?.file).toMatch(/create-user\.dto\.ts/)
  })
})
