import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type { IntermediateExecutionGraph, ArchMindUserConfig } from "@kidkender/archmind-protocol"
import type { SemanticAdapter } from "@kidkender/archmind-protocol"
import { extractRoutes } from "./extractors/route.extractor.js"
import { emitGraphs } from "./emitters/ir-emitter.js"
import { scanGlobalPipes } from "./resolvers/global.resolver.js"
import { scanGlobalGuards } from "./resolvers/module.resolver.js"
import { scanMiddleware } from "./resolvers/middleware.scanner.js"
import { parseDTOSchemas } from "./dto-scanner.js"
import type { NestJSSemanticRoute } from "./types.js"
import type { GuardDescriptor } from "./types.js"
import type { DTOSchema } from "@kidkender/archmind-protocol"

function loadUserConfig(projectRoot: string): ArchMindUserConfig | undefined {
  const configPath = join(projectRoot, "archmind.json")
  if (!existsSync(configPath)) return undefined
  try {
    return JSON.parse(readFileSync(configPath, "utf-8")) as ArchMindUserConfig
  } catch {
    return undefined
  }
}

export class NestJSAdapter implements SemanticAdapter {
  parseProject(root: string): IntermediateExecutionGraph[] {
    const userConfig    = loadUserConfig(root)
    const globalPipes   = scanGlobalPipes(root)
    const globalGuards  = scanGlobalGuards(root, userConfig)
    const middlewareMap = scanMiddleware(root, userConfig)
    const routes = extractRoutes({ projectRoot: root, userConfig })

    // Build DTO schema index — enriches validation_gate nodes with field detail
    let dtoIndex = new Map<string, DTOSchema>()
    try { dtoIndex = parseDTOSchemas(root).index } catch { /* skip on parse error */ }

    const withGlobalGuards = globalGuards.length === 0
      ? routes
      : routes.map(r => r.isPublic ? r : { ...r, guards: [...globalGuards, ...r.guards] })

    // Apply NestMiddleware entries to matching routes
    const withMiddleware = middlewareMap.size === 0
      ? withGlobalGuards
      : withGlobalGuards.map(r => applyMiddleware(r, middlewareMap))

    return emitGraphs(withMiddleware, globalPipes, dtoIndex)
  }
}

function applyMiddleware(
  route: NestJSSemanticRoute,
  map: import("./resolvers/middleware.scanner.js").MiddlewareMap
): NestJSSemanticRoute {
  if (route.isPublic) return route

  const normPath = route.path.replace(/:([a-zA-Z_]+)/g, "{*}")

  // Try exact method match, then ALL
  const exactKey = `${route.method} ${normPath}`
  const allKey   = `ALL ${normPath}`

  const mwEntries = [
    ...(map.get(exactKey) ?? []),
    ...(map.get(allKey)   ?? []),
  ]

  if (!mwEntries.length) return route

  const mwGuards: GuardDescriptor[] = mwEntries.map(e => ({
    className: e.className,
    args:      [],
    irType:    e.irType,
  }))

  // Prepend middleware guards before route-level guards (middleware runs first)
  return { ...route, guards: [...mwGuards, ...route.guards] }
}

export function parseNestJSProject(root: string): IntermediateExecutionGraph[] {
  return new NestJSAdapter().parseProject(root)
}
