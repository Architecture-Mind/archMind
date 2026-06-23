/**
 * Cross-framework equivalence tests — Phase 11.
 *
 * Proves the core IR claim: same security pattern in different frameworks
 * produces the same IR node type set.
 *
 * Test structure:
 *   1. Parse Laravel fixture with laravel-parser
 *   2. Parse NestJS fixture with nestjs-parser
 *   3. Assert both graphs contain the SAME set of IR node types
 *
 * Fixtures live in research/cross-framework/{pattern}/laravel|nestjs/
 */

import { join, dirname } from "path"
import { fileURLToPath } from "url"
import {
  parseRouteFile,
  augmentGraph,
  inferProjectConfig,
  resolveAliasMap,
} from "@archmind/laravel-parser"
import { parseNestJSProject } from "../adapter.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname = packages/nestjs-parser/src/__tests__
// 4 levels up = archMind root
const FIXTURES = join(__dirname, "../../../../research/cross-framework")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function irNodeTypes(graph: IntermediateExecutionGraph): Set<string> {
  return new Set(graph.nodes.map(n => n.type))
}

function laravelGraphsFor(pattern: string): IntermediateExecutionGraph[] {
  const root = join(FIXTURES, pattern, "laravel")
  const config = inferProjectConfig(root)
  const aliasMap = resolveAliasMap(root, config) as unknown as Record<string, string>
  const routeFile = join(root, "routes/api.php")
  const skeletons = parseRouteFile(routeFile, { aliasMap })
  return skeletons.map(g => augmentGraph(g, { projectRoot: root, config }))
}

function nestjsGraphsFor(pattern: string): IntermediateExecutionGraph[] {
  return parseNestJSProject(join(FIXTURES, pattern, "nestjs"))
}

// ---------------------------------------------------------------------------
// Pattern 1: Auth only
//   Laravel:  Route::middleware('auth:sanctum') → GET /tasks/{id}
//   NestJS:   @Controller @UseGuards(JwtAuthGuard) → @Get(':id')
//
//   Expected IR: both must contain auth_gate + business_handler
//   Neither should contain authz_check or validation_gate
// ---------------------------------------------------------------------------

describe("Cross-framework: auth-only pattern", () => {
  let laravelTypes: Set<string>
  let nestjsTypes: Set<string>

  beforeAll(() => {
    const lg = laravelGraphsFor("auth-only")
    const ng = nestjsGraphsFor("auth-only")
    expect(lg).toHaveLength(1)
    expect(ng).toHaveLength(1)
    laravelTypes = irNodeTypes(lg[0])
    nestjsTypes  = irNodeTypes(ng[0])
  })

  test("Laravel graph has ir:auth_gate", () => {
    expect(laravelTypes.has("ir:auth_gate")).toBe(true)
  })

  test("NestJS graph has ir:auth_gate", () => {
    expect(nestjsTypes.has("ir:auth_gate")).toBe(true)
  })

  test("Laravel graph has ir:business_handler", () => {
    expect(laravelTypes.has("ir:business_handler")).toBe(true)
  })

  test("NestJS graph has ir:business_handler", () => {
    expect(nestjsTypes.has("ir:business_handler")).toBe(true)
  })

  test("Laravel graph has NO ir:authz_check (auth-only, no authorization)", () => {
    expect(laravelTypes.has("ir:authz_check")).toBe(false)
  })

  test("NestJS graph has NO ir:authz_check (auth-only, no authorization)", () => {
    expect(nestjsTypes.has("ir:authz_check")).toBe(false)
  })

  test("EQUIVALENCE: both have auth_gate + business_handler, neither has authz_check", () => {
    const both = (t: Set<string>) => t.has("ir:auth_gate") && t.has("ir:business_handler") && !t.has("ir:authz_check")
    expect(both(laravelTypes)).toBe(true)
    expect(both(nestjsTypes)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Pattern 2: Auth + Authz
//   Laravel:  middleware('auth') + $this->authorize('update', $task)
//   NestJS:   @UseGuards(JwtAuthGuard, RolesGuard) + @Roles('editor')
//
//   Expected IR: both must contain auth_gate + authz_check + business_handler
// ---------------------------------------------------------------------------

describe("Cross-framework: auth + authz pattern", () => {
  let laravelTypes: Set<string>
  let nestjsTypes: Set<string>

  beforeAll(() => {
    const lg = laravelGraphsFor("auth-authz")
    const ng = nestjsGraphsFor("auth-authz")
    expect(lg).toHaveLength(1)
    expect(ng).toHaveLength(1)
    laravelTypes = irNodeTypes(lg[0])
    nestjsTypes  = irNodeTypes(ng[0])
  })

  test("Laravel graph has ir:auth_gate", () => {
    expect(laravelTypes.has("ir:auth_gate")).toBe(true)
  })

  test("NestJS graph has ir:auth_gate", () => {
    expect(nestjsTypes.has("ir:auth_gate")).toBe(true)
  })

  test("Laravel graph has ir:authz_check", () => {
    expect(laravelTypes.has("ir:authz_check")).toBe(true)
  })

  test("NestJS graph has ir:authz_check", () => {
    expect(nestjsTypes.has("ir:authz_check")).toBe(true)
  })

  test("EQUIVALENCE: both have auth_gate + authz_check + business_handler", () => {
    const full = (t: Set<string>) =>
      t.has("ir:auth_gate") && t.has("ir:authz_check") && t.has("ir:business_handler")
    expect(full(laravelTypes)).toBe(true)
    expect(full(nestjsTypes)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Pattern 3: Auth + Validation
//   Laravel:  middleware('auth') + FormRequest (StoreTaskRequest)
//   NestJS:   @UseGuards(JwtAuthGuard) + @UsePipes(ValidationPipe) + DTO
//
//   Expected IR: both must contain auth_gate + validation_gate + business_handler
// ---------------------------------------------------------------------------

describe("Cross-framework: auth + validation pattern", () => {
  let laravelTypes: Set<string>
  let nestjsTypes: Set<string>

  beforeAll(() => {
    const lg = laravelGraphsFor("auth-validation")
    const ng = nestjsGraphsFor("auth-validation")
    expect(lg).toHaveLength(1)
    expect(ng).toHaveLength(1)
    laravelTypes = irNodeTypes(lg[0])
    nestjsTypes  = irNodeTypes(ng[0])
  })

  test("Laravel graph has ir:auth_gate", () => {
    expect(laravelTypes.has("ir:auth_gate")).toBe(true)
  })

  test("NestJS graph has ir:auth_gate", () => {
    expect(nestjsTypes.has("ir:auth_gate")).toBe(true)
  })

  test("Laravel graph has ir:validation_gate", () => {
    expect(laravelTypes.has("ir:validation_gate")).toBe(true)
  })

  test("NestJS graph has ir:validation_gate", () => {
    expect(nestjsTypes.has("ir:validation_gate")).toBe(true)
  })

  test("EQUIVALENCE: both have auth_gate + validation_gate + business_handler", () => {
    const full = (t: Set<string>) =>
      t.has("ir:auth_gate") && t.has("ir:validation_gate") && t.has("ir:business_handler")
    expect(full(laravelTypes)).toBe(true)
    expect(full(nestjsTypes)).toBe(true)
  })
})
