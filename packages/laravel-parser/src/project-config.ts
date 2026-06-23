import { readFileSync, existsSync, readdirSync, statSync } from "fs"
import { join, relative, dirname, basename } from "path"
import type { ProjectConfig } from "@kidkender/archmind-protocol"
import { parseKernel, type AliasMap } from "./kernel-parser.js"
import { parseBootstrap } from "./bootstrap-parser.js"

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  routeFiles: ["routes/api.php"],
  namespaces: { "App\\": "app/" },
  policyPaths: ["app/Policies"],
  permissionConstantFiles: [],
  conventions: {
    tenantSignals: [
      "tenant_id", "tenantId", "tenant",
      "organization_id", "organizationId",
      "whereTenant", "whereTenantId", "forTenant",
      "whereOrganization", "whereOrganizationId",
    ],
    tenantContainerKeys: ["tenant", "organization"],
  },
}

/**
 * Load project config using a 3-layer merge:
 *   Layer 1 (base)     — DEFAULT_PROJECT_CONFIG (hardcoded Laravel conventions)
 *   Layer 2 (inferred) — inferProjectConfig() scans composer.json, routes/, Policies/
 *   Layer 3 (override) — .archmind.json explicit user config (wins over everything)
 *
 * Each field is resolved independently so partial .archmind.json files work correctly.
 */
export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const inferred = inferProjectConfig(projectRoot)

  const configPath = join(projectRoot, ".archmind.json")
  if (!existsSync(configPath)) return inferred

  let overrides: Partial<ProjectConfig>
  try {
    overrides = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<ProjectConfig>
  } catch {
    return inferred
  }

  return {
    routeFiles:             overrides.routeFiles             ?? inferred.routeFiles,
    namespaces:             overrides.namespaces             ?? inferred.namespaces,
    policyPaths:            overrides.policyPaths            ?? inferred.policyPaths,
    permissionConstantFiles: overrides.permissionConstantFiles ?? inferred.permissionConstantFiles,
    conventions: {
      tenantSignals:      overrides.conventions?.tenantSignals      ?? inferred.conventions.tenantSignals,
      tenantContainerKeys: overrides.conventions?.tenantContainerKeys ?? inferred.conventions.tenantContainerKeys,
    },
  }
}

/**
 * Layer 2: Infer project config from the real project structure.
 *
 * - namespaces: read from composer.json autoload.psr-4 (falls back to default)
 * - routeFiles: scan routes/ directory for *.php files (falls back to default)
 * - policyPaths: check well-known policy directories that actually exist on disk
 * - permissionConstantFiles: scan app/ for files named *Permission*.php or *Permissions*.php
 * - conventions: always inherits defaults (tenant signals can't be auto-inferred)
 */
export function inferProjectConfig(projectRoot: string): ProjectConfig {
  return {
    namespaces:             inferNamespaces(projectRoot),
    routeFiles:             inferRouteFiles(projectRoot),
    policyPaths:            inferPolicyPaths(projectRoot),
    permissionConstantFiles: inferPermissionFiles(projectRoot),
    conventions:            DEFAULT_PROJECT_CONFIG.conventions,
  }
}

/** Read PSR-4 namespaces from composer.json autoload section. */
function inferNamespaces(projectRoot: string): Record<string, string> {
  const composerPath = join(projectRoot, "composer.json")
  if (!existsSync(composerPath)) return DEFAULT_PROJECT_CONFIG.namespaces

  let composer: unknown
  try {
    composer = JSON.parse(readFileSync(composerPath, "utf-8"))
  } catch {
    return DEFAULT_PROJECT_CONFIG.namespaces
  }

  if (!composer || typeof composer !== "object") return DEFAULT_PROJECT_CONFIG.namespaces
  const c = composer as Record<string, unknown>

  const psr4 = (c["autoload"] as Record<string, unknown> | undefined)?.["psr-4"]
  if (!psr4 || typeof psr4 !== "object") return DEFAULT_PROJECT_CONFIG.namespaces

  // Normalize: ensure namespace ends with \\ and dir ends with /
  // PSR-4 dirs can be a string or array of strings — take the first entry when array
  const result: Record<string, string> = {}
  for (const [ns, dirRaw] of Object.entries(psr4 as Record<string, string | string[]>)) {
    const dir = Array.isArray(dirRaw) ? dirRaw[0] : dirRaw
    if (typeof dir !== "string") continue
    const normNs  = ns.endsWith("\\")  ? ns  : `${ns}\\`
    const normDir = dir.endsWith("/")   ? dir : `${dir}/`
    result[normNs] = normDir
  }
  return Object.keys(result).length > 0 ? result : DEFAULT_PROJECT_CONFIG.namespaces
}

