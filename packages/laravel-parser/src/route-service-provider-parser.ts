import { readFileSync } from "fs"
import { dirname, join, normalize, relative } from "path"
import Parser from "tree-sitter"
// @ts-ignore — tree-sitter lacks ambient declarations in this workspace
import PHP from "tree-sitter-php"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

// route file path (relative to projectRoot, POSIX-style) → middleware group names /
// class strings from the Route::group([...], fn () => require(...)) that wraps it.
export type RouteWrappingMap = Map<string, string[]>

// route file path (relative to projectRoot, POSIX-style) → the single namespace that
// wraps it, from ->namespace(...) (fluent or ['namespace' => ...] options-array form).
export type RouteNamespaceMap = Map<string, string>

// route file path (relative to projectRoot, POSIX-style) → the path prefix that wraps
// it, from ->prefix(...) (fluent or ['prefix' => ...] options-array form) — e.g. classic
// Laravel's RouteServiceProvider::mapApiRoutes() wrapping routes/api.php in prefix('api').
export type RoutePrefixMap = Map<string, string>

/**
 * Parse a Laravel <=10 app/Providers/RouteServiceProvider.php for
 * Route::group(['middleware' => X, ...], fn () => require base_path(Y)) — and the
 * fluent equivalent Route::middleware(X)->group(fn () => require(Y)) — recording
 * which middleware group(s) wrap each required route file.
 *
 * Returns an empty map if the file cannot be read or no such pattern is found.
 */
export function parseRouteServiceProvider(filePath: string, projectRoot: string): RouteWrappingMap {
  return parseProvider(filePath, projectRoot).middleware
}

/**
 * Parse the same provider for ->namespace(...) wrapping instead of middleware —
 * covers classic Laravel's `protected $namespace = 'App\Http\Controllers';` +
 * `->namespace($this->namespace)->group(...)` pattern (found via real-repo blind
 * test on Akaunting's app/Providers/Route.php, a custom-named RouteServiceProvider
 * subclass), plus literal-string and options-array ['namespace' => ...] forms.
 *
 * Returns an empty map if the file cannot be read or no such pattern is found.
 */
export function parseRouteServiceProviderNamespaces(filePath: string, projectRoot: string): RouteNamespaceMap {
  return parseProvider(filePath, projectRoot).namespace
}

/**
 * Parse the same provider for ->prefix(...) wrapping — covers classic Laravel's
 * RouteServiceProvider::mapApiRoutes() pattern:
 *   Route::prefix('api')->middleware('api')->group(base_path('routes/api.php'));
 * Plain-path routes (e.g. akaunting's `Route::resource('invoices', ...)`) do not carry
 * this prefix in their own file, so it must be resolved from the outer wrap.
 *
 * Returns an empty map if the file cannot be read or no such pattern is found.
 */
export function parseRouteServiceProviderPrefixes(filePath: string, projectRoot: string): RoutePrefixMap {
  return parseProvider(filePath, projectRoot).prefix
}

// ---- Internals -------------------------------------------------------

function parseProvider(
  filePath: string,
  projectRoot: string
): { middleware: RouteWrappingMap; namespace: RouteNamespaceMap; prefix: RoutePrefixMap } {
  const middleware: RouteWrappingMap = new Map()
  const namespace: RouteNamespaceMap = new Map()
  const prefix: RoutePrefixMap = new Map()
  let source: string
  let tree: ReturnType<typeof _parser.parse>
  try {
    source = readFileSync(filePath, "utf-8")
    tree = _parser.parse(source)
  } catch {
    return { middleware, namespace, prefix }
  }
  const classNamespaceProperty = findClassNamespaceProperty(tree.rootNode)
  walk(tree.rootNode, filePath, projectRoot, middleware, namespace, prefix, classNamespaceProperty)
  return { middleware, namespace, prefix }
}

