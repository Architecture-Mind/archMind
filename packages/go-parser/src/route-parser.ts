import { parseGo, callParts, stringLiteralValue, functionName, functionParamNames, functionParamTypes, findFunctionDecls, statementsOf } from "./ast.js"
import type { SyntaxNode } from "./ast.js"
import { shortMiddlewareName } from "./middleware-mapper.js"

export interface GoSourceFile {
  /** Relative path from project root — becomes ExecutionNode.file. */
  path: string
  content: string
}

export interface MiddlewareRef {
  /** Unqualified name, e.g. "AuthMiddleware" out of "middleware.AuthMiddleware". */
  shortName: string
  /** Raw call text as written, e.g. "middleware.RequireRole(model.RoleAdmin)". */
  text: string
  /** Raw argument texts, e.g. ["model.RoleAdmin", "model.RoleManager"]. */
  args: string[]
  file: string
  line: number
}

export interface RouteInfo {
  method: string
  /** Fully resolved path — concatenation of every enclosing Group() prefix. */
  path: string
  /** Raw text of the final (handler) argument, e.g. "handler.CreateOrder". */
  handlerText: string
  /** Bare struct type of the handler's receiver (e.g. "OrderHandler"), when resolvable — needed to look up the method body for validation-gate detection. */
  handlerReceiverType?: string
  /** Middleware in application order: inherited group middleware first, then inline. */
  middleware: MiddlewareRef[]
  file: string
  line: number
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])

interface GroupState {
  prefix: string
  middleware: MiddlewareRef[]
}

interface ParsedFile {
  path: string
  root: SyntaxNode
}

interface FunctionEntry {
  name: string
  node: SyntaxNode
  file: string
}

function toLine(node: SyntaxNode): number {
  return node.startPosition.row + 1
}

function isEngineConstructor(parts: { receiver: string | null; method: string }): boolean {
  return parts.receiver === "gin" && (parts.method === "Default" || parts.method === "New")
}

function toMiddlewareRef(node: SyntaxNode, file: string): MiddlewareRef | null {
  const parts = callParts(node)
  if (!parts) return null
  const qualified = parts.receiver ? `${parts.receiver}.${parts.method}` : parts.method
  return {
    shortName: shortMiddlewareName(qualified),
    text:      node.text,
    args:      parts.args.map((a) => a.text),
    file,
    line:      toLine(node),
  }
}

/**
 * Builds a global function registry (short name → declaration) spanning every
 * provided file. Route-registration functions are matched by name only,
 * ignoring package boundaries — the same approach Laravel's parser takes for
 * controller resolution across a project's namespace. Last declaration wins
 * on a name collision (acceptable for v1: same-named route registrars across
 * unrelated packages are not a pattern observed in any of the 3 surveyed repos)
 * — EXCEPT for the entry function itself (default "main"), which commonly
 * collides across `cmd/server/main.go`, `cmd/seed/main.go`,
 * `cmd/worker/main.go`, etc. in exactly this project layout. For that name,
 * prefer whichever declaration's body actually constructs a Gin engine
 * (`gin.Default()`/`gin.New()`) — the one real web-server entrypoint — over
 * an arbitrary last-wins pick that could silently resolve to a CLI script's
 * empty main() instead.
 */
function buildFunctionRegistry(files: ParsedFile[], entryName = "main"): Map<string, FunctionEntry> {
  const registry = new Map<string, FunctionEntry>()
  for (const file of files) {
    for (const fn of findFunctionDecls(file.root)) {
      const name = functionName(fn)
      if (!name) continue
      if (name === entryName && registry.has(entryName) && !looksLikeGinEntrypoint(fn)) continue
      registry.set(name, { name, node: fn, file: file.path })
    }
  }
  return registry
}

function looksLikeGinEntrypoint(fn: SyntaxNode): boolean {
  const body = fn.childForFieldName("body")
  if (!body) return false
  for (const node of statementsOf(body)) {
    const rhs = (node.childForFieldName("right") ?? node.namedChildren[1])?.namedChildren[0]
    if (rhs?.type === "call_expression") {
      const parts = callParts(rhs)
      if (parts && isEngineConstructor(parts)) return true
    }
  }
  return false
}

