import { readFileSync } from "fs"

/**
 * Scan all Java files and build a map of simple class name → @RequestMapping path.
 * Used to resolve base-class paths for controllers that use inheritance
 * (e.g. `class FooController extends BasePublicController`).
 */
export function buildBaseClassIndex(javaFiles: string[]): Map<string, string> {
  const index = new Map<string, string>()

  for (const file of javaFiles) {
    let src: string
    try {
      src = readFileSync(file, "utf-8")
    } catch {
      continue
    }

    // Look for classes that have @RequestMapping but are NOT @RestController/@Controller
    // (i.e. abstract base classes that define URL prefix only)
    if (src.includes("@RestController") || src.includes("@Controller")) continue
    if (!src.includes("@RequestMapping")) continue

    const className = extractClassName(src)
    const mapping   = extractClassLevelRequestMapping(src)

    if (className && mapping !== null) {
      index.set(className, mapping)
    }
  }

  return index
}

/** Extract the simple class name from Java source. */
function extractClassName(src: string): string | null {
  const m = src.match(/(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/)
  return m?.[1] ?? null
}

/** Extract @RequestMapping value at class level (before the class declaration). */
function extractClassLevelRequestMapping(src: string): string | null {
  // Match @RequestMapping("value") or @RequestMapping(value = "value")
  // that appears before `class` keyword
  const classIdx = src.search(/(?:public\s+)?(?:abstract\s+)?class\s+\w+/)
  if (classIdx < 0) return null

  const preamble = src.slice(0, classIdx)

  // @RequestMapping("path")
  let m = preamble.match(/@RequestMapping\s*\(\s*["']([^"']+)["']/)
  if (m) return m[1]

  // @RequestMapping(value = "path") or @RequestMapping(value = {"path"})
  m = preamble.match(/@RequestMapping\s*\([^)]*value\s*=\s*["']([^"']+)["']/)
  if (m) return m[1]

  // @RequestMapping with no args — rare, maps to "/"
  m = preamble.match(/@RequestMapping\s*(?!\()/)
  if (m) return ""

  return null
}

/** Extract the `extends ClassName` from a class declaration. */
export function extractBaseClassName(src: string): string | null {
  const m = src.match(/class\s+\w+\s+extends\s+(\w+)/)
  return m?.[1] ?? null
}
