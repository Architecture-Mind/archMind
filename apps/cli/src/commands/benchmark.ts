import { readFileSync, readdirSync, statSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { parseProject, requireProject } from "../utils/parse-project.js"

// ---------------------------------------------------------------------------
// Pain spec types
// ---------------------------------------------------------------------------

interface PainSpec {
  id:             string
  framework:      string
  category:       string
  difficulty:     string
  entrypoint:     string
  expected_nodes: string[]
  expected_edges: string[]   // e.g. ["JwtGuard -> Controller", "Controller -> Service"]
  source_project: string | undefined
  file:           string
}

interface BenchmarkResult {
  id:            string
  category:      string
  difficulty:    string
  entrypoint:    string
  found:         boolean
  recall:        number
  matched:       string[]
  missing:       string[]
  edge_recall:   number
  matched_edges: string[]
  missing_edges: string[]
  passed:        boolean
}

interface BenchmarkSnapshot {
  ran_at:          string
  project:         string
  pains_dir:       string
  total:           number
  passed:          number
  skipped:         number
  avg_recall:      number
  avg_edge_recall: number
  results:         BenchmarkResult[]
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// Handles simple YAML: scalar values and string-array lists.
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): Record<string, unknown> | null {
  if (!content.startsWith("---")) return null
  const end = content.indexOf("\n---", 3)
  if (end === -1) return null
  const block = content.slice(4, end)
  const result: Record<string, unknown> = {}
  const lines = block.split("\n")
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const kv = line.match(/^([\w][\w_-]*):\s*(.*)$/)
    if (kv) {
      const key = kv[1]
      const val = kv[2].trim()
      if (val === "") {
        // peek ahead for indented list items
        const items: string[] = []
        let j = i + 1
        while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
          items.push(lines[j].replace(/^\s+-\s+/, "").trim())
          j++
        }
        result[key] = items
        i = j
        continue
      } else {
        result[key] = val
      }
    }
    i++
  }
  return result
}

// ---------------------------------------------------------------------------
// Load pain specs from a directory tree
// ---------------------------------------------------------------------------

function loadPainSpecs(dir: string): PainSpec[] {
  const specs: PainSpec[] = []

  function walk(d: string): void {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry)
      if (statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (!entry.endsWith(".md")) continue

      const content = readFileSync(p, "utf-8")
      const fm = parseFrontmatter(content)
      if (!fm) continue

      const id        = fm["id"]
      const entrypoint = fm["entrypoint"]
      const nodes     = fm["expected_nodes"]

      // skip pain files without machine-readable metadata
      if (!id || !entrypoint || !Array.isArray(nodes) || nodes.length === 0) continue

      const edges = fm["expected_edges"]

      specs.push({
        id:             String(id),
        framework:      String(fm["framework"] ?? "laravel"),
        category:       String(fm["category"] ?? ""),
        difficulty:     String(fm["difficulty"] ?? ""),
        entrypoint:     String(entrypoint),
        expected_nodes: nodes as string[],
        expected_edges: Array.isArray(edges) ? edges as string[] : [],
        source_project: fm["source_project"] ? String(fm["source_project"]) : undefined,
        file:           p,
      })
    }
  }

  walk(dir)
  return specs.sort((a, b) => a.id.localeCompare(b.id))
}

// ---------------------------------------------------------------------------
// Entrypoint matching
// ---------------------------------------------------------------------------

function findGraph(
  graphs: IntermediateExecutionGraph[],
  entrypoint: string,
): IntermediateExecutionGraph | undefined {
  const norm = entrypoint.trim().toLowerCase()
  // exact match
  const exact = graphs.find((g) => g.entrypoint.toLowerCase() === norm)
  if (exact) return exact

  // normalise path params {id} → {_} and compare method + path
  const [method, ...pathParts] = norm.split(" ")
  const path = pathParts.join(" ").replace(/\{[^}]+\}/g, "{_}")

  return graphs.find((g) => {
    const [gm, ...gp] = g.entrypoint.toLowerCase().split(" ")
    const gpath = gp.join(" ").replace(/\{[^}]+\}/g, "{_}")
    return gm === method && gpath === path
  })
}

// ---------------------------------------------------------------------------
// Node recall
// Strategy: for each expected symbol, check whether any graph node's symbol
// contains it (or is contained by it). Case-insensitive substring match.
// ---------------------------------------------------------------------------

