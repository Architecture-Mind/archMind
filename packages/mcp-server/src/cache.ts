import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap, ParseCache } from "@kidkender/archmind-laravel-parser"
import { parseNestJSProjectIncremental, createNestProject } from "@kidkender/archmind-nestjs-parser"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { join, relative } from "path"
import { existsSync, statSync, readdirSync } from "fs"
import { Project } from "ts-morph"

const cache        = new Map<string, IntermediateExecutionGraph[]>()
const parseCaches  = new Map<string, ParseCache<unknown>>()
// Laravel only: relPath → last-seen mtimeMs, rebuilt after each parse.
// Used to auto-invalidate the graph cache when source files change.
const trackedFiles = new Map<string, Map<string, number>>()
// NestJS: one cached ts-morph Project per projectRoot.  Kept alive across
// calls so SourceFiles remain parsed in memory; only changed files are refreshed.
const nestProjects     = new Map<string, Project>()
// NestJS: relPath → last-seen mtimeMs (*.controller.ts files + archmind.json).
const nestTrackedFiles = new Map<string, Map<string, number>>()

export type Framework = "laravel" | "nestjs"

// Auto-detect framework from project root.
// nest-cli.json  → NestJS
// artisan        → Laravel
// default        → Laravel
export function detectFramework(projectRoot: string): Framework {
  if (existsSync(join(projectRoot, "nest-cli.json"))) return "nestjs"
  return "laravel"
}

function statMtime(absPath: string): number | null {
  try { return statSync(absPath).mtimeMs } catch { return null }
}

// Staleness window: files that did not exist at parse time are not tracked.
// If a new PHP class or route file is added after the last parse, the auto-invalidation
// won't detect it — the index has no entry to compare against.
// Users must call archmind_invalidate_cache after adding files.
// For changes to existing tracked files (edits, deletes), auto-invalidation is reliable.
export function buildFileIndex(
  graphs: IntermediateExecutionGraph[],
  projectRoot: string,
  routeFiles: string[],
): Map<string, number> {
  const relPaths = new Set<string>()

  for (const g of graphs) {
    for (const n of g.nodes) {
      if (n.file) relPaths.add(n.file)
    }
  }

  // Route files may not appear as node.file — track them explicitly.
  for (const rel of routeFiles) relPaths.add(rel)

  // archmind.json affects guard classification and credential paths.
  if (existsSync(join(projectRoot, "archmind.json"))) relPaths.add("archmind.json")

  const index = new Map<string, number>()
  for (const rel of relPaths) {
    const mtime = statMtime(join(projectRoot, rel))
    if (mtime !== null) index.set(rel, mtime)
  }
  return index
}

export function hasAnyTrackedFileChanged(projectRoot: string): boolean {
  const index = trackedFiles.get(projectRoot)
  if (!index) return false
  for (const [rel, lastMtime] of index) {
    const current = statMtime(join(projectRoot, rel))
    // null = file was deleted → trigger re-parse
    if (current === null || current !== lastMtime) return true
  }
  return false
}

// ── NestJS incremental helpers ────────────────────────────────────────────────

// Recursively find files matching a predicate, skipping node_modules and hidden dirs.
function findFiles(dir: string, predicate: (name: string) => boolean, results: string[] = []): string[] {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name)
      if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
        findFiles(child, predicate, results)
      } else if (entry.isFile() && predicate(entry.name)) {
        results.push(child)
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results
}

function buildNestFileIndex(project: Project, projectRoot: string): Map<string, number> {
  const index = new Map<string, number>()

  // Controller and DTO files already in the ts-morph Project.
  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath()
    const rel = relative(projectRoot, absPath).replace(/\\/g, "/")
    const mtime = statMtime(absPath)
    if (mtime !== null) index.set(rel, mtime)
  }

  // Module files are NOT in the Project (no parsing needed) but guard/middleware
  // configs live in *.module.ts — track their mtimes so changes trigger re-parse.
  for (const absPath of findFiles(projectRoot, n => n.endsWith(".module.ts"))) {
    const rel = relative(projectRoot, absPath).replace(/\\/g, "/")
    const mtime = statMtime(absPath)
    if (mtime !== null) index.set(rel, mtime)
  }

  if (existsSync(join(projectRoot, "archmind.json"))) {
    const mtime = statMtime(join(projectRoot, "archmind.json"))
    if (mtime !== null) index.set("archmind.json", mtime)
  }

  return index
}

function hasNestTrackedFileChanged(projectRoot: string): boolean {
  const index = nestTrackedFiles.get(projectRoot)
  if (!index) return false
  for (const [rel, lastMtime] of index) {
    const current = statMtime(join(projectRoot, rel))
    if (current === null || current !== lastMtime) return true
  }
  return false
}

