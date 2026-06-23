import { join } from "path"
import { existsSync, readFileSync } from "fs"
import {
  parseRouteFile,
  augmentGraph,
  loadProjectConfig,
  resolveAliasMap,
} from "@archmind/laravel-parser"
import { parseNestJSProject } from "@archmind/nestjs-parser"
import type { IntermediateExecutionGraph } from "@archmind/protocol"

export type Framework = "laravel" | "nestjs" | "unknown"

export interface ParsedProject {
  graphs:      IntermediateExecutionGraph[]
  routeCount:  number
  fileCount:   number
  projectRoot: string
  framework:   Framework
}

export function detectFramework(projectRoot: string): Framework {
  const pkgPath = join(projectRoot, "package.json")
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>
      const deps = {
        ...((pkg["dependencies"] as Record<string, string>) ?? {}),
        ...((pkg["devDependencies"] as Record<string, string>) ?? {}),
      }
      if ("@nestjs/core" in deps || "@nestjs/common" in deps) return "nestjs"
    } catch {
      // ignore malformed package.json
    }
  }

  const composerPath = join(projectRoot, "composer.json")
  if (existsSync(composerPath)) {
    try {
      const composer = JSON.parse(readFileSync(composerPath, "utf-8")) as Record<string, unknown>
      const require = (composer["require"] as Record<string, string>) ?? {}
      if ("laravel/framework" in require) return "laravel"
    } catch {
      // ignore malformed composer.json
    }
  }

  // Fallback heuristics
  if (existsSync(join(projectRoot, "artisan"))) return "laravel"
  if (existsSync(join(projectRoot, "nest-cli.json"))) return "nestjs"

  return "unknown"
}

export function parseProject(projectRoot: string): ParsedProject {
  const framework = detectFramework(projectRoot)

  if (framework === "nestjs") {
    const graphs = parseNestJSProject(projectRoot)
    return {
      graphs,
      routeCount: graphs.length,
      fileCount:  0,
      projectRoot,
      framework,
    }
  }

  // Default: Laravel
  const config = loadProjectConfig(projectRoot)
  const { aliasMap, routeFiles } = resolveAliasMap(projectRoot, config)

  const graphs: IntermediateExecutionGraph[] = []
  for (const relFile of routeFiles) {
    const skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap, namespaces: config.namespaces })
    for (const g of skeletons) {
      graphs.push(augmentGraph(g, { projectRoot, config }))
    }
  }

  return {
    graphs,
    routeCount: graphs.length,
    fileCount:  routeFiles.length,
    projectRoot,
    framework: framework === "unknown" ? "laravel" : framework,
  }
}

export function requireProject(flags: Record<string, string>): string {
  const p = flags["project"]
  if (!p) {
    console.error("Error: --project <path> is required")
    process.exit(2)
  }
  return p
}