/**
 * Walks one function body in source order, tracking which local variables
 * are gin route groups (the router param itself, `gin.Default()`/`gin.New()`
 * results, or `X.Group(...)` results) and their accumulated prefix +
 * middleware. Emits a RouteInfo for every `X.METHOD(path, ...)` call found on
 * a tracked group, and recurses into any call to another registry function
 * that receives a tracked group as an argument, OR that itself constructs
 * and returns a new engine (a "router factory" — `func NewRouter() *gin.Engine`
 * — a common alternative to the inject-the-engine-as-a-parameter style; both
 * patterns showed up across a 10-repo spot-check of real public Gin projects).
 *
 * Returns the GroupState of whatever this function returns via a bare
 * `return x` where `x` is itself a tracked group at that point, so a caller
 * assigning this function's result (`r := NewRouter()`) can bind its own
 * local to the right state. Returns undefined when nothing qualifies.
 */
function walkFunctionBody(
  fn: FunctionEntry,
  initialGroups: Map<string, GroupState>,
  registry: Map<string, FunctionEntry>,
  routes: RouteInfo[],
  visiting: Set<string>
): GroupState | undefined {
  if (visiting.has(fn.name)) return undefined // guard against accidental recursion
  visiting.add(fn.name)

  const body = fn.node.childForFieldName("body")
  if (!body) { visiting.delete(fn.name); return undefined }

  const groups = new Map(initialGroups)
  const paramTypes = functionParamTypes(fn.node)
  const statements = statementsOf(body)

  for (const stmt of statements) {
    handleStatement(stmt, fn.file, groups, paramTypes, registry, routes, visiting)
  }

  visiting.delete(fn.name)
  return findReturnedGroupState(statements, groups)
}

/** Scans for a `return x` statement where `x` is a bare identifier that's a tracked group. */
function findReturnedGroupState(statements: SyntaxNode[], groups: Map<string, GroupState>): GroupState | undefined {
  for (const stmt of statements) {
    if (stmt.type !== "return_statement") continue
    const exprList = stmt.namedChildren[0]
    const expr = exprList?.type === "expression_list" ? exprList.namedChildren[0] : exprList
    if (expr?.type === "identifier" && groups.has(expr.text)) return groups.get(expr.text)
  }
  return undefined
}

function handleStatement(
  stmt: SyntaxNode,
  file: string,
  groups: Map<string, GroupState>,
  paramTypes: Map<string, string>,
  registry: Map<string, FunctionEntry>,
  routes: RouteInfo[],
  visiting: Set<string>
): void {
  // Bare `{ ... }` scoping block — a common Go idiom for visually grouping a
  // route group's registrations (`apiv1 := r.Group(...); apiv1.Use(...); {
  // apiv1.GET(...) ... }`). Not a control-flow construct, just lexical
  // scoping — its statements execute unconditionally, in order, same as if
  // the braces weren't there, so recurse into it directly.
  if (stmt.type === "block") {
    for (const inner of statementsOf(stmt)) {
      handleStatement(inner, file, groups, paramTypes, registry, routes, visiting)
    }
    return
  }

  // `local := expr` or `local = expr` — check if expr is a group-producing call
  if (stmt.type === "short_var_declaration" || stmt.type === "assignment_statement") {
    const left  = stmt.childForFieldName("left")  ?? stmt.namedChildren[0]
    const right = stmt.childForFieldName("right") ?? stmt.namedChildren[1]
    const targetName = left?.namedChildren[0]?.text
    const rhsExpr = right?.namedChildren[0]
    if (targetName && rhsExpr?.type === "call_expression") {
      const parts = callParts(rhsExpr)
      if (parts && isEngineConstructor(parts)) {
        groups.set(targetName, { prefix: "", middleware: [] })
      } else if (parts && parts.method === "Group" && parts.receiver && groups.has(parts.receiver)) {
        const parent = groups.get(parts.receiver)!
        const [pathArg, ...mwArgs] = parts.args
        const suffix = pathArg ? stringLiteralValue(pathArg) ?? "" : ""
        const inlineMw = mwArgs.map((a) => toMiddlewareRef(a, file)).filter((m): m is MiddlewareRef => !!m)
        groups.set(targetName, {
          prefix:     parent.prefix + suffix,
          middleware: [...parent.middleware, ...inlineMw],
        })
      } else if (parts) {
        // Router-factory pattern: `local := SomeRegisteredFn(...)` where the
        // callee builds (and returns) its own engine internally, rather than
        // receiving one as a parameter.
        const callee = registry.get(parts.method)
        if (callee) {
          const returned = walkFunctionBody(callee, resolveDelegationArgs(parts, callee, groups), registry, routes, visiting)
          if (returned) groups.set(targetName, returned)
        }
      }
    }
    return
  }

  if (stmt.type !== "expression_statement") return
  const call = stmt.namedChildren[0]
  if (!call || call.type !== "call_expression") return
  const parts = callParts(call)
  if (!parts) return

  // X.Use(mw...) — extends X's middleware for everything registered after this line
  if (parts.method === "Use" && parts.receiver && groups.has(parts.receiver)) {
    const state = groups.get(parts.receiver)!
    const added = parts.args.map((a) => toMiddlewareRef(a, file)).filter((m): m is MiddlewareRef => !!m)
    groups.set(parts.receiver, { ...state, middleware: [...state.middleware, ...added] })
    return
  }

  // X.GET/POST/PUT/PATCH/DELETE(path, ...middleware, handler)
  if (parts.receiver && groups.has(parts.receiver) && HTTP_METHODS.has(parts.method)) {
    const state = groups.get(parts.receiver)!
    const [pathArg, ...rest] = parts.args
    if (!pathArg || rest.length === 0) return
    const suffix = stringLiteralValue(pathArg) ?? ""
    const handlerArg = rest[rest.length - 1]
    const inlineMwArgs = rest.slice(0, -1)
    const inlineMw = inlineMwArgs
      .map((a) => (a.type === "call_expression" ? toMiddlewareRef(a, file) : null))
      .filter((m): m is MiddlewareRef => !!m)

    routes.push({
      method:              parts.method,
      path:                state.prefix + suffix,
      handlerText:         handlerArg.text,
      handlerReceiverType: handlerReceiverType(handlerArg, paramTypes),
      middleware:          [...state.middleware, ...inlineMw],
      file,
      line:                toLine(call),
    })
    return
  }

  // Delegation to another registrar: fn(arg0, arg1, ...) where fn is a known
  // registry function and one or more args is a tracked group variable.
  // Matched by short name only, ignoring any package qualifier (parts.receiver) —
  // same "resolve by name across the whole project" approach the function
  // registry itself uses.
  const callee = registry.get(parts.method)
  if (callee) {
    const childInitial = resolveDelegationArgs(parts, callee, groups)
    if (childInitial.size > 0) {
      walkFunctionBody(callee, childInitial, registry, routes, visiting)
    }
  }
}

