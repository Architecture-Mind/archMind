// Core graph types — structural definitions only.
// Node/edge `type` and `relation` are string, not enum: ontology is still evolving.

export const PROTOCOL_VERSION = "1.0.0"

// ---------------------------------------------------------------------------
// Edge relation registry — stable as of v1.0.0
// ---------------------------------------------------------------------------

export const EDGE_RELATIONS = {
  NEXT_MIDDLEWARE:    "next_middleware",
  CALLS:              "calls",
  POLICY_CHECK:       "policy_check",
  VALIDATES:          "validates",
  PERMISSION_GATE:    "permission_gate",
  INJECTS:            "injects",
  TRANSACTION_WRAP:   "transaction_wrap",
  DISPATCHES:         "dispatches",
  WRITES:             "writes",
} as const

export type KnownEdgeRelation = typeof EDGE_RELATIONS[keyof typeof EDGE_RELATIONS]

// ---------------------------------------------------------------------------
// Annotation type registry
// ---------------------------------------------------------------------------

export const ANNOTATION_TYPES = {
  AUTH_GAP:            "auth_gap",
  DOUBLE_CHECK:        "double_check",
  MISSING_POLICY:      "missing_policy",
  TXN_ANOMALY:         "txn_anomaly",
  ISOLATION_RISK:      "isolation_risk",
  RUNTIME_ANOMALY:     "runtime_anomaly",
} as const

export type KnownAnnotationType = typeof ANNOTATION_TYPES[keyof typeof ANNOTATION_TYPES]

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type Confidence = "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN"

export type EdgeTraceability = "static" | "semantic" | "runtime" | "probabilistic"

export type RetrievalFocus = "auth" | "validation" | "runtime" | "transaction" | "isolation" | "side_effects" | "all"

export interface ExecutionNode {
  id:               string
  type:             string    // use KnownNodeType for known values
  symbol:           string    // e.g. "ResolveTenant::handle", "auth:sanctum"
  file?:            string    // relative path from project root
  args?:            string[]  // e.g. ["task.update"] for CheckPermission
  role?:            string    // semantic hint: "auth_layer_1", "tenant_resolver", etc.
  detail?:          string    // JSON-serialized node-specific metadata (e.g. api_resource field list)
  occurrenceCount?: number    // set by deduplicate() when multiple nodes are merged into one
}

export interface ExecutionEdge {
  from:          string
  to:            string
  relation:      string           // use KnownEdgeRelation for known values
  traceability:  EdgeTraceability
  mechanism?:    string           // e.g. "$this->authorize('update', $task)"
  side_effect?:  string           // e.g. "injects app('tenant')"
}

export interface GraphAnnotation {
  type:        string             // use KnownAnnotationType for known values
  nodes?:      string[]
  description: string
  severity?:   "critical" | "high" | "medium" | "low" | "info"
  fix?:        string
  confidence?: Confidence
  evidence?:   string[]
}

export interface IntermediateExecutionGraph {
  entrypoint:   string            // e.g. "PUT /tasks/{id}"
  method:       string            // "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
  path:         string            // e.g. "/tasks/{id}"
  nodes:        ExecutionNode[]
  edges:        ExecutionEdge[]
  annotations:  GraphAnnotation[]
  framework?:   string            // "laravel" | "nestjs" | "django" — set by adapter, for diagnostics
  ir_ver?:      string            // IR spec version that emitted this graph (from ir.ts IR_VERSION)
  adapter_ver?: string            // adapter package version that emitted this graph (for regression keying)
}

export interface RetrievalRequest {
  entrypoint: string              // e.g. "PUT /tasks/{id}"
  focus?:     RetrievalFocus      // omit for full graph (R0)
  query?:     string              // user query for keyword-based node ranking
}

export interface RetrievalResult {
  entrypoint:        string
  nodes:             ExecutionNode[]
  edges:             ExecutionEdge[]
  token_estimate:    number          // rough: JSON length / 4
  pruned:            boolean         // false at R0, true when relevance pruning applied
  focus:             RetrievalFocus  // "all" when unpruned
  protocol_version:  string          // PROTOCOL_VERSION at time of retrieval
}
