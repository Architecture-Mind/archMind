// Ensure stdio transport when spawned by editors that don't pass --stdio
if (!process.argv.includes("--stdio") && !process.argv.includes("--node-ipc") && !process.argv.some(a => a.startsWith("--socket"))) {
  process.argv.push("--stdio")
}

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  InlayHintParams,
} from "vscode-languageserver/node.js"
import { TextDocument } from "vscode-languageserver-textdocument"
import { resolve, dirname, join } from "path"
import { existsSync } from "fs"
import { WorkspaceManager } from "./workspace/manager.js"
import { buildInlayHints } from "./providers/inlay-hints.js"
import { uriToFile } from "./converters/ir-to-lsp.js"

const connection = createConnection(ProposedFeatures.all)
const documents  = new TextDocuments(TextDocument)
const manager    = new WorkspaceManager()

let analysisVersion = 0

// Debounced refresh — prevents rapid file switches from flooding Zed with refresh signals
let refreshTimer: ReturnType<typeof setTimeout> | null = null
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    connection.languages.inlayHint.refresh()
  }, 150)
}

// In-progress analysis guard — prevents concurrent analyses for the same root
const analyzing = new Set<string>()

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const inlayHintCap = params.capabilities.textDocument?.inlayHint
  connection.console.log(`[archmind] client inlayHint support: ${JSON.stringify(inlayHintCap)}`)

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      inlayHintProvider: { resolveProvider: false },
    },
    serverInfo: {
      name:    "archmind-lsp",
      version: "0.1.0",
    },
  }
})

// Trigger analysis on open
documents.onDidOpen(async event => {
  const root = findProjectRoot(uriToFile(event.document.uri))
  if (!root) return
  const ctx = manager.getOrCreate(root)
  if (ctx.cache) {
    // Already analyzed — debounced refresh so Zed requests hints for this file
    scheduleRefresh()
    return
  }
  await runAnalysis(root, event.document.uri, event.document.version)
})

// Trigger re-analysis on save
documents.onDidSave(async event => {
  const root = findProjectRoot(uriToFile(event.document.uri))
  if (!root) return
  manager.invalidate(root)
  await runAnalysis(root, event.document.uri, event.document.version ?? 0)
})

connection.languages.inlayHint.on(async (params: InlayHintParams) => {
  const filePath = uriToFile(params.textDocument.uri)
  const root     = findProjectRoot(filePath)
  if (!root) return []

  const ctx = manager.get(root)

  // No cache: trigger lazy analysis if not already running, return [] for now
  if (!ctx?.cache) {
    if (!analyzing.has(root)) {
      runAnalysis(root, params.textDocument.uri, 0).catch(() => {})
    }
    return []
  }

  // Normalize to forward slashes — parser stores paths with /, Windows uses \
  const normalRoot = root.replace(/\\/g, "/")
  const normalFile = filePath.replace(/\\/g, "/")
  const relFile    = normalFile.replace(normalRoot, "").replace(/^\//, "")

  const routes = ctx.cache.analysis.indexes.routesByFile.get(relFile)
              ?? ctx.cache.analysis.indexes.routesByFile.get(normalFile)
              ?? []

  return buildInlayHints(routes)
})

async function runAnalysis(root: string, triggerUri: string, docVersion: number): Promise<void> {
  if (analyzing.has(root)) return
  analyzing.add(root)

  const ctx = manager.getOrCreate(root)

  try {
    connection.console.log(`[archmind] analyzing ${root}`)
    const analysis = await ctx.analyzer.analyze()
    analysisVersion += 1

    const documentVersions = ctx.cache?.documentVersions ?? new Map<string, number>()
    documentVersions.set(triggerUri, docVersion)

    ctx.cache = {
      analysis,
      analysisVersion,
      documentVersions,
      lastAnalyzed: Date.now(),
    }

    connection.console.log(`[archmind] found ${analysis.routes.length} routes`)

    scheduleRefresh()
  } catch (err: unknown) {
    connection.console.error(`[archmind] analysis failed: ${String(err)}`)
  } finally {
    analyzing.delete(root)
  }
}

function findProjectRoot(filePath: string): string | null {
  const MARKERS = ["artisan", "nest-cli.json", "composer.json", "package.json"]
  let dir = dirname(resolve(filePath))

  for (let i = 0; i < 10; i++) {
    if (MARKERS.some(m => existsSync(join(dir, m)))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return null
}

documents.listen(connection)
connection.listen()
