import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { aql } from "@kidkender/archmind-aql"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"

export interface ConstraintRule {
  name:     string
  query:    string          // AQL string
  severity: Severity
  message?: string
}

export interface ConstraintConfig {
  version?: number
  rules:    ConstraintRule[]
}

export interface ConstraintViolation {
  rule:       ConstraintRule
  routes:     string[]       // entrypoints that violate this rule
}

export interface ConstraintReport {
  ok:         boolean
  violations: ConstraintViolation[]
  total_violations: number
  checked:    number         // number of rules evaluated
}

// ---------------------------------------------------------------------------
// Loader — minimal YAML parser for the constraints file
// ---------------------------------------------------------------------------

function parseConstraintYaml(content: string): ConstraintConfig {
  const rules: ConstraintRule[] = []
  const lines = content.split("\n")
  let i = 0

  // advance past version line if present
  while (i < lines.length && !lines[i]!.trimStart().startsWith("- ")) i++

  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trimStart().startsWith("- ")) { i++; continue }

    // Start of a rule block
    const rule: Partial<ConstraintRule> = {}
    i++ // skip the "  - " opener line itself (name follows on same or next line)

    // The "  - name: ..." pattern means name is on the same line after "- "
    const nameLine = line.replace(/^\s*-\s*/, "")
    const nameKv = nameLine.match(/^name:\s*(.+)$/)
    if (nameKv) rule.name = nameKv[1]!.trim()

    // Read sub-keys until next rule or EOF
    while (i < lines.length && !lines[i]!.trimStart().startsWith("- ")) {
      const sub = lines[i]!
      const kv = sub.match(/^\s+(name|query|severity|message):\s*(.+)$/)
      if (kv) {
        const key = kv[1] as keyof ConstraintRule
        const val = kv[2]!.trim().replace(/^["']|["']$/g, "")
        if (key === "severity") rule.severity = val as Severity
        else rule[key] = val as never
      }
      i++
    }

    if (rule.name && rule.query && rule.severity) {
      rules.push(rule as ConstraintRule)
    }
  }

  return { rules }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const DEFAULT_FILE = ".archmind/constraints.yml"

/** Load constraint config from a project root. Returns null if no file found. */
export function loadConstraints(projectRoot: string, file = DEFAULT_FILE): ConstraintConfig | null {
  const p = join(projectRoot, file)
  if (!existsSync(p)) return null
  try {
    return parseConstraintYaml(readFileSync(p, "utf-8"))
  } catch {
    return null
  }
}

/** Evaluate all rules against a set of graphs. */
export function checkConstraints(
  config: ConstraintConfig,
  graphs: IntermediateExecutionGraph[],
): ConstraintReport {
  const violations: ConstraintViolation[] = []

  for (const rule of config.rules) {
    let result
    try {
      result = aql(rule.query, graphs)
    } catch (e) {
      // invalid AQL — surface as a special violation
      violations.push({ rule, routes: [`[AQL error: ${String(e)}]`] })
      continue
    }

    if (result.count > 0) {
      violations.push({ rule, routes: result.entrypoints })
    }
  }

  const total = violations.reduce((s, v) => s + v.routes.length, 0)
  return {
    ok:               violations.length === 0,
    violations,
    total_violations: total,
    checked:          config.rules.length,
  }
}
