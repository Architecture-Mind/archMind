import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { explain } from "../index.js"
import { selectEvidenceByIntent, buildExecutionPath } from "./selector.js"
import { extractFacts } from "./facts.js"
import type { EvidencePackage, EvidenceItem, IntentScore } from "./types.js"

export interface EvidencePackageOptions {
  forceIntent?: EvidencePackage["intent"]
}

export function buildEvidencePackage(
  question: string,
  graph: IntermediateExecutionGraph,
  options: EvidencePackageOptions = {}
): EvidencePackage {
  // 1. Detect intents — multi-intent aware
  const allIntents = options.forceIntent
    ? [{ intent: options.forceIntent, score: 1.0 }]
    : scoreIntents(question)

  const primary = allIntents[0].intent
  const activeIntentNames = allIntents.map((i) => i.intent)

  // 2. Build execution path
  const executionPath = buildExecutionPath(graph)

  // 3. Run detectors (finding is metadata, not driver)
  const findings = explain(graph, question)
  const top = findings[0]

  // 4. Merge evidence from all active intents — union with dedup
  const evidence = mergeEvidence(graph, activeIntentNames, top)

  // 5. Extract structured facts with merged relevance map
  const facts = extractFacts(graph, activeIntentNames)

  return {
    question,
    intent:  primary,
    intents: allIntents.length > 1 ? allIntents : undefined,
    facts,
    execution_path: executionPath,
    evidence,
    finding:    top?.type      ?? "none",
    severity:   top?.severity  ?? "INFO",
    confidence: top?.confidence ?? "LOW",
  }
}

// ─── Multi-intent keyword scoring ───────────────────────────────────────────

// Each intent has a keyword list. Score = matched / total (case-insensitive word scan).
const INTENT_KEYWORDS: Record<string, string[]> = {
  auth:        ["auth", "authoriz", "permission", "policy", "middleware", "guard", "access", "role", "privilege", "guest", "unauthenticated", "anonymous", "who can", "ownership"],
  transaction: ["transaction", "commit", "rollback", "atomic", "dispatch", "db", "database", "operations"],
  validation:  ["validat", "form request", "input", "sanitiz"],
  isolation:   ["tenant", "isolation", "cross-tenant", "multi-tenant", "scope", "unscoped", "data leak"],
  runtime:     ["runtime", "inject", "container", "binding"],
}

// Minimum score threshold for a secondary intent to be included (0.0–1.0).
// Set low enough to catch partial domain signals (e.g., "authorization requirements"
// in a transaction-dominant question scores auth at ~0.14 with a 14-word keyword list).
const SECONDARY_THRESHOLD = 0.12

function scoreIntents(question: string): IntentScore[] {
  const q = question.toLowerCase()

  const scored: IntentScore[] = Object.entries(INTENT_KEYWORDS).map(([intent, keywords]) => {
    const matched = keywords.filter((kw) => q.includes(kw)).length
    return {
      intent: intent as EvidencePackage["intent"],
      score: matched / keywords.length,
    }
  })

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score)

  // Primary = highest scorer; include secondaries above threshold
  const primary = scored[0].score > 0 ? scored[0] : { intent: "all" as const, score: 0 }
  const secondaries = scored.slice(1).filter(
    (s) => s.score >= SECONDARY_THRESHOLD && s.intent !== primary.intent
  )

  const active = [primary, ...secondaries]

  // If nothing scored, fall back to "all"
  if (primary.score === 0) return [{ intent: "all", score: 0 }]

  return active
}

// ─── Evidence merging ────────────────────────────────────────────────────────

function mergeEvidence(
  graph: IntermediateExecutionGraph,
  intents: string[],
  top: ReturnType<typeof explain>[0] | undefined
): EvidenceItem[] {
  const seen = new Set<string>()
  const merged: EvidenceItem[] = []

  for (const intent of intents) {
    const items = selectEvidenceByIntent(graph, intent as EvidencePackage["intent"], top)
    for (const item of items) {
      if (!seen.has(item.nodeId)) {
        seen.add(item.nodeId)
        merged.push(item)
      }
    }
  }

  return merged
}