function checkNodeRecall(
  graph: IntermediateExecutionGraph,
  expected: string[],
): { matched: string[]; missing: string[]; recall: number } {
  const symbols = graph.nodes
    .map((n) => (n.symbol ?? "").toLowerCase())
    .filter(Boolean)

  const matched: string[] = []
  const missing: string[] = []

  for (const exp of expected) {
    const e = exp.toLowerCase()
    const found = symbols.some((s) => s.includes(e) || e.includes(s))
    if (found) matched.push(exp)
    else        missing.push(exp)
  }

  const recall = expected.length > 0 ? matched.length / expected.length : 1
  return { matched, missing, recall }
}

// ---------------------------------------------------------------------------
// Edge recall
// Parse "A -> B" and check whether graph has any edge where from-node symbol
// contains A and to-node symbol contains B (case-insensitive substring).
// ---------------------------------------------------------------------------

function checkEdgeRecall(
  graph: IntermediateExecutionGraph,
  expectedEdges: string[],
): { matched: string[]; missing: string[]; recall: number } {
  const matched: string[] = []
  const missing: string[] = []

  for (const spec of expectedEdges) {
    const arrow = spec.indexOf("->")
    if (arrow === -1) continue   // malformed — skip silently

    const fromKey = spec.slice(0, arrow).trim().toLowerCase()
    const toKey   = spec.slice(arrow + 2).trim().toLowerCase()

    const found = graph.edges.some((edge) => {
      const fromNode = graph.nodes.find((n) => n.id === edge.from)
      const toNode   = graph.nodes.find((n) => n.id === edge.to)
      if (!fromNode || !toNode) return false
      const fs = (fromNode.symbol ?? "").toLowerCase()
      const ts = (toNode.symbol ?? "").toLowerCase()
      return (fs.includes(fromKey) || fromKey.includes(fs)) &&
             (ts.includes(toKey)   || toKey.includes(ts))
    })

    if (found) matched.push(spec)
    else        missing.push(spec)
  }

  const recall = expectedEdges.length > 0 ? matched.length / expectedEdges.length : 1
  return { matched, missing, recall }
}

// ---------------------------------------------------------------------------
// Explain output — shown when --explain flag is set and a spec fails
// ---------------------------------------------------------------------------

function buildPathChain(graph: IntermediateExecutionGraph): string[] {
  const incoming = new Set(graph.edges.map((e) => e.to))
  const roots    = graph.nodes.filter((n) => !incoming.has(n.id))
  const visited  = new Set<string>()
  const path: string[] = []
  const queue = roots.map((n) => n.id)

  while (queue.length > 0) {
    const nodeId = queue.shift()!
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    const node = graph.nodes.find((n) => n.id === nodeId)
    if (node?.symbol) path.push(node.symbol)
    const children = graph.edges
      .filter((e) => e.from === nodeId && !visited.has(e.to))
      .map((e) => e.to)
    queue.push(...children)
  }

  return path
}

