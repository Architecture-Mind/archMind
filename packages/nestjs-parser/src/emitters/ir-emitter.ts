import type { IntermediateExecutionGraph, ExecutionNode, ExecutionEdge, DTOSchema } from "@kidkender/archmind-protocol"
import { IR_VERSION, IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import type { NestJSSemanticRoute } from "../types.js"

const ADAPTER_VERSION = "0.2.0"

export function emitGraphs(
  routes: NestJSSemanticRoute[],
  globalPipes: boolean = false,
  dtoIndex: Map<string, DTOSchema> = new Map()
): IntermediateExecutionGraph[] {
  return routes.map(r => emitGraph(r, globalPipes, dtoIndex))
}

function emitGraph(
  route: NestJSSemanticRoute,
  globalPipes: boolean,
  dtoIndex: Map<string, DTOSchema>
): IntermediateExecutionGraph {
  const nodes: ExecutionNode[] = []
  const edges: ExecutionEdge[] = []

  // Guard nodes (auth_gate / authz_check / unknown_guard)
  for (let i = 0; i < route.guards.length; i++) {
    const guard = route.guards[i]
    const id = `mw_${i}_${slug(guard.className)}`
    nodes.push({
      id,
      type: guard.irType,
      symbol: guard.className,
      role: guard.irType === "ir:auth_gate" ? "authentication" : "authorization",
      ...(guard.args.length > 0 && { args: guard.args }),
    })
  }

  // Business handler node
  const [, methodName = "handle"] = route.symbol.split("::")
  const handlerId = `ctrl_${slug(route.controllerClass)}_${slug(methodName)}`
  nodes.push({
    id: handlerId,
    type: IR_NODE_TYPES.BUSINESS_HANDLER,
    symbol: route.symbol,
    role: "handler",
    file: route.file,
  })

  // Validation gate — only when DTO is present + ValidationPipe active
  if (route.dto && (route.validationPipe || globalPipes)) {
    const dtoId = `vg_${slug(route.dto)}`
    const dtoSchema = dtoIndex.get(route.dto)
    nodes.push({
      id: dtoId,
      type: IR_NODE_TYPES.VALIDATION_GATE,
      symbol: route.dto,
      role: "validation",
      ...(dtoSchema ? {
        file:   dtoSchema.file,
        detail: JSON.stringify({ fields: dtoSchema.fields }),
      } : {}),
    })
    edges.push({
      from: handlerId,
      to: dtoId,
      relation: "validates",
      traceability: "static",
    })
  }

  // Side-effect nodes (ir:queue_job, ir:event_dispatch, ir:mail, ir:notification)
  for (let i = 0; i < route.sideEffects.length; i++) {
    const se = route.sideEffects[i]
    const seId = `se_${i}_${slug(se.symbol)}`
    nodes.push({
      id: seId,
      type: se.type,
      symbol: se.symbol,
      role: "side_effect",
      ...(se.queued !== undefined && {
        detail: JSON.stringify({ queued: se.queued }),
      }),
    })
    edges.push({
      from: handlerId,
      to: seId,
      relation: "dispatches",
      traceability: "static",
    })
  }

  // Service call nodes (ir:service_call)
  for (let i = 0; i < (route.serviceCalls?.length ?? 0); i++) {
    const sc = route.serviceCalls[i]
    const scId = `svc_${slug(sc.serviceClass)}_${slug(sc.method)}_${handlerId}`
    nodes.push({
      id: scId,
      type: "ir:service_call",
      symbol: sc.symbol,
      role: "service",
    })
    edges.push({
      from: handlerId,
      to: scId,
      relation: "calls",
      traceability: "semantic",
    })
  }

  // Response resource node (ir:api_resource)
  if (route.responseResource) {
    const rr   = route.responseResource
    const rrId = `api_resource_${slug(rr.className)}_${handlerId}`
    nodes.push({
      id:     rrId,
      type:   "ir:api_resource",
      symbol: `${rr.className}::serialize`,
      role:   "response",
      ...(rr.fields.length > 0 && {
        detail: JSON.stringify({
          fields:           rr.fields.map(f => f.name),
          sensitiveFields:  rr.sensitiveFields,
          excludedByDefault: rr.excludedByDefault,
        }),
      }),
    })
    edges.push({
      from:         handlerId,
      to:           rrId,
      relation:     "responds_with",
      traceability: "static",
    })
  }

  // Transaction nodes (ir:txn_boundary + ir:txn_write)
  for (let i = 0; i < (route.transactions?.length ?? 0); i++) {
    const txn   = route.transactions[i]
    const txnId = `txn_${i}_${handlerId}`
    nodes.push({
      id:     txnId,
      type:   IR_NODE_TYPES.TXN_BOUNDARY,
      symbol: txn.symbol,
      role:   "atomicity",
    })
    edges.push({
      from:         handlerId,
      to:           txnId,
      relation:     "opens_transaction",
      traceability: "static",
    })
    for (let j = 0; j < txn.writes.length; j++) {
      const w       = txn.writes[j]
      const writeId = `txn_write_${i}_${j}_${handlerId}`
      nodes.push({
        id:     writeId,
        type:   IR_NODE_TYPES.TXN_WRITE,
        symbol: `${w.entity}::${w.operation}`,
        role:   "persistence",
      })
      edges.push({
        from:         txnId,
        to:           writeId,
        relation:     "within_transaction",
        traceability: "static",
      })
    }
  }

  // Guard chain: mw_0 → mw_1 → ... → handler
  const guardNodes = nodes.filter(n => n.id.startsWith("mw_"))
  for (let i = 0; i < guardNodes.length - 1; i++) {
    edges.push({
      from: guardNodes[i].id,
      to: guardNodes[i + 1].id,
      relation: "next_middleware",
      traceability: "static",
    })
  }
  if (guardNodes.length > 0) {
    edges.push({
      from: guardNodes[guardNodes.length - 1].id,
      to: handlerId,
      relation: "next_middleware",
      traceability: "static",
    })
  }

  return {
    entrypoint: `${route.method} ${route.path}`,
    method: route.method,
    path: route.path,
    nodes,
    edges,
    annotations: [],
    framework: "nestjs",
    ir_ver: IR_VERSION,
    adapter_ver: ADAPTER_VERSION,
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "_")
}
