import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"

/** Walk src/main/java and return all .java file paths. */
export function findJavaFiles(root: string): string[] {
  const candidates = [
    join(root, "src", "main", "java"),
    join(root, "src"),          // flat layout (test fixtures)
    root,                        // single-dir layout
  ]
  for (const dir of candidates) {
    if (existsSync(dir)) {
      const files = walkJava(dir)
      if (files.length) return files
    }
  }
  return []
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

/** Quick pre-filter: does this file look like a Spring controller? */
export function isControllerFile(filePath: string): boolean {
  try {
    const src = readFileSync(filePath, "utf-8")
    return (
      (src.includes("@RestController") || src.includes("@Controller")) &&
      (src.includes("Mapping") || src.includes("@RequestMapping"))
    )
  } catch {
    return false
  }
}
