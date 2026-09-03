import type {
  IntermediateExecutionGraph,
  ExecutionNode,
  ExecutionEdge,
  RetrievalRequest,
  RetrievalResult,
  RetrievalFocus,
} from "@kidkender/archmind-protocol"
import { PROTOCOL_VERSION, toIRNodeType } from "@kidkender/archmind-protocol"
import { estimateSerializedTokens } from "./serializer.js"

export type RetrievalRelevance = "HIGH" | "MEDIUM" | "LOW"

// Re-export so existing consumers don't break
export type { RetrievalFocus }

// Focus → minimum relevance level for each semantic section.
// Nodes below threshold are pruned; the rest are kept intact.
// "side_effects" uses type-based filtering (see pruneBySideEffects) instead of relevance.
const FOCUS_THRESHOLD: Record<Exclude<RetrievalFocus, "side_effects" | "all">, RetrievalRelevance> = {
  auth:        "HIGH",    // only auth-critical nodes
  validation:  "MEDIUM",  // validation + auth context
  runtime:     "MEDIUM",  // runtime injection + middleware
  transaction: "HIGH",    // transaction boundary + escapes only
  isolation:   "HIGH",    // unscoped query + tenant injection only
}

// Node types kept under the side_effects focus.
// Includes the business handler so the caller knows which controller triggered them.
const SIDE_EFFECT_TYPES = new Set([
  "ir:queue_job",
  "ir:event_dispatch",
  "ir:api_resource",
  "ir:notification",
  "ir:mail",
  "ir:business_handler",
])

// Node types where repeated occurrences carry no additional semantic meaning
// and are safe to merge. Caller-scoped types (service_call, policy, permission,
// form_request, etc.) must NOT be deduplicated.
const DEDUP_TYPES = new Set([
  "ir:txn_boundary",
  "ir:txn_write",
  "ir:txn_escape",
  "ir:unscoped_query",
  "ir:unscoped_write",
  "ir:scoped_query",
])

// Rough token budget: if graph exceeds this after dedup, prune by relevance.
const TOKEN_BUDGET = 2500

// ---- Public API -------------------------------------------------------

export function retrieve(
  request: RetrievalRequest,
  graphs: IntermediateExecutionGraph[]
): RetrievalResult | null {
  const graph = findGraph(request.entrypoint, graphs)
  if (!graph) return null

  const focus: RetrievalFocus = request.focus ?? "all"

  let result: RetrievalResult = {
    entrypoint:       graph.entrypoint,
    nodes:            graph.nodes,
    edges:            graph.edges,
    token_estimate:   estimateTokens(graph.nodes, graph.edges),
    pruned:           false,
    focus,
    protocol_version: PROTOCOL_VERSION,
  }

  result = deduplicate(result)
  result = rankByQuery(result, request.query)

  if (focus === "side_effects") {
    result = pruneBySideEffects(result)
  } else if (focus !== "all") {
    result = prune(result, FOCUS_THRESHOLD[focus])
  }

  if (result.token_estimate > TOKEN_BUDGET && !result.pruned) {
    result = prune(result, "MEDIUM")
  }

  return result
}

// ---- Query-aware ranking ---------------------------------------------
// Common English words that carry no code-search meaning.
const STOP_WORDS = new Set([
  "the", "is", "are", "for", "this", "that", "what", "how", "can",
  "does", "will", "not", "any", "all", "and", "but", "with", "from",
  "has", "have", "was", "were", "been", "get", "got", "use", "used",
  "via", "its", "our", "there", "here", "also", "just", "should",
  "would", "could", "when", "where", "which", "who", "why",
])

function extractKeywords(query: string | undefined): string[] {
  if (!query?.trim()) return []
  return query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
}

function queryScore(node: ExecutionNode, keywords: string[]): number {
  if (keywords.length === 0) return 0
  const haystack = [node.symbol, ...(node.args ?? [])].join(" ").toLowerCase()
  return keywords.filter((kw) => haystack.includes(kw)).length
}

export function rankByQuery(result: RetrievalResult, query: string | undefined): RetrievalResult {
  const keywords = extractKeywords(query)
  if (keywords.length === 0) return result

  const typeRelevanceScore = (n: ExecutionNode) => RELEVANCE_ORDER[classifyNode(n)]
  const isStructural = (n: ExecutionNode) => (n.occurrenceCount ?? 1) > 1

  const sorted = [...result.nodes].sort((a, b) => {
    // Structural summary nodes (deduplicated ×N) always go last
    const aStr = isStructural(a) ? 1 : 0
    const bStr = isStructural(b) ? 1 : 0
    if (aStr !== bStr) return aStr - bStr

    // Then by query keyword score descending
    const scoreDiff = queryScore(b, keywords) - queryScore(a, keywords)
    if (scoreDiff !== 0) return scoreDiff

    // Tie-break by type relevance descending
    return typeRelevanceScore(b) - typeRelevanceScore(a)
  })

  return { ...result, nodes: sorted }
}

