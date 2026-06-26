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
import { uriToFile, fileToUri } from "./converters/ir-to-lsp.js"

const connection = createConnection(ProposedFeatures.all)
const documents  = new TextDocuments(TextDocument)
const manager    = new WorkspaceManager()

let analysisVersion = 0

connection.onInitialize((_params: InitializeParams): InitializeResult => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    inlayHintProvider: true,
  },
  serverInfo: {
    name:    "archmind-lsp",
    version: "0.1.0",
  },
}))

// Trigger analysis on open
documents.onDidOpen(async event => {
  const root = findProjectRoot(uriToFile(event.document.uri))
  if (!root) return
  await runAnalysis(root, event.document.uri, event.document.version)
})

// Trigger analysis on save only (not every keystroke — analysis is project-wide)
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
  if (!ctx?.cache) return []

  // Resolve routes for this file using the index (O(1) lookup)
  const relFile  = filePath.replace(root + "/", "").replace(root + "\\", "")
  const routes   = ctx.cache.analysis.indexes.routesByFile.get(relFile)
               ?? ctx.cache.analysis.indexes.routesByFile.get(filePath)
               ?? []

  return buildInlayHints(routes)
})

async function runAnalysis(root: string, triggerUri: string, docVersion: number): Promise<void> {
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

    // Notify client to refresh inlay hints for all open documents in this workspace
    connection.languages.inlayHint.refresh()
  } catch (err: unknown) {
    connection.console.error(`[archmind] analysis failed: ${String(err)}`)
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
