import { existsSync } from "fs"
import { join } from "path"
import type { AnalysisResult, RouteInfo, FindingInfo } from "@archmind/protocol"
import { buildIndexes } from "@archmind/protocol"
import type { IntermediateExecutionGraph } from "@archmind/protocol"

const THROTTLE_RE = /throttl|ratelimit|rate.?limit/i

export class AnalysisService {
  constructor(private readonly projectRoot: string) {}

  async analyze(): Promise<AnalysisResult> {
    // Dynamic require keeps tree-sitter native addon under system Node ABI
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const laravelParser = require("@archmind/laravel-parser")
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nestjsParser  = require("@archmind/nestjs-parser")

    const isNestJS = existsSync(join(this.projectRoot, "nest-cli.json"))
    const graph: IntermediateExecutionGraph[] = isNestJS
      ? this.parseNestJS(nestjsParser)
      : await this.parseLaravel(laravelParser)

    const routes = graph.map(g => this.buildRoute(g))
    this.inferPublicRoutes(routes)
    // Re-detect findings after isPublic is resolved — public routes should not fire missing_authorization
    for (const r of routes) r.findings = detectFindings(r)

    const findings = routes.flatMap(r => r.findings)
    const indexes  = buildIndexes(graph, routes)

    return { graph, routes, findings, indexes }
  }

  private async parseLaravel(parser: any): Promise<IntermediateExecutionGraph[]> {
    const { loadProjectConfig, resolveAliasMap, parseRouteFile, augmentGraph } = parser
    const config = loadProjectConfig(this.projectRoot)
    const { aliasMap, routeFiles } = resolveAliasMap(this.projectRoot, config)
    const graphs: IntermediateExecutionGraph[] = []

    for (const relFile of routeFiles) {
      const skeletons = parseRouteFile(join(this.projectRoot, relFile), { aliasMap, namespaces: config.namespaces })
      for (const skeleton of skeletons) {
        try {
          const g = await augmentGraph(skeleton, { projectRoot: this.projectRoot, config })
          graphs.push(g)
        } catch { /* skip unparseable route */ }
      }
    }

    return graphs
  }

  private parseNestJS(parser: any): IntermediateExecutionGraph[] {
    const { parseNestJSProject } = parser
    return parseNestJSProject(this.projectRoot) as IntermediateExecutionGraph[]
  }

  private buildRoute(graph: IntermediateExecutionGraph): RouteInfo {
    const handler = graph.nodes.find(n => n.type === "ir:business_handler")

    const authGates   = graph.nodes.filter(n => n.type === "ir:auth_gate").map(n => n.symbol)
    const authzChecks = graph.nodes.filter(n => n.type === "ir:authz_check").map(n => {
      const args = n.args?.length ? `:${n.args.join(",")}` : ""
      return `${n.symbol}${args}`
    })
    const validations = graph.nodes.filter(n => n.type === "ir:validation_gate").map(n => n.symbol)
    const services    = graph.nodes.filter(n => n.type === "ir:service_call").map(n => n.symbol)
    const hasTxn      = graph.nodes.some(n => n.type === "ir:txn_boundary")
    const throttled   = graph.nodes.some(n =>
      (n.type === "ir:auth_gate" || n.type === "ir:authz_check") && THROTTLE_RE.test(n.symbol)
    )

    const file = handler?.file ?? ""
    const line = handler?.line ?? 1

    const partial: Omit<RouteInfo, "findings"> = {
      entrypoint: graph.entrypoint,
      method:     graph.method,
      path:       graph.path,
      file,
      line,
      symbol:         handler?.symbol ?? "",
      authGates,
      authzChecks,
      validations,
      services,
      hasTransaction: hasTxn,
      throttled,
      framework:  graph.framework ?? "unknown",
      isPublic:   false,
    }

    return { ...partial, findings: detectFindings(partial) }
  }

  private inferPublicRoutes(routes: RouteInfo[]): void {
    const someHaveAuth = routes.some(r => r.authGates.length > 0)
    if (!someHaveAuth) return
    for (const r of routes) {
      if (r.authGates.length === 0) r.isPublic = true
    }
  }
}

function detectFindings(route: Omit<RouteInfo, "findings">): FindingInfo[] {
  const findings: FindingInfo[] = []

  if (!route.isPublic && route.authGates.length === 0 && route.authzChecks.length === 0) {
    findings.push({
      type:     "missing_authorization",
      severity: "HIGH",
      summary:  "Route has no authentication or authorization guards",
    })
  }

  if (route.method === "GET" && route.authGates.length === 0 && route.services.length > 0) {
    findings.push({
      type:     "exposed_read_endpoint",
      severity: "HIGH",
      summary:  "Public GET endpoint with business logic — potential data exposure",
    })
  }

  if (!route.throttled && route.authGates.length === 0) {
    findings.push({
      type:     "no_rate_limiting",
      severity: "LOW",
      summary:  "No rate limiting detected on public endpoint",
    })
  }

  if (route.services.length >= 5) {
    findings.push({
      type:     "fat_controller",
      severity: "LOW",
      summary:  `Controller calls ${route.services.length} services — consider decomposing`,
    })
  }

  return findings
}
