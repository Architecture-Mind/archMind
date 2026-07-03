import { readFileSync, existsSync } from "fs"
import { join } from "path"
import type { GoldenTrace } from "@kidkender/archmind-scorer"

// ---- Public API -------------------------------------------------------

export interface NaiveRagResult {
  entrypoint:     string
  files:          string[]   // paths read
  content:        string     // concatenated raw content
  token_estimate: number     // content.length / 4
}

export interface ComparisonReport {
  entrypoint:        string
  naive_rag:         { files: number; token_estimate: number }
  archmind:          { nodes: number; token_estimate: number; recall: number }
  compression_ratio: number   // naive_rag_tokens / archmind_tokens
  token_savings_pct: number   // (1 - compression_ratio^-1) * 100
}

// Simulate naive RAG: read all source files referenced in the golden trace.
// This represents what a naive embedding-based retrieval would return —
// the raw file contents for every file involved in the execution path.
export function naiveRag(
  golden: GoldenTrace,
  projectRoot: string
): NaiveRagResult {
  const uniqueFiles = [
    ...new Set(
      golden.nodes
        .map((n) => n.file)
        .filter((f): f is string => !!f)
    ),
  ]

  const chunks: string[] = []
  const read:   string[] = []

  for (const relPath of uniqueFiles) {
    const abs = join(projectRoot, relPath)
    if (!existsSync(abs)) continue
    chunks.push(`// File: ${relPath}\n` + readFileSync(abs, "utf-8"))
    read.push(relPath)
  }

  const content = chunks.join("\n\n")
  return {
    entrypoint:     golden.entrypoint,
    files:          read,
    content,
    token_estimate: Math.ceil(content.length / 4),
  }
}

export function compare(
  naive:          NaiveRagResult,
  archmindTokens: number,
  archmindRecall: number
): ComparisonReport {
  const ratio    = naive.token_estimate / archmindTokens
  const savingsPct = ((1 - 1 / ratio) * 100)

  return {
    entrypoint:        naive.entrypoint,
    naive_rag:         { files: naive.files.length, token_estimate: naive.token_estimate },
    archmind:          { nodes: 0, token_estimate: archmindTokens, recall: archmindRecall },
    compression_ratio: ratio,
    token_savings_pct: savingsPct,
  }
}
