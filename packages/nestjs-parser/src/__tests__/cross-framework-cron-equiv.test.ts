/**
 * Cross-framework equivalence — Cron + Transaction entrypoint.
 *
 * Proves the milestone-1 claim from the Spring/NestJS entrypoint discussion:
 * the same semantic pattern (a scheduled job wrapped in a transaction) in two
 * frameworks should produce the same IR shape at the entrypoint level —
 * a "cron" EntrypointDescriptor plus a txn_boundary — even though the
 * concrete annotations/decorators differ:
 *
 *   Spring:  @Scheduled(cron = "...") + @Transactional
 *   NestJS:  @Cron('...')             + dataSource.transaction(...)
 *
 * Fixtures live in research/cross-framework/cron-transaction/{spring,nestjs}.
 */

import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { parseSpringBootProject } from "@kidkender/archmind-springboot-parser"
import { parseNestJSProject } from "../adapter.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname = packages/nestjs-parser/src/__tests__
// 4 levels up = archMind root
const FIXTURES = join(__dirname, "../../../../research/cross-framework/cron-transaction")

function irNodeTypes(graph: IntermediateExecutionGraph): Set<string> {
  return new Set(graph.nodes.map((n) => n.type))
}

describe("Cross-framework: cron + transaction pattern", () => {
  let springGraphs: IntermediateExecutionGraph[]
  let nestGraphs:   IntermediateExecutionGraph[]
  let springTypes:  Set<string>
  let nestTypes:    Set<string>

  beforeAll(() => {
    springGraphs = parseSpringBootProject(join(FIXTURES, "spring"))
    nestGraphs   = parseNestJSProject(join(FIXTURES, "nestjs"))
    expect(springGraphs).toHaveLength(1)
    expect(nestGraphs).toHaveLength(1)
    springTypes = irNodeTypes(springGraphs[0])
    nestTypes   = irNodeTypes(nestGraphs[0])
  })

  test("Spring graph.source is a cron EntrypointDescriptor", () => {
    expect(springGraphs[0].source?.type).toBe("cron")
  })

  test("NestJS graph.source is a cron EntrypointDescriptor", () => {
    expect(nestGraphs[0].source?.type).toBe("cron")
  })

  test("Spring graph has ir:txn_boundary", () => {
    expect(springTypes.has("ir:txn_boundary")).toBe(true)
  })

  test("NestJS graph has ir:txn_boundary", () => {
    expect(nestTypes.has("ir:txn_boundary")).toBe(true)
  })

  test("Spring graph has ir:txn_write (repository.save)", () => {
    expect(springTypes.has("ir:txn_write")).toBe(true)
  })

  test("NestJS graph has ir:txn_write (manager.save)", () => {
    expect(nestTypes.has("ir:txn_write")).toBe(true)
  })

  test("EQUIVALENCE: both produce a cron entrypoint wrapping a transaction boundary + write", () => {
    const shape = (g: IntermediateExecutionGraph, types: Set<string>) =>
      g.source?.type === "cron" && types.has("ir:txn_boundary") && types.has("ir:txn_write")
    expect(shape(springGraphs[0], springTypes)).toBe(true)
    expect(shape(nestGraphs[0], nestTypes)).toBe(true)
  })
})
