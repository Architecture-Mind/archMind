import type { Finding } from "../findings/types.js"
import type { ExpectedFinding } from "@kidkender/archmind-scorer"

export interface ExplainerScoreResult {
  recall: number
  node_coverage: number
  hits: string[]
  misses: string[]
}

export function scoreExplainer(
  findings: Finding[],
  expected: ExpectedFinding[]
): ExplainerScoreResult {
  if (expected.length === 0) {
    return { recall: 1, node_coverage: 1, hits: [], misses: [] }
  }

  const foundTypes = new Set(findings.map((f) => f.type))
  const hits = expected.filter((e) => foundTypes.has(e.type)).map((e) => e.type)
  const misses = expected.filter((e) => !foundTypes.has(e.type)).map((e) => e.type)
  const recall = hits.length / expected.length

  const allRequired = expected.flatMap((e) => e.required_nodes)
  const allSupporting = new Set(findings.flatMap((f) => f.provenance.supporting_nodes))
  const coveredCount = allRequired.filter((n) => allSupporting.has(n)).length
  const node_coverage = allRequired.length === 0 ? 1 : coveredCount / allRequired.length

  return { recall, node_coverage, hits, misses }
}
