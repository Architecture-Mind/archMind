/**
 * Phase 18A.3 — Runtime Gap Report
 *
 * Usage:
 *   node scripts/generate-gap-report.mjs <traces-dir> <project-root>
 *
 * Example:
 *   node scripts/generate-gap-report.mjs research/corpus/traces/laravel-io /path/to/laravel-io
 *
 * It reads all OTLP JSON files from <traces-dir>, parses + correlates them
 * against the ArchMind execution graph of <project-root>, then prints a
 * Runtime Coverage Score with breakdown by semantic category.
 */

import { readdirSync, writeFileSync, existsSync, statSync } from "fs"
import { join, resolve, dirname } from "path"
import { fileURLToPath, pathToFileURL } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")

function distUrl(pkgPath) {
  return new URL(pkgPath, new URL("../", import.meta.url)).href
}

function findRouteFiles(projectRoot) {
  const routesDir = join(projectRoot, "routes")
  if (!existsSync(routesDir)) return []
  const found = []
  for (const entry of readdirSync(routesDir)) {
    const abs = join(routesDir, entry)
    const s = statSync(abs)
    if (s.isFile() && entry.endsWith(".php")) {
      found.push(abs)
    } else if (s.isDirectory()) {
      for (const sub of readdirSync(abs)) {
        const subAbs = join(abs, sub)
        if (sub.endsWith(".php") && statSync(subAbs).isFile()) found.push(subAbs)
      }
    }
  }
  return found
}

