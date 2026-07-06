// @ts-ignore — tree-sitter lacks ambient declarations in this workspace
import Parser from "tree-sitter"
import { readFileSync } from "fs"
// @ts-ignore
import PHP from "tree-sitter-php"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

// alias string → fully-qualified class name
// e.g. { "role": "App\\Http\\Middleware\\EnsureUserHasRole", "tenant": "App\\Http\\Middleware\\ResolveTenant" }
export type AliasMap = Record<string, string>

// group name → concrete middleware entries (FQCN or raw builtin string like "throttle:api")
// e.g. { "api": ["App\\Http\\Middleware\\ApiAuthenticate", "throttle:api"] }
export type MiddlewareGroupMap = Record<string, string[]>

/**
 * Parse $middlewareAliases (Laravel 10) or $routeMiddleware (Laravel 9) from Kernel.php.
 * Returns an empty map if the file cannot be read or no aliases are found.
 */
export function parseKernel(filePath: string): AliasMap {
  let source: string
  let tree: ReturnType<typeof _parser.parse>
  try {
    source = readFileSync(filePath, "utf-8")
    tree = _parser.parse(source)
  } catch {
    return {}
  }
  const out: AliasMap = {}
  findAliasProperty(tree.rootNode, out)
  return out
}

/**
 * Parse $middlewareGroups from Kernel.php (e.g. 'api' => [SubstituteBindings::class, 'throttle:api']).
 * Returns an empty map if the file cannot be read or no groups are found.
 */
export function parseMiddlewareGroups(filePath: string): MiddlewareGroupMap {
  let source: string
  let tree: ReturnType<typeof _parser.parse>
  try {
    source = readFileSync(filePath, "utf-8")
    tree = _parser.parse(source)
  } catch {
    return {}
  }
  const out: MiddlewareGroupMap = {}
  findMiddlewareGroupsProperty(tree.rootNode, out)
  return out
}

// ---- Internals -----------------------------------------------------------

function findAliasProperty(node: { type: string; children: typeof node[]; namedChildren: typeof node[]; text: string }, out: AliasMap): void {
  if (node.type === "property_element") {
    const nameNode = node.children.find((c) => c.type === "variable_name")
    if (
      nameNode &&
      (nameNode.text === "$middlewareAliases" || nameNode.text === "$routeMiddleware")
    ) {
      const arrNode = node.children.find((c) => c.type === "array_creation_expression")
      if (arrNode) {
        extractAliasArray(arrNode, out)
        return
      }
    }
  }

  for (const child of node.children) {
    findAliasProperty(child, out)
  }
}

type AstNode = { type: string; children: AstNode[]; namedChildren: AstNode[]; text: string }

function findMiddlewareGroupsProperty(node: AstNode, out: MiddlewareGroupMap): void {
  if (node.type === "property_element") {
    const nameNode = node.children.find((c) => c.type === "variable_name")
    if (nameNode && nameNode.text === "$middlewareGroups") {
      const arrNode = node.children.find((c) => c.type === "array_creation_expression")
      if (arrNode) {
        extractMiddlewareGroupsArray(arrNode, out)
        return
      }
    }
  }

  for (const child of node.children) {
    findMiddlewareGroupsProperty(child, out)
  }
}

function extractMiddlewareGroupsArray(arrNode: AstNode, out: MiddlewareGroupMap): void {
  for (const child of arrNode.children) {
    if (child.type !== "array_element_initializer") continue

    const named = child.namedChildren
    if (named.length < 2) continue

    const keyNode   = named[0]
    const valueNode = named[named.length - 1]

    const key = extractStringContent(keyNode)
    if (!key || valueNode.type !== "array_creation_expression") continue

    const entries: string[] = []
    for (const el of valueNode.children) {
      if (el.type !== "array_element_initializer" && el.type !== "class_constant_access_expression" && el.type !== "string" && el.type !== "encapsed_string") continue
      const itemNode = el.type === "array_element_initializer" ? el.namedChildren[0] : el
      if (!itemNode) continue
      const entry = extractClassFqcn(itemNode)
      if (entry) entries.push(entry)
    }

    out[key] = entries
  }
}

function extractAliasArray(arrNode: AstNode, out: AliasMap): void {
  for (const child of arrNode.children) {
    if (child.type !== "array_element_initializer") continue

    const named = child.namedChildren
    if (named.length < 2) continue

    const keyNode   = named[0]
    const valueNode = named[named.length - 1]

    const key  = extractStringContent(keyNode)
    const fqcn = extractClassFqcn(valueNode)

    if (key && fqcn) {
      out[key] = fqcn
    }
  }
}

function extractStringContent(node: AstNode): string | null {
  if (node.type === "string" || node.type === "encapsed_string") {
    const content = node.children.find((c) => c.type === "string_content")
    return content?.text ?? null
  }
  return null
}

function extractClassFqcn(node: AstNode): string | null {
  if (node.type === "class_constant_access_expression") {
    const classNode = node.children[0]
    const constNode = node.children[2]
    if (constNode?.text === "class" && classNode) {
      return classNode.text.replace(/^\\/, "")
    }
  }
  // String literal fallback: 'App\Http\Middleware\Foo'
  return extractStringContent(node)
}
