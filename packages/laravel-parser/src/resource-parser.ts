import { readFileSync } from "fs"
import Parser from "tree-sitter"
// @ts-ignore
import PHP from "tree-sitter-php"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ResourceField {
  key:        string         // e.g. "id", "name", "email"
  valueExpr:  string         // raw PHP expression, e.g. "$this->id"
  isSensitive: boolean       // heuristic: key contains "secret|token|password|internal|admin"
}

export interface NestedResourceRef {
  shortName:    string   // e.g. "TagResource"
  fqcn:         string   // e.g. "App\Http\Resources\TagResource"
  isCollection: boolean  // true for ::collection() call
}

export interface ApiResourceInfo {
  className:  string         // e.g. "UserResource"
  fqcn:       string         // e.g. "App\Http\Resources\UserResource"
  fields:     ResourceField[]
  isCollection: boolean      // true if it extends ResourceCollection
  conditionalFields: string[] // fields wrapped in $this->when(...)
  nestedResources: NestedResourceRef[] // resources returned from toArray() values
}

const SENSITIVE_PATTERNS = /secret|token|password|passwd|internal|admin_|_admin|private|api_key/i

/**
 * Parse a Laravel JsonResource PHP file and extract the field list from toArray().
 * Returns null if the file can't be parsed or has no toArray() method.
 */
export function parseApiResource(filePath: string): ApiResourceInfo | null {
  let source: string
  let tree: ReturnType<typeof _parser.parse>
  try {
    source = readFileSync(filePath, "utf-8")
    tree = _parser.parse(source)
  } catch {
    return null
  }

  const root = tree.rootNode
  const className   = extractClassName(root)
  const fqcn        = buildFqcn(root, className)
  const useMap      = extractResourceUseMap(root)
  const isCollection = checkIsCollection(source)
  const fields      = extractToArrayFields(root)
  const conditionalFields = extractConditionalFields(root)
  const nestedResources   = extractNestedResourceRefs(root, useMap)

  return { className, fqcn, fields, isCollection, conditionalFields, nestedResources }
}

/**
 * Detect `return new XResource(...)` or `XResource::collection(...)` in a method body.
 * Returns list of short class names found.
 */