/** Find `protected/public/private $namespace = '...';` declared directly in the class body. */
function findClassNamespaceProperty(root: Parser.SyntaxNode): string | null {
  let found: string | null = null
  const visit = (node: Parser.SyntaxNode): void => {
    if (found) return
    if (node.type === "property_element") {
      const nameNode = node.children.find((c) => c.type === "variable_name")
      if (nameNode?.text === "$namespace") {
        const valueNode = node.children.find((c) => c.type === "string" || c.type === "encapsed_string")
        if (valueNode) found = resolveValue(valueNode)[0] ?? null
      }
    }
    for (const child of node.children) visit(child)
  }
  visit(root)
  return found
}

function walk(
  node: Parser.SyntaxNode,
  providerFile: string,
  projectRoot: string,
  middlewareOut: RouteWrappingMap,
  namespaceOut: RouteNamespaceMap,
  prefixOut: RoutePrefixMap,
  classNamespaceProperty: string | null
): void {
  if (node.type === "member_call_expression" || node.type === "scoped_call_expression") {
    const nameNode = node.childForFieldName("name")
    if (nameNode?.text === "group") {
      handleGroupCall(node, providerFile, projectRoot, middlewareOut, namespaceOut, prefixOut, classNamespaceProperty)
    }
  }
  for (const child of node.children) {
    walk(child, providerFile, projectRoot, middlewareOut, namespaceOut, prefixOut, classNamespaceProperty)
  }
}

function handleGroupCall(
  node: Parser.SyntaxNode,
  providerFile: string,
  projectRoot: string,
  middlewareOut: RouteWrappingMap,
  namespaceOut: RouteNamespaceMap,
  prefixOut: RoutePrefixMap,
  classNamespaceProperty: string | null
): void {
  const argsNode = node.childForFieldName("arguments")
  if (!argsNode) return
  const args = getArgNodes(argsNode)

  const middleware: string[] = []
  let namespaceValue: string | null = null
  let prefixValue: string | null = null

  // Fluent form: Route::middleware('api')->namespace(...)->prefix('v1')->group(fn)
  const objectNode = node.childForFieldName("object")
  if (objectNode) {
    collectFluentMiddleware(objectNode, middleware)
    namespaceValue = collectFluentNamespace(objectNode, classNamespaceProperty)
    prefixValue = collectFluentPrefix(objectNode)
  }

  let closureNode: Parser.SyntaxNode | undefined = args[0]

  // Options form: Route::group(['middleware' => X, 'namespace' => Y, 'prefix' => Z, ...], fn)
  if (args[0]?.type === "array_creation_expression") {
    extractMiddlewareFromOptions(args[0], middleware)
    namespaceValue = extractNamespaceFromOptions(args[0]) ?? namespaceValue
    prefixValue = extractKeyFromOptions(args[0], "prefix") ?? prefixValue
    closureNode = args[1]
  }

  if (!closureNode || (middleware.length === 0 && !namespaceValue && !prefixValue)) return

  // Laravel's Router::group() also accepts a route-file path directly instead of a
  // closure — the common Laravel <=8 skeleton form:
  //   Route::middleware('web')->group(base_path('routes/web.php'));
  const directPath = resolveRequirePath(closureNode, providerFile, projectRoot)
  if (directPath) {
    if (middleware.length > 0) {
      const existing = middlewareOut.get(directPath) ?? []
      middlewareOut.set(directPath, Array.from(new Set([...existing, ...middleware])))
    }
    if (namespaceValue) namespaceOut.set(directPath, namespaceValue)
    if (prefixValue) prefixOut.set(directPath, prefixValue)
    return
  }

  const body = getFunctionBody(closureNode)
  if (!body) return

  collectRequiredFiles(body, providerFile, projectRoot, (relFile) => {
    if (middleware.length > 0) {
      const existing = middlewareOut.get(relFile) ?? []
      middlewareOut.set(relFile, Array.from(new Set([...existing, ...middleware])))
    }
    if (namespaceValue) namespaceOut.set(relFile, namespaceValue)
    if (prefixValue) prefixOut.set(relFile, prefixValue)
  })
}

