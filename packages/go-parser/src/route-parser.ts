import { parseGo, walk, callParts, stringLiteralValue, functionName, functionParamNames, findFunctionDecls } from "./ast.js"
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
  /** Raw argument texts, e.g. ["model.RoleAdmin", "model.RoleDoctor"]. */
  args: string[]
  file: string
  line: number
}

export interface RouteInfo {
  method: string
  /** Fully resolved path — concatenation of every enclosing Group() prefix. */
  path: string
  /** Raw text of the final (handler) argument, e.g. "handler.RegisterAppointment". */
  handlerText: string
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
 * unrelated packages are not a pattern observed in any of the 3 surveyed repos).
 */
function buildFunctionRegistry(files: ParsedFile[]): Map<string, FunctionEntry> {
  const registry = new Map<string, FunctionEntry>()
  for (const file of files) {
    for (const fn of findFunctionDecls(file.root)) {
      const name = functionName(fn)
      if (name) registry.set(name, { name, node: fn, file: file.path })
    }
  }
  return registry
}

/**
 * Walks one function body in source order, tracking which local variables
 * are gin route groups (the router param itself, `gin.Default()`/`gin.New()`
 * results, or `X.Group(...)` results) and their accumulated prefix +
 * middleware. Emits a RouteInfo for every `X.METHOD(path, ...)` call found on
 * a tracked group, and recurses into any call to another registry function
 * that receives a tracked group as an argument.
 */
function walkFunctionBody(
  fn: FunctionEntry,
  initialGroups: Map<string, GroupState>,
  registry: Map<string, FunctionEntry>,
  routes: RouteInfo[],
  visiting: Set<string>
): void {
  if (visiting.has(fn.name)) return // guard against accidental recursion
  visiting.add(fn.name)

  const body = fn.node.childForFieldName("body")
  if (!body) { visiting.delete(fn.name); return }

  const groups = new Map(initialGroups)
  const statements = body.namedChildren[0]?.namedChildren ?? [] // statement_list

  for (const stmt of statements) {
    handleStatement(stmt, fn.file, groups, registry, routes, visiting)
  }

  visiting.delete(fn.name)
}

function handleStatement(
  stmt: SyntaxNode,
  file: string,
  groups: Map<string, GroupState>,
  registry: Map<string, FunctionEntry>,
  routes: RouteInfo[],
  visiting: Set<string>
): void {
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
      method:      parts.method,
      path:        state.prefix + suffix,
      handlerText: handlerArg.text,
      middleware:  [...state.middleware, ...inlineMw],
      file,
      line:        toLine(call),
    })
    return
  }

  // Delegation to another registrar: fn(arg0, arg1, ...) where fn is a known
  // registry function and one or more args is a tracked group variable.
  // Matched by short name only, ignoring any package qualifier (parts.receiver) —
  // same "resolve by name across the whole project" approach the function
  // registry itself uses.
  const callee = registry.get(parts.method)
  if (callee && callee.node !== undefined) {
    const paramNames = functionParamNames(callee.node)
    const childInitial = new Map<string, GroupState>()
    parts.args.forEach((argNode, i) => {
      const paramName = paramNames[i]
      const argIdent = argNode.type === "identifier" ? argNode.text : null
      if (paramName && argIdent && groups.has(argIdent)) {
        childInitial.set(paramName, groups.get(argIdent)!)
      }
    })
    if (childInitial.size > 0) {
      walkFunctionBody(callee, childInitial, registry, routes, visiting)
    }
  }
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
  const registry = buildFunctionRegistry(parsed)

  const entryName = opts.entryFunction ?? "main"
  const entry = registry.get(entryName)
  if (!entry) return []

  const routes: RouteInfo[] = []
  walkFunctionBody(entry, new Map(), registry, routes, new Set())
  return routes
}