/** Scan the routes/ directory (and one level of subdirs) for PHP files. */
function inferRouteFiles(projectRoot: string): string[] {
  const routesDir = join(projectRoot, "routes")
  if (!existsSync(routesDir)) return DEFAULT_PROJECT_CONFIG.routeFiles

  const files: string[] = []

  // Top-level PHP files in routes/
  for (const f of readdirSync(routesDir)) {
    const abs = join(routesDir, f)
    const stat = statSync(abs)
    if (stat.isFile() && f.endsWith(".php")) {
      files.push(`routes/${f}`)
    } else if (stat.isDirectory()) {
      // One level deep: routes/api/*.php, routes/frontend/*.php, etc.
      for (const sub of readdirSync(abs)) {
        const subAbs = join(abs, sub)
        if (sub.endsWith(".php") && statSync(subAbs).isFile()) {
          files.push(`routes/${f}/${sub}`)
        }
      }
    }
  }

  return files.length > 0 ? files : DEFAULT_PROJECT_CONFIG.routeFiles
}

const KNOWN_POLICY_DIRS = [
  "app/Policies",
  "app/Http/Policies",
  "src/Policies",
  "app/Domain/Policies",
]

/** Return all well-known policy directories that exist in this project. */
function inferPolicyPaths(projectRoot: string): string[] {
  const found = KNOWN_POLICY_DIRS.filter((dir) => existsSync(join(projectRoot, dir)))
  return found.length > 0 ? found : DEFAULT_PROJECT_CONFIG.policyPaths
}

/** Scan app/ (and src/) for PHP files likely to be permission constant classes. */
function inferPermissionFiles(projectRoot: string): string[] {
  const files: string[] = []
  for (const base of ["app", "src"]) {
    const absBase = join(projectRoot, base)
    if (!existsSync(absBase)) continue
    walkDir(absBase, ".php", files)
  }

  return files
    .map((abs) => relative(projectRoot, abs).replace(/\\/g, "/"))
    .filter((rel) => {
      const name = basename(rel, ".php").toLowerCase()
      return name.includes("permission") || name.includes("permissions")
    })
}

/**
 * Expand a single route file pattern (may contain `*` or `**`) into concrete
 * relative file paths that exist under projectRoot.
 *
 * Supported patterns:
 *   - Exact path: `routes/api.php`           → ["routes/api.php"] if file exists
 *   - Wildcard:   `routes/api/*.php`          → all `.php` files in that directory
 *   - Recursive:  `routes/**\/*.php`           → all `.php` files recursively
 */
export function expandRouteGlob(projectRoot: string, pattern: string): string[] {
  if (!pattern.includes("*")) {
    // Exact path — include only if it exists
    const abs = join(projectRoot, pattern)
    return existsSync(abs) ? [pattern] : []
  }

  const doubleStarIdx = pattern.indexOf("**")
  if (doubleStarIdx >= 0) {
    // Recursive glob: split on `**`, get base dir and extension filter
    const baseDir = pattern.slice(0, doubleStarIdx).replace(/[/\\]$/, "") || "."
    const afterDoubleStar = pattern.slice(doubleStarIdx + 2).replace(/^[/\\]/, "")
    const ext = afterDoubleStar.startsWith("*.") ? afterDoubleStar.slice(1) : null

    const absBase = join(projectRoot, baseDir)
    if (!existsSync(absBase)) return []

    const results: string[] = []
    walkDir(absBase, ext, results)
    return results.map((abs) => relative(projectRoot, abs).replace(/\\/g, "/"))
  }

  // Single-star wildcard: match files in a specific directory
  const dir = dirname(pattern)
  const filePattern = basename(pattern) // e.g. "*.php"
  const ext = filePattern.startsWith("*.") ? filePattern.slice(1) : null // e.g. ".php"

  const absDir = join(projectRoot, dir)
  if (!existsSync(absDir)) return []

  return readdirSync(absDir)
    .filter((name) => {
      if (ext !== null) return name.endsWith(ext)
      return true
    })
    .map((name) => `${dir}/${name}`.replace(/\\/g, "/"))
    .filter((rel) => {
      const abs = join(projectRoot, rel)
      return existsSync(abs) && statSync(abs).isFile()
    })
}

function walkDir(absDir: string, ext: string | null, out: string[]): void {
  for (const entry of readdirSync(absDir)) {
    const abs = join(absDir, entry)
    const st = statSync(abs)
    if (st.isDirectory()) {
      walkDir(abs, ext, out)
    } else if (st.isFile()) {
      if (ext === null || entry.endsWith(ext)) out.push(abs)
    }
  }
}

/**
 * Expand all route file patterns and return a deduplicated list of relative paths.
 */
export function expandRouteFiles(projectRoot: string, patterns: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const pattern of patterns) {
    for (const rel of expandRouteGlob(projectRoot, pattern)) {
      if (!seen.has(rel)) {
        seen.add(rel)
        result.push(rel)
      }
    }
  }
  return result
}

/**
 * Scan route files for `require __DIR__.'/subpath.php'` includes and flatten them
 * into the list. Handles one level of includes (no deep recursion).
 *
 * This supports projects that split routes across subdirectories:
 *   routes/api.php  →  require __DIR__.'/api/auth.php'
 *                      require __DIR__.'/api/orders.php'
 */
