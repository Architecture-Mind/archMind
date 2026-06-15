/**
 * Phase 18A — Static Corpus Analyzer
 *
 * Scans Laravel repos for semantic classes (Jobs, Events, Policies, etc.)
 * and compares against what ArchMind's parser currently models from routes.
 *
 * Generates a gap report without needing to run the app.
 *
 * Usage:
 *   node scripts/static-corpus-analyzer.mjs
 *
 * Output:
 *   research/corpus/static-gap-report.json
 *   Console: formatted gap report
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs"
import { join, dirname, extname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")

// ─── Semantic category definitions ───────────────────────────────────────────

const CATEGORIES = [
  { id: "queue_job",          dirs: ["Jobs"],                       baseClasses: ["ShouldQueue", "Job"] },
  { id: "event_listener",     dirs: ["Listeners"],                  baseClasses: ["ShouldQueue", "handle"] },
  { id: "event_dispatch",     dirs: ["Events"],                     baseClasses: ["Dispatchable", "ShouldBroadcast"] },
  { id: "api_resource",       dirs: ["Http/Resources"],             baseClasses: ["JsonResource", "ResourceCollection"] },
  { id: "notification",       dirs: ["Notifications"],              baseClasses: ["Notification", "ShouldQueue"] },
  { id: "mail",               dirs: ["Mail"],                       baseClasses: ["Mailable", "ShouldQueue"] },
  { id: "policy",             dirs: ["Policies"],                   baseClasses: ["Policy", "Gate"] },
  { id: "scheduled_command",  dirs: ["Console/Commands"],           baseClasses: ["Command", "Artisan"] },
  { id: "middleware",         dirs: ["Http/Middleware"],            baseClasses: ["Middleware", "handle"] },
  { id: "controller",         dirs: ["Http/Controllers"],          baseClasses: ["Controller"] },
  { id: "service",            dirs: ["Services", "Actions"],       baseClasses: [] },
  { id: "observer",           dirs: ["Observers"],                  baseClasses: ["Observer"] },
  { id: "action",             dirs: ["Actions"],                    baseClasses: [] },
]

// ─── File scanner ─────────────────────────────────────────────────────────────

function collectPhpFiles(dir) {
  if (!existsSync(dir)) return []
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectPhpFiles(fullPath))
    } else if (entry.isFile() && extname(entry.name) === ".php") {
      files.push(fullPath)
    }
  }
  return files
}

function getClassName(content, filePath) {
  const match = content.match(/^class\s+(\w+)/m)
  return match ? match[1] : filePath.replace(/.*[\\/]/, "").replace(".php", "")
}

function getNamespace(content) {
  const match = content.match(/^namespace\s+([\w\\]+)/m)
  return match ? match[1] : ""
}

function scanCategory(appDir, category) {
  const found = []
  for (const dir of category.dirs) {
    const targetDir = join(appDir, dir)
    const files = collectPhpFiles(targetDir)
    for (const file of files) {
      try {
        const content = readFileSync(file, "utf-8")
        const className = getClassName(content, file)
        const ns = getNamespace(content)
        const fqcn = ns ? `${ns}\\${className}` : className
        found.push({ className, fqcn, file: file.replace(appDir, ""), content })
      } catch {
        // skip unreadable files
      }
    }
  }
  return found
}

// ─── Route scanner ────────────────────────────────────────────────────────────

function scanRoutes(repoRoot) {
  const routesDir = join(repoRoot, "routes")
  if (!existsSync(routesDir)) return []
  const routes = []
  for (const file of readdirSync(routesDir)) {
    if (!file.endsWith(".php")) continue
    try {
      const content = readFileSync(join(routesDir, file), "utf-8")
      // Match Route::get/post/put/patch/delete/any patterns
      const matches = content.matchAll(/Route::(get|post|put|patch|delete|any)\s*\(\s*['"]([^'"]+)['"]/g)
      for (const m of matches) {
        routes.push({ method: m[1].toUpperCase(), path: m[2], file })
      }
      // Match Route::resource / Route::apiResource
      const resourceMatches = content.matchAll(/Route::(apiResource|resource)\s*\(\s*['"]([^'"]+)['"]/g)
      for (const m of resourceMatches) {
        routes.push({ method: m[1].toUpperCase(), path: m[2], file })
      }
    } catch {}
  }
  return routes
}

// ─── Relationship detector ────────────────────────────────────────────────────

// Classify what kind of caller a file is
function callerType(filePath) {
  if (filePath.includes("Http/Controllers")) return "controller"
  if (filePath.includes("Listeners"))        return "listener"
  if (filePath.includes("Services"))         return "service"
  if (filePath.includes("Actions"))          return "action"
  if (filePath.includes("Console"))          return "command"
  if (filePath.includes("Jobs"))             return "job"
  if (filePath.includes("Observers"))        return "observer"
  return "other"
}

function findDispatchedJobs(appDir, jobFqcns) {
  const jobClassNames = new Set(jobFqcns.map(f => f.split("\\").at(-1)))
  const dispatchers = []

  // Scan entire app/ — not just controllers
  for (const file of collectPhpFiles(appDir)) {
    try {
      const content = readFileSync(file, "utf-8")
      const caller = getClassName(content, file)
      const source = callerType(file)
      for (const name of jobClassNames) {
        const isDispatch = content.includes(`dispatch(new ${name}`) || content.includes(`${name}::dispatch(`)
        const isChain    = content.includes(`new ${name}`) && content.includes("chain(")
        if (isDispatch || isChain) {
          dispatchers.push({ caller, source, job: name, chained: isChain && !isDispatch })
        }
      }
    } catch {}
  }
  return dispatchers
}

function findDispatchedEvents(appDir, eventFqcns) {
  const eventClassNames = new Set(eventFqcns.map(f => f.split("\\").at(-1)))
  const dispatchers = []

  // Scan entire app/
  for (const file of collectPhpFiles(appDir)) {
    try {
      const content = readFileSync(file, "utf-8")
      const caller = getClassName(content, file)
      const source = callerType(file)
      for (const name of eventClassNames) {
        if (content.includes(`event(new ${name}`) || content.includes(`${name}::dispatch(`)) {
          dispatchers.push({ caller, source, event: name })
        }
      }
    } catch {}
  }
  return dispatchers
}

function findGateCalls(appDir) {
  const calls = []
  // Scan entire app/ — Gate can be called from services, policies, middleware
  for (const file of collectPhpFiles(appDir)) {
    try {
      const content = readFileSync(file, "utf-8")
      const source = callerType(file)
      const matches = content.matchAll(/Gate::(allows|denies|authorize|check)\s*\(\s*['"]([^'"]+)['"]/g)
      for (const m of matches) {
        calls.push({ caller: getClassName(content, file), source, method: m[1], ability: m[2] })
      }
    } catch {}
  }
  return calls
}

function findApiResourceUsage(appDir, resourceFqcns) {
  const resourceClassNames = new Set(resourceFqcns.map(f => f.split("\\").at(-1)))
  const usage = []
  // Scan entire app/ — Resources can be returned from services or actions too
  for (const file of collectPhpFiles(appDir)) {
    try {
      const content = readFileSync(file, "utf-8")
      const source = callerType(file)
      for (const name of resourceClassNames) {
        if (content.includes(`new ${name}(`) || content.includes(`${name}::collection(`)) {
          usage.push({ caller: getClassName(content, file), source, resource: name })
        }
      }
    } catch {}
  }
  return usage
}

// ─── Gap analysis ─────────────────────────────────────────────────────────────

function analyzeRepo(repoRoot, repoName) {
  const appDir = join(repoRoot, "app")
  console.log(`\n[analyzer] Scanning ${repoName}...`)

  const corpus = {}
  for (const cat of CATEGORIES) {
    corpus[cat.id] = scanCategory(appDir, cat)
  }

  const routes = scanRoutes(repoRoot)
  const dispatchedJobs = findDispatchedJobs(appDir, corpus.queue_job.map(j => j.fqcn))
  const dispatchedEvents = findDispatchedEvents(appDir, corpus.event_dispatch.map(e => e.fqcn))
  const gateCalls = findGateCalls(appDir)
  const apiResourceUsage = findApiResourceUsage(appDir, corpus.api_resource.map(r => r.fqcn))

  return { repoName, repoRoot, corpus, routes, dispatchedJobs, dispatchedEvents, gateCalls, apiResourceUsage }
}

// ─── Reporting ────────────────────────────────────────────────────────────────

function printRepoReport(analysis) {
  const { repoName, corpus, routes, dispatchedJobs, dispatchedEvents, gateCalls, apiResourceUsage } = analysis

  console.log(`\n${"=".repeat(60)}`)
  console.log(`REPO: ${repoName}`)
  console.log("=".repeat(60))
  console.log(`Routes found: ${routes.length}`)
  console.log("")
  console.log("Semantic Class Inventory:")

  for (const cat of CATEGORIES) {
    const items = corpus[cat.id] ?? []
    if (items.length === 0) continue
    console.log(`  ${cat.id.padEnd(22)} ${items.length} classes`)
  }

  // Helper: group by source type
  function bySource(items, key) {
    const groups = {}
    for (const item of items) {
      const src = item.source ?? "other"
      if (!groups[src]) groups[src] = []
      groups[src].push(item[key])
    }
    return groups
  }

  console.log("")
  console.log("Cross-References — full app/ scope (what parser currently misses):")

  if (dispatchedJobs.length > 0) {
    const groups = bySource(dispatchedJobs, "job")
    console.log(`  ✗ QUEUE_JOB: ${dispatchedJobs.length} dispatch/chain references across app/`)
    for (const [src, jobs] of Object.entries(groups)) {
      const uniq = [...new Set(jobs)]
      console.log(`      from ${src}: ${uniq.slice(0, 3).join(", ")}${uniq.length > 3 ? ` (+${uniq.length - 3} more)` : ""}`)
    }
  } else {
    console.log(`  ✓ QUEUE_JOB: no dispatch() calls found`)
  }

  if (dispatchedEvents.length > 0) {
    const groups = bySource(dispatchedEvents, "event")
    console.log(`  ✗ EVENT_DISPATCH: ${dispatchedEvents.length} event() references across app/`)
    for (const [src, evts] of Object.entries(groups)) {
      const uniq = [...new Set(evts)]
      console.log(`      from ${src}: ${uniq.slice(0, 3).join(", ")}${uniq.length > 3 ? ` (+${uniq.length - 3} more)` : ""}`)
    }
  }

  if (gateCalls.length > 0) {
    const groups = bySource(gateCalls, "ability")
    console.log(`  ✗ GATE_CALL: ${gateCalls.length} inline Gate:: calls across app/`)
    for (const [src, abilities] of Object.entries(groups)) {
      const uniq = [...new Set(abilities)]
      console.log(`      from ${src}: ${uniq.slice(0, 3).join(", ")}`)
    }
  }

  if (apiResourceUsage.length > 0) {
    const groups = bySource(apiResourceUsage, "resource")
    console.log(`  ✗ API_RESOURCE: ${apiResourceUsage.length} Resource instantiations across app/`)
    for (const [src, resources] of Object.entries(groups)) {
      const uniq = [...new Set(resources)]
      console.log(`      from ${src}: ${uniq.slice(0, 3).join(", ")}${uniq.length > 3 ? ` (+${uniq.length - 3} more)` : ""}`)
    }
  }

  console.log("")
  console.log("Parser Gap Summary (full app/ scope):")
  const gapMap = {
    queue_job:      dispatchedJobs.length,
    event_dispatch: dispatchedEvents.length,
    gate_call:      gateCalls.length,
    api_resource:   apiResourceUsage.length,
  }

  const totalGaps = Object.values(gapMap).reduce((a, b) => a + b, 0)
  if (totalGaps === 0) {
    console.log("  No gaps detected.")
  } else {
    for (const [type, count] of Object.entries(gapMap).sort((a, b) => b[1] - a[1])) {
      if (count > 0) {
        const bar = "█".repeat(Math.min(25, count))
        console.log(`  ${type.padEnd(18)} ${String(count).padStart(4)} refs  ${bar}`)
      }
    }
  }
}

function printConsolidatedGaps(analyses) {
  console.log(`\n${"=".repeat(60)}`)
  console.log("CONSOLIDATED GAP REPORT (across all repos)")
  console.log("=".repeat(60))

  const totals = {
    queue_job:      0,
    event_dispatch: 0,
    gate_call:      0,
    api_resource:   0,
    notification:   0,
    mail:           0,
    policy:         0,
  }

  const inventory = {}
  for (const cat of CATEGORIES) inventory[cat.id] = 0

  for (const a of analyses) {
    totals.queue_job      += a.dispatchedJobs.length
    totals.event_dispatch += a.dispatchedEvents.length
    totals.gate_call      += a.gateCalls.length
    totals.api_resource   += a.apiResourceUsage.length

    for (const cat of CATEGORIES) {
      inventory[cat.id] += (a.corpus[cat.id] ?? []).length
    }
  }

  console.log("\nSemantic Class Inventory (total across repos):")
  for (const [cat, count] of Object.entries(inventory)) {
    if (count > 0) console.log(`  ${cat.padEnd(22)} ${count}`)
  }

  console.log("\nUntraced References by Category:")
  console.log("(Things that exist in codebase but ArchMind parser doesn't follow into)")
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1])
  for (const [type, count] of sorted) {
    if (count === 0) continue
    const bar = "█".repeat(Math.min(30, count))
    console.log(`  ${type.padEnd(20)} ${String(count).padStart(3)}  ${bar}`)
  }

  console.log("\nRecommended Parser Priorities (by untraced reference count):")
  const priorities = sorted.filter(([, c]) => c > 0)
  for (let i = 0; i < priorities.length; i++) {
    const [type, count] = priorities[i]
    console.log(`  ${i + 1}. ${type}: ${count} untraced references → add parser support`)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const corpusDir = join(ROOT, "research", "corpus")
  const repos = [
    { name: "laravel-io",   root: join(corpusDir, "laravel-io") },
    { name: "crater",       root: join(corpusDir, "crater") },
  ]

  const analyses = []
  for (const repo of repos) {
    if (!existsSync(repo.root)) {
      console.warn(`[analyzer] Skipping ${repo.name} — not found at ${repo.root}`)
      continue
    }
    analyses.push(analyzeRepo(repo.root, repo.name))
  }

  for (const a of analyses) {
    printRepoReport(a)
  }

  if (analyses.length > 1) {
    printConsolidatedGaps(analyses)
  }

  // Save JSON report
  const reportPath = join(corpusDir, "static-gap-report.json")
  const report = {
    generatedAt: new Date().toISOString(),
    repos: analyses.map(a => ({
      name: a.repoName,
      routes: a.routes.length,
      inventory: Object.fromEntries(CATEGORIES.map(c => [c.id, (a.corpus[c.id] ?? []).length])),
      gaps: {
        queue_job:      a.dispatchedJobs.map(d => `${d.caller}[${d.source}] → ${d.job}`),
        event_dispatch: a.dispatchedEvents.map(d => `${d.caller}[${d.source}] → ${d.event}`),
        gate_call:      a.gateCalls.map(g => `${g.caller}[${g.source}].${g.method}('${g.ability}')`),
        api_resource:   a.apiResourceUsage.map(r => `${r.caller}[${r.source}] → ${r.resource}`),
      },
    })),
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`\n[analyzer] JSON report saved → ${reportPath}`)
}

main().catch(e => { console.error(e); process.exit(1) })
