import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { entrypointDetectors, httpEntrypointDetector } from "./entrypoint-detector.js"

// Directories that never contain a Maven module worth descending into —
// skipped for both correctness (test/generated sources) and scan speed.
const SKIP_DIRS = new Set(["node_modules", "target", "build", ".git", ".idea", ".mvn", "dist", "out", "src"])

// Bounds recursion depth for pathological directory trees; real Maven
// multi-module projects (even deeply nested ones like SpringBlade's
// blade-service/blade-demo/src/main/java) stay well under this.
const MAX_SCAN_DEPTH = 8

/**
 * Walk src/main/java under the root, at any nesting depth. Handles
 * multi-module Maven projects where modules are nested arbitrarily deep
 * (e.g. `blade-service/blade-demo/src/main/java`), not just one level
 * below the root.
 */
export function findJavaFiles(root: string): string[] {
  const out: string[] = []
  walkForJavaSrc(root, out, 0)
  if (out.length) return out

  // Flat fallback for test fixtures / unusual layouts
  return walkJava(root)
}

function walkForJavaSrc(dir: string, out: string[], depth: number): void {
  if (depth > MAX_SCAN_DEPTH) return

  const javaSrc = join(dir, "src", "main", "java")
  if (existsSync(javaSrc)) out.push(...walkJava(javaSrc))

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const sub = join(dir, entry)
    let isDir: boolean
    try {
      isDir = statSync(sub).isDirectory()
    } catch {
      continue
    }
    if (isDir) walkForJavaSrc(sub, out, depth + 1)
  }
}

function walkJava(dir: string): string[] {
  const out: string[] = []
  try {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) out.push(...walkJava(p))
      else if (entry.endsWith(".java"))  out.push(p)
    }
  } catch { /* permission error */ }
  return out
}

/**
 * Quick pre-filter: does this file look like a Spring REST controller
 * (HTTP entrypoints only)? Kept narrow because `apps/cli` reports this
 * count specifically as "controller files" — use isEntrypointFile() for
 * scanning all entrypoint kinds (HTTP, messaging, scheduled).
 */
export function isControllerFile(filePath: string): boolean {
  return matchesDetector(filePath, httpEntrypointDetector.matchesSource)
}

/**
 * Quick pre-filter: does this file contain ANY known entrypoint kind —
 * HTTP controller, message listener (@KafkaListener/@RabbitListener/
 * @JmsListener), or @Scheduled job? New kinds register a detector in
 * entrypoint-detector.ts instead of adding another isXFile() function here.
 */
export function isEntrypointFile(filePath: string): boolean {
  return matchesDetector(filePath, (src) => entrypointDetectors.some((d) => d.matchesSource(src)))
}

function matchesDetector(filePath: string, predicate: (source: string) => boolean): boolean {
  try {
    const src = readFileSync(filePath, "utf-8")
    return predicate(src)
  } catch {
    return false
  }
}
