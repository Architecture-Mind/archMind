import type { IntermediateExecutionGraph, ExecutionNode } from "@kidkender/archmind-protocol"
import { toIRNodeType } from "@kidkender/archmind-protocol"
import type { GoldenTrace, GoldenNode } from "./golden-trace.js"

// ---- Public API -------------------------------------------------------

export interface NodeMatch {
  golden_id:     string
  extracted_id:  string | null  // null = no match found
  match_reason:  string         // how the match was decided
}

export interface TierScore {
  total:   number     // nodes in this tier in the golden trace
  matched: number     // how many were covered by the extracted graph
  recall:  number     // matched / total
}

export interface ScoreReport {
  golden_id:   string
  entrypoint:  string
  route_found: boolean  // was the route in the extracted graphs at all?

  // Skeleton: middleware chain + controller (statically extractable from routes file)
  skeleton: TierScore & { matches: NodeMatch[] }

  // Deeper: policy, form_request, service_call (require interprocedural analysis)
  deeper: {
    total:   number
    matched: number
    recall:  number
    reason:  string        // why unmatched nodes aren't extracted yet
    nodes:   string[]      // golden node IDs
    matches: NodeMatch[]
  }

  // Edge coverage at skeleton level
  edge_recall: number

  // Summary line for reporting
  summary: string
}

// ---- Tier classification ----------------------------------------------

// Skeleton = nodes extractable from the routes file alone (no interprocedural analysis).
// "ir:authz_check" is intentionally excluded — it covers both middleware-level authz
// (skeleton) AND policy-level authz (deeper).
const SKELETON_TYPES = new Set([
  "ir:auth_gate",
  "ir:business_handler",
  // Non-IR types with no IR equivalent (kept as-is by middleware-mapper)
  "rate_limiter",
  "signature_check",
  "email_verification",
])

function isSkeleton(node: GoldenNode): boolean {
  // Do NOT normalize here — golden trace type strings encode skeleton/deeper distinction
  // that would be lost by mapping "authorization_check" and "policy" both to "ir:authz_check"
  return SKELETON_TYPES.has(node.type)
}

// ---- Entrypoint matching ----------------------------------------------

// Normalize route parameters: /tasks/{id} and /tasks/{task} both → /tasks/{*}
function normalizeEntrypoint(ep: string): string {
  return ep.replace(/\{[^}]+\}/g, "{*}")
}

export function findMatchingGraph(
  golden: GoldenTrace,
  graphs: IntermediateExecutionGraph[]
): IntermediateExecutionGraph | null {
  const goldenNorm = normalizeEntrypoint(golden.entrypoint)
  return (
    graphs.find((g) => normalizeEntrypoint(g.entrypoint) === goldenNorm) ?? null
  )
}

// ---- Node matching ----------------------------------------------------

// Score how well an extracted node matches a golden node (0–1)
function matchScore(golden: GoldenNode, extracted: ExecutionNode): number {
  const gSym = golden.symbol.toLowerCase()
  const eSym = extracted.symbol.toLowerCase()

  // Exact symbol match
  if (gSym === eSym) return 1.0

  // Extracted symbol contained in golden (e.g. "ResolveTenant" in "ResolveTenant::handle")
  if (gSym.includes(eSym) || eSym.includes(gSym)) return 0.9

  // The golden args overlap with extracted args (e.g. task.update)
  if (golden.args && extracted.args) {
    const goldenArgs = new Set(golden.args.map((a) => a.toLowerCase()))
    const extractedArgs = new Set(extracted.args.map((a) => a.toLowerCase()))
    const overlap = [...goldenArgs].filter((a) => extractedArgs.has(a))
    if (overlap.length > 0) return 0.7
  }

  // Type semantic equivalence (e.g. golden "middleware" → extracted "authentication_gate")
  if (semanticTypeMatch(golden.type, extracted.type)) {
    // Same semantic category — check if symbols share a root token (including substrings)
    const goldenWords = tokenize(gSym)
    const extractedWords = tokenize(eSym)
    const shared = goldenWords.filter((gw) =>
      extractedWords.some((ew) => ew.includes(gw) || gw.includes(ew))
    )
    if (shared.length > 0) return 0.6
  }

  return 0
}

function semanticTypeMatch(goldenType: string, extractedType: string): boolean {
  const g = toIRNodeType(goldenType)
  const e = toIRNodeType(extractedType)
  if (g === e) return true
  // Middleware in golden traces covers both auth and authz — treat all middleware IR types as compatible
  const AUTH_TYPES    = new Set(["ir:auth_gate", "ir:authz_check", "middleware", "authentication_gate", "authorization_check", "signature_check", "email_verification"])
  const AUTHZ_TYPES   = new Set(["ir:authz_check", "ir:auth_gate", "middleware", "authorization_check", "policy"])
  const HANDLER_TYPES = new Set(["ir:business_handler", "controller", "controller_action"])

  if (AUTH_TYPES.has(g)    && AUTH_TYPES.has(e))    return true
  if (AUTHZ_TYPES.has(g)   && AUTHZ_TYPES.has(e))   return true
  if (HANDLER_TYPES.has(g) && HANDLER_TYPES.has(e)) return true
  return false
}

