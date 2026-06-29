import { parseRouteFile, augmentGraph, loadProjectConfig, resolveAliasMap, ParseCache } from "@archmind/laravel-parser"
import { parseNestJSProject } from "@archmind/nestjs-parser"
import type { IntermediateExecutionGraph } from "@archmind/protocol"
import { join } from "path"
import { existsSync, statSync } from "fs"

const cache        = new Map<string, IntermediateExecutionGraph[]>()
const parseCaches  = new Map<string, ParseCache<unknown>>()
// Laravel only: relPath → last-seen mtimeMs, rebuilt after each parse.
// Used to auto-invalidate the graph cache when source files change.
const trackedFiles = new Map<string, Map<string, number>>()

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

export function getGraphs(projectRoot: string): IntermediateExecutionGraph[] {
  // Auto-invalidate if any tracked file changed since the last parse.
  // Only drop the top-level cache, not parseCaches — content-hash keying means
  // changed files get new hash keys (miss) while unchanged files get hits (warm).
  if (cache.has(projectRoot) && hasAnyTrackedFileChanged(projectRoot)) {
    cache.delete(projectRoot)
  }

  if (cache.has(projectRoot)) {
    return cache.get(projectRoot)!
  }

  const framework = detectFramework(projectRoot)
  let graphs: IntermediateExecutionGraph[]
  let routeFiles: string[] = []

  if (framework === "nestjs") {
    // NestJS: ts-morph load dominates; incremental deferred to a later phase.
    graphs = parseNestJSProject(projectRoot)
  } else {
    if (!parseCaches.has(projectRoot)) {
      parseCaches.set(projectRoot, new ParseCache<unknown>())
    }
    const parseCache = parseCaches.get(projectRoot)!

    const config = loadProjectConfig(projectRoot)
    const resolved = resolveAliasMap(projectRoot, config)
    routeFiles = resolved.routeFiles
    const { aliasMap } = resolved

    graphs = []
    for (const relRouteFile of routeFiles) {
      const routesFile = join(projectRoot, relRouteFile)
      const skeletons = parseRouteFile(routesFile, { aliasMap })
      for (const g of skeletons) {
        graphs.push(augmentGraph(g, { projectRoot, config, cache: parseCache }))
      }
    }

    // Record mtimes for all files that contributed to this parse so we can
    // detect changes on the next call without an explicit invalidate_cache.
    trackedFiles.set(projectRoot, buildFileIndex(graphs, projectRoot, routeFiles))
  }

  cache.set(projectRoot, graphs)
  return graphs
}

export function invalidate(projectRoot: string): void {
  cache.delete(projectRoot)
  trackedFiles.delete(projectRoot)
  // Don't clear parseCaches — content-hash keying means a changed file produces
  // a new hash (miss) while unchanged files stay warm. Clearing would only slow
  // the next full re-parse without gaining correctness.
}

// ── Testing helpers (not part of the public MCP API) ─────────────────────────

export function _clearForTesting(): void {
  cache.clear()
  parseCaches.clear()
  trackedFiles.clear()
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
