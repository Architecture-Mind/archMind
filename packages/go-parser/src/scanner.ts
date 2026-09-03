import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join, relative } from "path"

// Directories never worth descending into — vendored deps, build output,
// VCS metadata. Mirrors springboot-parser's scanner.ts SKIP_DIRS.
const SKIP_DIRS = new Set(["node_modules", "vendor", "bin", "tmp", ".git", ".idea", "dist", "build", "testdata"])

const MAX_SCAN_DEPTH = 12

function readIfExists(path: string): string | null {
  try { return readFileSync(path, "utf-8") } catch { return null }
}

/** True when go.mod (at root, or the nearest one found while scanning) references gin-gonic/gin. */
export function isGinProject(root: string): boolean {
  const goMod = readIfExists(join(root, "go.mod"))
  return !!goMod && /github\.com\/gin-gonic\/gin\b/.test(goMod)
}

/**
 * Walks the project for every `*.go` file (excluding `_test.go` — test
 * files aren't part of the routing surface and only add noise), skipping
 * vendor/build/VCS directories. Returns paths relative to `root`.
 */
export function findGoFiles(root: string): string[] {
  const out: string[] = []
  walk(root, root, out, 0)
  return out
}

function walk(root: string, dir: string, out: string[], depth: number): void {
  if (depth > MAX_SCAN_DEPTH) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue
    const abs = join(dir, entry)
    let isDir: boolean
    try {
      isDir = statSync(abs).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      walk(root, abs, out, depth + 1)
    } else if (entry.endsWith(".go") && !entry.endsWith("_test.go")) {
      out.push(relative(root, abs))
    }
  }
}

export interface ReadGoFile {
  path: string
  content: string
}

/** Reads every discovered Go file's content, skipping any that fail to read (permissions, symlink races). */
export function readGoProjectFiles(root: string): ReadGoFile[] {
  const out: ReadGoFile[] = []
  for (const rel of findGoFiles(root)) {
    const content = readIfExists(join(root, rel))
    if (content !== null) out.push({ path: rel, content })
  }
  return out
}

export function goModExists(root: string): boolean {
  return existsSync(join(root, "go.mod"))
}
