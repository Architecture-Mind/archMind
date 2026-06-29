import { readdirSync, readFileSync } from "fs"
import path from "path"
import type { GuardDescriptor } from "../types.js"
import { classifyGuard } from "./guard.classifier.js"
import type { ArchMindUserConfig } from "@kidkender/archmind-protocol"

// Scan all *.module.ts files under projectRoot for APP_GUARD token providers.
// Pattern: { provide: APP_GUARD, useClass: SomeGuard } in any order.
// APP_PIPE is a known gap — deferred to Phase 3.
export function scanGlobalGuards(projectRoot: string, userConfig?: ArchMindUserConfig): GuardDescriptor[] {
  const moduleFiles = findModuleFiles(projectRoot)
  const seen = new Set<string>()
  const guards: GuardDescriptor[] = []

  for (const filePath of moduleFiles) {
    const text = readFileSync(filePath, "utf8")
    if (!text.includes("APP_GUARD")) continue

    for (const className of extractAppGuardClasses(text)) {
      if (seen.has(className)) continue
      seen.add(className)
      guards.push({ className, args: [], irType: classifyGuard(className, userConfig) })
    }
  }

  return guards
}

function extractAppGuardClasses(text: string): string[] {
  const classes: string[] = []
  let pos = 0

  while (true) {
    const idx = text.indexOf("APP_GUARD", pos)
    if (idx === -1) break

    // Search within 300 chars around the APP_GUARD occurrence for useClass
    const start = Math.max(0, idx - 300)
    const end   = Math.min(text.length, idx + 300)
    const window = text.slice(start, end)
    const match  = window.match(/useClass\s*:\s*(\w+)/)
    if (match) classes.push(match[1])

    pos = idx + 1
  }

  return classes
}

function findModuleFiles(dir: string): string[] {
  const results: string[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") {
        results.push(...findModuleFiles(full))
      } else if (entry.isFile() && entry.name.endsWith(".module.ts")) {
        results.push(full)
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return results
}
