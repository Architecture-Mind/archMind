import type { LLMResponse } from "@kidkender/archmind-llm-client"
import type { GoldenConvTurnExpected } from "./golden-conversation.js"

export interface ConvTurnScore {
  turn: number
  query: string
  finding_type_pass: boolean | null
  severity_pass: boolean | null
  explanation_coverage: number
  recommendation_coverage: number
  combined_score: number
  passed: boolean
  missing_explanation: string[]
  missing_recommendation_groups: string[][]
}

export interface ConversationScore {
  golden_id: string
  entrypoint: string
  turn_scores: ConvTurnScore[]
  avg_combined_score: number
  all_passed: boolean
}

function containsPhrase(text: string, phrase: string): boolean {
  return text.toLowerCase().includes(phrase.toLowerCase())
}

function scoreTurn(
  turnIndex: number,
  query: string,
  expected: GoldenConvTurnExpected,
  response: LLMResponse
): ConvTurnScore {
  const finding_type_pass =
    expected.finding_type != null
      ? response.finding_type.toLowerCase() === expected.finding_type.toLowerCase()
      : null

  const severity_pass =
    expected.severity != null
      ? response.severity.toLowerCase() === expected.severity.toLowerCase()
      : null

  const requiredPhrases = expected.explanation_must_contain ?? []
  const missingExplanation = requiredPhrases.filter(
    (p) => !containsPhrase(response.explanation, p)
  )
  const explanation_coverage =
    requiredPhrases.length > 0
      ? (requiredPhrases.length - missingExplanation.length) / requiredPhrases.length
      : 1

  const recText = response.recommendations.join(" ")
  const requiredGroups = expected.recommendations_must_contain ?? []
  const missingGroups = requiredGroups.filter(
    (group) => !group.some((p) => containsPhrase(recText, p))
  )
  const recommendation_coverage =
    requiredGroups.length > 0
      ? (requiredGroups.length - missingGroups.length) / requiredGroups.length
      : 1

  // Simpler weighting for turn scores — explanation is the main signal
  const combined_score =
    (finding_type_pass == null ? 1 : finding_type_pass ? 1 : 0) * 0.25 +
    (severity_pass == null ? 1 : severity_pass ? 1 : 0) * 0.15 +
    explanation_coverage * 0.40 +
    recommendation_coverage * 0.20

  return {
    turn: turnIndex + 1,
    query,
    finding_type_pass,
    severity_pass,
    explanation_coverage,
    recommendation_coverage,
    combined_score,
    passed: combined_score >= 0.65,
    missing_explanation: missingExplanation,
    missing_recommendation_groups: missingGroups,
  }
}

export function scoreConversation(
  goldenId: string,
  entrypoint: string,
  turns: Array<{ query: string; expected: GoldenConvTurnExpected }>,
  responses: LLMResponse[]
): ConversationScore {
  const turn_scores = turns.map((t, i) => scoreTurn(i, t.query, t.expected, responses[i]))
  const avg_combined_score =
    turn_scores.reduce((sum, s) => sum + s.combined_score, 0) / (turn_scores.length || 1)

  return {
    golden_id: goldenId,
    entrypoint,
    turn_scores,
    avg_combined_score,
    all_passed: turn_scores.every((s) => s.passed),
  }
}
