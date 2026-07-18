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

// Method-level mapping annotations are Spring MVC/WebFlux-specific and, in
// practice, only ever appear on routing methods — so their presence alone is
// a reliable HTTP-entrypoint signal, even on classes that skip the standard
// @RestController/@Controller stereotype in favor of a custom one (e.g.
// Spring Boot Admin's @AdminController, which carries no meta-annotations
// and is wired up via a custom HandlerMapping instead).
const HTTP_METHOD_MAPPING_ANNS = ["@GetMapping", "@PostMapping", "@PutMapping", "@DeleteMapping", "@PatchMapping"]

export const httpEntrypointDetector: EntrypointDetector = {
  kind: "http",
  matchesSource(source: string): boolean {
    if (HTTP_METHOD_MAPPING_ANNS.some((a) => source.includes(a))) return true
    return (
      (source.includes("@RestController") || source.includes("@Controller")) &&
      source.includes("@RequestMapping")
    )
  },
}

export const messagingEntrypointDetector: EntrypointDetector = {
  kind: "queue",
  matchesSource(source: string): boolean {
    return (
      source.includes("@KafkaListener") ||
      source.includes("@RabbitListener") ||
      source.includes("@JmsListener")
    )
  },
}

export const scheduledEntrypointDetector: EntrypointDetector = {
  kind: "cron",
  matchesSource(source: string): boolean {
    return source.includes("@Scheduled")
  },
}

export const entrypointDetectors: EntrypointDetector[] = [
  httpEntrypointDetector,
  messagingEntrypointDetector,
  scheduledEntrypointDetector,
]
