import type { RuntimeFinding, CorrelatedSession } from "@kidkender/archmind-protocol"

const DEFAULT_THRESHOLD_MS = 500

function spanDurationMs(startNano: string, endNano: string): number {
  return Number(BigInt(endNano) - BigInt(startNano)) / 1_000_000
}

function toSeverity(ms: number): RuntimeFinding["severity"] {
  if (ms >= 2000) return "critical"
  if (ms >= 1000) return "high"
  return "medium"
}

export function detectSlowQuery(
  session: CorrelatedSession,
  thresholdMs = DEFAULT_THRESHOLD_MS,
): RuntimeFinding[] {
  const findings: RuntimeFinding[] = []

  for (const span of session.infraSpans) {
    if (!span.name.startsWith("db.") || !span.attributes["db.statement"]) continue

    const durationMs = Math.round(spanDurationMs(span.startTimeUnixNano, span.endTimeUnixNano))
    if (durationMs < thresholdMs) continue

    const stmt = String(span.attributes["db.statement"])
    const parentCorrelation = session.correlations.find(
      c => c.span.spanId === span.parentSpanId,
    )
    const nodeIds = parentCorrelation?.nodeId ? [parentCorrelation.nodeId] : []

    findings.push({
      type:     "slow_query",
      severity: toSeverity(durationMs),
      spanIds:  [span.spanId],
      nodeIds,
      evidence: `Query took ${durationMs}ms (threshold: ${thresholdMs}ms) — ${stmt.substring(0, 100)}`,
      metadata: {
        durationMs,
        thresholdMs,
        statement:     stmt,
        parentNodeId:  parentCorrelation?.nodeId ?? null,
      },
    })
  }

  return findings
}
