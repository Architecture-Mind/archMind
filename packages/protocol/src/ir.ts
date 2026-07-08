// Semantic IR — framework-agnostic vocabulary for ArchMind execution graphs.
// This is the target type system. Laravel-specific strings in graph.ts are
// the current source of truth; migration happens adapter-by-adapter.
//
// Spec: research/semantic-ir/spec.md

export const IR_VERSION = "1.10"

// Semantic Coverage (narrow scope — the 6 gaps from
// research/semantic-ir/v1.5-semantic-fidelity-plan.md, per discuss6.txt's
// proposed metric): 6/6. All 6 phases landed AND real-repo regression-checked
// against koel/BookStack (not just unit fixtures) as of IR_VERSION 1.10 —
// see research/semantic-ir/v1.5-session-handoff.md for what each phase's
// real-repo verification actually found and fixed.

// ---------------------------------------------------------------------------
// IR Node Types
// ---------------------------------------------------------------------------

export const IR_NODE_TYPES = {
  // HTTP Request domain
  ENTRYPOINT:          "ir:entrypoint",
  AUTH_GATE:           "ir:auth_gate",
  AUTHZ_CHECK:         "ir:authz_check",
  BUSINESS_HANDLER:    "ir:business_handler",
  VALIDATION_GATE:     "ir:validation_gate",
  SERVICE_CALL:        "ir:service_call",
  PERMISSION_CONSTANT: "ir:permission_constant",

  // Runtime context domain
  RUNTIME_INJECT:      "ir:runtime_inject",
  RUNTIME_CONSUME:     "ir:runtime_consume",
  TENANT_CONTEXT:      "ir:tenant_context",

  // Data access domain
  SCOPED_QUERY:        "ir:scoped_query",
  UNSCOPED_QUERY:      "ir:unscoped_query",
  UNSCOPED_WRITE:      "ir:unscoped_write",

  // Transaction domain
  TXN_BOUNDARY:        "ir:txn_boundary",
  TXN_WRITE:           "ir:txn_write",
  TXN_ESCAPE:          "ir:txn_escape",

  // Resource domain (IR v1.1)
  RESOURCE:            "ir:resource",

  // API Response domain (IR v1.2)
  API_RESOURCE:        "ir:api_resource",

  // Async dispatch domain (IR v1.3)
  QUEUE_JOB:           "ir:queue_job",
  EVENT_DISPATCH:      "ir:event_dispatch",

  // Side-effect domain (IR v1.4)
  NOTIFICATION:        "ir:notification",
  MAIL:                "ir:mail",

  // Semantic fidelity domain (IR v1.5)
  UNKNOWN_MIDDLEWARE:  "ir:unknown_middleware",  // resolved name but unclassified — honest "don't know" instead of a guessed auth_gate
  GUARD_CLAUSE:        "ir:guard_clause",        // a call that can short-circuit execution via throw/abort based on a precondition
  AUDIT_LOG:           "ir:audit_log",           // side-effect: a durable audit/activity-log record is created
  CONDITIONAL_BRANCH:  "ir:conditional_branch",  // execution forks based on a named condition (narrow cut: request-param-driven only)
} as const

export type IRNodeType = typeof IR_NODE_TYPES[keyof typeof IR_NODE_TYPES]

// ---------------------------------------------------------------------------
// IR Edge Relations
// ---------------------------------------------------------------------------

export const IR_EDGE_RELATIONS = {
  PRECEDES:          "ir:precedes",
  CALLS:             "ir:calls",
  GUARDS:            "ir:guards",
  VALIDATES:         "ir:validates",
  INJECTS:           "ir:injects",
  CHECKS_PERMISSION: "ir:checks_permission",
  ACCESSES:          "ir:accesses",
  WRAPS:             "ir:wraps",
  ESCAPES:           "ir:escapes",
  AUTHORIZES:        "ir:authorizes",
  RETURNS:           "ir:returns",
  DISPATCHES:        "ir:dispatches",
  SENDS:             "ir:sends",
  CONTROLS:          "ir:controls",
} as const

export type IREdgeRelation = typeof IR_EDGE_RELATIONS[keyof typeof IR_EDGE_RELATIONS]

// ---------------------------------------------------------------------------
// IR Annotation Types (detections — run on IR, framework-agnostic)
// ---------------------------------------------------------------------------

export const IR_ANNOTATION_TYPES = {
  AUTH_GAP:      "ir:auth_gap",
  AUTHZ_GAP:     "ir:authz_gap",
  MISSING_POLICY: "ir:missing_policy",
  DOUBLE_CHECK:  "ir:double_check",
  TXN_ESCAPE:       "ir:txn_escape",
  MISSING_TXN:      "ir:missing_txn",
  ISOLATION_RISK:   "ir:isolation_risk",
  RESOURCE_MISMATCH: "ir:resource_mismatch",
} as const

export type IRAnnotationType = typeof IR_ANNOTATION_TYPES[keyof typeof IR_ANNOTATION_TYPES]

// ---------------------------------------------------------------------------
// Laravel adapter mapping — legacy type → IR type
// Used during migration to normalise graphs emitted before full IR adoption.
// ---------------------------------------------------------------------------

