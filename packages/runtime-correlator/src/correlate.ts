import type {
  OtelSpan,
  TraceSession,
  ExecutionNode,
  IntermediateExecutionGraph,
  CorrelatedSpan,
  CorrelatedSession,
} from "@kidkender/archmind-protocol"
import { partitionSpans } from "@kidkender/archmind-runtime-ingest"

// ─── Correlation strategies (ordered by precision) ───────────────────────────

function getAttr(span: OtelSpan, key: string): string | undefined {
  const v = span.attributes[key]
  return v !== undefined ? String(v) : undefined
}

/** Strategy 1: span.name === node.symbol */
function tryExactSymbol(span: OtelSpan, nodes: ExecutionNode[]): ExecutionNode | null {
  return nodes.find(n => n.symbol === span.name) ?? null
}

/** Strategy 2: code.namespace + code.function → ClassName::method */
function tryNamespaceFunction(span: OtelSpan, nodes: ExecutionNode[]): ExecutionNode | null {
  const ns  = getAttr(span, "code.namespace")
  const fn_ = getAttr(span, "code.function")
  if (!ns || !fn_) return null
  const className = ns.split("\\").at(-1)!
  const symbol = `${className}::${fn_}`
  return nodes.find(n => n.symbol === symbol) ?? null
}

/** Strategy 3: middleware.name attribute (exact or ::handle suffix) */
function tryMiddlewareName(span: OtelSpan, nodes: ExecutionNode[]): ExecutionNode | null {
  const mwName = getAttr(span, "middleware.name") ?? getAttr(span, "laravel.middleware")
  if (!mwName) return null
  return (
    nodes.find(n => n.symbol === mwName) ??
    nodes.find(n => n.type === "middleware" && n.symbol.startsWith(`${mwName}::`)) ??
    null
  )
}

/** Strategy 4: partial — last resort, lower confidence */
function tryPartialSymbol(span: OtelSpan, nodes: ExecutionNode[]): ExecutionNode | null {
  if (span.name.startsWith("db.") || /^(GET|POST|PUT|PATCH|DELETE) /.test(span.name)) {
    return null
  }
  return (
    nodes.find(n => n.symbol.includes(span.name)) ??
    nodes.find(n => {
      const className = n.symbol.split("::")[0]
      return className ? span.name.includes(className) : false
    }) ??
    null
  )
}

function correlateOne(span: OtelSpan, nodes: ExecutionNode[]): CorrelatedSpan {
  let matched: ExecutionNode | null
  let strategy: CorrelatedSpan["strategy"]
  let confidence: CorrelatedSpan["confidence"]

  if ((matched = tryExactSymbol(span, nodes))) {
    strategy = "exact_symbol"; confidence = "exact"
  } else if ((matched = tryNamespaceFunction(span, nodes))) {
    strategy = "namespace_function"; confidence = "exact"
  } else if ((matched = tryMiddlewareName(span, nodes))) {
    strategy = "middleware_name"; confidence = "high"
  } else if ((matched = tryPartialSymbol(span, nodes))) {
    strategy = "partial_symbol"; confidence = "partial"
  } else {
    matched = null; strategy = "unmatched"; confidence = "none"
  }

  return {
    span,
    nodeId:     matched?.id ?? null,
    strategy,
    confidence,
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function correlateSession(
  session: TraceSession,
  graph: IntermediateExecutionGraph,
): CorrelatedSession {
  const { candidates, infra } = partitionSpans(session.spans)
  const correlations = candidates.map(s => correlateOne(s, graph.nodes))
  const matched = correlations.filter(c => c.confidence !== "none").length
  const correlationRate = candidates.length > 0 ? matched / candidates.length : 0

  return { session, correlations, correlationRate, infraSpans: infra }
}

/** Return all spans matched to a specific graph node ID */
export function spansForNode(correlated: CorrelatedSession, nodeId: string): OtelSpan[] {
  return correlated.correlations
    .filter(c => c.nodeId === nodeId)
    .map(c => c.span)
}

/** Return db/infra spans that are children of spans matched to a node */
export function infraUnderNode(correlated: CorrelatedSession, nodeId: string): OtelSpan[] {
  const nodeSpanIds = new Set(spansForNode(correlated, nodeId).map(s => s.spanId))
  return correlated.infraSpans.filter(s => s.parentSpanId && nodeSpanIds.has(s.parentSpanId))
}
