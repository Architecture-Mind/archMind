import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { SemanticFact } from "./fact-extraction/types.js"
import type { Finding } from "./findings/types.js"
import { extractFacts } from "./fact-extraction/index.js"
import { detect } from "./pattern-detectors/index.js"
import { renderMarkdown } from "./renderers/markdown.js"
import { rankFindings } from "./ranking/rank-findings.js"
import { classifyQuery } from "./query/classify.js"
import { prioritizeByFocus } from "./query/prioritize.js"

export function explain(graph: IntermediateExecutionGraph, query?: string): Finding[] {
  const facts = extractFacts(graph)
  const ranked = rankFindings(detect(facts, graph))
  if (!query) return ranked
  const ctx = classifyQuery(query)
  return prioritizeByFocus(ranked, ctx.focus)
}

export { extractFacts, detect, renderMarkdown, rankFindings, classifyQuery, prioritizeByFocus }
export { buildEvidencePackage } from "./evidence/index.js"
export type { EvidencePackage, EvidenceItem, EvidencePackageOptions } from "./evidence/index.js"
export { traceByPattern } from "./trace/index.js"
export type { TracePattern, TraceResult } from "./trace/index.js"
export type { SemanticFact, Finding }
export * from "./fact-extraction/types.js"
export * from "./findings/types.js"
export * from "./query/classify.js"