// Update the cached Project to reflect file-system changes: adds new controllers
// and DTO files, refreshes edited ones, removes deleted ones.
// Must be called before extractRoutes.
function refreshNestProject(project: Project, projectRoot: string): void {
  const globs = [
    "**/*.controller.ts",
    "**/*.dto.ts",
    "**/*.response.ts",
    "**/*.resource.ts",
  ].map(g => join(projectRoot, g).replace(/\\/g, "/"))

  // addSourceFilesAtPaths is idempotent for already-loaded files; only adds new ones.
  project.addSourceFilesAtPaths(globs)

  // Snapshot to avoid mutating the collection while iterating.
  const sourceFiles = project.getSourceFiles()
  for (const sf of sourceFiles) {
    const absPath = sf.getFilePath()
    if (!existsSync(absPath)) {
      project.removeSourceFile(sf)
    } else {
      sf.refreshFromFileSystemSync()
    }
  }
}

export function getGraphs(projectRoot: string): IntermediateExecutionGraph[] {
  const framework = detectFramework(projectRoot)

  if (framework === "nestjs") {
    // Auto-invalidate if tracked controller/config files changed.
    // Keep nestProjects alive — the cached Project will be refreshed below.
    if (cache.has(projectRoot) && hasNestTrackedFileChanged(projectRoot)) {
      cache.delete(projectRoot)
    }

    if (cache.has(projectRoot)) return cache.get(projectRoot)!

    let project = nestProjects.get(projectRoot)

    if (!project) {
      // Cold parse: create Project, load all controller files, parse.
      project = createNestProject()
      project.addSourceFilesAtPaths(
        join(projectRoot, "**/*.controller.ts").replace(/\\/g, "/")
      )
      nestProjects.set(projectRoot, project)
    } else {
      // Warm re-parse: refresh changed/new/deleted files, then re-extract.
      refreshNestProject(project, projectRoot)
    }

    const graphs = parseNestJSProjectIncremental(projectRoot, project)
    nestTrackedFiles.set(projectRoot, buildNestFileIndex(project, projectRoot))
    cache.set(projectRoot, graphs)
    return graphs
  }

  // Laravel path
  // Auto-invalidate if any tracked file changed since the last parse.
  // Only drop the top-level cache, not parseCaches — content-hash keying means
  // changed files get new hash keys (miss) while unchanged files get hits (warm).
  if (cache.has(projectRoot) && hasAnyTrackedFileChanged(projectRoot)) {
    cache.delete(projectRoot)
  }

  if (cache.has(projectRoot)) return cache.get(projectRoot)!

  if (!parseCaches.has(projectRoot)) {
    parseCaches.set(projectRoot, new ParseCache<unknown>())
  }
  const parseCache = parseCaches.get(projectRoot)!

  const config = loadProjectConfig(projectRoot)
  const resolved = resolveAliasMap(projectRoot, config)
  const routeFiles = resolved.routeFiles
  const { aliasMap, routeWrapping, routeNamespaceWrapping, routePrefixWrapping } = resolved

  const graphs: IntermediateExecutionGraph[] = []
  for (const relRouteFile of routeFiles) {
    const routesFile = join(projectRoot, relRouteFile)
    const skeletons = parseRouteFile(routesFile, {
      aliasMap,
      namespaces: config.namespaces,
      wrappingMiddleware: routeWrapping.get(relRouteFile),
      wrappingNamespace: routeNamespaceWrapping.get(relRouteFile),
      wrappingPrefix: routePrefixWrapping.get(relRouteFile),
    })
    for (const g of skeletons) {
      graphs.push(augmentGraph(g, { projectRoot, config, cache: parseCache }))
    }
  }

  // Record mtimes for all files that contributed to this parse so we can
  // detect changes on the next call without an explicit invalidate_cache.
  trackedFiles.set(projectRoot, buildFileIndex(graphs, projectRoot, routeFiles))
  cache.set(projectRoot, graphs)
  return graphs
}

export function invalidate(projectRoot: string): void {
  cache.delete(projectRoot)
  trackedFiles.delete(projectRoot)
  nestProjects.delete(projectRoot)
  nestTrackedFiles.delete(projectRoot)
  // Don't clear parseCaches — content-hash keying means a changed file produces
  // a new hash (miss) while unchanged files stay warm. Clearing would only slow
  // the next full re-parse without gaining correctness.
}

// ── Testing helpers (not part of the public MCP API) ─────────────────────────

export function _clearForTesting(): void {
  cache.clear()
  parseCaches.clear()
  trackedFiles.clear()
  nestProjects.clear()
  nestTrackedFiles.clear()
}

export function _setCacheEntry(projectRoot: string, graphs: IntermediateExecutionGraph[]): void {
  cache.set(projectRoot, graphs)
}

export function _setTrackedFiles(projectRoot: string, index: Map<string, number>): void {
  trackedFiles.set(projectRoot, index)
}

export function _getTrackedFiles(projectRoot: string): Map<string, number> | undefined {
  return trackedFiles.get(projectRoot)
}

export function _isCached(projectRoot: string): boolean {
  return cache.has(projectRoot)
}

export function _getNestProject(projectRoot: string): Project | undefined {
  return nestProjects.get(projectRoot)
}

export function _getNestTrackedFiles(projectRoot: string): Map<string, number> | undefined {
  return nestTrackedFiles.get(projectRoot)
}