function printExplain(
  graph: IntermediateExecutionGraph,
  missingNodes: string[],
  matchedNodes: string[],
  missingEdges: string[],
): void {
  const pad = "        "

  if (missingNodes.length > 0) {
    console.log(`${pad}Missing nodes:`)
    for (const sym of missingNodes) {
      console.log(`${pad}  ✗ ${sym}`)
    }
  }

  if (missingEdges.length > 0) {
    console.log(`${pad}Missing edges:`)
    for (const edge of missingEdges) {
      console.log(`${pad}  ✗ ${edge}`)
    }
  }

  if (matchedNodes.length > 0) {
    console.log(`${pad}Found nodes:`)
    for (const sym of matchedNodes) {
      console.log(`${pad}  ✓ ${sym}`)
    }
  }

  const pathSymbols = buildPathChain(graph)
  if (pathSymbols.length > 0) {
    console.log(`${pad}Execution path:`)
    for (let i = 0; i < pathSymbols.length; i++) {
      const prefix = i === 0 ? `${pad}  ` : `${pad}  ↓ `
      console.log(`${prefix}${pathSymbols[i]}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

const PASS_THRESHOLD = 0.7

export async function runBenchmark(
  flags: Record<string, string>,
): Promise<void> {
  const projectRoot = requireProject(flags)
  const painsDirRaw = flags["pains-dir"]
  const filterId    = flags["id"]
  const framework   = flags["framework"]
  const outFile     = flags["output"]
  const doExplain   = "explain" in flags

  if (!painsDirRaw) {
    console.error("Error: --pains-dir <path> is required")
    process.exit(2)
  }

  const painsDir = resolve(painsDirRaw)

  console.log(`Loading pain specs from: ${painsDir}`)
  let specs = loadPainSpecs(painsDir)

  if (filterId) {
    specs = specs.filter((s) => s.id === filterId)
    if (specs.length === 0) {
      console.error(`No pain spec found with id: ${filterId}`)
      process.exit(2)
    }
  }

  if (framework) {
    specs = specs.filter((s) => s.framework === framework)
  }

  console.log(`Found ${specs.length} spec(s)`)
  console.log(`Parsing project: ${projectRoot}`)
  const { graphs } = parseProject(projectRoot)
  console.log(`Parsed ${graphs.length} routes\n`)

  const results: BenchmarkResult[] = []
  let skipped = 0

  for (const spec of specs) {
    const graph = findGraph(graphs, spec.entrypoint)

    if (!graph) {
      const label = `${spec.id.padEnd(26)} entrypoint not found: ${spec.entrypoint}`
      console.log(`  SKIP  ${label}`)
      skipped++
      continue
    }

    const { matched, missing, recall } = checkNodeRecall(graph, spec.expected_nodes)
    const edgeResult = checkEdgeRecall(graph, spec.expected_edges)
    const passed  = recall >= PASS_THRESHOLD
    const pct     = `${(recall * 100).toFixed(0)}%`
    const edgePct = spec.expected_edges.length > 0
      ? `  edges=${(edgeResult.recall * 100).toFixed(0)}% (${edgeResult.matched.length}/${spec.expected_edges.length})`
      : ""
    const status  = passed ? "PASS" : "FAIL"

    console.log(`  ${status}  ${spec.id.padEnd(26)} recall=${pct}  (${matched.length}/${spec.expected_nodes.length} nodes)${edgePct}`)
    if (missing.length > 0) {
      console.log(`        missing nodes: ${missing.join(", ")}`)
    }
    if (edgeResult.missing.length > 0) {
      console.log(`        missing edges: ${edgeResult.missing.join(" | ")}`)
    }

    if (doExplain && (!passed || edgeResult.missing.length > 0)) {
      printExplain(graph, missing, matched, edgeResult.missing)
    }

    results.push({
      id:            spec.id,
      category:      spec.category,
      difficulty:    spec.difficulty,
      entrypoint:    spec.entrypoint,
      found:         true,
      recall,
      matched,
      missing,
      edge_recall:   edgeResult.recall,
      matched_edges: edgeResult.matched,
      missing_edges: edgeResult.missing,
      passed,
    })
  }

  const passed    = results.filter((r) => r.passed).length
  const total     = results.length
  const avgRecall = total > 0
    ? results.reduce((sum, r) => sum + r.recall, 0) / total
    : 0
  const avgEdgeRecall = total > 0
    ? results.reduce((sum, r) => sum + r.edge_recall, 0) / total
    : 0

  console.log("\n" + "─".repeat(60))
  console.log(`Total: ${passed}/${total} passed  (${skipped} skipped — entrypoint not found in project)`)
  console.log(`Avg node recall: ${(avgRecall * 100).toFixed(1)}%`)
  if (results.some((r) => r.matched_edges.length + r.missing_edges.length > 0)) {
    console.log(`Avg edge recall: ${(avgEdgeRecall * 100).toFixed(1)}%`)
  }

  if (outFile) {
    const snapshot: BenchmarkSnapshot = {
      ran_at:          new Date().toISOString(),
      project:         projectRoot,
      pains_dir:       painsDir,
      total,
      passed,
      skipped,
      avg_recall:      avgRecall,
      avg_edge_recall: avgEdgeRecall,
      results,
    }
    writeFileSync(resolve(outFile), JSON.stringify(snapshot, null, 2), "utf-8")
    console.log(`\nResults written to ${outFile}`)
  }

  process.exit(passed < total ? 1 : 0)
}
