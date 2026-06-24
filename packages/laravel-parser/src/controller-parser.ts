import { readFileSync } from "fs"
import Parser from "tree-sitter"
// @ts-ignore
import PHP from "tree-sitter-php"
import { extractReturnedResources } from "./resource-parser.js"
import { classifyDispatch } from "./transaction-parser.js"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

// ---- Public API -------------------------------------------------------

export interface FormRequestParam {
  shortName: string   // e.g. "UpdateTaskRequest"
  fqcn:      string   // e.g. "App\Modules\Task\Requests\UpdateTaskRequest"
  paramName: string   // e.g. "$request"
}

export interface AuthorizeCall {
  ability:   string   // first string arg, e.g. "update"
  mechanism: string   // full call text, e.g. "$this->authorize('update', $task)"
  modelVar?: string   // second arg variable name, e.g. "$task"
}

export interface ModelParam {
  className: string   // e.g. "Product"
  classFqcn: string   // e.g. "App\Models\Product"
  paramName: string   // e.g. "$product"
}

export interface ServiceCall {
  propertyName: string   // injected property name, e.g. "permissionService"
  serviceClass: string   // short class name, e.g. "PermissionService"
  serviceFqcn:  string   // FQCN, e.g. "App\Modules\Access\Services\PermissionService"
  method:       string   // called method, e.g. "hasPermission"
  args:         string[] // string literal args extracted from the call site
}

export interface ConstructorMiddleware {
  raw:    string    // e.g. "auth:web,subdealer"
  except: string[]  // method names excluded from this middleware
  only:   string[]  // if non-empty, middleware only applies to these methods
}

export interface ReturnedResource {
  shortName:    string   // e.g. "UserResource"
  fqcn:         string   // e.g. "App\Http\Resources\UserResource"
  isCollection: boolean  // true if ::collection() call
}

export interface StandaloneDispatch {
  className: string            // e.g. "ProcessPaymentJob"
  fqcn:      string            // e.g. "App\Jobs\ProcessPaymentJob"
  kind:      "job" | "event" | "unknown"
  callText:  string
}

export interface NotificationDispatch {
  className: string            // e.g. "WelcomeNotification"
  fqcn:      string            // e.g. "App\Notifications\WelcomeNotification"
  kind:      "notification" | "mail"
  queued:    boolean           // true for Mail::queue() / ->queue()
  callText:  string
}

export interface ControllerL1 {
  useMap:                  Map<string, string>
  formRequests:            FormRequestParam[]
  authorizeCalls:          AuthorizeCall[]
  serviceCalls:            ServiceCall[]
  constructorMiddleware:   ConstructorMiddleware[]
  modelParams:             ModelParam[]
  returnedResources:       ReturnedResource[]
  standaloneDispatches:    StandaloneDispatch[]
  standaloneNotifications: NotificationDispatch[]
}

// Classes that must NOT be treated as FormRequest nodes
const SKIP_FQCN = new Set([
  "Request",
  "Illuminate\\Http\\Request",
  "Illuminate\\Foundation\\Http\\FormRequest",
])

