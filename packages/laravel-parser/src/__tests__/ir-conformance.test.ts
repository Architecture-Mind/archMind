/**
 * IR v2 Conformance Tests — Laravel Parser
 *
 * These tests ensure the Laravel parser (route-parser + graph-augmenter) emits
 * only known IR node types and edge relations. A failure here means a parser
 * change introduced a node type or edge relation that isn't in the IR schema
 * and isn't a known legacy string.
 *
 * Legend:
 *   conformant   = no unknown_node_type or unknown_edge_relation violations
 *   legacy       = known pre-IR strings; tracked as migration debt, not failures
 */
import { join } from "path"
import { parseRouteFile } from "../route-parser.js"
import { augmentGraph } from "../graph-augmenter.js"
import { validateGraph } from "@kidkender/archmind-protocol"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const FIXTURES = join(process.cwd(), "src/__tests__/fixtures")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allGraphViolations(graphs: IntermediateExecutionGraph[]) {
  return graphs.flatMap((g) => {
    const { violations } = validateGraph(g)
    return violations.map((v) => ({ route: g.entrypoint, ...v }))
  })
}

function unknownOnly(violations: ReturnType<typeof allGraphViolations>) {
  return violations.filter(
    (v) => v.kind === "unknown_node_type" || v.kind === "unknown_edge_relation"
  )
}

// ---------------------------------------------------------------------------
// Suite 1: Route parser (no augmentation)
// ---------------------------------------------------------------------------

describe("IR conformance — route-parser (no augmentation)", () => {
  let graphs: IntermediateExecutionGraph[]

  beforeAll(() => {
    graphs = [
      ...parseRouteFile(join(FIXTURES, "routes-simple.php")),
      ...parseRouteFile(join(FIXTURES, "routes-nested.php")),
      ...parseRouteFile(join(FIXTURES, "routes-alias.php")),
    ]
  })

  test("parses at least 1 graph from fixtures", () => {
    expect(graphs.length).toBeGreaterThan(0)
  })

  test("no unknown node types or edge relations", () => {
    const unknown = unknownOnly(allGraphViolations(graphs))
    if (unknown.length > 0) {
      const summary = unknown
        .map((v) => `  [${v.route}] ${v.kind}: "${v.value}"`)
        .join("\n")
      throw new Error(`Unknown IR types detected — add to IR_NODE_TYPES or LARAVEL_TO_IR:\n${summary}`)
    }
    expect(unknown).toHaveLength(0)
  })

  test("all node types are valid IR (legacy types are migration debt, not failures)", () => {
    const violations = allGraphViolations(graphs)
    const legacyNodes = violations.filter((v) => v.kind === "legacy_node_type")
    // Document legacy types present — these should decrease over time
    const legacyTypeSet = new Set(legacyNodes.map((v) => v.value))
    // Snapshot: if this grows, a regression was introduced
    expect([...legacyTypeSet].sort()).toMatchSnapshot()
  })

  test("all edge relations are valid IR (legacy relations are migration debt)", () => {
    const violations = allGraphViolations(graphs)
    const legacyEdges = violations.filter((v) => v.kind === "legacy_edge_relation")
    const legacyRelSet = new Set(legacyEdges.map((v) => v.value))
    expect([...legacyRelSet].sort()).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// Suite 2: Graph augmenter (route-parser + augmentation)
// ---------------------------------------------------------------------------

describe("IR conformance — graph-augmenter (route + augment)", () => {
  let graphs: IntermediateExecutionGraph[]

  beforeAll(() => {
    const raw = parseRouteFile(join(FIXTURES, "routes-simple.php"))
    graphs = raw.map((g) => augmentGraph(g, { projectRoot: FIXTURES }))
  })

  test("augmenter produces graphs", () => {
    expect(graphs.length).toBeGreaterThan(0)
  })

  test("no unknown node types or edge relations after augmentation", () => {
    const unknown = unknownOnly(allGraphViolations(graphs))
    if (unknown.length > 0) {
      const summary = unknown
        .map((v) => `  [${v.route}] ${v.kind}: "${v.value}"`)
        .join("\n")
      throw new Error(`Unknown IR types after augmentation:\n${summary}`)
    }
    expect(unknown).toHaveLength(0)
  })

  test("tracks legacy node types after augmentation (snapshot)", () => {
    const violations = allGraphViolations(graphs)
    const legacyTypeSet = new Set(
      violations.filter((v) => v.kind === "legacy_node_type").map((v) => v.value)
    )
    expect([...legacyTypeSet].sort()).toMatchSnapshot()
  })

  test("tracks legacy edge relations after augmentation (snapshot)", () => {
    const violations = allGraphViolations(graphs)
    const legacyRelSet = new Set(
      violations.filter((v) => v.kind === "legacy_edge_relation").map((v) => v.value)
    )
    expect([...legacyRelSet].sort()).toMatchSnapshot()
  })
})
