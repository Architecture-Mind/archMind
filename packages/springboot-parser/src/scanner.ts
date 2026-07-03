import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { entrypointDetectors, httpEntrypointDetector } from "./entrypoint-detector.js"

/**
 * Walk src/main/java under the root (handles multi-module Maven projects where
 * multiple sub-directories each have their own src/main/java tree).
 */
export function findJavaFiles(root: string): string[] {
  // Try the root itself first (single-module or test fixtures)
  const singleSrc = join(root, "src", "main", "java")
  if (existsSync(singleSrc)) return walkJava(singleSrc)

  // Multi-module: each top-level sub-dir may have its own src/main/java
  const out: string[] = []
  try {
    for (const entry of readdirSync(root)) {
      const sub = join(root, entry)
      if (!statSync(sub).isDirectory()) continue
      const javaSrc = join(sub, "src", "main", "java")
      if (existsSync(javaSrc)) {
        out.push(...walkJava(javaSrc))
      }
    }
  } catch { /* permission error */ }

  if (out.length) return out

  // Flat fallback for test fixtures / unusual layouts
  return walkJava(root)
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