/** Walk a fluent method chain for a `->namespace(...)` call, resolving `$this->namespace`
 *  against the class's own property declaration when the arg isn't a literal string. */
function collectFluentNamespace(node: Parser.SyntaxNode, classNamespaceProperty: string | null): string | null {
  let cur: Parser.SyntaxNode | null = node
  while (cur) {
    if (cur.type === "member_call_expression" || cur.type === "scoped_call_expression") {
      const nameNode = cur.childForFieldName("name")
      if (nameNode?.text === "namespace") {
        const argsNode = cur.childForFieldName("arguments")
        const arg = argsNode ? getArgNodes(argsNode)[0] : undefined
        if (arg) {
          if (arg.type === "member_access_expression") {
            const objText = arg.childForFieldName("object")?.text
            const propText = arg.childForFieldName("name")?.text
            if (objText === "$this" && propText === "namespace") return classNamespaceProperty
          } else {
            return resolveValue(arg)[0] ?? null
          }
        }
      }
      cur = cur.type === "scoped_call_expression" ? null : (cur.childForFieldName("object") ?? null)
    } else {
      cur = null
    }
  }
  return null
}

function extractNamespaceFromOptions(optionsNode: Parser.SyntaxNode): string | null {
  return extractKeyFromOptions(optionsNode, "namespace")
}

function extractKeyFromOptions(optionsNode: Parser.SyntaxNode, key: string): string | null {
  for (const child of optionsNode.children) {
    if (child.type !== "array_element_initializer") continue
    const named = child.namedChildren
    if (named.length < 2) continue
    const foundKey = named[0]?.type === "string"
      ? (named[0].children.find((c) => c.type === "string_content")?.text ?? "")
      : named[0]?.text ?? ""
    if (foundKey !== key) continue
    const value = named[1]
    if (value) return resolveValue(value)[0] ?? null
  }
  return null
}

/** Walk a fluent method chain for a `->prefix(...)` call. */
function collectFluentPrefix(node: Parser.SyntaxNode): string | null {
  let cur: Parser.SyntaxNode | null = node
  while (cur) {
    if (cur.type === "member_call_expression" || cur.type === "scoped_call_expression") {
      const nameNode = cur.childForFieldName("name")
      if (nameNode?.text === "prefix") {
        const argsNode = cur.childForFieldName("arguments")
        const arg = argsNode ? getArgNodes(argsNode)[0] : undefined
        if (arg) return resolveValue(arg)[0] ?? null
      }
      cur = cur.type === "scoped_call_expression" ? null : (cur.childForFieldName("object") ?? null)
    } else {
      cur = null
    }
  }
  return null
}

function collectFluentMiddleware(node: Parser.SyntaxNode, out: string[]): void {
  let cur: Parser.SyntaxNode | null = node
  while (cur) {
    if (cur.type === "member_call_expression") {
      const nameNode = cur.childForFieldName("name")
      if (nameNode?.text === "middleware") {
        const argsNode = cur.childForFieldName("arguments")
        if (argsNode) out.push(...resolveMiddlewareArgs(getArgNodes(argsNode)))
      }
      cur = cur.childForFieldName("object") ?? null
    } else if (cur.type === "scoped_call_expression") {
      const nameNode = cur.childForFieldName("name")
      if (nameNode?.text === "middleware") {
        const argsNode = cur.childForFieldName("arguments")
        if (argsNode) out.push(...resolveMiddlewareArgs(getArgNodes(argsNode)))
      }
      cur = null // Route::middleware(...) is the chain root
    } else {
      cur = null
    }
  }
}

function extractMiddlewareFromOptions(optionsNode: Parser.SyntaxNode, out: string[]): void {
  for (const child of optionsNode.children) {
    if (child.type !== "array_element_initializer") continue
    const named = child.namedChildren
    if (named.length < 2) continue
    const key = named[0]?.type === "string"
      ? (named[0].children.find((c) => c.type === "string_content")?.text ?? "")
      : named[0]?.text ?? ""
    if (key !== "middleware") continue
    const value = named[1]
    if (value) out.push(...resolveMiddlewareArgs([value]))
  }
}

