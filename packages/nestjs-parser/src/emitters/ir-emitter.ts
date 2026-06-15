import type { IntermediateExecutionGraph, ExecutionNode, ExecutionEdge } from "@archmind/protocol"
import { IR_VERSION, IR_NODE_TYPES } from "@archmind/protocol"
import type { NestJSSemanticRoute } from "../types.js"

const ADAPTER_VERSION = "0.2.0"

export function emitGraphs(
  routes: NestJSSemanticRoute[],
  globalPipes: boolean = false
): IntermediateExecutionGraph[] {
  return routes.map(r => emitGraph(r, globalPipes))
}

function emitGraph(route: NestJSSemanticRoute, globalPipes: boolean): IntermediateExecutionGraph {
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
    nodes.push({
      id: dtoId,
      type: IR_NODE_TYPES.VALIDATION_GATE,
      symbol: route.dto,
      role: "validation",
    })
    edges.push({
      from: handlerId,
      to: dtoId,
      relation: "validates",
      traceability: "static",
    })
  }

  // Side-effect nodes (ir:queue_job, ir:event_dispatch, ir:mail)
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