/** Maps a call's argument identifiers to the callee's matching parameter name, for every arg that's a currently-tracked group. */
function resolveDelegationArgs(
  parts: { args: SyntaxNode[] },
  callee: FunctionEntry,
  groups: Map<string, GroupState>
): Map<string, GroupState> {
  const paramNames = functionParamNames(callee.node)
  const childInitial = new Map<string, GroupState>()
  parts.args.forEach((argNode, i) => {
    const paramName = paramNames[i]
    const argIdent = argNode.type === "identifier" ? argNode.text : null
    if (paramName && argIdent && groups.has(argIdent)) {
      childInitial.set(paramName, groups.get(argIdent)!)
    }
  })
  return childInitial
}

/**
 * For a handler expression `paramName.MethodName`, resolves paramName's
 * declared type from the enclosing function's own parameters — e.g. given
 * `func RegisterOrderRoutes(router gin.IRouter, handler *handler.OrderHandler)`
 * and the call `handler.CreateOrder`, returns "OrderHandler".
 * Returns undefined for anything else (bare function reference, unresolvable
 * receiver) — validation-gate detection is simply skipped for that route.
 */
function handlerReceiverType(handlerArg: SyntaxNode, paramTypes: Map<string, string>): string | undefined {
  if (handlerArg.type !== "selector_expression") return undefined
  const operand = handlerArg.childForFieldName("operand")
  if (!operand || operand.type !== "identifier") return undefined
  return paramTypes.get(operand.text)
}

export interface ExtractRoutesOptions {
  /** Name of the process entrypoint function to start walking from. Defaults to "main". */
  entryFunction?: string
}

/**
 * Extracts every Gin route reachable from the entry function (default
 * `main`), resolving group prefixes and middleware across function-call
 * boundaries (main → RegisterRoutes → RegisterXRoutes → r.GET(...)).
 *
 * `files` should include the whole set of Go source files that make up the
 * routing surface — typically `cmd/server/main.go`, `routes/routes.go`, and
 * everything under `routes/`. Files outside the reachable call graph from
 * the entry function are parsed (for the function registry) but otherwise
 * inert.
 */
export function extractRoutes(files: GoSourceFile[], opts: ExtractRoutesOptions = {}): RouteInfo[] {
  const parsed: ParsedFile[] = files.map((f) => ({ path: f.path, root: parseGo(f.content) }))
  const entryName = opts.entryFunction ?? "main"
  const registry = buildFunctionRegistry(parsed, entryName)

  const entry = registry.get(entryName)
  if (!entry) return []

  const routes: RouteInfo[] = []
  walkFunctionBody(entry, new Map(), registry, routes, new Set())
  return routes
}