export function extractReturnedResources(
  methodBody: Parser.SyntaxNode,
  useMap: Map<string, string>
): Array<{ shortName: string; fqcn: string; isCollection: boolean }> {
  const found: Array<{ shortName: string; fqcn: string; isCollection: boolean }> = []
  gatherResourceReturns(methodBody, useMap, found)
  return found
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function extractClassName(root: Parser.SyntaxNode): string {
  for (const child of root.children) {
    const name = findClassNameIn(child)
    if (name) return name
  }
  return "Unknown"
}

function findClassNameIn(node: Parser.SyntaxNode): string | null {
  if (node.type === "class_declaration") {
    const nameNode = node.childForFieldName("name")
    return nameNode?.text ?? null
  }
  for (const child of node.children) {
    const found = findClassNameIn(child)
    if (found) return found
  }
  return null
}

function buildFqcn(root: Parser.SyntaxNode, className: string): string {
  const nsNode = root.children.find(c => c.type === "namespace_definition")
  if (!nsNode) return className
  const nameNode = nsNode.childForFieldName("name")
  return nameNode ? `${nameNode.text}\\${className}` : className
}

function checkIsCollection(source: string): boolean {
  return source.includes("ResourceCollection") || source.includes("::collection(")
}

function extractToArrayFields(root: Parser.SyntaxNode): ResourceField[] {
  const methodNode = findMethodNode(root, "toArray")
  if (!methodNode) return []

  const body = methodNode.childForFieldName("body")
  if (!body) return []

  const fields: ResourceField[] = []

  // Find array return: return [...] or return array(...)
  for (const child of walkNodes(body)) {
    if (child.type !== "return_statement") continue
    const expr = child.namedChildren[0]
    if (!expr) continue
    if (expr.type === "array_creation_expression") {
      extractArrayFields(expr, fields)
    }
    // array_merge([...], [...]) — extract from each array arg
    if (expr.type === "function_call_expression") {
      const nameNode = expr.childForFieldName("function")
      if (nameNode?.text === "array_merge") {
        const args = expr.childForFieldName("arguments")
        if (args) {
          for (const arg of args.children) {
            if (arg.type === "argument" && arg.namedChildren[0]?.type === "array_creation_expression") {
              extractArrayFields(arg.namedChildren[0], fields)
            }
          }
        }
      }
    }
  }

  return fields
}

function extractArrayFields(arrayNode: Parser.SyntaxNode, fields: ResourceField[]): void {
  for (const elem of arrayNode.namedChildren) {
    if (elem.type !== "array_element_initializer") continue
    const named = elem.namedChildren
    // Key => value pair: ['key' => $this->something]
    if (named.length >= 2) {
      const keyNode = named[0]
      const valNode = named[1]
      if (keyNode.type === "string") {
        const key = resolveString(keyNode)
        const valueExpr = valNode.text.trim()
        // Skip $this->when(...) — captured separately as conditional
        const isSensitive = SENSITIVE_PATTERNS.test(key)
        fields.push({ key, valueExpr, isSensitive })
      }
    }
  }
}

function extractConditionalFields(root: Parser.SyntaxNode): string[] {
  const methodNode = findMethodNode(root, "toArray")
  if (!methodNode) return []

  const body = methodNode.childForFieldName("body")
  if (!body) return []

  const conditionals: string[] = []
  for (const node of walkNodes(body)) {
    // $this->when('field', ...) or $this->whenLoaded('relation', ...)
    if (node.type === "member_call_expression") {
      const obj  = node.childForFieldName("object")
      const name = node.childForFieldName("name")
      if (obj?.text === "$this" && (name?.text === "when" || name?.text === "whenLoaded" || name?.text === "whenNotNull")) {
        const args = node.childForFieldName("arguments")
        const firstArg = args?.namedChildren[0]?.namedChildren[0]
        if (firstArg?.type === "string") {
          conditionals.push(resolveString(firstArg))
        }
      }
    }
  }
  return conditionals
}

function gatherResourceReturns(
  node: Parser.SyntaxNode,
  useMap: Map<string, string>,
  found: Array<{ shortName: string; fqcn: string; isCollection: boolean }>
): void {
  // new XResource($model) or new XResource::make($model)
  if (node.type === "object_creation_expression") {
    const classNode = node.childForFieldName("class_name") ?? node.namedChildren[0]
    if (classNode) {
      const shortName = classNode.text.trim()
      if (shortName.endsWith("Resource") || shortName.endsWith("Collection")) {
        const fqcn = useMap.get(shortName) ?? shortName
        found.push({ shortName, fqcn, isCollection: false })
      }
    }
  }

  // XResource::collection($models) — static call
  if (node.type === "scoped_call_expression") {
    const scope  = node.childForFieldName("scope")
    const method = node.childForFieldName("name")
    if (method?.text === "collection" && scope) {
      const shortName = scope.text.trim()
      if (shortName.endsWith("Resource") || shortName.endsWith("Collection")) {
        const fqcn = useMap.get(shortName) ?? shortName
        found.push({ shortName, fqcn, isCollection: true })
      }
    }
    // XResource::make($model)
    if (method?.text === "make" && scope) {
      const shortName = scope.text.trim()
      if (shortName.endsWith("Resource")) {
        const fqcn = useMap.get(shortName) ?? shortName
        found.push({ shortName, fqcn, isCollection: false })
      }
    }
  }

  for (const child of node.children) {
    gatherResourceReturns(child, useMap, found)
  }
}

function findMethodNode(root: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  for (const node of walkNodes(root)) {
    if (node.type === "method_declaration") {
      const nameNode = node.childForFieldName("name")
      if (nameNode?.text === name) return node
    }
  }
  return null
}

function* walkNodes(node: Parser.SyntaxNode): Generator<Parser.SyntaxNode> {
  yield node
  for (const child of node.children) {
    yield* walkNodes(child)
  }
}

function resolveString(node: Parser.SyntaxNode): string {
  const content = node.children.find(c => c.type === "string_content")
  return content?.text ?? node.text.slice(1, -1)
}

// ─── Use-map for resource files ───────────────────────────────────────────────

function extractResourceUseMap(root: Parser.SyntaxNode): Map<string, string> {
  const map = new Map<string, string>()
  for (const node of walkNodes(root)) {
    if (node.type !== "namespace_use_declaration") continue
    const group  = node.children.find(c => c.type === "namespace_use_group")
    const prefix = node.children.find(c => c.type === "namespace_name")?.text ?? ""
    if (group) {
      for (const clause of group.children) {
        if (clause.type === "namespace_use_clause") registerClause(clause, prefix, map)
      }
    } else {
      for (const clause of node.children) {
        if (clause.type === "namespace_use_clause") registerClause(clause, "", map)
      }
    }
  }
  return map
}

function registerClause(clause: Parser.SyntaxNode, prefix: string, map: Map<string, string>): void {
  const qualName = clause.children.find(c => c.type === "qualified_name" || c.type === "name")
  if (!qualName) return
  const raw  = qualName.text.trim()
  const fqcn = prefix ? `${prefix}\\${raw}` : raw
  const short = fqcn.split("\\").pop() ?? fqcn
  map.set(short, fqcn)
}

// ─── Nested resource detection ────────────────────────────────────────────────

/**
 * Scan toArray() body for nested resource instantiations:
 *   - new XResource($model)                        — direct array value
 *   - XResource::collection($models)               — direct array value
 *   - $this->when(..., fn() => new XResource())    — inside when() closures
 */
export function extractNestedResourceRefs(
  root: Parser.SyntaxNode,
  useMap: Map<string, string>
): NestedResourceRef[] {
  const methodNode = findMethodNode(root, "toArray")
  if (!methodNode) return []
  const body = methodNode.childForFieldName("body")
  if (!body) return []

  const refs: NestedResourceRef[] = []
  const seen = new Set<string>()

  for (const node of walkNodes(body)) {
    // new XResource(...) — object_creation_expression
    if (node.type === "object_creation_expression") {
      const clsNode = node.childForFieldName("class_name") ?? node.namedChildren[0]
      if (clsNode) {
        const short = clsNode.text.trim()
        if (isResourceName(short) && !seen.has(short)) {
          seen.add(short)
          refs.push({ shortName: short, fqcn: useMap.get(short) ?? short, isCollection: false })
        }
      }
    }

    // XResource::collection(...) or XResource::make(...) — scoped_call_expression
    if (node.type === "scoped_call_expression") {
      const scope  = node.childForFieldName("scope")
      const method = node.childForFieldName("name")
      if (scope && (method?.text === "collection" || method?.text === "make")) {
        const short = scope.text.trim()
        if (isResourceName(short) && !seen.has(short)) {
          seen.add(short)
          refs.push({ shortName: short, fqcn: useMap.get(short) ?? short, isCollection: method.text === "collection" })
        }
      }
    }
  }

  return refs
}

function isResourceName(name: string): boolean {
  return (name.endsWith("Resource") || name.endsWith("Collection")) && name !== "JsonResource" && name !== "ResourceCollection"
}