export const LARAVEL_TO_IR: Record<string, IRNodeType> = {
  // Auth / validation domain
  "authentication_gate":  IR_NODE_TYPES.AUTH_GATE,
  "authorization_check":  IR_NODE_TYPES.AUTHZ_CHECK,
  "controller_action":    IR_NODE_TYPES.BUSINESS_HANDLER,
  "form_request":         IR_NODE_TYPES.VALIDATION_GATE,
  "service_call":         IR_NODE_TYPES.SERVICE_CALL,
  "permission":           IR_NODE_TYPES.PERMISSION_CONSTANT,
  "middleware":           IR_NODE_TYPES.AUTH_GATE,       // default; middleware-mapper classifies more specifically
  "policy":               IR_NODE_TYPES.AUTHZ_CHECK,
  "runtime_injection":    IR_NODE_TYPES.RUNTIME_INJECT,

  // Transaction domain
  "transaction_boundary": IR_NODE_TYPES.TXN_BOUNDARY,
  "transactional_write":  IR_NODE_TYPES.TXN_WRITE,
  "transaction_escape":   IR_NODE_TYPES.TXN_ESCAPE,

  // Isolation domain
  "unscoped_query":       IR_NODE_TYPES.UNSCOPED_QUERY,
  "unscoped_write":       IR_NODE_TYPES.UNSCOPED_WRITE,
  "tenant_scoped_query":  IR_NODE_TYPES.SCOPED_QUERY,
}

// Normalise a node type string: if it's a legacy Laravel type, return the IR equivalent.
// If it's already an IR type (starts with "ir:"), return as-is.
// Unknown types pass through unchanged.
export function toIRNodeType(type: string): string {
  if (type.startsWith("ir:")) return type
  return LARAVEL_TO_IR[type] ?? type
}

// ---------------------------------------------------------------------------
// IR conformance check
// ---------------------------------------------------------------------------

const IR_TYPE_SET = new Set<string>(Object.values(IR_NODE_TYPES))
const IR_EDGE_SET = new Set<string>(Object.values(IR_EDGE_RELATIONS))
const LEGACY_NODE_SET = new Set<string>(Object.keys(LARAVEL_TO_IR))

// Edge relations that parsers still emit pre-IR-migration.
// Each entry is a known legacy string that should eventually get an IR equivalent.
export const LEGACY_EDGE_RELATIONS: ReadonlyArray<string> = [
  "calls",               // → ir:calls
  "validates",           // → ir:validates
  "dispatches",          // → ir:dispatches (string, not constant)
  "escapes_transaction", // → needs IR equivalent
  "form_request",        // → needs IR equivalent
  "next_middleware",     // → needs IR equivalent
  "opens_transaction",   // → needs IR equivalent
  "policy_check",        // → needs IR equivalent
  "responds_with",       // → needs IR equivalent
  "missing_tenant_scope",// → needs IR equivalent
  "ir:includes",         // → needs IR normalization
  "guards",              // → ir:guards (string, not constant)
  "authorizes",          // → ir:authorizes (string, not constant)
]

const LEGACY_EDGE_SET = new Set<string>(LEGACY_EDGE_RELATIONS)

export function isIRNodeType(type: string): type is IRNodeType {
  return IR_TYPE_SET.has(type)
}

export function isIREdgeRelation(relation: string): relation is IREdgeRelation {
  return IR_EDGE_SET.has(relation)
}

export interface GraphViolation {
  kind:     "unknown_node_type" | "legacy_node_type" | "unknown_edge_relation" | "legacy_edge_relation"
  id?:      string   // node id (for node violations)
  edgeKey?: string   // "from→to" (for edge violations)
  value:    string   // the offending type or relation string
}

/**
 * Validates all node types and edge relations in a graph against the IR schema.
 *
 * - unknown_node_type: type not in IR_NODE_TYPES and not in LARAVEL_TO_IR
 * - legacy_node_type:  type is a known legacy string (present in LARAVEL_TO_IR)
 * - unknown_edge_relation: relation not in IR_EDGE_RELATIONS and not in LEGACY_EDGE_RELATIONS
 * - legacy_edge_relation:  relation is in LEGACY_EDGE_RELATIONS (known but not IR)
 *
 * Conformance = no unknown_* violations. Legacy violations are migration debt,
 * not failures.
 */
export function validateGraph(graph: {
  nodes: Array<{ id: string; type: string }>
  edges: Array<{ from: string; to: string; relation: string }>
}): { conformant: boolean; violations: GraphViolation[] } {
  const violations: GraphViolation[] = []

  for (const node of graph.nodes) {
    if (IR_TYPE_SET.has(node.type)) continue
    if (LEGACY_NODE_SET.has(node.type)) {
      violations.push({ kind: "legacy_node_type", id: node.id, value: node.type })
    } else {
      violations.push({ kind: "unknown_node_type", id: node.id, value: node.type })
    }
  }

  for (const edge of graph.edges) {
    const key = `${edge.from}→${edge.to}`
    if (IR_EDGE_SET.has(edge.relation)) continue
    if (LEGACY_EDGE_SET.has(edge.relation)) {
      violations.push({ kind: "legacy_edge_relation", edgeKey: key, value: edge.relation })
    } else {
      violations.push({ kind: "unknown_edge_relation", edgeKey: key, value: edge.relation })
    }
  }

  const conformant = !violations.some(
    (v) => v.kind === "unknown_node_type" || v.kind === "unknown_edge_relation"
  )

  return { conformant, violations }
}
