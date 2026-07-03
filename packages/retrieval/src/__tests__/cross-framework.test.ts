/**
 * Phase 11 — Comparative Eval Suite
 *
 * Proves: same semantics → same IR graph across frameworks.
 *
 * For each scenario, parse both the Laravel and NestJS fixture.
 * Assert they produce the same semantic signature (which IR node types are present).
 * This is a stronger proof than per-framework recall scores.
 *
 * Run with:
 *   node --experimental-vm-modules ../../node_modules/jest/bin/jest.js src/__tests__/cross-framework.test.ts
 */
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { parseRouteFile, augmentGraph } from "@kidkender/archmind-laravel-parser"
import { parseNestJSProject } from "@kidkender/archmind-nestjs-parser"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const REPO_ROOT  = join(__dirname, "../../../../")
const CF_DIR     = join(REPO_ROOT, "research/cross-framework")

// ---- Helpers ---------------------------------------------------------------

interface SemanticSignature {
  hasAuthGate:       boolean
  hasAuthzCheck:     boolean
  hasValidationGate: boolean
  types:             string[]
}

function signature(graphs: IntermediateExecutionGraph[]): SemanticSignature {
  const types = [...new Set(graphs.flatMap((g) => g.nodes.map((n) => n.type)))]
  return {
    hasAuthGate:       types.includes("ir:auth_gate"),
    hasAuthzCheck:     types.includes("ir:authz_check"),
    hasValidationGate: types.includes("ir:validation_gate"),
    types,
  }
}

function parseLaravel(scenario: string): IntermediateExecutionGraph[] {
  const dir       = join(CF_DIR, scenario, "laravel")
  const routeFile = join(dir, "routes/api.php")
  const skeletons = parseRouteFile(routeFile, {})
  return skeletons.map((s) => augmentGraph(s, { projectRoot: dir }))
}

function parseNestJS(scenario: string): IntermediateExecutionGraph[] {
  return parseNestJSProject(join(CF_DIR, scenario, "nestjs"))
}

// ---- Scenario: auth-only ---------------------------------------------------

describe("auth-only: authentication gate only", () => {
  let laravel: SemanticSignature
  let nestjs:  SemanticSignature

  beforeAll(() => {
    laravel = signature(parseLaravel("auth-only"))
    nestjs  = signature(parseNestJS("auth-only"))
  })

  test("Laravel emits ir:auth_gate", () => {
    expect(laravel.hasAuthGate).toBe(true)
  })

  test("NestJS emits ir:auth_gate", () => {
    expect(nestjs.hasAuthGate).toBe(true)
  })

  test("neither framework emits ir:authz_check", () => {
    expect(laravel.hasAuthzCheck).toBe(false)
    expect(nestjs.hasAuthzCheck).toBe(false)
  })

  test("neither framework emits ir:validation_gate", () => {
    expect(laravel.hasValidationGate).toBe(false)
    expect(nestjs.hasValidationGate).toBe(false)
  })

  test("semantic signatures match", () => {
    expect(laravel.hasAuthGate).toBe(nestjs.hasAuthGate)
    expect(laravel.hasAuthzCheck).toBe(nestjs.hasAuthzCheck)
    expect(laravel.hasValidationGate).toBe(nestjs.hasValidationGate)
  })
})

// ---- Scenario: auth-authz --------------------------------------------------

describe("auth-authz: authentication + authorization", () => {
  let laravel: SemanticSignature
  let nestjs:  SemanticSignature

  beforeAll(() => {
    laravel = signature(parseLaravel("auth-authz"))
    nestjs  = signature(parseNestJS("auth-authz"))
  })

  test("Laravel emits ir:auth_gate", () => {
    expect(laravel.hasAuthGate).toBe(true)
  })

  test("NestJS emits ir:auth_gate", () => {
    expect(nestjs.hasAuthGate).toBe(true)
  })

  test("Laravel emits ir:authz_check", () => {
    expect(laravel.hasAuthzCheck).toBe(true)
  })

  test("NestJS emits ir:authz_check", () => {
    expect(nestjs.hasAuthzCheck).toBe(true)
  })

  test("semantic signatures match", () => {
    expect(laravel.hasAuthGate).toBe(nestjs.hasAuthGate)
    expect(laravel.hasAuthzCheck).toBe(nestjs.hasAuthzCheck)
    expect(laravel.hasValidationGate).toBe(nestjs.hasValidationGate)
  })
})

// ---- Scenario: auth-validation ---------------------------------------------

describe("auth-validation: authentication + input validation", () => {
  let laravel: SemanticSignature
  let nestjs:  SemanticSignature

  beforeAll(() => {
    laravel = signature(parseLaravel("auth-validation"))
    nestjs  = signature(parseNestJS("auth-validation"))
  })

  test("Laravel emits ir:auth_gate", () => {
    expect(laravel.hasAuthGate).toBe(true)
  })

  test("NestJS emits ir:auth_gate", () => {
    expect(nestjs.hasAuthGate).toBe(true)
  })

  test("Laravel emits ir:validation_gate", () => {
    expect(laravel.hasValidationGate).toBe(true)
  })

  test("NestJS emits ir:validation_gate", () => {
    expect(nestjs.hasValidationGate).toBe(true)
  })

  test("semantic signatures match", () => {
    expect(laravel.hasAuthGate).toBe(nestjs.hasAuthGate)
    expect(laravel.hasAuthzCheck).toBe(nestjs.hasAuthzCheck)
    expect(laravel.hasValidationGate).toBe(nestjs.hasValidationGate)
  })
})
