import { IR_NODE_TYPES, IR_EDGE_RELATIONS, IR_VERSION } from "@kidkender/archmind-protocol"
import type { IntermediateExecutionGraph, ExecutionNode, ExecutionEdge } from "@kidkender/archmind-protocol"
import type { RouteInfo, MiddlewareRef, GoSourceFile } from "./route-parser.js"
import { extractRoutes, type ExtractRoutesOptions } from "./route-parser.js"
import { irTypeForMiddleware, resolveSkipListForMiddleware, type SkipEntry } from "./middleware-mapper.js"
import { parseGo, findFunctionDecls, functionName, callParts, findCalls, type SyntaxNode } from "./ast.js"
import { buildConstRegistry, resolveConstExpr } from "./const-resolver.js"
import { buildMethodRegistry, findBindCalls, resolveVarDtoType, type HandlerMethod } from "./handler-parser.js"
import { resolveDtoBinding, findStructFieldTypes } from "./dto-binding-parser.js"
import { findTransactionBoundaries } from "./transaction-parser.js"

const ADAPTER_VERSION = "0.1.0"

interface ParsedFile {
  path: string
  root: SyntaxNode
}

function buildSkipListIndex(parsed: ParsedFile[], middlewareNames: Set<string>): Map<string, SkipEntry[]> {
  const functionsByName = new Map<string, SyntaxNode>()
  for (const file of parsed) {
    for (const fn of findFunctionDecls(file.root)) {
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

function middlewareNode(
  mw: MiddlewareRef,
  idx: number,
  skipListIndex: Map<string, SkipEntry[]>,
  route: RouteInfo,
  constRegistry: Map<string, string>
): ExecutionNode | null {
  const type = irTypeForMiddleware(mw.shortName)

  // A globally-applied auth middleware with a matching skip-list entry means
  // this specific route is exempt — don't emit the auth_gate node for it,
  // same way an unmatched entry means the gate genuinely applies.
  if (type === IR_NODE_TYPES.AUTH_GATE) {
    const skipList = skipListIndex.get(mw.shortName) ?? []
    if (isExempt(route, skipList)) return null
  }

  // Resolve role/permission const identifiers (e.g. "model.RoleAdmin") to
  // their declared literal value where possible — same intent as Laravel's
  // Permission::TASK_DELETE constant resolution.
  const resolvedArgs = mw.args.map((a) => resolveConstExpr(a, constRegistry))

  return {
    id:     `mw_${idx}`,
    type,
    symbol: mw.text,
    file:   mw.file,
    line:   mw.line,
    args:   resolvedArgs.length > 0 ? resolvedArgs : undefined,
    role:   type === IR_NODE_TYPES.AUTH_GATE ? "authentication" : type === IR_NODE_TYPES.AUTHZ_CHECK ? "authorization" : "middleware",
  }
}

/** Resolves a route's handler method declaration from its receiver type + method name, when known. */
function resolveHandlerMethod(
  route: RouteInfo,
  methodRegistry: ReturnType<typeof buildMethodRegistry>
): HandlerMethod | null {
  if (!route.handlerReceiverType) return null
  const methodShortName = route.handlerText.slice(route.handlerText.lastIndexOf(".") + 1)
  return methodRegistry.get(`${route.handlerReceiverType}.${methodShortName}`) ?? null
}

/**
 * Resolves the ir:validation_gate node for a route, when its handler is
 * known (handlerReceiverType set) and that handler method calls one of the
 * ShouldBind family on a locally-declared DTO struct. Returns null whenever
 * any step of that chain doesn't resolve — validation-gate detection is
 * best-effort, not required for a route to have a correct graph otherwise.
 */
function validationGateNode(
  route: RouteInfo,
  methodRegistry: ReturnType<typeof buildMethodRegistry>,
  parsed: ParsedFile[]
): ExecutionNode | null {
  const method = resolveHandlerMethod(route, methodRegistry)
  if (!method) return null

  const body = method.node.childForFieldName("body")
  if (!body) return null

  const [bindCall] = findBindCalls(body)
  if (!bindCall) return null

  const dtoType = resolveVarDtoType(body, bindCall.varName)
  if (!dtoType) return null

  const binding = resolveDtoBinding(dtoType, parsed)
  if (!binding || binding.fields.length === 0) return null

  const rules = binding.fields
    .filter((f) => f.bindingTag)
    .map((f) => `${f.name}:${f.bindingTag}`)

  return {
    id:     "validation",
    type:   IR_NODE_TYPES.VALIDATION_GATE,
    symbol: dtoType,
    file:   binding.file,
    role:   "validation",
    args:   rules.length > 0 ? rules : undefined,
    detail: `bound via ctx.${bindCall.kind === "json" ? "ShouldBindJSON" : bindCall.kind === "query" ? "ShouldBindQuery" : "ShouldBindUri"}`,
  }
}

/**
 * Resolves the ir:txn_boundary node for a route. Checks the handler method's
 * own body first (rare in the surveyed repos — handlers are thin), then
 * follows one hop into a directly-called service method (`h.someService.Method(...)`,
 * resolved via the handler struct's own field types) since all 3 surveyed
 * repos put GORM transactions in the service layer, never the handler
 * itself. Only that single hop is followed — matches the plan's stated v1
 * scope (handler-level + one hop, not full recursive service-call
 * expansion). Presence-only detection (v1): doesn't yet determine which
 * specific downstream mutations fall inside the transaction, the same
 * transaction-scope-flattening gap the README documents for the Laravel IR.
 */
function transactionBoundaryNode(
  route: RouteInfo,
  methodRegistry: ReturnType<typeof buildMethodRegistry>,
  parsed: ParsedFile[]
): ExecutionNode | null {
  const method = resolveHandlerMethod(route, methodRegistry)
  if (!method || !route.handlerReceiverType) return null
  const body = method.node.childForFieldName("body")
  if (!body) return null

  const direct = findTransactionBoundaries(body)
  if (direct.length > 0) {
    return {
      id:     "txn",
      type:   IR_NODE_TYPES.TXN_BOUNDARY,
      symbol: route.handlerText,
      file:   method.file,
      line:   direct[0].line,
      role:   "transaction",
    }
  }

  let fieldTypes: Map<string, string> | null = null
  for (const file of parsed) {
    fieldTypes = findStructFieldTypes(file.root, route.handlerReceiverType)
    if (fieldTypes) break
  }
  if (!fieldTypes) return null

  for (const node of findCalls(body)) {
    const parts = callParts(node)
    if (!parts?.receiver) continue
    const fieldName = parts.receiver.slice(parts.receiver.lastIndexOf(".") + 1)
    const serviceType = fieldTypes.get(fieldName)
    if (!serviceType) continue

    const serviceMethod = methodRegistry.get(`${serviceType}.${parts.method}`)
    const serviceBody = serviceMethod?.node.childForFieldName("body")
    if (!serviceBody) continue

    const found = findTransactionBoundaries(serviceBody)
    if (found.length > 0) {
      return {
        id:     "txn",
        type:   IR_NODE_TYPES.TXN_BOUNDARY,
        symbol: `${serviceType}.${parts.method}`,
        file:   serviceMethod!.file,
        line:   found[0].line,
        role:   "transaction",
      }
    }
  }
  return null
}

function routeToGraph(
  route: RouteInfo,
  skipListIndex: Map<string, SkipEntry[]>,
  constRegistry: Map<string, string>,
  methodRegistry: ReturnType<typeof buildMethodRegistry>,
  parsed: ParsedFile[]
): IntermediateExecutionGraph {
  const nodes: ExecutionNode[] = []
  const edges: ExecutionEdge[] = []

  const mwNodes = route.middleware
    .map((mw, i) => middlewareNode(mw, i, skipListIndex, route, constRegistry))
    .filter((n): n is ExecutionNode => !!n)

  nodes.push(...mwNodes)

  const validationNode = validationGateNode(route, methodRegistry, parsed)
  if (validationNode) nodes.push(validationNode)

  const handlerNode: ExecutionNode = {
    id:     "handler",
    type:   IR_NODE_TYPES.BUSINESS_HANDLER,
    symbol: route.handlerText,
    file:   route.file,
    line:   route.line,
    role:   "handler",
  }
  nodes.push(handlerNode)

  // Transaction boundary is a downstream effect of the handler running (it
  // lives inside the handler or the service it calls), so it's placed after
  // business_handler in the chain rather than before, like Laravel's graphs.
  const txnNode = transactionBoundaryNode(route, methodRegistry, parsed)
  if (txnNode) nodes.push(txnNode)

  const chain = [...mwNodes, ...(validationNode ? [validationNode] : []), handlerNode, ...(txnNode ? [txnNode] : [])]
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
 * per route: routes + auth gate (honoring global-middleware skip-lists),
 * authz-check role resolution, validation-gate from DTO binding tags, and
 * transaction-boundary detection (GORM `.Transaction()` closures, one hop
 * into a directly-called service method). Isolation (tenant scoping) is not
 * implemented yet.
 */
export function parseGinProject(files: GoSourceFile[], opts: ExtractRoutesOptions = {}): IntermediateExecutionGraph[] {
  const routes = extractRoutes(files, opts)
  if (routes.length === 0) return []

  const parsed: ParsedFile[] = files.map((f) => ({ path: f.path, root: parseGo(f.content) }))

  const middlewareNames = new Set(routes.flatMap((r) => r.middleware.map((m) => m.shortName)))
  const skipListIndex   = buildSkipListIndex(parsed, middlewareNames)
  const constRegistry   = buildConstRegistry(files)
  const methodRegistry  = buildMethodRegistry(parsed)

  return routes.map((r) => routeToGraph(r, skipListIndex, constRegistry, methodRegistry, parsed))
}
