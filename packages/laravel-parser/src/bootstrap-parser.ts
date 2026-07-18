import { readFileSync } from "fs"
import { join, relative, normalize } from "path"
// @ts-ignore
import Parser from "tree-sitter"
// @ts-ignore
import PHP from "tree-sitter-php"

import type { AliasMap } from "./kernel-parser.js"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

export interface BootstrapParseResult {
  /** Middleware alias → FQCN map extracted from ->withMiddleware($m->alias([...])) */
  aliasMap: AliasMap
  /** Route files (relative to projectRoot) detected from ->withRouting(api:..., web:...) */
  routeFiles: string[]
  /**
   * Route file (relative to projectRoot) → path prefix implied by ->withRouting(). The
   * `api:` argument implicitly wraps its file in Laravel's default 'api' prefix unless
   * overridden by an explicit `apiPrefix:` argument (empty string disables it).
   */
  routePrefixes: Map<string, string>
}

type AstNode = { type: string; children: AstNode[]; namedChildren: AstNode[]; text: string }

/**
 * Parse Laravel 11+ bootstrap/app.php.
 * Returns empty aliasMap and routeFiles if the file cannot be read or parsed.
 */
export function parseBootstrap(filePath: string, projectRoot: string): BootstrapParseResult {
  let source: string
  let tree: ReturnType<typeof _parser.parse>
  try {
    source = readFileSync(filePath, "utf-8")
    tree = _parser.parse(source)
  } catch {
    return { aliasMap: {}, routeFiles: [], routePrefixes: new Map() }
  }
  const root = tree.rootNode as AstNode

  const aliasMap = extractAliasMap(root)
  const routeFiles = extractRouteFiles(root, filePath, projectRoot)
  const routePrefixes = extractRoutePrefixes(root, filePath, projectRoot)

  return { aliasMap, routeFiles, routePrefixes }
}

// ---- Middleware alias extraction -----------------------------------------

// Finds: ->withMiddleware(function(Middleware $middleware) { $middleware->alias([...]) })
function extractAliasMap(root: AstNode): AliasMap {
  const out: AliasMap = {}
  findWithMiddlewareCall(root, out)
  return out
}

function findWithMiddlewareCall(node: AstNode, out: AliasMap): void {
  if (node.type === "member_call_expression") {
    const nameNode = node.children.find((c) => c.type === "name")
    if (nameNode?.text === "withMiddleware") {
      const args = node.children.find((c) => c.type === "arguments")
      if (args) {
        extractAliasFromMiddlewareClosure(args, out)
        return
      }
    }
  }
  for (const child of node.children) {
    findWithMiddlewareCall(child, out)
  }
}

function extractAliasFromMiddlewareClosure(argsNode: AstNode, out: AliasMap): void {
  // Walk into closure body, find $middleware->alias([...])
  findAliasCall(argsNode, out)
}

function findAliasCall(node: AstNode, out: AliasMap): void {
  if (node.type === "member_call_expression") {
    const nameNode = node.children.find((c) => c.type === "name")
    if (nameNode?.text === "alias") {
      const args = node.children.find((c) => c.type === "arguments")
      if (args) {
        const arr = findArrayCreation(args)
        if (arr) extractAliasArray(arr, out)
        return
      }
    }
  }
  for (const child of node.children) {
    findAliasCall(child, out)
  }
}

function findArrayCreation(node: AstNode): AstNode | null {
  if (node.type === "array_creation_expression") return node
  for (const child of node.children) {
    const found = findArrayCreation(child)
    if (found) return found
  }
  return null
}

function extractAliasArray(arrNode: AstNode, out: AliasMap): void {
  for (const child of arrNode.children) {
    if (child.type !== "array_element_initializer") continue
    const named = child.namedChildren
    if (named.length < 2) continue
    const key = extractStringContent(named[0]!)
    const fqcn = extractClassFqcn(named[named.length - 1]!)
    if (key && fqcn) out[key] = fqcn
  }
}

// ---- Route file extraction -----------------------------------------------

// Finds: ->withRouting(api: __DIR__.'/../routes/api.php', web: ...)
function extractRouteFiles(root: AstNode, bootstrapFilePath: string, projectRoot: string): string[] {
  const bootstrapDir = bootstrapFilePath.replace(/[/\\][^/\\]+$/, "") // dirname
  const files: string[] = []
  findWithRoutingCall(root, bootstrapDir, projectRoot, files)
  return files
}

const ROUTE_ARG_NAMES = new Set(["api", "web", "commands"])
const DEFAULT_API_PREFIX = "api"

