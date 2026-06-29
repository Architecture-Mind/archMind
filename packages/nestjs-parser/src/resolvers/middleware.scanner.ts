/**
 * NestMiddleware scanner.
 *
 * Scans *.module.ts files for the NestModule.configure() pattern:
 *
 *   consumer.apply(AuthMiddleware).forRoutes(
 *     { path: 'articles/feed', method: RequestMethod.GET },
 *     ...
 *   )
 *
 * Returns a map: normalised entrypoint → middleware class names[]
 * so the adapter can prepend auth nodes to matching routes.
 */

import { readdirSync, statSync } from "fs"
import { join } from "path"
import { Project, SyntaxKind } from "ts-morph"
import { classifyGuard } from "./guard.classifier.js"
import type { GuardDescriptor } from "../types.js"
import type { ArchMindUserConfig } from "@kidkender/archmind-protocol"

// ---- Types ---------------------------------------------------------------

export interface MiddlewareEntry {
  className:  string
  irType:     GuardDescriptor["irType"]
}

/** normalised entrypoint (e.g. "GET /articles/feed") → middleware descriptors */
export type MiddlewareMap = Map<string, MiddlewareEntry[]>

// ---- RequestMethod numeric values (from @nestjs/common) -----------------
// We match both enum name ("GET") and numeric value (0).
const REQUEST_METHOD_NAMES: Record<string, string> = {
  GET: "GET", POST: "POST", PUT: "PUT", DELETE: "DELETE",
  PATCH: "PATCH", OPTIONS: "OPTIONS", HEAD: "HEAD", ALL: "ALL",
  "0": "GET", "1": "POST", "2": "PUT", "3": "DELETE",
  "4": "PATCH", "5": "OPTIONS", "6": "HEAD", "7": "ALL",
}

// ---- Public API ----------------------------------------------------------

export function scanMiddleware(projectRoot: string, userConfig?: ArchMindUserConfig): MiddlewareMap {
  const map: MiddlewareMap = new Map()
  const moduleFiles = findModuleFiles(projectRoot)
  if (!moduleFiles.length) return map

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, noEmit: true, skipLibCheck: true, strict: false },
  })
  project.addSourceFilesAtPaths(moduleFiles.map(f => f.replace(/\\/g, "/")))

  for (const sourceFile of project.getSourceFiles()) {
    for (const cls of sourceFile.getClasses()) {
      // Only process classes implementing NestModule
      const implementsClauses = cls.getImplements().map(i => i.getText())
      if (!implementsClauses.some(c => c.includes("NestModule"))) continue

      const configureMethod = cls.getMethod("configure")
      if (!configureMethod) continue

      extractMiddlewareFromConfigure(configureMethod, map, userConfig)
    }
  }

  return map
}

// ---- Internal ------------------------------------------------------------

function findModuleFiles(root: string): string[] {
  const results: string[] = []
  function walk(dir: string, depth = 0) {
    if (depth > 8) return
    try {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist" || entry === ".git") continue
        const full = join(dir, entry)
        const stat = statSync(full)
        if (stat.isDirectory()) walk(full, depth + 1)
        else if (entry.endsWith(".module.ts")) results.push(full)
      }
    } catch {}
  }
  walk(root)
  return results
}

function extractMiddlewareFromConfigure(
  configureMethod: import("ts-morph").MethodDeclaration,
  map: MiddlewareMap,
  userConfig?: ArchMindUserConfig
): void {
  // Find all call expressions in the method body
  const body = configureMethod.getBody()
  if (!body) return

  // Look for consumer.apply(X).forRoutes(...) chains
  const callExprs = body.getDescendantsOfKind(SyntaxKind.CallExpression)

  for (const call of callExprs) {
    // We want the outermost forRoutes() call
    const fnExpr = call.getExpression()
    if (!fnExpr.getText().endsWith(".forRoutes")) continue

    // Get the .apply() call in the chain: consumer.apply(Middleware)
    const applyCall = findApplyCall(call)
    if (!applyCall) continue

    const middlewareClasses = extractApplyArgs(applyCall)
    if (!middlewareClasses.length) continue

    // Parse forRoutes() arguments
    const routeArgs = call.getArguments() as import("ts-morph").Expression[]
    const entries = parseForRoutes(routeArgs)

    for (const { method, path } of entries) {
      const key = normaliseEntrypoint(method, path)
      const existing = map.get(key) ?? []
      for (const cls of middlewareClasses) {
        if (!existing.some(e => e.className === cls)) {
          existing.push({ className: cls, irType: classifyGuard(cls, userConfig) })
        }
      }
      map.set(key, existing)
    }
  }
}

function findApplyCall(forRoutesCall: import("ts-morph").CallExpression): import("ts-morph").CallExpression | null {
  // forRoutes call expr looks like: consumer.apply(X).forRoutes(...)
  // The expression of forRoutes is a PropertyAccessExpression on a CallExpression (apply)
  const expr = forRoutesCall.getExpression()
  // expr.getExpression() should be the apply() CallExpression
  const applyCallExpr = expr.getFirstChildByKind(SyntaxKind.CallExpression)
  if (!applyCallExpr) return null
  const applyFn = applyCallExpr.getExpression()
  if (!applyFn.getText().endsWith(".apply")) return null
  return applyCallExpr
}

function extractApplyArgs(applyCall: import("ts-morph").CallExpression): string[] {
  return applyCall.getArguments().map(arg => {
    const text = arg.getText().trim()
    // Handle both `AuthMiddleware` (class ref) and `new AuthMiddleware()`
    return text.replace(/^new\s+/, "").replace(/\(.*\)$/, "").trim()
  })
}

interface RouteEntry { method: string; path: string }

function parseForRoutes(args: import("ts-morph").Expression[]): RouteEntry[] {
  const entries: RouteEntry[] = []

  for (const arg of args) {
    const text = arg.getText().trim()

    // Object form: { path: 'articles/feed', method: RequestMethod.GET }
    if (text.startsWith("{")) {
      const pathMatch  = text.match(/path:\s*['"`]([^'"`]+)['"`]/)
      const methodMatch = text.match(/method:\s*(?:RequestMethod\.)?(\w+)/)

      if (pathMatch) {
        const path   = pathMatch[1]
        const method = methodMatch ? (REQUEST_METHOD_NAMES[methodMatch[1]] ?? "ALL") : "ALL"
        entries.push({ method, path })
      }
      continue
    }

    // String form: 'articles'
    if (text.startsWith("'") || text.startsWith('"') || text.startsWith("`")) {
      entries.push({ method: "ALL", path: text.replace(/['"`]/g, "") })
      continue
    }

    // Controller class reference: ArticleController — skip for now (needs route resolution)
  }

  return entries
}

function normaliseEntrypoint(method: string, path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`
  // Normalise :param to {*} for matching
  const normPath = cleanPath.replace(/:([a-zA-Z_]+)/g, "{*}")
  return `${method.toUpperCase()} ${normPath}`
}
