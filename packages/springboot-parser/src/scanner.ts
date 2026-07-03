import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"
import { entrypointDetectors } from "./entrypoint-detector.js"

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
 * Quick pre-filter: does this file look like it contains a known entrypoint
 * kind (HTTP controller today; Kafka/Scheduled register more detectors in
 * entrypoint-detector.ts without changing this function).
 */
export function isControllerFile(filePath: string): boolean {
  try {
    const src = readFileSync(filePath, "utf-8")
    return entrypointDetectors.some((detector) => detector.matchesSource(src))
  } catch {
    return false
  }
}