function findWithRoutingCall(node: AstNode, bootstrapDir: string, projectRoot: string, out: string[]): void {
  if (node.type === "member_call_expression") {
    const nameNode = node.children.find((c) => c.type === "name")
    if (nameNode?.text === "withRouting") {
      const args = node.children.find((c) => c.type === "arguments")
      if (args) {
        extractNamedRouteArgs(args, bootstrapDir, projectRoot, out)
        return
      }
    }
  }
  for (const child of node.children) {
    findWithRoutingCall(child, bootstrapDir, projectRoot, out)
  }
}

function extractNamedRouteArgs(argsNode: AstNode, bootstrapDir: string, projectRoot: string, out: string[]): void {
  for (const child of argsNode.children) {
    // PHP 8 named args in tree-sitter-php use type "argument" with leading name + ":"
    if (child.type !== "argument") continue
    const nameNode = child.children.find((c) => c.type === "name")
    if (!nameNode || !ROUTE_ARG_NAMES.has(nameNode.text)) continue

    // Value is the expression after the ":" separator
    const colonIdx = child.children.findIndex((c) => c.text === ":")
    const valueNode = colonIdx >= 0 ? child.children[colonIdx + 1] : undefined
    if (!valueNode) continue

    const resolved = resolvePathExpression(valueNode, bootstrapDir)
    if (!resolved) continue

    // Convert absolute path to relative path from projectRoot
    const rel = relative(projectRoot, resolved).replace(/\\/g, "/")
    if (!rel.startsWith("..") && !out.includes(rel)) {
      out.push(rel)
    }
  }
}

// Finds: ->withRouting(api: __DIR__.'/../routes/api.php', apiPrefix: 'api/v1')
// The `api:` arg implicitly wraps in the default 'api' prefix unless `apiPrefix:` overrides it.
function extractRoutePrefixes(root: AstNode, bootstrapFilePath: string, projectRoot: string): Map<string, string> {
  const bootstrapDir = bootstrapFilePath.replace(/[/\\][^/\\]+$/, "")
  const out = new Map<string, string>()
  findWithRoutingPrefixCall(root, bootstrapDir, projectRoot, out)
  return out
}

function findWithRoutingPrefixCall(node: AstNode, bootstrapDir: string, projectRoot: string, out: Map<string, string>): void {
  if (node.type === "member_call_expression") {
    const nameNode = node.children.find((c) => c.type === "name")
    if (nameNode?.text === "withRouting") {
      const args = node.children.find((c) => c.type === "arguments")
      if (args) {
        extractApiPrefixArg(args, bootstrapDir, projectRoot, out)
        return
      }
    }
  }
  for (const child of node.children) {
    findWithRoutingPrefixCall(child, bootstrapDir, projectRoot, out)
  }
}

function extractApiPrefixArg(argsNode: AstNode, bootstrapDir: string, projectRoot: string, out: Map<string, string>): void {
  let apiRelFile: string | null = null
  let apiPrefix: string = DEFAULT_API_PREFIX

  for (const child of argsNode.children) {
    if (child.type !== "argument") continue
    const nameNode = child.children.find((c) => c.type === "name")
    if (!nameNode) continue

    const colonIdx = child.children.findIndex((c) => c.text === ":")
    const valueNode = colonIdx >= 0 ? child.children[colonIdx + 1] : undefined
    if (!valueNode) continue

    if (nameNode.text === "api") {
      const resolved = resolvePathExpression(valueNode, bootstrapDir)
      if (resolved) apiRelFile = relative(projectRoot, resolved).replace(/\\/g, "/")
    } else if (nameNode.text === "apiPrefix") {
      apiPrefix = extractStringContent(valueNode) ?? apiPrefix
    }
  }

  if (apiRelFile && !apiRelFile.startsWith("..") && apiPrefix) {
    out.set(apiRelFile, apiPrefix)
  }
}

/**
 * Resolve PHP path expressions like __DIR__.'/../routes/api.php'
 * Returns absolute path or null if unresolvable.
 */
function resolvePathExpression(node: AstNode, bootstrapDir: string): string | null {
  // __DIR__ . '/../routes/api.php'
  if (node.type === "binary_expression") {
    const left = node.children[0]
    const right = node.children[2]
    if (!left || !right) return null

    const leftStr = left.text === "__DIR__" ? bootstrapDir : extractStringContent(left)
    const rightStr = extractStringContent(right)

    if (leftStr && rightStr) {
      return normalize(join(leftStr, rightStr))
    }
    return null
  }

  // plain string
  const str = extractStringContent(node)
  if (str) return normalize(str)

  return null
}

// ---- Shared helpers -------------------------------------------------------

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
  return extractStringContent(node)
}