export function parseControllerMethod(
  filePath: string,
  methodName: string
): ControllerL1 | null {
  let source: string
  let tree: ReturnType<typeof _parser.parse>
  try {
    source = readFileSync(filePath, "utf-8")
    tree = _parser.parse(source)
  } catch {
    return null
  }
  const root  = tree.rootNode
  const useMap = extractUseMap(root)

  const methodNode = findMethod(root, methodName)
  const constructorMiddleware = gatherConstructorMiddleware(root)

  if (!methodNode) {
    return { useMap, formRequests: [], authorizeCalls: [], serviceCalls: [], constructorMiddleware, modelParams: [], returnedResources: [], standaloneDispatches: [], standaloneNotifications: [] }
  }

  const injections = extractConstructorInjections(root, useMap)
  const methodInjections = extractMethodParamInjections(methodNode, useMap)
  // Merge: method params take precedence over constructor for same var name
  const allInjections = new Map([...injections, ...methodInjections])

  const formRequests         = extractFormRequests(methodNode, useMap)
  const modelParams          = extractModelParams(methodNode, useMap)
  const authorizeCalls       = extractAuthorizeCalls(methodNode, modelParams)
  const serviceCalls         = extractServiceCalls(methodNode, allInjections, useMap)
  const returnedResources      = extractReturnedResources(methodNode, useMap)
  const standaloneDispatches   = extractStandaloneDispatches(methodNode, useMap)
  const standaloneNotifications = extractNotificationDispatches(methodNode, useMap)

  // Depth-1 private method traversal: follow $this->helper() calls into the
  // same class, but do not recurse further to avoid graph blow-up.
  const privateNames = extractPrivateMethodCallNames(methodNode)
  for (const name of privateNames) {
    const privateMethod = findMethod(root, name)
    if (!privateMethod) continue
    authorizeCalls.push(...extractAuthorizeCalls(privateMethod, modelParams))
    serviceCalls.push(...extractServiceCalls(privateMethod, allInjections, useMap))
  }

  // Deduplicate service calls by propertyName+method (same call site from two
  // traversal paths should not produce two nodes).
  const seenSvc = new Set<string>()
  const uniqueServiceCalls = serviceCalls.filter((sc) => {
    const key = `${sc.propertyName}::${sc.method}`
    if (seenSvc.has(key)) return false
    seenSvc.add(key)
    return true
  })

  return {
    useMap,
    formRequests,
    authorizeCalls,
    serviceCalls: uniqueServiceCalls,
    constructorMiddleware,
    modelParams,
    returnedResources,
    standaloneDispatches,
    standaloneNotifications,
  }
}

// ---- FormRequest authorize() body extraction --------------------------

/**
 * Parse a FormRequest PHP file and extract the return expression from authorize().
 * Returns the raw PHP expression text, e.g. "$this->user()?->isAdmin()"
 * Returns undefined if the file can't be parsed or has no authorize() method.
 */
export function parseFormRequestAuthorize(filePath: string): string | undefined {
  let source: string
  let tree: ReturnType<typeof _parser.parse>
  try {
    source = readFileSync(filePath, "utf-8")
    tree = _parser.parse(source)
  } catch {
    return undefined
  }
  const methodNode = findMethod(tree.rootNode, "authorize")
  if (!methodNode) return undefined

  const body = methodNode.childForFieldName("body")
  if (!body) return undefined

  for (const child of body.children) {
    if (child.type === "return_statement") {
      const expr = child.children.find(
        (c) => c.type !== "return" && c.type !== ";" && c.text.trim() !== ""
      )
      if (expr) return expr.text.trim()
    }
  }
  return undefined
}

// ---- Use-statement extraction -----------------------------------------

export function extractUseMap(root: Parser.SyntaxNode): Map<string, string> {
  const map = new Map<string, string>()
  gatherUseDecls(root, map)
  return map
}

function registerUseClause(clause: Parser.SyntaxNode, prefix: string, map: Map<string, string>): void {
  const qualName  = (clause.children as Parser.SyntaxNode[]).find(
    (c) => c.type === "qualified_name" || c.type === "name"
  )
  const aliasNode = (clause.children as Parser.SyntaxNode[]).find(
    (c) => c.type === "alias_clause"
  )
  if (!qualName) return
  const raw  = qualName.text.trim()
  if (!raw)  return
  const fqcn = prefix ? `${prefix}\\${raw}` : raw
  const shortName = aliasNode
    ? ((aliasNode.children as Parser.SyntaxNode[]).find((c) => c.type === "name")?.text ?? lastSegment(fqcn))
    : lastSegment(fqcn)
  map.set(shortName, fqcn)
}