function tokenize(sym: string): string[] {
  return sym
    .replace(/::/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 2)
}

// Best-match extracted node for a golden node (score threshold: 0.5)
function findBestMatch(
  golden: GoldenNode,
  extracted: ExecutionNode[]
): { node: ExecutionNode; score: number; reason: string } | null {
  let best: { node: ExecutionNode; score: number } | null = null

  for (const e of extracted) {
    const s = matchScore(golden, e)
    if (s > (best?.score ?? 0)) best = { node: e, score: s }
  }

  if (!best || best.score < 0.5) return null

  const reason =
    best.score >= 1.0 ? "exact symbol" :
    best.score >= 0.9 ? "symbol substring" :
    best.score >= 0.7 ? "arg overlap" :
    "semantic type + shared token"

  return { ...best, reason }
}

// ---- Main score function ----------------------------------------------

export function scoreTrace(
  golden: GoldenTrace,
  graphs: IntermediateExecutionGraph[]
): ScoreReport {
  const graph = findMatchingGraph(golden, graphs)

  if (!graph) {
    const isCrossCutting = golden.entrypoint.includes("*") || golden.entrypoint.startsWith("ANY")
    const reason = isCrossCutting
      ? "cross-cutting concern — applies to multiple routes, not a single entrypoint (Phase 3+)"
      : "route not found in extracted graphs"
    return {
      golden_id:   golden.id,
      entrypoint:  golden.entrypoint,
      route_found: false,
      skeleton:    { total: 0, matched: 0, recall: 0, matches: [] },
      deeper:      { total: 0, matched: 0, recall: 0, reason, nodes: [], matches: [] },
      edge_recall: 0,
      summary:     `${golden.id}: SKIP — ${reason}`,
    }
  }

  const skeletonNodes = golden.nodes.filter(isSkeleton)
  const deeperNodes   = golden.nodes.filter((n) => !isSkeleton(n))

  const matches: NodeMatch[] = skeletonNodes.map((gn) => {
    const hit = findBestMatch(gn, graph.nodes)
    return {
      golden_id:    gn.id,
      extracted_id: hit?.node.id ?? null,
      match_reason: hit?.reason ?? "no match",
    }
  })

  const matched = matches.filter((m) => m.extracted_id !== null).length
  const recall  = skeletonNodes.length > 0 ? matched / skeletonNodes.length : 1

  // Edge recall: count golden skeleton edges covered by extracted edges
  const skeletonEdgeCount = golden.edges.filter((e) => {
    const fromNode = golden.nodes.find((n) => n.id === e.from)
    const toNode   = golden.nodes.find((n) => n.id === e.to)
    return fromNode && toNode && isSkeleton(fromNode) && isSkeleton(toNode)
  }).length

  const edgeRecall = graph.edges.length > 0 && skeletonEdgeCount > 0
    ? Math.min(1, graph.edges.length / skeletonEdgeCount)
    : skeletonEdgeCount === 0 ? 1 : 0

  // Score deeper nodes against any non-skeleton nodes in the extracted graph
  // Normalize extracted node types to catch ir: prefixed types that map to legacy skeleton types
  const extractedDeeper = graph.nodes.filter((n) => {
    const normalized = toIRNodeType(n.type)
    return !SKELETON_TYPES.has(n.type) && !SKELETON_TYPES.has(normalized)
  })
  const deeperMatches: NodeMatch[] = deeperNodes.map((gn) => {
    const hit = findBestMatch(gn, extractedDeeper)
    return {
      golden_id:    gn.id,
      extracted_id: hit?.node.id ?? null,
      match_reason: hit?.reason ?? "no match",
    }
  })
  const deeperMatched = deeperMatches.filter((m) => m.extracted_id !== null).length
  const deeperRecall  = deeperNodes.length > 0 ? deeperMatched / deeperNodes.length : 1

  const pct        = (recall * 100).toFixed(0)
  const deeperPct  = (deeperRecall * 100).toFixed(0)
  const summary    = deeperMatched > 0
    ? `${golden.id}: skeleton ${pct}% (${matched}/${skeletonNodes.length}), deeper ${deeperPct}% (${deeperMatched}/${deeperNodes.length})`
    : `${golden.id}: skeleton recall ${pct}% (${matched}/${skeletonNodes.length} nodes)`

  return {
    golden_id:   golden.id,
    entrypoint:  golden.entrypoint,
    route_found: true,
    skeleton:    { total: skeletonNodes.length, matched, recall, matches },
    deeper: {
      total:   deeperNodes.length,
      matched: deeperMatched,
      recall:  deeperRecall,
      reason:  "requires interprocedural analysis (Phase 3+)",
      nodes:   deeperNodes.map((n) => n.id),
      matches: deeperMatches,
    },
    edge_recall: edgeRecall,
    summary,
  }
}
