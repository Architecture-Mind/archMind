import type { IntermediateExecutionGraph, ConversationTurn, QueryMode } from "@kidkender/archmind-protocol"
import type { Finding } from "@kidkender/archmind-explainer"
import { serializeExecutionPath } from "./serialize-graph.js"
import { serializeFindings } from "./serialize-findings.js"
import { detectContradictions, serializeContradictions } from "./detect-contradictions.js"

export interface PromptInput {
  query: string
  graph: IntermediateExecutionGraph
  findings: Finding[]
  history?: ConversationTurn[]
  mode?: QueryMode
  projectRoot?: string
}

export interface BuiltPrompt {
  system: string
  user: string
  output_instructions: string
}

const SYSTEM_BY_MODE: Record<QueryMode, string> = {
  review:
    `You are a semantic code reasoning engine. You explain execution flow and \
security findings based ONLY on the structured context provided below. \
Do NOT infer relationships not explicitly listed. Do NOT reference source \
code not shown. If uncertain, say so.`,

  teach:
    `You are a patient senior engineer explaining a codebase to a junior developer. \
Use the structured context provided — do NOT invent details. \
Explain concepts step by step with analogies where helpful. \
Assume the reader is unfamiliar with the execution path but understands basic PHP/web concepts.`,

  debug:
    `You are a terse debugging assistant. Focus on root cause only. \
Use the structured context provided — do NOT invent details. \
Skip policy background and "why it matters" prose. \
Answer the question directly: what is broken, where, and the minimal fix.`,
}

const OUTPUT_INSTRUCTIONS_BY_MODE: Record<QueryMode, string> = {
  review: `Respond with a JSON object matching this schema exactly:

{
  "finding_type": "<string describing the issue type — e.g. missing_authorization, race_condition, transaction_leak, stale_cache, or any type that accurately names the problem>",
  "severity": "<CRITICAL | HIGH | MEDIUM | LOW>",
  "confidence": "<HIGH | MEDIUM | LOW>",
  "explanation": "<markdown string — 2-4 paragraphs, developer-audience>",
  "key_nodes": ["<symbol>", ...],
  "recommendations": ["<actionable fix>", ...],
  "uncertainty": "<null or one sentence if uncertain>"
}

Rules:
- "finding_type" should name the real issue found — do NOT invent vague types, but DO name types the detector list above missed if you see them in the code.
- "key_nodes" must be the exact identifier shown first on each node line in the Execution path section (e.g. "auth:sanctum", "OrderController::store" — not the bracketed type label).
- Write explanation for a senior developer reading a PR review.
- First paragraph: what the finding is and where it occurs.
- Second paragraph: why it matters.
- Third paragraph (optional): when it is acceptable.
- If source code snippets are shown, reason about the actual implementation — not just the graph structure.`,

  teach: `Respond with a JSON object matching this schema exactly:

{
  "finding_type": "<string describing the issue type — e.g. missing_authorization, race_condition, or any type that accurately names the problem>",
  "severity": "<CRITICAL | HIGH | MEDIUM | LOW>",
  "confidence": "<HIGH | MEDIUM | LOW>",
  "explanation": "<markdown string — 3-5 paragraphs, teaching style with step-by-step breakdown>",
  "key_nodes": ["<symbol>", ...],
  "recommendations": ["<actionable fix with brief why>", ...],
  "uncertainty": "<null or one sentence if uncertain>"
}

Rules:
- "finding_type" should name the real issue — go beyond the detector list if the code shows something else.
- "key_nodes" must be the exact identifier shown first on each node line in the Execution path section (e.g. "auth:sanctum", "OrderController::store" — not the bracketed type label).
- Write for a junior developer — explain what each node does before explaining the problem.
- Use numbered steps or analogies to clarify execution order.
- If source code snippets are shown, walk through the actual code.`,

  debug: `Respond with a JSON object matching this schema exactly:

{
  "finding_type": "<string describing the issue type — e.g. missing_authorization, race_condition, or any type that accurately names the problem>",
  "severity": "<CRITICAL | HIGH | MEDIUM | LOW>",
  "confidence": "<HIGH | MEDIUM | LOW>",
  "explanation": "<markdown string — 1-2 paragraphs max, direct and terse>",
  "key_nodes": ["<symbol>", ...],
  "recommendations": ["<minimal fix — one line each>", ...],
  "uncertainty": "<null or one sentence if uncertain>"
}

Rules:
- "finding_type" should name the real issue — be specific.
- "key_nodes" must be the exact identifier shown first on each node line in the Execution path section (e.g. "auth:sanctum", "OrderController::store" — not the bracketed type label).
- Be terse: state the root cause, name the node, state the fix. Nothing more.
- If source code snippets are shown, cite exact line or pattern that's wrong.`,
}

function serializeConversationHistory(history: ConversationTurn[]): string {
  if (history.length === 0) return ""
  const lines: string[] = ["Prior conversation turns:"]
  for (const [i, turn] of history.entries()) {
    lines.push(`\n[Turn ${i + 1}]`)
    lines.push(`Q: ${turn.query}`)
    lines.push(`Finding: ${turn.response.finding_type} (${turn.response.severity})`)
    lines.push(`A: ${turn.response.explanation.slice(0, 400)}${turn.response.explanation.length > 400 ? "…" : ""}`)
  }
  return lines.join("\n")
}

function serializeUncertainty(findings: Finding[]): string {
  const reasons = findings.flatMap((f) => f.uncertainty ?? [])
  if (reasons.length === 0) return ""
  const lines = reasons.map((u) => `- ${u.description}`)
  return `Uncertainty notes:\n${lines.join("\n")}`
}

export function buildPrompt(input: PromptInput): BuiltPrompt {
  const { query, graph, findings, history, mode = "review", projectRoot } = input

  const executionSection = serializeExecutionPath(graph, projectRoot)
  const findingsSection = serializeFindings(findings)
  const uncertaintySection = serializeUncertainty(findings)
  const historySection = history && history.length > 0 ? serializeConversationHistory(history) : ""
  const contradictionSection = serializeContradictions(detectContradictions(findings))

  const userParts: string[] = [
    `User question:\n"${query}"`,
    executionSection,
  ]
  if (historySection) userParts.push(historySection)
  if (findingsSection) userParts.push(findingsSection)
  if (contradictionSection) userParts.push(contradictionSection)
  if (uncertaintySection) userParts.push(uncertaintySection)

  return {
    system: SYSTEM_BY_MODE[mode],
    user: userParts.join("\n\n"),
    output_instructions: OUTPUT_INSTRUCTIONS_BY_MODE[mode],
  }
}
