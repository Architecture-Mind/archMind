import { IR_NODE_TYPES, IR_EDGE_RELATIONS, IR_VERSION } from "@kidkender/archmind-protocol"
import type { IntermediateExecutionGraph, ExecutionNode, ExecutionEdge } from "@kidkender/archmind-protocol"
import type { RouteInfo, MiddlewareRef, GoSourceFile } from "./route-parser.js"
import { extractRoutes, type ExtractRoutesOptions } from "./route-parser.js"
import { irTypeForMiddleware, resolveSkipListForMiddleware, type SkipEntry } from "./middleware-mapper.js"
import { parseGo, findFunctionDecls, functionName } from "./ast.js"

const ADAPTER_VERSION = "0.1.0"

/**
 * Builds a global map of middleware short name → its own skip-list (empty
 * for the overwhelming majority of middleware; non-empty only for something
 * shaped like docs/go-support-plan.md §2's global auth exemption pattern).
 */
function buildSkipListIndex(files: GoSourceFile[], middlewareNames: Set<string>): Map<string, SkipEntry[]> {
  const functionsByName = new Map<string, ReturnType<typeof parseGo>>()
  for (const file of files) {
    const root = parseGo(file.content)
    for (const fn of findFunctionDecls(root)) {
      const name = functionName(fn)
      if (name) functionsByName.set(name, fn)
    }
  }

  const index = new Map<string, SkipEntry[]>()
  for (const name of middlewareNames) {
    index.set(name, resolveSkipListForMiddleware(name, functionsByName))
  }
  return index
}

function isExempt(route: RouteInfo, skipList: SkipEntry[]): boolean {
  return skipList.some((e) => e.method === route.method && e.path === route.path)
}

function middlewareNode(mw: MiddlewareRef, idx: number, skipListIndex: Map<string, SkipEntry[]>, route: RouteInfo): ExecutionNode | null {
  const type = irTypeForMiddleware(mw.shortName)

  // A globally-applied auth middleware with a matching skip-list entry means
  // this specific route is exempt — don't emit the auth_gate node for it,
  // same way an unmatched entry means the gate genuinely applies.
  if (type === IR_NODE_TYPES.AUTH_GATE) {
    const skipList = skipListIndex.get(mw.shortName) ?? []
    if (isExempt(route, skipList)) return null
  }

  return {
    id:     `mw_${idx}`,
    type,
    symbol: mw.text,
    file:   mw.file,
    line:   mw.line,
    args:   mw.args.length > 0 ? mw.args : undefined,
    role:   type === IR_NODE_TYPES.AUTH_GATE ? "authentication" : type === IR_NODE_TYPES.AUTHZ_CHECK ? "authorization" : "middleware",
  }
}

function routeToGraph(route: RouteInfo, skipListIndex: Map<string, SkipEntry[]>): IntermediateExecutionGraph {
  const nodes: ExecutionNode[] = []
  const edges: ExecutionEdge[] = []

  const mwNodes = route.middleware
    .map((mw, i) => middlewareNode(mw, i, skipListIndex, route))
    .filter((n): n is ExecutionNode => !!n)

  nodes.push(...mwNodes)

  const handlerNode: ExecutionNode = {
    id:     "handler",
    type:   IR_NODE_TYPES.BUSINESS_HANDLER,
    symbol: route.handlerText,
    file:   route.file,
    line:   route.line,
    role:   "handler",
  }
  nodes.push(handlerNode)

  const chain = [...mwNodes, handlerNode]
  for (let i = 0; i < chain.length - 1; i++) {
    edges.push({
      from:         chain[i].id,
      to:           chain[i + 1].id,
      relation:     IR_EDGE_RELATIONS.PRECEDES,
      traceability: "static",
    })
  }

  return {
    entrypoint:   `${route.method} ${route.path}`,
    method:       route.method,
    path:         route.path,
    nodes,
    edges,
    annotations:  [],
    framework:    "gin",
    ir_ver:       IR_VERSION,
    adapter_ver:  ADAPTER_VERSION,
  }
}

/**
 * Parses a Gin project's routing surface into one IntermediateExecutionGraph
 * per route. See docs/go-support-plan.md for the architecture this targets
 * (Phase A: routes + auth gate, honoring global-middleware skip-lists).
 */
export function parseGinProject(files: GoSourceFile[], opts: ExtractRoutesOptions = {}): IntermediateExecutionGraph[] {
  const routes = extractRoutes(files, opts)

  const middlewareNames = new Set(routes.flatMap((r) => r.middleware.map((m) => m.shortName)))
  const skipListIndex = buildSkipListIndex(files, middlewareNames)

  return routes.map((r) => routeToGraph(r, skipListIndex))
}