function gatherUseDecls(node: Parser.SyntaxNode, map: Map<string, string>): void {
  for (const child of node.children as Parser.SyntaxNode[]) {
    if (child.type === "namespace_use_declaration") {
      // Detect PHP 7+ grouped use: `use Ns\{A, B, C};`
      const group  = (child.children as Parser.SyntaxNode[]).find((c) => c.type === "namespace_use_group")
      const prefix = (child.children as Parser.SyntaxNode[]).find((c) => c.type === "namespace_name")?.text ?? ""

      if (group) {
        for (const sub of group.children as Parser.SyntaxNode[]) {
          if (sub.type === "namespace_use_clause") registerUseClause(sub, prefix, map)
        }
      } else {
        for (const sub of child.children as Parser.SyntaxNode[]) {
          if (sub.type === "namespace_use_clause") registerUseClause(sub, "", map)
        }
      }
    } else {
      gatherUseDecls(child, map)
    }
  }
}

function lastSegment(fqcn: string): string {
  return fqcn.split("\\").pop() ?? fqcn
}

// ---- Method finder ----------------------------------------------------

function findMethod(root: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  for (const child of root.children) {
    const found = findMethodIn(child, name)
    if (found) return found
  }
  return null
}

function findMethodIn(node: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  if (node.type === "method_declaration") {
    const nameNode = node.childForFieldName("name")
    if (nameNode?.text === name) return node
  }

  for (const child of node.children) {
    const found = findMethodIn(child, name)
    if (found) return found
  }
  return null
}

// ---- FormRequest extraction -------------------------------------------

function extractFormRequests(
  methodNode: Parser.SyntaxNode,
  useMap: Map<string, string>
): FormRequestParam[] {
  const results: FormRequestParam[] = []

  const paramsNode = methodNode.childForFieldName("parameters")
  if (!paramsNode) return results

  for (const param of paramsNode.children) {
    if (param.type !== "simple_parameter") continue

    const typeNode = param.childForFieldName("type")
    if (!typeNode) continue

    const typeName = typeNode.text.trim()

    // Skip bare Request (Illuminate's base request)
    if (SKIP_FQCN.has(typeName)) continue

    const fqcn = useMap.get(typeName) ?? typeName
    if (SKIP_FQCN.has(fqcn)) continue

    // Only include classes that look like FormRequests
    if (!typeName.endsWith("Request")) continue

    const varNode =
      param.childForFieldName("variable_name") ??
      param.childForFieldName("name") ??
      (param.children as Parser.SyntaxNode[]).find((c) => c.type === "variable_name")

    results.push({ shortName: typeName, fqcn, paramName: varNode?.text ?? "$request" })
  }

  return results
}

// ---- Model param extraction (route-model-binding) --------------------
// Suffixes that indicate service/infrastructure classes, not Eloquent models.
const SERVICE_LIKE_SUFFIXES = new Set([
  "Service", "Repository", "Manager", "Provider", "Factory",
  "Contract", "Interface", "Middleware", "Policy", "Gate",
  "Guard", "Controller", "Handler", "Listener", "Job", "Event",
  "Mailer", "Notification", "Resource", "Transformer",
])

function extractModelParams(
  methodNode: Parser.SyntaxNode,
  useMap: Map<string, string>
): ModelParam[] {
  const results: ModelParam[] = []
  const paramsNode = methodNode.childForFieldName("parameters")
  if (!paramsNode) return results

  for (const param of paramsNode.children as Parser.SyntaxNode[]) {
    if (param.type !== "simple_parameter") continue
    const typeNode = param.childForFieldName("type")
    const varNode  = (param.children as Parser.SyntaxNode[]).find(
      (c) => c.type === "variable_name"
    )
    if (!typeNode || !varNode) continue

    const typeName = typeNode.text.trim()
    if (!typeName || typeName[0] !== typeName[0].toUpperCase() || typeName[0] === typeName[0].toLowerCase()) continue
    if (SKIP_FQCN.has(typeName)) continue
    if (typeName.endsWith("Request")) continue

    const suffix = typeName.replace(/.*([A-Z][a-z]+)$/, "$1")
    if (SERVICE_LIKE_SUFFIXES.has(suffix)) continue

    const classFqcn = useMap.get(typeName) ?? typeName
    if (SKIP_FQCN.has(classFqcn)) continue

    results.push({ className: typeName, classFqcn, paramName: varNode.text })
  }

  return results
}

