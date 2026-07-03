import type { OtelSpan, RuntimeFinding } from "@kidkender/archmind-protocol"
import type { CorrelatedSession } from "@kidkender/archmind-protocol"

const DEFAULT_THRESHOLD = 5

interface QueryGroup {
  table: string
  spanIds: string[]
  statement: string
  parentSpanId: string
}

function extractTable(statement: string): string | null {
  // FROM <table> or UPDATE <table> or INSERT INTO <table>
  const m =
    statement.match(/\bFROM\s+[`"]?(\w+)[`"]?/i) ??
    statement.match(/\bUPDATE\s+[`"]?(\w+)[`"]?/i) ??
    statement.match(/\bINSERT\s+INTO\s+[`"]?(\w+)[`"]?/i)
  return m?.[1]?.toLowerCase() ?? null
}

function groupDbSpansByParent(infraSpans: OtelSpan[]): Map<string, OtelSpan[]> {
  const byParent = new Map<string, OtelSpan[]>()
  for (const span of infraSpans) {
    const key = span.parentSpanId ?? "__root__"
    const group = byParent.get(key) ?? []
    group.push(span)
    byParent.set(key, group)
  }
  return byParent
}

export function detectNPlusOne(
  session: CorrelatedSession,
  threshold = DEFAULT_THRESHOLD,
): RuntimeFinding[] {
  const findings: RuntimeFinding[] = []
  const dbSpans = session.infraSpans.filter(
    s => s.name.startsWith("db.") && s.attributes["db.statement"],
  )

  if (dbSpans.length < threshold) return findings

  const byParent = groupDbSpansByParent(dbSpans)

  for (const [parentSpanId, spans] of byParent) {
    // Group by table within this parent
    const byTable = new Map<string, QueryGroup>()

    for (const span of spans) {
      const stmt  = String(span.attributes["db.statement"] ?? "")
      const table = extractTable(stmt)
      if (!table) continue

      const existing = byTable.get(table)
      if (existing) {
        existing.spanIds.push(span.spanId)
      } else {
        byTable.set(table, {
          table,
          spanIds:      [span.spanId],
          statement:    stmt,
          parentSpanId,
        })
      }
    }

    for (const group of byTable.values()) {
      if (group.spanIds.length < threshold) continue

      // Find which graph node the parent span maps to
      const parentCorrelation = session.correlations.find(
        c => c.span.spanId === parentSpanId,
      )
      const nodeIds = parentCorrelation?.nodeId ? [parentCorrelation.nodeId] : []

      findings.push({
        type:     "n_plus_one",
        severity: group.spanIds.length >= 10 ? "high" : "medium",
        spanIds:  group.spanIds,
        nodeIds,
        evidence: `${group.spanIds.length}× SELECT from \`${group.table}\` under a single parent span — N+1 query pattern detected`,
        count:    group.spanIds.length,
        metadata: {
          table:          group.table,
          sampleStatement: group.statement.substring(0, 120),
          parentSpanId,
          parentNodeId:   parentCorrelation?.nodeId ?? null,
        },
      })
    }
  }

  return findings
}
