import type { LLMResponse } from "@kidkender/archmind-llm-client"
import type { GoldenAnswer } from "./golden-answer.js"

export interface FieldScore {
  pass: boolean
  expected: string
  actual: string
}

export interface KeynodeScore {
  total: number
  matched: number
  recall: number
  missing: string[]
}

export interface KeyphraseScore {
  total: number
  matched: number
  coverage: number
  missing: string[]
}

export interface RecommendationScore {
  total_groups: number
  matched_groups: number
  coverage: number
  missing_groups: string[][]
}

export interface AnswerScore {
  golden_id: string
  entrypoint: string
  finding_type: FieldScore
  severity: FieldScore
  key_nodes: KeynodeScore
  explanation: KeyphraseScore
  recommendations: RecommendationScore
  // Combined score: weighted average of pass rates
  combined_score: number
  passed: boolean
}

const WEIGHTS = {
  finding_type: 0.30,
  severity: 0.15,
  key_nodes: 0.25,
  explanation: 0.20,
  recommendations: 0.10,
}

function containsPhrase(text: string, phrase: string): boolean {
  return text.toLowerCase().includes(phrase.toLowerCase())
}

function scoreKeyNodes(golden: string[], actual: string[]): KeynodeScore {
  const actualSet = new Set(actual.map((s) => s.toLowerCase()))
  const missing: string[] = []
  let matched = 0
  for (const node of golden) {
    if (actualSet.has(node.toLowerCase())) {
      matched++
    } else {
      missing.push(node)
    }
  }
  return {
    total: golden.length,
    matched,
    recall: golden.length > 0 ? matched / golden.length : 1,
    missing,
  }
}

function scoreExplanation(required: string[], explanation: string): KeyphraseScore {
  const missing: string[] = []
  let matched = 0
  for (const phrase of required) {
    if (containsPhrase(explanation, phrase)) {
      matched++
    } else {
      missing.push(phrase)
    }
  }
  return {
    total: required.length,
    matched,
    coverage: required.length > 0 ? matched / required.length : 1,
    missing,
  }
}

function scoreRecommendations(
  groups: string[][],
  recommendations: string[]
): RecommendationScore {
  const recText = recommendations.join(" ")
  const missingGroups: string[][] = []
  let matchedGroups = 0
  for (const group of groups) {
    const hit = group.some((phrase) => containsPhrase(recText, phrase))
    if (hit) {
      matchedGroups++
    } else {
      missingGroups.push(group)
    }
  }
  return {
    total_groups: groups.length,
    matched_groups: matchedGroups,
    coverage: groups.length > 0 ? matchedGroups / groups.length : 1,
    missing_groups: missingGroups,
  }
}

export function scoreAnswer(golden: GoldenAnswer, response: LLMResponse): AnswerScore {
  const exp = golden.expected_response

  const finding_type: FieldScore = {
    pass: response.finding_type.toLowerCase() === exp.finding_type.toLowerCase(),
    expected: exp.finding_type,
    actual: response.finding_type,
  }

  const severity: FieldScore = {
    pass: response.severity.toLowerCase() === exp.severity.toLowerCase(),
    expected: exp.severity,
    actual: response.severity,
  }

  const key_nodes = scoreKeyNodes(exp.key_nodes, response.key_nodes)
  const explanation = scoreExplanation(exp.explanation_must_contain, response.explanation)
  const recommendations = scoreRecommendations(
    exp.recommendations_must_contain,
    response.recommendations
  )

  const combined_score =
    (finding_type.pass ? 1 : 0) * WEIGHTS.finding_type +
    (severity.pass ? 1 : 0) * WEIGHTS.severity +
    key_nodes.recall * WEIGHTS.key_nodes +
    explanation.coverage * WEIGHTS.explanation +
    recommendations.coverage * WEIGHTS.recommendations

  return {
    golden_id: golden.id,
    entrypoint: golden.entrypoint,
    finding_type,
    severity,
    key_nodes,
    explanation,
    recommendations,
    combined_score,
    passed: combined_score >= 0.7,
  }
}
