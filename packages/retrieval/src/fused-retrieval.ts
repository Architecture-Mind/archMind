import type {
  RetrievalResult,
  RuntimeFinding,
  TraceSession,
  OtelSpan,
  CorrelatedSession,
} from "@kidkender/archmind-protocol"

export interface FusedRetrievalResult extends RetrievalResult {
  runtimeFindings: RuntimeFinding[]
  traceSession: TraceSession
  /** nodeId → spans that were correlated to that node */
  correlatedSpans: Map<string, OtelSpan[]>
}

export function fuseWithRuntime(
  staticResult: RetrievalResult,
  correlatedSession: CorrelatedSession,
  findings: RuntimeFinding[],
): FusedRetrievalResult {
  const correlatedSpans = new Map<string, OtelSpan[]>()
  for (const c of correlatedSession.correlations) {
    if (c.nodeId && c.confidence !== "none") {
      const existing = correlatedSpans.get(c.nodeId) ?? []
      correlatedSpans.set(c.nodeId, [...existing, c.span])
    }
  }

  // Findings add a small token overhead on top of the static graph
  const runtimeOverhead = Math.ceil(JSON.stringify(findings).length / 4)

  return {
    ...staticResult,
    token_estimate: staticResult.token_estimate + runtimeOverhead,
    runtimeFindings: findings,
    traceSession: correlatedSession.session,
    correlatedSpans,
  }
}
