import type { LLMResponse, JudgeClient } from "@kidkender/archmind-llm-client"
import type { GoldenAnswer } from "./golden-answer.js"
import type { AnswerScore, FieldScore, KeyphraseScore } from "./answer-scorer.js"
import { scoreAnswer } from "./answer-scorer.js"

const JUDGE_SYSTEM = `You are a code review quality evaluator. Your job is to judge whether a given explanation semantically covers specific security concepts. Answer only with valid JSON.`

async function judgeExplanationCoverage(
  explanation: string,
  requiredConcepts: string[],
  judgeClient: JudgeClient
): Promise<KeyphraseScore> {
  if (requiredConcepts.length === 0) {
    return { total: 0, matched: 0, coverage: 1, missing: [] }
  }

  const prompt = `Does the following security finding explanation semantically cover ALL of these concepts?

Concepts to check:
${requiredConcepts.map((c, i) => `${i + 1}. "${c}"`).join("\n")}

Explanation:
"""
${explanation.slice(0, 2000)}
"""

For each concept, answer true if the explanation addresses it meaningfully (even with different wording), false if it is missing or only trivially mentioned.

Respond with JSON only:
{"covered": [true_or_false_per_concept_in_order]}`

  let covered: boolean[] = requiredConcepts.map(() => false)
  try {
    const raw = await judgeClient.judge(JUDGE_SYSTEM, prompt)
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0]) as { covered?: unknown[] }
      if (Array.isArray(parsed.covered)) {
        covered = parsed.covered.map((v) => v === true)
      }
    }
  } catch {
    // fall back to all-false on parse error
  }

  const matched = covered.filter(Boolean).length
  const missing = requiredConcepts.filter((_, i) => !covered[i])
  return {
    total: requiredConcepts.length,
    matched,
    coverage: requiredConcepts.length > 0 ? matched / requiredConcepts.length : 1,
    missing,
  }
}

async function judgeFindingType(
  expected: string,
  actual: string,
  judgeClient: JudgeClient
): Promise<FieldScore> {
  const exactPass = actual.toLowerCase() === expected.toLowerCase()
  if (exactPass) return { pass: true, expected, actual }

  const prompt = `Are these two security finding types semantically equivalent or close enough that a developer would consider them to describe the same issue?

Expected: "${expected}"
Actual: "${actual}"

Respond with JSON only: {"equivalent": true_or_false}`

  try {
    const raw = await judgeClient.judge(JUDGE_SYSTEM, prompt)
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0]) as { equivalent?: unknown }
      return { pass: parsed.equivalent === true, expected, actual }
    }
  } catch {
    // fall back to exact match result
  }
  return { pass: false, expected, actual }
}

const WEIGHTS = {
  finding_type: 0.30,
  severity: 0.15,
  key_nodes: 0.25,
  explanation: 0.20,
  recommendations: 0.10,
}

export async function scoreAnswerWithJudge(
  golden: GoldenAnswer,
  response: LLMResponse,
  judgeClient: JudgeClient
): Promise<AnswerScore> {
  const base = scoreAnswer(golden, response)

  // Re-score finding_type and explanation using LLM judge
  const finding_type = await judgeFindingType(
    golden.expected_response.finding_type,
    response.finding_type,
    judgeClient
  )

  const explanation = await judgeExplanationCoverage(
    response.explanation,
    golden.expected_response.explanation_must_contain,
    judgeClient
  )

  const combined_score =
    (finding_type.pass ? 1 : 0) * WEIGHTS.finding_type +
    (base.severity.pass ? 1 : 0) * WEIGHTS.severity +
    base.key_nodes.recall * WEIGHTS.key_nodes +
    explanation.coverage * WEIGHTS.explanation +
    base.recommendations.coverage * WEIGHTS.recommendations

  return {
    ...base,
    finding_type,
    explanation,
    combined_score,
    passed: combined_score >= 0.7,
  }
}