async function main() {
  const [tracesDir, projectRoot] = process.argv.slice(2)

  if (!tracesDir || !projectRoot) {
    console.error("Usage: node generate-gap-report.mjs <traces-dir> <project-root>")
    process.exit(1)
  }

  const absTracesDir = resolve(tracesDir)
  const absProjectRoot = resolve(projectRoot)

  // Dynamic imports — use distUrl() for Windows ESM compatibility
  const { ingestOtlpFile } = await import(distUrl("packages/runtime-ingest/dist/index.js"))
  const { correlateSession, generateGapReport } = await import(distUrl("packages/runtime-correlator/dist/index.js"))
  const { parseRouteFile, augmentGraph, inferProjectConfig, resolveAliasMap } = await import(
    distUrl("packages/laravel-parser/dist/index.js")
  )

  // Parse all routes from project
  console.log(`[gap-report] Parsing project: ${absProjectRoot}`)
  const config = inferProjectConfig(absProjectRoot)
  const aliasMap = config ? resolveAliasMap(absProjectRoot, config) : {}
  const routeFiles = findRouteFiles(absProjectRoot)

  const allNodes = []
  let routeCount = 0
  for (const rf of routeFiles) {
    try {
      const graphs = parseRouteFile(rf, { aliasMap })
      for (const g of graphs) {
        try {
          const aug = augmentGraph(g, { projectRoot: absProjectRoot, config })
          allNodes.push(...aug.nodes)
          routeCount++
        } catch {
          allNodes.push(...g.nodes)
          routeCount++
        }
      }
    } catch {}
  }
  console.log(`[gap-report] Graph nodes: ${allNodes.length} across ${routeCount} routes`)

  // Load all trace files
  const traceFiles = readdirSync(absTracesDir).filter(f => f.endsWith(".json"))
  if (traceFiles.length === 0) {
    console.error(`[gap-report] No trace files found in ${absTracesDir}`)
    console.error("  → Run the app with OTLP enabled and the otlp-collector to generate traces first.")
    process.exit(1)
  }

  console.log(`[gap-report] Loading ${traceFiles.length} trace file(s)...`)

  // Aggregate correlations across all traces
  let totalSpans = 0, matchedSpans = 0
  const categoryTotals = new Map()
  const categoryExamples = new Map()

  for (const file of traceFiles) {
    const session = ingestOtlpFile(join(absTracesDir, file))

    // correlateSession's partitionSpans excludes root spans from candidates.
    // Our middleware emits controller info as standalone root spans.
    // Manually correlate every span so root controller spans are included.
    const correlations = session.spans.map(span => {
      const ns  = span.attributes["code.namespace"]
      const fn_ = span.attributes["code.function"]

      if (ns && fn_) {
        // Try namespace+function match (ArticlesController::index)
        const className = String(ns).split("\\").at(-1)
        const symbol    = `${className}::${fn_}`
        const matched   = allNodes.find(n => n.symbol === symbol)
        if (matched) {
          return { span, nodeId: matched.id, strategy: "namespace_function", confidence: "exact" }
        }
        // Try exact symbol match with FQCN
        const fqSymbol = `${ns}::${fn_}`
        const fqMatched = allNodes.find(n => n.symbol === fqSymbol)
        if (fqMatched) {
          return { span, nodeId: fqMatched.id, strategy: "exact_symbol", confidence: "exact" }
        }
      }
      return { span, nodeId: null, strategy: "unmatched", confidence: "none" }
    })

    const matched = correlations.filter(c => c.confidence !== "none").length
    const syntheticCorrelated = {
      session,
      correlations,
      correlationRate: session.spans.length > 0 ? matched / session.spans.length : 0,
      infraSpans: [],
    }

    const report = generateGapReport(syntheticCorrelated)

    totalSpans += report.totalSpans
    matchedSpans += report.matchedSpans

    for (const b of report.breakdown) {
      categoryTotals.set(b.category, (categoryTotals.get(b.category) ?? 0) + b.count)
      if (!categoryExamples.has(b.category)) categoryExamples.set(b.category, b.examples)
    }
  }

  const coverageScore = totalSpans > 0 ? matchedSpans / totalSpans : 0
  const unmatchedTotal = totalSpans - matchedSpans

  // Build aggregated breakdown
  const breakdown = Array.from(categoryTotals.entries())
    .map(([category, count]) => ({
      category,
      count,
      percentage: totalSpans > 0 ? Math.round((count / totalSpans) * 100) : 0,
      examples: categoryExamples.get(category) ?? [],
    }))
    .sort((a, b) => b.count - a.count)

  // Print report
  console.log("\n" + "=".repeat(60))
  console.log("ARCHMIND — RUNTIME COVERAGE REPORT")
  console.log("=".repeat(60))
  console.log(`Project:        ${absProjectRoot}`)
  console.log(`Trace files:    ${traceFiles.length}`)
  console.log(`Total spans:    ${totalSpans}`)
  console.log(`Matched:        ${matchedSpans}  (${Math.round(coverageScore * 100)}%)`)
  console.log(`Unmatched:      ${unmatchedTotal}  (${Math.round((1 - coverageScore) * 100)}%)`)
  console.log("-".repeat(60))
  console.log("Unmatched Breakdown (sorted by count):")

  const infraCategories = ["db_infra", "http_infra", "cache_infra"]
  for (const b of breakdown) {
    const isInfra = infraCategories.includes(b.category)
    const tag = isInfra ? " [infra - expected]" : " ← PARSER GAP"
    const bar = "█".repeat(Math.round(b.percentage / 3))
    console.log(`  ${b.category.padEnd(22)} ${String(b.percentage + "%").padStart(4)}  ${bar}${tag}`)
    if (b.examples.length > 0 && !isInfra) {
      console.log(`    e.g. ${b.examples.join(", ")}`)
    }
  }

  console.log("-".repeat(60))
  console.log("Top Parser Targets (coverage increase estimate):")
  const gaps = breakdown.filter(b => !infraCategories.includes(b.category))
  let cumulative = Math.round(coverageScore * 100)
  for (const g of gaps.slice(0, 5)) {
    const after = cumulative + g.percentage
    console.log(`  → Add ${g.category} parser: ${cumulative}% → ${after}%`)
    cumulative = after
  }
  console.log("=".repeat(60))

  // Save JSON report
  const reportPath = join(ROOT, "research", "corpus", "gap-report.json")
  const reportData = {
    generatedAt: new Date().toISOString(),
    projectRoot: absProjectRoot,
    traceFiles: traceFiles.length,
    totalSpans,
    matchedSpans,
    unmatchedSpans: unmatchedTotal,
    coverageScore,
    breakdown,
  }
  writeFileSync(reportPath, JSON.stringify(reportData, null, 2))
  console.log(`\n[gap-report] JSON report saved to ${reportPath}`)
}

main().catch(e => { console.error(e); process.exit(1) })
