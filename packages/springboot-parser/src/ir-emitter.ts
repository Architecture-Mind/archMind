import { randomUUID } from "crypto"
import type { IntermediateExecutionGraph, ExecutionNode, ExecutionEdge } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES, IR_EDGE_RELATIONS, IR_VERSION } from "@kidkender/archmind-protocol"
import type { SpringControllerMethod, AuthAnnotation } from "./types.js"

// ---------------------------------------------------------------------------
// Emit one IntermediateExecutionGraph per SpringControllerMethod
// ---------------------------------------------------------------------------

export function emitGraph(m: SpringControllerMethod): IntermediateExecutionGraph {
  const nodes: ExecutionNode[] = []
  const edges: ExecutionEdge[] = []

  function node(type: string, symbol: string, extra?: Partial<ExecutionNode>): ExecutionNode {
    const n: ExecutionNode = { id: `svc_${randomUUID().slice(0, 8)}`, type, symbol, ...extra } as ExecutionNode
    nodes.push(n)
    return n
  }
  function edge(from: string, to: string, relation: string): void {
    const e: ExecutionEdge = { from, to, relation, traceability: "static" }
    edges.push(e)
  }

  // ------------------------------------------------------------------
  // 1. Auth gates / authz checks (run before the handler)
  // ------------------------------------------------------------------
  const guardIds: string[] = []
  for (const ann of m.authAnnotations) {
    const type = classifyAuthAnnotation(ann)
    const n = node(type, formatAuthSymbol(ann))
    guardIds.push(n.id)
  }

  // ------------------------------------------------------------------
  // 2. Validation gate (@Valid on request body)
  // ------------------------------------------------------------------
  let validationId: string | null = null
  if (m.hasValidation) {
    const label = m.validatedParamTypes.length
      ? m.validatedParamTypes.join(", ")
      : "RequestBody"
    const n = node(IR_NODE_TYPES.VALIDATION_GATE, label)
    validationId = n.id
  }

  // ------------------------------------------------------------------
  // 3. Business handler (controller method)
  // ------------------------------------------------------------------
  const handler = node(IR_NODE_TYPES.BUSINESS_HANDLER, `${m.className}::${m.methodName}`)

  // Wire: guards → handler
  for (const gid of guardIds) edge(gid, handler.id, "ir:guards")
  if (validationId)             edge(validationId, handler.id, "ir:validates")

  // ------------------------------------------------------------------
  // 4. Transaction boundary
  // ------------------------------------------------------------------
  let txnId: string | null = null
  if (m.isTransactional) {
    const label = m.readOnly ? "@Transactional(readOnly=true)" : "@Transactional"
    const txn = node(IR_NODE_TYPES.TXN_BOUNDARY, label)
    txnId = txn.id
    edge(handler.id, txnId, IR_EDGE_RELATIONS.CALLS)
  }

  const callFrom = txnId ?? handler.id

  // ------------------------------------------------------------------
  // 5. Service calls
  // ------------------------------------------------------------------
  for (const svc of m.serviceCalls) {
    const n = node(IR_NODE_TYPES.SERVICE_CALL, `${svc.fieldType}::${svc.method}`)
    edge(callFrom, n.id, IR_EDGE_RELATIONS.CALLS)
  }

  // ------------------------------------------------------------------
  // 6. Data access (repository calls)
  // ------------------------------------------------------------------
  for (const dao of m.dataAccessCalls) {
    const type = dao.isWrite ? IR_NODE_TYPES.TXN_WRITE : IR_NODE_TYPES.SCOPED_QUERY
    const rel  = dao.isWrite ? "ir:writes" : "ir:queries"
    const n    = node(type, `${dao.fieldType}::${dao.method}`)
    edge(callFrom, n.id, rel)
  }

  // ------------------------------------------------------------------
  // 7. Event publications
  // ------------------------------------------------------------------
  for (const ev of m.eventPublications) {
    const n = node(IR_NODE_TYPES.EVENT_DISPATCH, `${ev.className}::publish`)
    edge(callFrom, n.id, "ir:dispatches")
    // Event dispatched inside @Transactional = potential txn escape
    if (ev.insideTxn && txnId) {
      edge(n.id, txnId, "escapes_transaction")
    }
  }

  // ------------------------------------------------------------------
  // 8. Async calls
  // ------------------------------------------------------------------
  for (const sym of m.asyncCalls) {
    const n = node(IR_NODE_TYPES.QUEUE_JOB, sym)
    edge(callFrom, n.id, "ir:dispatches")
  }

  // ------------------------------------------------------------------
  // 9. Messaging (Rabbit / Kafka / JMS)
  // ------------------------------------------------------------------
  for (const sym of m.messagingCalls) {
    const n = node(IR_NODE_TYPES.QUEUE_JOB, sym)
    edge(callFrom, n.id, "ir:dispatches")
  }

  // ------------------------------------------------------------------
  // 10. Mail
  // ------------------------------------------------------------------
  for (const sym of m.mailCalls) {
    const n = node(IR_NODE_TYPES.MAIL, sym)
    edge(callFrom, n.id, "ir:dispatches")
  }

  return {
    entrypoint:  `${m.httpMethod} ${m.path}`,
    method:      m.httpMethod,
    path:        m.path,
    framework:   "springboot",
    ir_ver:      IR_VERSION,
    nodes,
    edges,
    annotations: [],
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyAuthAnnotation(ann: AuthAnnotation): string {
  if (ann.isAuthOnly) return IR_NODE_TYPES.AUTH_GATE
  // Any role/permission/authority check = authz
  if (
    ann.expression.includes("hasRole") ||
    ann.expression.includes("hasAuthority") ||
    ann.expression.includes("hasPermission") ||
    ann.expression.includes("hasAnyRole") ||
    ann.kind === "secured" ||
    ann.kind === "rolesAllowed"
  ) return IR_NODE_TYPES.AUTHZ_CHECK
  // Generic @PreAuthorize that isn't purely isAuthenticated
  return IR_NODE_TYPES.AUTHZ_CHECK
}

function formatAuthSymbol(ann: AuthAnnotation): string {
  switch (ann.kind) {
    case "preAuthorize": return `@PreAuthorize("${ann.expression}")`
    case "secured":      return `@Secured("${ann.expression}")`
    case "rolesAllowed": return `@RolesAllowed("${ann.expression}")`
  }
}
