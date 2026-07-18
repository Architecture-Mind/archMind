import { join } from "path"
import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import {
  parseRouteFile,
  augmentGraph,
  loadProjectConfig,
  resolveAliasMap,
  parseSchedule,
  parseQueuedJobs,
} from "@kidkender/archmind-laravel-parser"
import { parseNestJSProject } from "@kidkender/archmind-nestjs-parser"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

export type Framework = "laravel" | "nestjs" | "springboot" | "unknown"

function tryParseSpringBoot(root: string): { graphs: IntermediateExecutionGraph[]; fileCount: number } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isSpringBootProject, parseSpringBootProject, findJavaFiles, isControllerFile } =
      require("@kidkender/archmind-springboot-parser") as {
        isSpringBootProject: (root: string) => boolean
        parseSpringBootProject: (root: string) => IntermediateExecutionGraph[]
        findJavaFiles: (root: string) => string[]
        isControllerFile: (filePath: string) => boolean
      }
    if (!isSpringBootProject(root)) return null
    const graphs = parseSpringBootProject(root)
    const fileCount = findJavaFiles(root).filter(isControllerFile).length
    return { graphs, fileCount }
  } catch {
    return null
  }
}

/** Count files matching common NestJS controller-file naming, walked recursively. */
function countNestControllerFiles(root: string): number {
  let count = 0
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue
      const p = join(dir, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p)
      else if (entry.endsWith(".controller.ts")) count++
    }
  }
  walk(root)
  return count
}

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
  if (existsSync(join(projectRoot, "pom.xml")) || existsSync(join(projectRoot, "build.gradle"))) return "springboot"

  return "unknown"
}

export function parseProject(projectRoot: string): ParsedProject {
  const framework = detectFramework(projectRoot)

  if (framework === "nestjs") {
    const graphs = parseNestJSProject(projectRoot)
    return { graphs, routeCount: graphs.length, fileCount: countNestControllerFiles(projectRoot), projectRoot, framework }
  }

  if (framework === "springboot") {
    const result = tryParseSpringBoot(projectRoot)
    const graphs = result?.graphs ?? []
    return { graphs, routeCount: graphs.length, fileCount: result?.fileCount ?? 0, projectRoot, framework }
  }

  // Default: Laravel
  const config = loadProjectConfig(projectRoot)
  const { aliasMap, routeFiles, routeWrapping, routeNamespaceWrapping, routePrefixWrapping } = resolveAliasMap(projectRoot, config)

  const graphs: IntermediateExecutionGraph[] = []
  for (const relFile of routeFiles) {
    const wrappingMiddleware = routeWrapping.get(relFile)
    const wrappingNamespace = routeNamespaceWrapping.get(relFile)
    const wrappingPrefix = routePrefixWrapping.get(relFile)
    const skeletons = parseRouteFile(join(projectRoot, relFile), { aliasMap, namespaces: config.namespaces, wrappingMiddleware, wrappingNamespace, wrappingPrefix })
    for (const g of skeletons) {
      graphs.push(augmentGraph(g, { projectRoot, config }))
    }
  }

  const kernelPath = join(projectRoot, "app/Console/Kernel.php")
  if (existsSync(kernelPath)) {
    graphs.push(...parseSchedule(kernelPath))
  }

  const jobsDir = join(projectRoot, "app/Jobs")
  if (existsSync(jobsDir)) {
    graphs.push(...parseQueuedJobs(jobsDir))
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
