import type { OtelSpan, CorrelatedSession } from "@kidkender/archmind-protocol"

export type SpanCategory =
  | "queue_job"
  | "event_listener"
  | "event_dispatch"
  | "api_resource"
  | "notification"
  | "mail"
  | "policy"
  | "scheduled_command"
  | "middleware"
  | "controller"
  | "service"
  | "db_infra"
  | "http_infra"
  | "cache_infra"
  | "unknown"

export interface SpanCategoryBreakdown {
  category: SpanCategory
  count: number
  percentage: number
  examples: string[]
}

export interface GapReport {
  totalSpans: number
  matchedSpans: number
  unmatchedSpans: number
  coverageScore: number
  breakdown: SpanCategoryBreakdown[]
  topGaps: SpanCategoryBreakdown[]
}

// ─── Laravel namespace / span-name heuristics ────────────────────────────────

const NAMESPACE_RULES: Array<{ pattern: RegExp; category: SpanCategory }> = [
  { pattern: /\\Jobs\\/i,                          category: "queue_job" },
  { pattern: /\\Listeners\\/i,                     category: "event_listener" },
  { pattern: /\\Events\\/i,                        category: "event_dispatch" },
  { pattern: /\\Http\\Resources\\/i,               category: "api_resource" },
  { pattern: /\\Notifications\\/i,                 category: "notification" },
  { pattern: /\\Mail\\/i,                          category: "mail" },
  { pattern: /\\Policies\\/i,                      category: "policy" },
  { pattern: /\\Console\\Commands\\/i,             category: "scheduled_command" },
  { pattern: /\\Http\\Middleware\\/i,              category: "middleware" },
  { pattern: /\\Http\\Controllers\\/i,             category: "controller" },
  { pattern: /\\Services\\/i,                      category: "service" },
]

const SPAN_NAME_RULES: Array<{ pattern: RegExp; category: SpanCategory }> = [
  { pattern: /^queue\.job\./i,                     category: "queue_job" },
  { pattern: /^event\./i,                          category: "event_dispatch" },
  { pattern: /^(Illuminate|laravel)\\.*Job/i,      category: "queue_job" },
  { pattern: /^db\.(select|insert|update|delete|statement)/i, category: "db_infra" },
  { pattern: /^(GET|POST|PUT|PATCH|DELETE) \//,    category: "http_infra" },
  { pattern: /^cache\./i,                          category: "cache_infra" },
  { pattern: /^redis\./i,                          category: "cache_infra" },
]

function classifySpan(span: OtelSpan): SpanCategory {
  // Check code.namespace attribute first (most reliable)
  const ns = String(span.attributes["code.namespace"] ?? "")
  if (ns) {
    for (const rule of NAMESPACE_RULES) {
      if (rule.pattern.test(ns)) return rule.category
    }
  }

  // Fall back to span.name heuristics
  for (const rule of SPAN_NAME_RULES) {
    if (rule.pattern.test(span.name)) return rule.category
  }

  // Laravel queue worker span names often look like "App\Jobs\SendEmailJob"
  if (/^App\\/.test(span.name)) {
    for (const rule of NAMESPACE_RULES) {
      if (rule.pattern.test(span.name)) return rule.category
    }
  }

  return "unknown"
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function generateGapReport(session: CorrelatedSession): GapReport {
  const unmatched = session.correlations.filter(c => c.confidence === "none")
  const matched = session.correlations.filter(c => c.confidence !== "none")
  const total = session.correlations.length

  // Classify each unmatched span
  const categorized = new Map<SpanCategory, OtelSpan[]>()
  for (const c of unmatched) {
    const cat = classifySpan(c.span)
    if (!categorized.has(cat)) categorized.set(cat, [])
    categorized.get(cat)!.push(c.span)
  }

  const breakdown: SpanCategoryBreakdown[] = Array.from(categorized.entries())
    .map(([category, spans]) => ({
      category,
      count: spans.length,
      percentage: total > 0 ? Math.round((spans.length / total) * 100) : 0,
      examples: [...new Set(spans.map(s => s.name))].slice(0, 3),
    }))
    .sort((a, b) => b.count - a.count)

  const coverageScore = total > 0 ? matched.length / total : 0

  // Top gaps = unmatched categories that are NOT pure infra
  const infraCategories: SpanCategory[] = ["db_infra", "http_infra", "cache_infra"]
  const topGaps = breakdown.filter(b => !infraCategories.includes(b.category))

  return {
    totalSpans: total,
    matchedSpans: matched.length,
    unmatchedSpans: unmatched.length,
    coverageScore,
    breakdown,
    topGaps,
  }
}

export function formatGapReport(report: GapReport): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`
  const lines: string[] = [
    `Runtime Coverage Score: ${pct(report.coverageScore)} (${report.matchedSpans}/${report.totalSpans} spans matched)`,
    "",
    "Unmatched Span Breakdown:",
  ]

  for (const b of report.breakdown) {
    const bar = "█".repeat(Math.round(b.percentage / 5))
    lines.push(`  ${b.category.padEnd(20)} ${String(b.percentage + "%").padStart(4)}  ${bar}`)
    if (b.examples.length > 0) {
      lines.push(`    e.g. ${b.examples.join(", ")}`)
    }
  }

  if (report.topGaps.length > 0) {
    lines.push("", "Top Semantic Gaps (parser targets):")
    for (const g of report.topGaps.slice(0, 5)) {
      lines.push(`  → ${g.category}: ${g.percentage}% of total spans unmatched`)
    }
  }

  return lines.join("\n")
}
