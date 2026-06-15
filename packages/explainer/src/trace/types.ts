export type TracePattern = "auth" | "event" | "transaction" | "isolation" | "request" | "side_effects"

export interface AuthTraceEntry {
  entrypoint: string
  auth_gates: string[]        // middleware symbols
  authz_checks: string[]      // policy symbols
  validation_gates: string[]  // form_request symbols
  resources: string[]         // ir:resource symbols
  unprotected_resources: string[]
  has_auth: boolean
}

export interface EventTraceEntry {
  entrypoint: string
  dispatched_events: string[]   // txn_escape node symbols
  inside_transaction: boolean
}

export interface TransactionTraceEntry {
  entrypoint: string
  boundaries: string[]    // txn_boundary symbols
  writes: string[]        // txn_write symbols
  escapes: string[]       // txn_escape symbols (side-effects leaving txn)
}

export interface IsolationTraceEntry {
  entrypoint: string
  unscoped_queries: string[]
  unscoped_writes: string[]
  has_tenant_context: boolean
}

export interface RequestTraceEntry {
  entrypoint: string
  execution_path: Array<{
    nodeId: string
    symbol: string
    type: string
    role: string
  }>
}

export interface SideEffectsTraceEntry {
  entrypoint:        string
  queue_jobs:        string[]   // ir:queue_job symbols
  event_dispatches:  string[]   // ir:event_dispatch symbols
  api_resources:     string[]   // ir:api_resource symbols
  notifications:     string[]   // ir:notification symbols
  mails:             string[]   // ir:mail symbols (all)
  synchronous_mails: string[]   // ir:mail where detail.queued !== true
  has_side_effects:  boolean
}

export interface SideEffectsTraceSummary {
  routes_with_queue_jobs:        number
  routes_with_event_dispatches:  number
  routes_with_api_resources:     number
  routes_with_notifications:     number
  routes_with_mails:             number
  routes_with_synchronous_mails: number
}

export type TraceEntry =
  | AuthTraceEntry
  | EventTraceEntry
  | TransactionTraceEntry
  | IsolationTraceEntry
  | RequestTraceEntry
  | SideEffectsTraceEntry

export interface AuthTraceSummary {
  routes_with_auth: number
  routes_without_auth: number
  routes_with_unprotected_resources: number
}

export interface EventTraceSummary {
  routes_dispatching_events: number
  routes_with_unsafe_dispatch: number  // dispatch outside transaction
}

export interface TransactionTraceSummary {
  routes_with_transactions: number
  routes_with_escapes: number
}

export interface IsolationTraceSummary {
  routes_with_unscoped_queries: number
  routes_with_unscoped_writes: number
  routes_without_tenant_context: number
}

export interface TraceResult<E = TraceEntry, S = Record<string, number>> {
  pattern: TracePattern
  total_routes: number
  results: E[]
  summary: S
}