function resolveMiddlewareArgs(args: Parser.SyntaxNode[]): string[] {
  const result: string[] = []
  for (const arg of args) {
    if (arg.type === "array_creation_expression") {
      for (const el of arg.children) {
        if (el.type === "array_element_initializer") {
          const val = el.firstNamedChild
          if (val) result.push(...resolveValue(val))
        }
      }
    } else {
      result.push(...resolveValue(arg))
    }
  }
  return result
}

function resolveValue(node: Parser.SyntaxNode): string[] {
  if (node.type === "string" || node.type === "encapsed_string") {
    const content = node.children.find((c) => c.type === "string_content")
    return [content?.text ?? node.text.replace(/^['"]|['"]$/g, "")]
  }
  if (node.type === "class_constant_access_expression") {
    const classNode = node.children[0]
    const constNode = node.children[2]
    if (constNode?.text === "class" && classNode) {
      return [classNode.text.replace(/^\\/, "")]
    }
  }
  return [node.text]
}

function getArgNodes(argsNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  return argsNode.children
    .filter((c) => c.type === "argument")
    .map((c) => c.firstNamedChild)
    .filter((c): c is Parser.SyntaxNode => c !== null)
}

function getFunctionBody(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === "anonymous_function") {
    return node.childForFieldName("body") ?? null
  }
  for (const child of node.children) {
    if (child.type === "compound_statement") return child
    const found = getFunctionBody(child)
    if (found) return found
  }
  return null
}

// ---- require/include resolution --------------------------------------

function collectRequiredFiles(
  body: Parser.SyntaxNode,
  providerFile: string,
  projectRoot: string,
  onFound: (relFile: string) => void
): void {
  const REQUIRE_TYPES = new Set([
    "require_expression",
    "require_once_expression",
    "include_expression",
    "include_once_expression",
  ])

  const visit = (node: Parser.SyntaxNode): void => {
    if (REQUIRE_TYPES.has(node.type)) {
      const pathExpr = node.children.find(
        (c) => !REQUIRE_TYPES.has(c.type) && c.type !== "require" && c.type !== "require_once" &&
               c.type !== "include" && c.type !== "include_once"
      )
      if (pathExpr) {
        const resolved = resolveRequirePath(pathExpr, providerFile, projectRoot)
        if (resolved) onFound(resolved)
      }
    }
    for (const child of node.children) visit(child)
  }

  visit(body)
}

/** Resolve a require/include path expression to a path relative to projectRoot. */
function resolveRequirePath(
  expr: Parser.SyntaxNode,
  providerFile: string,
  projectRoot: string
): string | null {
  // base_path('routes/api.php')
  if (expr.type === "function_call_expression") {
    const nameNode = expr.childForFieldName("function")
    const argsNode = expr.childForFieldName("arguments")
    if (nameNode?.text === "base_path" && argsNode) {
      const arg = getArgNodes(argsNode)[0]
      const rel = arg ? resolveValue(arg)[0] : null
      return rel ? normalize(rel).replace(/\\/g, "/") : null
    }
    return null
  }

  // __DIR__ . '/../routes/api.php'
  if (expr.type === "binary_expression") {
    const op    = expr.childForFieldName("operator")?.text
    const left  = expr.childForFieldName("left")
    const right = expr.childForFieldName("right")
    if (op !== "." || left?.text !== "__DIR__" || !right) return null
    const rel = resolveValue(right)[0]
    if (!rel) return null
    const abs = normalize(join(dirname(providerFile), rel))
    const relFromRoot = relative(projectRoot, abs).replace(/\\/g, "/")
    return relFromRoot.startsWith("..") ? null : relFromRoot
  }

  // plain string literal — resolve relative to projectRoot
  if (expr.type === "string" || expr.type === "encapsed_string") {
    const rel = resolveValue(expr)[0]
    return rel ? normalize(rel).replace(/\\/g, "/") : null
  }

  return null
}