// ---- authorize() extraction -------------------------------------------

function extractAuthorizeCalls(methodNode: Parser.SyntaxNode, modelParams: ModelParam[]): AuthorizeCall[] {
  const results: AuthorizeCall[] = []
  const body = methodNode.childForFieldName("body")
  if (!body) return results
  gatherAuthorizeCalls(body, results, modelParams)
  return results
}

function gatherAuthorizeCalls(node: Parser.SyntaxNode, results: AuthorizeCall[], modelParams: ModelParam[]): void {
  // $this->authorize('ability', $model)
  if (node.type === "member_call_expression") {
    const obj  = node.childForFieldName("object")
    const name = node.childForFieldName("name")
    if (obj?.text === "$this" && name?.text === "authorize") {
      pushAuthorizeCall(node, results, modelParams)
    }
  }

  // Gate::authorize('ability', $model) or Gate::allows('ability', $model)
  // tree-sitter-php uses "scoped_call_expression" with field "scope" for the class
  if (node.type === "scoped_call_expression") {
    const cls    = node.childForFieldName("scope")
    const method = node.childForFieldName("name")
    if (cls?.text === "Gate" && (method?.text === "authorize" || method?.text === "allows" || method?.text === "check")) {
      pushAuthorizeCall(node, results, modelParams)
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherAuthorizeCalls(child, results, modelParams)
  }
}

function pushAuthorizeCall(node: Parser.SyntaxNode, results: AuthorizeCall[], modelParams: ModelParam[]): void {
  const argsNode = node.childForFieldName("arguments")
  if (!argsNode) return
  const argValues = (argsNode.children as Parser.SyntaxNode[])
    .filter((c) => c.type === "argument")
    .map((c) => c.firstNamedChild)
    .filter((c): c is Parser.SyntaxNode => c !== null)
  const ability = argValues[0] ? resolveStringNode(argValues[0]) : "unknown"

  // Extract the model variable from the second arg (e.g. "$task" from authorize('update', $task))
  let modelVar: string | undefined
  if (argValues[1]?.type === "variable_name") {
    const varText = argValues[1].text  // e.g. "$task"
    // Only set modelVar if we have a matching typed model param
    if (modelParams.some((mp) => mp.paramName === varText)) {
      modelVar = varText
    }
  }

  results.push({ ability, mechanism: node.text, modelVar })
}

// ---- Private method call extraction ----------------------------------
// Finds $this->methodName() calls (direct, not through a property chain).
// These are candidates for depth-1 traversal into the same class.

function extractPrivateMethodCallNames(methodNode: Parser.SyntaxNode): string[] {
  const names = new Set<string>()
  const body = methodNode.childForFieldName("body")
  if (!body) return []
  gatherPrivateMethodCallNames(body, names)
  return Array.from(names)
}

function gatherPrivateMethodCallNames(node: Parser.SyntaxNode, names: Set<string>): void {
  if (node.type === "member_call_expression") {
    const objNode  = node.childForFieldName("object")
    const nameNode = node.childForFieldName("name")
    // $this->method() — object is "$this" directly (not a property chain)
    if (objNode?.text === "$this" && nameNode) {
      names.add(nameNode.text)
    }
  }
  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherPrivateMethodCallNames(child, names)
  }
}

function resolveStringNode(node: Parser.SyntaxNode): string {
  if (node.type === "string") {
    const content = (node.children as Parser.SyntaxNode[]).find((c) => c.type === "string_content")
    return content?.text ?? node.text.slice(1, -1)
  }
  return node.text
}

