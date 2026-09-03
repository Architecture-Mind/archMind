import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import type { SyntaxNode } from "./ast.js"
import { findCalls, callParts, stringLiteralValue, walk } from "./ast.js"

// ---------------------------------------------------------------------------
// Middleware name → IR node type classification
// ---------------------------------------------------------------------------
// Matched on the final segment of the middleware's constructor name (e.g.
// "AuthMiddleware" out of "middleware.AuthMiddleware"), same "match by the
// function's short name, not its import path" approach as Laravel's
// middleware-mapper — resilient to how the package is imported/aliased.

const AUTH_NAME_PATTERN = /^(Auth|RequireAuth|JWTAuth|Authenticate)/
const AUTHZ_NAME_PATTERN = /^(RequireRole|RequireSystemRole|RequirePermission|RequireScope|Authorize)/

export type MiddlewareClassification =
  | { kind: "auth_gate" }
  | { kind: "authz_check" }
  | { kind: "unclassified" }

export function classifyMiddlewareName(shortName: string): MiddlewareClassification {
  if (AUTH_NAME_PATTERN.test(shortName)) return { kind: "auth_gate" }
  if (AUTHZ_NAME_PATTERN.test(shortName)) return { kind: "authz_check" }
  return { kind: "unclassified" }
}

export function irTypeForMiddleware(shortName: string): string {
  const c = classifyMiddlewareName(shortName)
  if (c.kind === "auth_gate") return IR_NODE_TYPES.AUTH_GATE
  if (c.kind === "authz_check") return IR_NODE_TYPES.AUTHZ_CHECK
  return IR_NODE_TYPES.UNKNOWN_MIDDLEWARE
}

// ---------------------------------------------------------------------------
// Skip-list extraction
// ---------------------------------------------------------------------------
// A globally-`Use()`d auth middleware commonly carries its own exemption list
// instead of being left off exempt routes at the registration site (see
// docs/go-support-plan.md §2). Shape observed in all 3 surveyed repos:
//
//   skipRoutes := map[skipKey]bool{
//       {http.MethodPost, "/api/v1/auth/register"}: true,
//       ...
//   }
//   if skipRoutes[skipKey{ctx.Request.Method, ctx.FullPath()}] { ... }
//
// We don't attempt full data-flow (is this specific map actually consulted
// to skip auth) — we take any `map[...]bool` composite literal in the
// function body whose keys are 2-element {method, path} literal pairs as the
// exemption list. False positives (an unrelated same-shaped map) are judged
// unlikely enough to accept for v1; revisit if a real repo trips it.

const HTTP_METHOD_CONSTANTS: Record<string, string> = {
  "http.MethodGet":     "GET",
  "http.MethodPost":    "POST",
  "http.MethodPut":     "PUT",
  "http.MethodPatch":   "PATCH",
  "http.MethodDelete":  "DELETE",
  "http.MethodHead":    "HEAD",
  "http.MethodOptions": "OPTIONS",
}

export interface SkipEntry {
  method: string
  path: string
}

function resolveMethodLiteral(node: SyntaxNode): string | null {
  if (node.type === "selector_expression") return HTTP_METHOD_CONSTANTS[node.text] ?? null
  const str = stringLiteralValue(node)
  return str ? str.toUpperCase() : null
}

/**
 * Scans a function body for `map[...]bool{ {methodExpr, "path"}: true, ... }`
 * composite literals and returns every {method, path} pair found. Returns []
 * when no such map exists (most middleware — this is only relevant for a
 * middleware that gates by method+path exemption).
 */
export function extractSkipList(functionBody: SyntaxNode): SkipEntry[] {
  const entries: SkipEntry[] = []

  for (const node of walk(functionBody)) {
    if (node.type !== "composite_literal") continue
    const mapType = node.namedChildren.find((c) => c.type === "map_type")
    if (!mapType) continue

    const literalValue = node.namedChildren.find((c) => c.type === "literal_value")
    if (!literalValue) continue

    for (const keyed of literalValue.namedChildren) {
      if (keyed.type !== "keyed_element") continue
      const [keyElement] = keyed.namedChildren
      if (!keyElement || keyElement.type !== "literal_element") continue
      const keyLiteral = keyElement.namedChildren[0]
      if (!keyLiteral || keyLiteral.type !== "literal_value") continue

      const parts = keyLiteral.namedChildren
        .filter((c) => c.type === "literal_element")
        .map((c) => c.namedChildren[0])
        .filter((c): c is SyntaxNode => !!c)
      if (parts.length !== 2) continue

      const method = resolveMethodLiteral(parts[0])
      const path = stringLiteralValue(parts[1])
      if (method && path) entries.push({ method, path })
    }
  }

  return entries
}

/**
 * Finds `funcDecl`'s in `allFunctions` whose name matches `shortName` and
 * returns its extracted skip-list (empty if not found or the function has
 * none). `allFunctions` should span every parsed file, not just one.
 */
export function resolveSkipListForMiddleware(
  shortName: string,
  functionsByName: Map<string, SyntaxNode>
): SkipEntry[] {
  const fn = functionsByName.get(shortName)
  if (!fn) return []
  const body = fn.childForFieldName("body")
  if (!body) return []
  return extractSkipList(body)
}

/** Extracts the short (unqualified) name from a receiver-qualified call, e.g. "middleware.AuthMiddleware" → "AuthMiddleware". */
export function shortMiddlewareName(qualifiedOrBare: string): string {
  const idx = qualifiedOrBare.lastIndexOf(".")
  return idx === -1 ? qualifiedOrBare : qualifiedOrBare.slice(idx + 1)
}

/** All call_expressions in `root` that look like middleware factory calls, e.g. `middleware.RequireRole(model.RoleAdmin)`. */
export function findMiddlewareCalls(root: SyntaxNode): SyntaxNode[] {
  return findCalls(root).filter((c) => {
    const parts = callParts(c)
    return !!parts && /Middleware$|^Require|^Authorize$/.test(parts.method)
  })
}
