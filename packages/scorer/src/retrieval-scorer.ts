import type { RetrievalResult, ExecutionNode } from "@kidkender/archmind-protocol"
import type { GoldenTrace, GoldenNode, RetrievalRelevance } from "./golden-trace.js"

// ---- Public API -------------------------------------------------------

export interface RetrievalScoreReport {
  golden_id:       string
  entrypoint:      string
  retrieved:       boolean
  high_recall:     number    // fraction of HIGH nodes covered
  medium_recall:   number    // fraction of MEDIUM nodes covered
  combined_recall: number    // fraction of HIGH + MEDIUM nodes covered
  token_estimate:  number
  summary:         string
}

export function scoreRetrieval(
  golden: GoldenTrace,
  result: RetrievalResult | null
): RetrievalScoreReport {
  if (!result) {
    return {
      golden_id:       golden.id,
      entrypoint:      golden.entrypoint,
      retrieved:       false,
      high_recall:     0,
      medium_recall:   0,
      combined_recall: 0,
      token_estimate:  0,
      summary:         `${golden.id}: NOT RETRIEVED`,
    }
  }

  const highNodes   = nodesWithRelevance(golden, "HIGH")
  const mediumNodes = nodesWithRelevance(golden, "MEDIUM")

  const highCovered   = highNodes.filter((n) => isCovered(n, result.nodes)).length
  const mediumCovered = mediumNodes.filter((n) => isCovered(n, result.nodes)).length
  const totalRelevant = highNodes.length + mediumNodes.length
  const totalCovered  = highCovered + mediumCovered

  const high_recall     = highNodes.length   > 0 ? highCovered   / highNodes.length   : 1
  const medium_recall   = mediumNodes.length > 0 ? mediumCovered / mediumNodes.length : 1
  const combined_recall = totalRelevant      > 0 ? totalCovered  / totalRelevant      : 1

  const hPct = (high_recall     * 100).toFixed(0)
  const mPct = (medium_recall   * 100).toFixed(0)
  const cPct = (combined_recall * 100).toFixed(0)

  const summary = `${golden.id}: retrieval recall ${cPct}% combined (H:${hPct}% M:${mPct}%), ~${result.token_estimate} tokens`

  return {
    golden_id:       golden.id,
    entrypoint:      golden.entrypoint,
    retrieved:       true,
    high_recall,
    medium_recall,
    combined_recall,
    token_estimate:  result.token_estimate,
    summary,
  }
}

// ---- Helpers ----------------------------------------------------------

function nodesWithRelevance(golden: GoldenTrace, level: RetrievalRelevance): GoldenNode[] {
  return golden.nodes.filter((n) => n.retrieval?.relevance === level)
}

function isCovered(golden: GoldenNode, extracted: ExecutionNode[]): boolean {
  const gSym = golden.symbol.toLowerCase()
  return extracted.some((e) => {
    const eSym = e.symbol.toLowerCase()
    return eSym === gSym || eSym.includes(gSym) || gSym.includes(eSym)
  })
}