// ---- Constructor middleware extraction --------------------------------

/**
 * Parse $this->middleware() calls from the __construct() body.
 *
 * Handles:
 *   $this->middleware('auth:web')
 *   $this->middleware('auth:web,subdealer', ['except' => ['login']])
 *   $this->middleware('auth:api', ['only' => ['store']])
 *
 * Note: method-chaining form ($this->middleware('auth')->except([...]))
 * is not yet supported — treated as middleware with no filters.
 */
function gatherConstructorMiddleware(root: Parser.SyntaxNode): ConstructorMiddleware[] {
  const constructNode = findMethod(root, "__construct")
  if (!constructNode) return []
  const body = constructNode.childForFieldName("body")
  if (!body) return []

  const results: ConstructorMiddleware[] = []
  collectMiddlewareCalls(body, results)
  return results
}

function collectMiddlewareCalls(node: Parser.SyntaxNode, results: ConstructorMiddleware[]): void {
  if (node.type === "member_call_expression") {
    const obj  = node.childForFieldName("object")
    const name = node.childForFieldName("name")

    if (obj?.text === "$this" && name?.text === "middleware") {
      const argsNode = node.childForFieldName("arguments")
      if (argsNode) {
        const argList = (argsNode.children as Parser.SyntaxNode[]).filter(
          (c) => c.type === "argument"
        )
        if (argList.length >= 1) {
          const firstVal = argList[0].firstNamedChild
          if (firstVal) {
            const raw = resolveStringNode(firstVal)
            if (raw) {
              let except: string[] = []
              let only:   string[] = []

              if (argList.length >= 2) {
                const secondVal = argList[1].firstNamedChild
                if (secondVal?.type === "array_creation_expression") {
                  for (const elem of secondVal.namedChildren as Parser.SyntaxNode[]) {
                    if (elem.type !== "array_element_initializer") continue
                    // namedChildren: [key_string, value_array] (=> token is anonymous)
                    const named = elem.namedChildren as Parser.SyntaxNode[]
                    if (named.length < 2) continue
                    const key = resolveStringNode(named[0])
                    const valNode = named[1]
                    if (valNode.type === "array_creation_expression") {
                      const vals = extractStringArrayValues(valNode)
                      if (key === "except") except = vals
                      else if (key === "only") only = vals
                    }
                  }
                }
              }

              results.push({ raw, except, only })
            }
          }
        }
      }
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    collectMiddlewareCalls(child, results)
  }
}

// ---- Standalone dispatch extraction (18B.2) --------------------------

const THIS_DISPATCH_METHODS = new Set(["dispatch", "dispatchSync", "dispatchNow", "dispatchAfterResponse"])

/**
 * Detect Job::dispatch() / event(new Event()) / dispatch(new Job()) calls
 * in a method body, EXCLUDING those inside DB::transaction() closures
 * (those are already captured as ir:txn_escape nodes by transaction-parser).
 */
function extractStandaloneDispatches(
  methodNode: Parser.SyntaxNode,
  useMap: Map<string, string>
): StandaloneDispatch[] {
  const body = methodNode.childForFieldName("body")
  if (!body) return []
  const results: StandaloneDispatch[] = []
  gatherStandaloneDispatches(body, useMap, results)
  return results
}

function gatherStandaloneDispatches(
  node: Parser.SyntaxNode,
  useMap: Map<string, string>,
  results: StandaloneDispatch[]
): void {
  // Skip DB::transaction() closures — those are handled by transaction-parser
  if (node.type === "scoped_call_expression") {
    const cls  = (node.children as Parser.SyntaxNode[])[0]
    const name = node.childForFieldName("name")
    if (cls?.text.replace(/^\\/, "") === "DB" && name?.text === "transaction") return

    // ClassName::dispatch() — static dispatch
    if (name?.text === "dispatch") {
      const clsText = cls?.text.replace(/^\\/, "") ?? ""
      if (clsText && clsText !== "DB" && clsText !== "Bus") {
        const fqcn = useMap.get(clsText) ?? clsText
        results.push({ className: clsText, fqcn, kind: classifyDispatch(clsText), callText: node.text })
        return
      }
    }
  }

  // $this->dispatch(new Job()) / $this->dispatchSync() / $this->dispatchNow() — DispatchesJobs trait
  if (node.type === "member_call_expression") {
    const obj  = node.childForFieldName("object")
    const name = node.childForFieldName("name")
    if (obj?.text === "$this" && name && THIS_DISPATCH_METHODS.has(name.text)) {
      const arg = firstArgClassName(node, useMap)
      if (arg) {
        results.push(arg)
        return
      }
    }
  }

  // dispatch(new ClassName()) — global function helper
  if (node.type === "function_call_expression") {
    const fn = node.childForFieldName("function")
    if (fn?.text === "dispatch" || fn?.text === "event") {
      const arg = firstArgClassName(node, useMap)
      if (arg) {
        results.push(arg)
        return
      }
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherStandaloneDispatches(child, useMap, results)
  }
}

function firstArgClassName(
  callNode: Parser.SyntaxNode,
  useMap: Map<string, string>
): StandaloneDispatch | null {
  const argsNode = callNode.childForFieldName("arguments")
  if (!argsNode) return null
  for (const arg of argsNode.children as Parser.SyntaxNode[]) {
    if (arg.type !== "argument") continue
    const val = arg.firstNamedChild
    if (val?.type === "object_creation_expression") {
      const clsNode = val.childForFieldName("class") ?? val.namedChildren[0]
      const clsText = clsNode?.text.replace(/^\\/, "") ?? ""
      if (!clsText) continue
      const fqcn = useMap.get(clsText) ?? clsText
      return { className: clsText, fqcn, kind: classifyDispatch(clsText), callText: callNode.text }
    }
  }
  return null
}

function extractStringArrayValues(arrayNode: Parser.SyntaxNode): string[] {
  const results: string[] = []
  for (const elem of arrayNode.namedChildren as Parser.SyntaxNode[]) {
    if (elem.type !== "array_element_initializer") continue
    const named = elem.namedChildren as Parser.SyntaxNode[]
    // Simple value (no key): namedChildren has exactly 1 element
    if (named.length === 1 && named[0].type === "string") {
      results.push(resolveStringNode(named[0]))
    }
  }
  return results
}

// ---- Constructor injection extraction --------------------------------

/**
 * Parse __construct parameters to build propertyName → FQCN map.
 * Handles PHP 8 constructor promotion (private/public/protected modifiers).
 */
function extractConstructorInjections(
  root: Parser.SyntaxNode,
  useMap: Map<string, string>
): Map<string, string> {
  const constructNode = findMethod(root, "__construct")
  if (!constructNode) return new Map()

  const paramsNode = constructNode.childForFieldName("parameters")
  if (!paramsNode) return new Map()

  const map = new Map<string, string>()

  for (const param of paramsNode.children as Parser.SyntaxNode[]) {
    // Works for simple_parameter and property_promotion_parameter
    const typeNode = param.childForFieldName("type")
    const varNode  = (param.children as Parser.SyntaxNode[]).find(
      (c) => c.type === "variable_name"
    )
    if (!typeNode || !varNode) continue

    const typeName = typeNode.text.trim()

    // Skip primitive and framework base types
    if (!typeName || typeName[0] === typeName[0].toLowerCase()) continue
    if (["Request", "Closure", "Response"].includes(typeName)) continue

    const fqcn    = useMap.get(typeName) ?? typeName
    const varName = varNode.text.replace(/^\$/, "")
    map.set(varName, fqcn)
  }

  return map
}

/**
 * Extract typed non-primitive method parameters as varName → FQCN injections.
 * Handles patterns like: public function store(OrderService $orderService, ...)
 */
function extractMethodParamInjections(
  methodNode: Parser.SyntaxNode,
  useMap: Map<string, string>
): Map<string, string> {
  const map = new Map<string, string>()
  const paramsNode = methodNode.childForFieldName("parameters")
  if (!paramsNode) return map

  for (const param of paramsNode.children as Parser.SyntaxNode[]) {
    if (param.type !== "simple_parameter") continue
    const typeNode = param.childForFieldName("type")
    const varNode  = (param.children as Parser.SyntaxNode[]).find(
      (c) => c.type === "variable_name"
    )
    if (!typeNode || !varNode) continue

    const typeName = typeNode.text.trim()
    if (!typeName || typeName[0] === typeName[0].toLowerCase()) continue
    if (["Request", "Closure", "Response"].includes(typeName)) continue
    // Skip FormRequest subclasses (already handled by extractFormRequests)
    if (typeName.endsWith("Request")) continue

    const fqcn    = useMap.get(typeName) ?? typeName
    const varName = varNode.text.replace(/^\$/, "")
    map.set(varName, fqcn)
  }

  return map
}

// ---- Service call extraction -----------------------------------------

function extractServiceCalls(
  methodNode: Parser.SyntaxNode,
  injections: Map<string, string>,
  _useMap: Map<string, string>
): ServiceCall[] {
  const results: ServiceCall[] = []
  const body = methodNode.childForFieldName("body")
  if (!body) return results
  gatherServiceCalls(body, injections, results)
  return results
}

function gatherServiceCalls(
  node: Parser.SyntaxNode,
  injections: Map<string, string>,
  results: ServiceCall[]
): void {
  if (node.type === "member_call_expression") {
    const objNode  = node.childForFieldName("object")
    const nameNode = node.childForFieldName("name")

    if (nameNode) {
      // Pattern 1: $this->propertyName->method(args)
      if (objNode?.type === "member_access_expression") {
        const innerObj = objNode.childForFieldName("object")
        const propNode = objNode.childForFieldName("name")

        if (innerObj?.text === "$this" && propNode) {
          const prop = propNode.text
          const fqcn = injections.get(prop)

          if (fqcn) {
            const shortName  = fqcn.split("\\").pop() ?? fqcn
            const argsNode   = node.childForFieldName("arguments")
            const stringArgs = argsNode ? extractStringCallArgs(argsNode) : []

            results.push({
              propertyName: prop,
              serviceClass: shortName,
              serviceFqcn:  fqcn,
              method:       nameNode.text,
              args:         stringArgs,
            })
          }
        }
      }

      // Pattern 2: $localVar->method(args) — method-injected service
      if (objNode?.type === "variable_name") {
        const varName = objNode.text.replace(/^\$/, "")
        const fqcn    = injections.get(varName)

        if (fqcn) {
          const shortName  = fqcn.split("\\").pop() ?? fqcn
          const argsNode   = node.childForFieldName("arguments")
          const stringArgs = argsNode ? extractStringCallArgs(argsNode) : []

          results.push({
            propertyName: varName,
            serviceClass: shortName,
            serviceFqcn:  fqcn,
            method:       nameNode.text,
            args:         stringArgs,
          })
        }
      }
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherServiceCalls(child, injections, results)
  }
}

function extractStringCallArgs(argsNode: Parser.SyntaxNode): string[] {
  return (argsNode.children as Parser.SyntaxNode[])
    .filter((c) => c.type === "argument")
    .flatMap((c) => {
      const val = c.firstNamedChild
      if (!val) return []
      if (val.type === "string") {
        const content = (val.children as Parser.SyntaxNode[]).find(
          (sc) => sc.type === "string_content"
        )
        return content?.text ? [content.text] : []
      }
      return []
    })
}

// ---- Notification + Mail dispatch extraction (18B.3) -----------------

function extractNotificationDispatches(
  methodNode: Parser.SyntaxNode,
  useMap: Map<string, string>
): NotificationDispatch[] {
  const body = methodNode.childForFieldName("body")
  if (!body) return []
  const results: NotificationDispatch[] = []
  gatherNotificationDispatches(body, useMap, results)
  return results
}

function gatherNotificationDispatches(
  node: Parser.SyntaxNode,
  useMap: Map<string, string>,
  results: NotificationDispatch[]
): void {
  if (node.type === "scoped_call_expression") {
    const cls  = node.childForFieldName("scope")
    const name = node.childForFieldName("name")
    const clsText = cls?.text.replace(/^\\/, "") ?? ""

    // Notification::send($notifiable, new FooNotification())
    if (clsText === "Notification" && name?.text === "send") {
      const argsNode = node.childForFieldName("arguments")
      const argList  = (argsNode?.children as Parser.SyntaxNode[] ?? []).filter(c => c.type === "argument")
      const notifArg = argList[1]?.firstNamedChild
      if (notifArg?.type === "object_creation_expression") {
        const entry = objCreationToDispatch(notifArg, useMap, "notification", false, node.text)
        if (entry) { results.push(entry); return }
      }
    }

    // Mail::queue(new FooMail()) or Mail::send(new FooMail())
    if (clsText === "Mail" && (name?.text === "queue" || name?.text === "send")) {
      const entry = firstArgToDispatch(node, useMap, "mail", name.text === "queue")
      if (entry) { results.push(entry); return }
    }
  }

  if (node.type === "member_call_expression") {
    const name = node.childForFieldName("name")

    // $user->notify(new FooNotification()) or $user->notifyNow(...)
    if (name?.text === "notify" || name?.text === "notifyNow") {
      const entry = firstArgToDispatch(node, useMap, "notification", false)
      if (entry) { results.push(entry); return }
    }

    // Mail::to(...)->send(new FooMail()) or ->queue(new FooMail())
    if (name?.text === "send" || name?.text === "queue") {
      const obj = node.childForFieldName("object")
      if (isMailFluentChain(obj)) {
        const entry = firstArgToDispatch(node, useMap, "mail", name.text === "queue")
        if (entry) { results.push(entry); return }
      }
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherNotificationDispatches(child, useMap, results)
  }
}

function isMailFluentChain(node: Parser.SyntaxNode | null | undefined): boolean {
  if (!node) return false
  if (node.type === "scoped_call_expression") {
    const cls  = node.childForFieldName("scope")
    const name = node.childForFieldName("name")
    return (cls?.text.replace(/^\\/, "") === "Mail") &&
           (name?.text === "to" || name?.text === "cc" || name?.text === "bcc")
  }
  if (node.type === "member_call_expression") {
    return isMailFluentChain(node.childForFieldName("object"))
  }
  return false
}

function firstArgToDispatch(
  callNode: Parser.SyntaxNode,
  useMap: Map<string, string>,
  kind: "notification" | "mail",
  queued: boolean
): NotificationDispatch | null {
  const argsNode = callNode.childForFieldName("arguments")
  if (!argsNode) return null
  for (const arg of argsNode.children as Parser.SyntaxNode[]) {
    if (arg.type !== "argument") continue
    const val = arg.firstNamedChild
    if (val?.type === "object_creation_expression") {
      return objCreationToDispatch(val, useMap, kind, queued, callNode.text)
    }
  }
  return null
}

function objCreationToDispatch(
  creationNode: Parser.SyntaxNode,
  useMap: Map<string, string>,
  kind: "notification" | "mail",
  queued: boolean,
  callText: string
): NotificationDispatch | null {
  const clsNode = creationNode.childForFieldName("class") ?? creationNode.namedChildren[0]
  const clsText = clsNode?.text.replace(/^\\/, "") ?? ""
  if (!clsText) return null
  return { className: clsText, fqcn: useMap.get(clsText) ?? clsText, kind, queued, callText }
}
