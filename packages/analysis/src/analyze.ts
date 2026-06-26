import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type { RouteInfo } from "@kidkender/archmind-protocol"
import { detectFindings } from "./detect.js"

const THROTTLE_RE = /throttl|ratelimit|rate.?limit/i

export async function analyzeProject(projectRoot: string): Promise<RouteInfo[]> {
  // Dynamic require keeps tree-sitter native addon under system Node ABI.
  // Must not be a static import — esbuild would try to inline the native .node binary.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const laravelParser = require("@kidkender/archmind-laravel-parser")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nestjsParser  = require("@kidkender/archmind-nestjs-parser")

  const isNestJS = existsSync(join(projectRoot, "nest-cli.json"))

  if (isNestJS) {
    return analyzeNestJS(projectRoot, nestjsParser)
  }
  return analyzeLaravel(projectRoot, laravelParser)
}

async function analyzeLaravel(projectRoot: string, parser: any): Promise<RouteInfo[]> {
  const { loadProjectConfig, resolveAliasMap, parseRouteFile, augmentGraph } = parser

  const config = loadProjectConfig(projectRoot)
  const { aliasMap, routeFiles } = resolveAliasMap(projectRoot, config)
  const routes: RouteInfo[] = []

  for (const relFile of routeFiles) {
    const skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap, namespaces: config.namespaces })
    for (const skeleton of skeletons) {
      try {
        const graph   = await augmentGraph(skeleton, { projectRoot, config })
        const handler = graph.nodes.find((n: any) => n.type === "ir:business_handler")
        if (!handler) continue
        routes.push(buildRoute(graph, handler, "laravel", projectRoot))
      } catch { /* skip unparseable route */ }
    }
  }

  return routes
}

function analyzeNestJS(projectRoot: string, parser: any): RouteInfo[] {
  const { parseNestJSProject } = parser
  const graphs = parseNestJSProject(projectRoot) as any[]
  const routes: RouteInfo[] = []

  for (const graph of graphs) {
    const handler = graph.nodes.find((n: any) => n.type === "ir:business_handler")
    if (!handler) continue
    try {
      routes.push(buildRoute(graph, handler, "nestjs", projectRoot))
    } catch { /* skip */ }
  }

  // Second pass: infer @Public() routes.
  // If the project has ANY route with an auth gate (i.e. a global guard is in use),
  // routes with no auth gate were intentionally marked @Public().
  inferPublicRoutes(routes)

  // Re-run findings after isPublic is set so public routes don't trigger findings.
  return routes.map(r => ({ ...r, findings: detectFindings(r) }))
}

function inferPublicRoutes(routes: RouteInfo[]): void {
  const someHaveAuth = routes.some(r => r.authGates.length > 0)
  if (!someHaveAuth) return
  for (const r of routes) {
    if (r.authGates.length === 0) r.isPublic = true
  }
}

function buildRoute(graph: any, handler: any, framework: string, projectRoot?: string): RouteInfo {
  const authGates   = graph.nodes.filter((n: any) => n.type === "ir:auth_gate").map((n: any) => n.symbol as string)
  const authzChecks = graph.nodes.filter((n: any) => n.type === "ir:authz_check").map((n: any) => {
    const args = n.args?.length ? `:${(n.args as string[]).join(",")}` : ""
    return `${n.symbol as string}${args}`
  })
  const validations = graph.nodes.filter((n: any) => n.type === "ir:validation_gate").map((n: any) => n.symbol as string)
  const services    = graph.nodes.filter((n: any) => n.type === "ir:service_call").map((n: any) => n.symbol as string)
  const hasTxn      = graph.nodes.some((n: any) => n.type === "ir:txn_boundary")
  const throttled   = graph.nodes.some((n: any) =>
    (n.type === "ir:auth_gate" || n.type === "ir:authz_check") &&
    THROTTLE_RE.test(n.symbol as string)
  )

  const line = resolveHandlerLine(handler, projectRoot)

  const partial: Omit<RouteInfo, "findings"> = {
    entrypoint:     graph.entrypoint as string,
    method:         graph.method as string,
    path:           graph.path as string,
    file:           (handler.file as string) ?? "",
    line,
    symbol:         handler.symbol as string,
    authGates,
    authzChecks,
    validations,
    services,
    hasTransaction: hasTxn,
    throttled,
    framework,
    isPublic:       false,
  }

  return { ...partial, findings: detectFindings(partial) }
}

function resolveHandlerLine(handler: any, projectRoot?: string): number {
  if (handler.line) return handler.line as number
  if (!handler.file || !handler.symbol || !projectRoot) return 1
  const [, method] = (handler.symbol as string).split("::")
  return method ? findMethodLine(join(projectRoot, handler.file as string), method) : 1
}

function findMethodLine(absFilePath: string, methodName: string): number {
  try {
    const lines = readFileSync(absFilePath, "utf-8").split("\n")
    const re = new RegExp(`(?:function\\s+${methodName}|(?:async\\s+)?${methodName}\\s*)\\s*\\(`)
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return i + 1
    }
  } catch { /* ignore */ }
  return 1
}
