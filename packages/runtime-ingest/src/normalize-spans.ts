import type { OtelSpan } from "@kidkender/archmind-protocol"

// Infra span patterns that are not graph nodes
const INFRA_PATTERNS = [
  /^db\./,
  /^redis\./,
  /^http\.client/,
  /^queue\./,
  /^cache\./,
  /^aws\./,
]

export function isInfraSpan(span: OtelSpan): boolean {
  return INFRA_PATTERNS.some(p => p.test(span.name))
}

export function isRootSpan(span: OtelSpan): boolean {
  return !span.parentSpanId
}

/**
 * Normalize span attributes — no mutations, returns new spans.
 * Fills in derived fields from OTel semantic conventions.
 */
export function normalizeAttributes(spans: OtelSpan[]): OtelSpan[] {
  return spans.map(span => {
    const attrs = { ...span.attributes }

    // Derive http.route from span name if it looks like "METHOD /path"
    if (!attrs["http.route"] && /^(GET|POST|PUT|PATCH|DELETE|HEAD) /.test(span.name)) {
      attrs["http.route"] = span.name
    }

    return { ...span, attributes: attrs }
  })
}

/**
 * Find the entrypoint from the root HTTP span.
 * Returns "http.route" attribute if present, else span name.
 */
export function extractEntrypoint(spans: OtelSpan[]): string {
  const root = spans.find(isRootSpan)
  if (!root) return "unknown"
  return String(root.attributes["http.route"] ?? root.name)
}

/**
 * Total request duration in ms from root span.
 */
export function computeDurationMs(spans: OtelSpan[]): number {
  const root = spans.find(isRootSpan)
  if (!root) return 0
  return (
    (parseInt(root.endTimeUnixNano) - parseInt(root.startTimeUnixNano)) / 1_000_000
  )
}

/**
 * Partition spans into candidate (correlatable) and infra (db, cache, etc.)
 */
export function partitionSpans(spans: OtelSpan[]): {
  candidates: OtelSpan[]
  infra: OtelSpan[]
  root: OtelSpan | undefined
} {
  const root       = spans.find(isRootSpan)
  const infra      = spans.filter(s => s !== root && isInfraSpan(s))
  const candidates = spans.filter(s => s !== root && !isInfraSpan(s))
  return { candidates, infra, root }
}
