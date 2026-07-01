import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import { query } from "@kidkender/archmind-graph-query"

// ---------------------------------------------------------------------------
// SemanticContext type — structured representation of one execution path
// ---------------------------------------------------------------------------

export type RiskLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"

export interface ContextFinding {
  type:        string
  severity:    string
  description: string
}

export interface SemanticContext {
  entrypoint:   string
  method:       string
  path:         string
  is_mutation:  boolean

  summary:      string        // one-sentence human/LLM readable summary

  security: {
    is_public:    boolean
    auth_gates:   string[]    // e.g. ["auth:sanctum"]
    authorization: {
      enforced: boolean
      checks:   string[]      // policy/gate symbols
    }
    findings:     ContextFinding[]
    risk_level:   RiskLevel
  }

  transaction: {
    has_boundary:  boolean
    escape_risks:  string[]   // symbols of nodes that escape the transaction
  }

  validation: {
    has_form_request: boolean
    classes:          string[]
  }

  services:          string[]   // service class symbols called
  middleware:        string[]   // all middleware in chain
  async_side_effects: string[]  // queue jobs, events, mail, notifications
  node_count:        number
}

// ---------------------------------------------------------------------------
// Risk level calculation
// ---------------------------------------------------------------------------

function computeRiskLevel(findings: ContextFinding[], isPublicMutation: boolean): RiskLevel {
  if (isPublicMutation) return "CRITICAL"
  const hasCritical = findings.some((f) => f.severity === "CRITICAL")
  const hasHigh     = findings.some((f) => f.severity === "HIGH")
  const hasMedium   = findings.some((f) => f.severity === "MEDIUM")
  if (hasCritical) return "CRITICAL"
  if (hasHigh)     return "HIGH"
  if (hasMedium)   return "MEDIUM"
  if (findings.length > 0) return "LOW"
  return "NONE"
}

// ---------------------------------------------------------------------------
// Summary builder — single sentence describing the route
// ---------------------------------------------------------------------------

function buildSummary(
  g: IntermediateExecutionGraph,
  ctx: Omit<SemanticContext, "summary">,
): string {
  const parts: string[] = []

  parts.push(ctx.is_mutation ? "Mutating" : "Read-only")
  parts.push(ctx.security.is_public ? "public" : "authenticated")
  parts.push("route")

  if (ctx.transaction.has_boundary) parts.push("with transaction boundary")
  if (ctx.security.authorization.enforced) parts.push("and authorization checks")
  if (ctx.async_side_effects.length > 0) parts.push(`with ${ctx.async_side_effects.length} async side-effect(s)`)
  if (ctx.transaction.escape_risks.length > 0) parts.push("— WARNING: side-effects escape transaction")

  return parts.join(" ") + "."
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Transform an execution graph (+ optional pre-computed findings) into a
 * structured SemanticContext for AI consumption.
 *
 * `findings` should be an array of finding objects with at least
 * { type, severity, description } fields. Pass [] if not available.
 */
export function buildSemanticContext(
  graph: IntermediateExecutionGraph,
  findings: ContextFinding[] = [],
): SemanticContext {
  const q = query(graph)

  // Security
  const authGates    = q.security().authenticationGates().toArray().map((n) => n.symbol)
  const authzChecks  = q.security().authorizationChecks().toArray().map((n) => n.symbol)
  const isPublic     = !q.security().hasAuthentication()
  const isMutation   = q.isMutation()

  // Transaction
  const hasTxn       = q.transaction().exists()
  const escapes      = q.transaction().escapes().toArray().map((n) => n.symbol)

  // Validation
  const validations  = q.nodes().ofType(IR_NODE_TYPES.VALIDATION_GATE).toArray().map((n) => n.symbol)

  // Services
  const services     = q.calls().toArray().toArray().map((n) => n.symbol)

  // Middleware — all auth_gate nodes (includes named middleware)
  const middleware   = q.nodes().ofType(IR_NODE_TYPES.AUTH_GATE).toArray().map((n) => n.symbol)

  // Async side-effects
  const asyncNodes   = [
    ...q.nodes().ofType(IR_NODE_TYPES.QUEUE_JOB).toArray(),
    ...q.nodes().ofType(IR_NODE_TYPES.EVENT_DISPATCH).toArray(),
    ...q.nodes().ofType(IR_NODE_TYPES.NOTIFICATION).toArray(),
    ...q.nodes().ofType(IR_NODE_TYPES.MAIL).toArray(),
  ]
  const asyncSideEffects = asyncNodes.map((n) => n.symbol)

  const riskLevel = computeRiskLevel(findings, isPublic && isMutation)

  const ctx: Omit<SemanticContext, "summary"> = {
    entrypoint:  graph.entrypoint,
    method:      graph.method ?? "",
    path:        graph.path   ?? "",
    is_mutation: isMutation,

    security: {
      is_public:  isPublic,
      auth_gates: authGates,
      authorization: {
        enforced: q.security().hasAuthorization(),
        checks:   authzChecks,
      },
      findings,
      risk_level: riskLevel,
    },

    transaction: {
      has_boundary: hasTxn,
      escape_risks: escapes,
    },

    validation: {
      has_form_request: validations.length > 0,
      classes:          validations,
    },

    services,
    middleware,
    async_side_effects: asyncSideEffects,
    node_count: graph.nodes.length,
  }

  return { ...ctx, summary: buildSummary(graph, ctx) }
}

/**
 * Build context for all graphs in a project. Returns a map of entrypoint → context.
 */
export function buildProjectContext(
  graphs: IntermediateExecutionGraph[],
  findingsMap: Record<string, ContextFinding[]> = {},
): Record<string, SemanticContext> {
  const result: Record<string, SemanticContext> = {}
  for (const g of graphs) {
    result[g.entrypoint] = buildSemanticContext(g, findingsMap[g.entrypoint] ?? [])
  }
  return result
}
