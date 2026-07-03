import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { loadConstraints, checkConstraints, type ConstraintConfig } from "../index.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

function makeGraph(overrides: Partial<IntermediateExecutionGraph> = {}): IntermediateExecutionGraph {
  return {
    entrypoint:  "POST /orders",
    method:      "POST",
    path:        "/orders",
    nodes:       [],
    edges:       [],
    annotations: [],
    ...overrides,
  }
}

describe("loadConstraints", () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "archmind-constraints-"))
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  test("returns null when no constraints file exists", () => {
    expect(loadConstraints(projectRoot)).toBeNull()
  })

  test("parses a custom file path when provided", () => {
    writeFileSync(
      join(projectRoot, "custom-constraints.yml"),
      [
        "rules:",
        "  - name: writes-need-transaction",
        "    query: FIND routes WHERE mutation AND no-transaction",
        "    severity: MEDIUM",
      ].join("\n"),
    )
    const config = loadConstraints(projectRoot, "custom-constraints.yml")
    expect(config?.rules).toHaveLength(1)
    expect(config?.rules[0]).toMatchObject({
      name:     "writes-need-transaction",
      severity: "MEDIUM",
    })
  })

  test("returns null when custom file path does not exist", () => {
    expect(loadConstraints(projectRoot, "does-not-exist.yml")).toBeNull()
  })

  test("parses multiple rules and skips malformed entries missing required keys", () => {
    writeFileSync(
      join(projectRoot, "constraints.yml"),
      [
        "rules:",
        "  - name: rule-one",
        "    query: FIND routes WHERE auth",
        "    severity: LOW",
        "  - name: incomplete-rule",
        "  - name: rule-two",
        "    query: FIND routes WHERE tenant-scoped",
        "    severity: CRITICAL",
        "    message: Every route must be tenant scoped",
      ].join("\n"),
    )
    const config = loadConstraints(projectRoot, "constraints.yml")
    expect(config?.rules.map((r) => r.name)).toEqual(["rule-one", "rule-two"])
  })
})

describe("checkConstraints", () => {
  test("ok=true and no violations when every rule passes", () => {
    const config: ConstraintConfig = {
      rules: [
        { name: "requires-auth", query: "FIND routes WHERE mutation AND no-auth", severity: "HIGH" },
      ],
    }
    const graphs = [makeGraph({ nodes: [{ id: "n1", type: "ir:auth_gate", symbol: "auth:sanctum" }] })]

    const report = checkConstraints(config, graphs)

    expect(report.ok).toBe(true)
    expect(report.violations).toHaveLength(0)
    expect(report.checked).toBe(1)
    expect(report.total_violations).toBe(0)
  })

  test("reports a violation with the offending route when a rule fails", () => {
    const config: ConstraintConfig = {
      rules: [
        { name: "requires-auth", query: "FIND routes WHERE mutation AND no-auth", severity: "HIGH", message: "Mutations need auth" },
      ],
    }
    const graphs = [makeGraph({ entrypoint: "POST /orders", nodes: [] })]

    const report = checkConstraints(config, graphs)

    expect(report.ok).toBe(false)
    expect(report.total_violations).toBe(1)
    expect(report.violations[0]?.rule.name).toBe("requires-auth")
    expect(report.violations[0]?.routes).toContain("POST /orders")
  })

  test("surfaces invalid AQL as a violation instead of throwing", () => {
    const config: ConstraintConfig = {
      rules: [
        { name: "broken-rule", query: "NOT VALID AQL ((", severity: "LOW" },
      ],
    }
    const graphs = [makeGraph()]

    const report = checkConstraints(config, graphs)

    expect(report.ok).toBe(false)
    expect(report.violations[0]?.routes[0]).toMatch(/AQL error/)
  })

  test("checked reflects total rule count even when some pass and some fail", () => {
    const config: ConstraintConfig = {
      rules: [
        { name: "passes", query: "FIND routes WHERE no-auth", severity: "LOW" },
        { name: "fails", query: "FIND routes WHERE auth", severity: "LOW" },
      ],
    }
    const graphs = [makeGraph({ nodes: [{ id: "n1", type: "ir:auth_gate", symbol: "auth:sanctum" }] })]

    const report = checkConstraints(config, graphs)

    expect(report.checked).toBe(2)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]?.rule.name).toBe("fails")
  })
})