export function deduplicate(result: RetrievalResult): RetrievalResult {
  // Map from original node ID → canonical node ID (for edge remapping)
  const idToCanonical = new Map<string, string>()
  // Map from dedup key → canonical node (first seen)
  const canonicalByKey = new Map<string, ExecutionNode>()
  const deduped: ExecutionNode[] = []

  for (const node of result.nodes) {
    if (!DEDUP_TYPES.has(node.type)) {
      idToCanonical.set(node.id, node.id)
      deduped.push(node)
      continue
    }

    const key = `${node.type}|${node.symbol}|${(node.args ?? []).join(",")}`
    const existing = canonicalByKey.get(key)

    if (!existing) {
      const canonical: ExecutionNode = { ...node, occurrenceCount: 1 }
      canonicalByKey.set(key, canonical)
      deduped.push(canonical)
      idToCanonical.set(node.id, node.id)
    } else {
      existing.occurrenceCount = (existing.occurrenceCount ?? 1) + 1
      idToCanonical.set(node.id, existing.id)
    }
  }

  // Remap edges to canonical IDs and deduplicate identical edges
  const seenEdgeKeys = new Set<string>()
  const remappedEdges: ExecutionEdge[] = []

  for (const edge of result.edges) {
    const from = idToCanonical.get(edge.from) ?? edge.from
    const to   = idToCanonical.get(edge.to)   ?? edge.to
    const edgeKey = `${from}|${to}|${edge.relation}`
    if (seenEdgeKeys.has(edgeKey)) continue
    seenEdgeKeys.add(edgeKey)
    remappedEdges.push({ ...edge, from, to })
  }

  return {
    ...result,
    nodes:          deduped,
    edges:          remappedEdges,
    token_estimate: estimateTokens(deduped, remappedEdges),
  }
}

export function prune(
  result: RetrievalResult,
  minRelevance: RetrievalRelevance
): RetrievalResult {
  const threshold = RELEVANCE_ORDER[minRelevance]

  const keptNodes = result.nodes.filter(
    (n) => RELEVANCE_ORDER[classifyNode(n)] >= threshold
  )
  const keptIds   = new Set(keptNodes.map((n) => n.id))
  const keptEdges = result.edges.filter(
    (e) => keptIds.has(e.from) && keptIds.has(e.to)
  )

  return {
    entrypoint:       result.entrypoint,
    nodes:            keptNodes,
    edges:            keptEdges,
    token_estimate:   estimateTokens(keptNodes, keptEdges),
    pruned:           true,
    focus:            result.focus,
    protocol_version: result.protocol_version,
  }
}

// Type-based filter for the side_effects focus.
// Keeps only side-effect node types plus the business handler for controller context.
export function pruneBySideEffects(result: RetrievalResult): RetrievalResult {
  const keptNodes = result.nodes.filter((n) => SIDE_EFFECT_TYPES.has(n.type))
  const keptIds   = new Set(keptNodes.map((n) => n.id))
  const keptEdges = result.edges.filter(
    (e) => keptIds.has(e.from) && keptIds.has(e.to)
  )
  return {
    entrypoint:       result.entrypoint,
    nodes:            keptNodes,
    edges:            keptEdges,
    token_estimate:   estimateTokens(keptNodes, keptEdges),
    pruned:           true,
    focus:            result.focus,
    protocol_version: result.protocol_version,
  }
}

// ---- Node type → relevance classification ----------------------------
// Derived from golden trace patterns across all 4 pain cases.

const NODE_TYPE_RELEVANCE: Record<string, RetrievalRelevance> = {
  "ir:auth_gate":           "HIGH",
  "ir:authz_check":         "HIGH",
  "ir:permission_constant": "HIGH",
  "ir:runtime_inject":      "HIGH",
  "ir:runtime_consume":     "MEDIUM",
  "ir:tenant_context":      "HIGH",
  "ir:service_call":        "HIGH",
  "ir:validation_gate":     "HIGH",
  "ir:business_handler":    "MEDIUM",
  "ir:entrypoint":          "MEDIUM",
  "ir:txn_boundary":        "HIGH",
  "ir:txn_write":           "HIGH",
  "ir:txn_escape":          "HIGH",
  "ir:unscoped_query":      "HIGH",
  "ir:unscoped_write":      "HIGH",
  "ir:scoped_query":        "MEDIUM",
  "ir:api_resource":        "HIGH",
  "ir:queue_job":           "HIGH",
  "ir:event_dispatch":      "MEDIUM",
  "ir:notification":        "HIGH",
  "ir:mail":                "MEDIUM",
}

const RELEVANCE_ORDER: Record<RetrievalRelevance, number> = {
  HIGH:   2,
  MEDIUM: 1,
  LOW:    0,
}

export function classifyNode(node: ExecutionNode): RetrievalRelevance {
  // NODE_TYPE_RELEVANCE is keyed by canonical "ir:" types; normalize first so
  // legacy (pre-IR-migration) type strings still classify correctly instead of
  // silently falling through to LOW for everything.
  return NODE_TYPE_RELEVANCE[toIRNodeType(node.type)] ?? "LOW"
}

// ---- Entrypoint matching ----------------------------------------------

function normalizeEntrypoint(ep: string): string {
  return ep.replace(/\{[^}]+\}/g, "{*}")
}

function findGraph(
  entrypoint: string,
  graphs: IntermediateExecutionGraph[]
): IntermediateExecutionGraph | null {
  const norm = normalizeEntrypoint(entrypoint)
  return graphs.find((g) => normalizeEntrypoint(g.entrypoint) === norm) ?? null
}

// ---- Token estimation -------------------------------------------------

function estimateTokens(nodes: ExecutionNode[], edges: ExecutionEdge[]): number {
  return estimateSerializedTokens(nodes, edges)
}
