import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { readGoProjectFiles, isGinProject } from "./scanner.js"
import { parseGinProject } from "./graph-builder.js"
import type { ExtractRoutesOptions } from "./route-parser.js"

export { isGinProject } from "./scanner.js"

/**
 * Discovers and parses an entire Gin project on disk into one
 * IntermediateExecutionGraph per route. This is the entrypoint the CLI/MCP
 * server should call — `parseGinProject` itself takes an already-read file
 * list (used directly in tests with synthetic fixtures).
 */
export function parseGinProjectAt(root: string, opts: ExtractRoutesOptions = {}): IntermediateExecutionGraph[] {
  const files = readGoProjectFiles(root)
  return parseGinProject(files, opts)
}
