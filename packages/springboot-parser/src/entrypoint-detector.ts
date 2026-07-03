// ---------------------------------------------------------------------------
// EntrypointDetector: framework-agnostic "does this file contain an
// entrypoint of kind X?" check. Kept as a cheap source-text predicate
// (not an AST walk) so scanner.ts can pre-filter files before the more
// expensive tree-sitter parse + full extraction in controller-parser.ts.
//
// New entrypoint kinds (Kafka, Scheduled, ...) register another detector
// here instead of adding another ad-hoc isXFile() function to scanner.ts.
// ---------------------------------------------------------------------------

export interface EntrypointDetector {
  kind: string // "http" | "queue" | "cron" | ...
  matchesSource(source: string): boolean
}

export const httpEntrypointDetector: EntrypointDetector = {
  kind: "http",
  matchesSource(source: string): boolean {
    return (
      (source.includes("@RestController") || source.includes("@Controller")) &&
      (source.includes("Mapping") || source.includes("@RequestMapping"))
    )
  },
}

export const entrypointDetectors: EntrypointDetector[] = [httpEntrypointDetector]