export function flattenRouteIncludes(projectRoot: string, routeFiles: string[]): string[] {
  const seen = new Set<string>(routeFiles)
  const result = [...routeFiles]

  const includeRe = /require(?:_once)?\s+__DIR__\s*\.\s*['"]([^'"]+)['"]/g

  for (const relFile of routeFiles) {
    const absFile = join(projectRoot, relFile)
    let source: string
    try {
      source = readFileSync(absFile, "utf-8")
    } catch {
      continue
    }

    let match: RegExpExecArray | null
    includeRe.lastIndex = 0
    while ((match = includeRe.exec(source)) !== null) {
      const includedRel = match[1]  // e.g. "/api/auth.php"
      const absIncluded = join(dirname(absFile), includedRel)
      if (!existsSync(absIncluded)) continue
      const rel = relative(projectRoot, absIncluded).replace(/\\/g, "/")
      if (!seen.has(rel)) {
        seen.add(rel)
        result.push(rel)
      }
    }
  }

  return result
}

/**
 * Find the first policy directory in policyPaths that contains the given policy class file.
 * Falls back to policyPaths[0] (or "app/Policies") when no match is found.
 */
export function resolvePolicyFile(
  projectRoot: string,
  policyClass: string,
  policyPaths: string[]
): string {
  const fileName = `${policyClass}.php`
  for (const dir of policyPaths) {
    const rel = `${dir}/${fileName}`
    if (existsSync(join(projectRoot, rel))) return rel
  }
  const fallbackDir = policyPaths[0] ?? "app/Policies"
  return `${fallbackDir}/${fileName}`
}

/** Resolve a fully-qualified PHP class name to a relative file path using the namespace map. */
export function fqcnToPath(fqcn: string, namespaces: Record<string, string>): string | null {
  for (const [ns, dir] of Object.entries(namespaces)) {
    if (fqcn.startsWith(ns)) {
      const relative = fqcn.slice(ns.length).replace(/\\/g, "/")
      return `${dir}${relative}.php`
    }
  }
  return null
}

export interface ResolvedAliases {
  aliasMap: AliasMap
  /** Effective route files — from bootstrap/app.php if detected, else from config */
  routeFiles: string[]
}

/**
 * Auto-detect Laravel version and resolve middleware alias map + effective route files.
 *
 * - Laravel ≤10: reads app/Http/Kernel.php for aliases
 * - Laravel 11+:  reads bootstrap/app.php for aliases and optional route file declarations
 *
 * Route files from bootstrap/app.php take precedence over config.routeFiles only when
 * bootstrap explicitly declares them (prevents silently ignoring config overrides).
 */
export function resolveAliasMap(projectRoot: string, config: ProjectConfig): ResolvedAliases {
  const kernelPath = join(projectRoot, "app", "Http", "Kernel.php")
  const bootstrapPath = join(projectRoot, "bootstrap", "app.php")

  if (existsSync(kernelPath)) {
    // Laravel ≤10 — Kernel-based middleware
    const expanded = expandRouteFiles(projectRoot, config.routeFiles)
    return {
      aliasMap: parseKernel(kernelPath),
      routeFiles: flattenRouteIncludes(projectRoot, expanded),
    }
  }

  if (existsSync(bootstrapPath)) {
    // Laravel 11/12 — bootstrap/app.php
    const { aliasMap, routeFiles: detected } = parseBootstrap(bootstrapPath, projectRoot)
    // Use bootstrap-detected files only when .archmind.json did NOT explicitly set routeFiles.
    // Filter out console/channels files — they register commands/events, not HTTP routes.
    const NON_HTTP = new Set(["routes/console.php", "routes/channels.php"])
    const httpDetected = detected.filter((f) => !NON_HTTP.has(f))
    // Fall back to inferred route files when bootstrap only found non-HTTP files
    // (e.g. projects using a custom RouteServiceProvider with a `using:` closure).
    const fallback = httpDetected.length === 0 ? inferRouteFiles(projectRoot) : httpDetected
    const useDetected = fallback.length > 0 && !archmindJsonHasRouteFiles(projectRoot)
    const expanded = expandRouteFiles(projectRoot, useDetected ? fallback : config.routeFiles)
    return {
      aliasMap,
      routeFiles: flattenRouteIncludes(projectRoot, expanded),
    }
  }

  // Unknown structure — expand patterns from config, no aliases
  const expanded = expandRouteFiles(projectRoot, config.routeFiles)
  return { aliasMap: {}, routeFiles: flattenRouteIncludes(projectRoot, expanded) }
}

/** Returns true when .archmind.json exists AND explicitly declares routeFiles. */
function archmindJsonHasRouteFiles(projectRoot: string): boolean {
  const configPath = join(projectRoot, ".archmind.json")
  if (!existsSync(configPath)) return false
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>
    return Array.isArray(parsed["routeFiles"])
  } catch {
    return false
  }
}
