import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { FactEntry } from "./types.js"

export type RelevanceTier = "high" | "medium" | "low"
const TIER: Record<RelevanceTier, number> = { high: 3, medium: 2, low: 1 }

// Relevance of each fact type per intent.
// HIGH = critical to answering the question, always include even if absent.
// MEDIUM = supporting context, include if present.
// LOW = background noise for this intent, omit if absent.
export const FACT_RELEVANCE: Record<string, Record<string, RelevanceTier>> = {
  auth: {
    auth_middleware:  "high",
    authz_check:      "high",
    ownership_check:  "high",
    permission:       "high",
    unknown_security: "high",
    resource_bound:   "medium",
    form_request:     "low",
    txn_boundary:     "low",
    tenant_context:   "low",
  },
  transaction: {
    txn_boundary:     "high",
    txn_write:        "high",
    txn_escape:       "high",
    auth_middleware:  "medium",
    authz_check:      "low",
    form_request:     "low",
  },
  validation: {
    form_request:     "high",
    auth_middleware:  "medium",
    authz_check:      "medium",
    permission:       "low",
  },
  isolation: {
    tenant_context:   "high",
    unscoped_query:   "high",
    scoped_query:     "high",
    auth_middleware:  "medium",
    authz_check:      "low",
  },
  runtime: {
    runtime_inject:   "high",
    runtime_consume:  "high",
    tenant_context:   "medium",
    auth_middleware:  "low",
  },
  all: {},
}

function joinSymbols(nodes: Array<{ symbol: string }>): string | undefined {
  const s = nodes.map(n => n.symbol).filter(Boolean).join(", ")
  return s || undefined
}

// Merge relevance maps for multiple intents — take max tier per fact type.
export function mergeRelevanceMaps(intents: string[]): Record<string, RelevanceTier> {
  const merged: Record<string, RelevanceTier> = {}
  for (const intent of intents) {
    const rel = FACT_RELEVANCE[intent] ?? {}
    for (const [type, relevance] of Object.entries(rel)) {
      const current = merged[type]
      if (!current || TIER[relevance] > TIER[current]) merged[type] = relevance
    }
  }
  return merged
}

export function extractFacts(
  graph: IntermediateExecutionGraph,
  intent: string | string[]
): FactEntry[] {
  const intents = Array.isArray(intent) ? intent : [intent]
  const rel = intents.length === 1
    ? (FACT_RELEVANCE[intents[0]] ?? {})
    : mergeRelevanceMaps(intents)

  const fact = (
    type: string,
    nodes: Array<{ symbol: string }>,
    extra?: string
  ): FactEntry => {
    const relevance = rel[type] ?? "low"
    const present = nodes.length > 0
    const value = extra ?? joinSymbols(nodes)
    // Always include HIGH-relevance facts (even absent ones — absence is informative).
    // Skip absent MEDIUM/LOW facts — they add noise.
    return { type, present, value: present ? value : undefined, relevance }
  }

  const byType = (t: string) => graph.nodes.filter(n => n.type === t)

  const authGates    = byType("ir:auth_gate")
  // Recognized-as-security-shaped but unclassified annotation (e.g. a custom
  // framework's @PreAuth) — an honest "don't know", not evidence of no-auth.
  const unknownSec   = byType("ir:unknown_middleware")
  // FormRequest nodes with ::authorize() count as delegated authz_check (not just validation)
  const explicitAuthz    = byType("ir:authz_check")
  const formReqAuthzNodes = byType("ir:validation_gate").filter(n =>
    n.symbol.toLowerCase().includes("authorize")
  )
  const authzChecks  = [...explicitAuthz, ...formReqAuthzNodes]
  const permissions  = byType("ir:permission_constant")
  const resources    = byType("ir:resource")
  const formReqs     = byType("ir:validation_gate")
  const txnBounds    = byType("ir:txn_boundary")
  const txnWrites    = byType("ir:txn_write")
  const txnEscapes   = byType("ir:txn_escape")
  const tenantCtx    = byType("ir:tenant_context")
  const scopedQ      = byType("ir:scoped_query")
  const unscopedQ    = byType("ir:unscoped_query")
  const runtimeInj   = byType("ir:runtime_inject")
  const runtimeCons  = byType("ir:runtime_consume")

  // ownership_check: authz_check nodes that look like a policy (not just permission strings)
  const ownershipNodes = authzChecks.filter(n =>
    n.symbol.toLowerCase().includes("policy") ||
    (n.role ?? "").toLowerCase().includes("policy")
  )

  const raw: FactEntry[] = [
    fact("auth_middleware", authGates),
    fact("unknown_security", unknownSec),
    fact("authz_check",     authzChecks),
    fact("ownership_check", ownershipNodes),
    fact("permission",      permissions),
    fact("resource_bound",  resources),
    fact("form_request",    formReqs),
    fact("txn_boundary",    txnBounds),
    fact("txn_write",       txnWrites),
    fact("txn_escape",      txnEscapes),
    fact("tenant_context",  tenantCtx),
    fact("scoped_query",    scopedQ),
    fact("unscoped_query",  unscopedQ),
    fact("runtime_inject",  runtimeInj),
    fact("runtime_consume", runtimeCons),
  ]

  // Keep: present facts OR absent HIGH-relevance facts (missing is informative)
  return raw.filter(f => f.present || f.relevance === "high")
}
