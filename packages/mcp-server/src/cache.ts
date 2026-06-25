import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap, ParseCache } from "@archmind/laravel-parser"
import { parseNestJSProject } from "@archmind/nestjs-parser"
import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { join } from "path"
import { existsSync } from "fs"

const cache      = new Map<string, IntermediateExecutionGraph[]>()
const parseCaches = new Map<string, ParseCache<unknown>>()

export type Framework = "laravel" | "nestjs"

// Auto-detect framework from project root.
// nest-cli.json  → NestJS
// artisan        → Laravel
// default        → Laravel
export function detectFramework(projectRoot: string): Framework {
  if (existsSync(join(projectRoot, "nest-cli.json"))) return "nestjs"
  return "laravel"
}

export function getGraphs(projectRoot: string): IntermediateExecutionGraph[] {
  if (cache.has(projectRoot)) {
    return cache.get(projectRoot)!
  }

  const framework = detectFramework(projectRoot)
  let graphs: IntermediateExecutionGraph[]

  if (framework === "nestjs") {
    graphs = parseNestJSProject(projectRoot)
  } else {
    // Reuse or create a ParseCache scoped to this project root
    if (!parseCaches.has(projectRoot)) {
      parseCaches.set(projectRoot, new ParseCache<unknown>())
    }
    const parseCache = parseCaches.get(projectRoot)!

    const config = loadProjectConfig(projectRoot)
    const { aliasMap, routeFiles } = resolveAliasMap(projectRoot, config)
    graphs = []
    for (const relRouteFile of routeFiles) {
      const routesFile = join(projectRoot, relRouteFile)
      const skeletons = parseRouteFile(routesFile, { aliasMap })
      for (const g of skeletons) {
        graphs.push(augmentGraph(g, { projectRoot, config, cache: parseCache }))
      }
    }
  }

  cache.set(projectRoot, graphs)
  return graphs
}

export function invalidate(projectRoot: string): void {
  cache.delete(projectRoot)
  // Also clear the parse-op cache so stale file parses don't persist
  parseCaches.get(projectRoot)?.clear()
}
