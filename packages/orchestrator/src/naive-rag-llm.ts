import type { LLMClient, LLMCallResult } from "@kidkender/archmind-llm-client"
import type { NaiveRagResult } from "@kidkender/archmind-retrieval"

const SYSTEM = `You are a security code reviewer for Laravel PHP applications. \
Analyze the provided PHP source code and answer the security question. \
Base your answer ONLY on the source files shown. Do NOT invent details not present in the code.`

const OUTPUT_INSTRUCTIONS = `Respond with a JSON object matching this schema exactly:

{
  "finding_type": "<one of: missing_authorization | delegated_validation | duplicate_authorization | double_permission_check | missing_tenant_scope | event_before_commit | unknown>",
  "severity": "<CRITICAL | HIGH | MEDIUM | LOW>",
  "confidence": "<HIGH | MEDIUM | LOW>",
  "explanation": "<markdown string — 2-4 paragraphs, developer-audience>",
  "key_nodes": ["<ClassName::method or middleware name>", ...],
  "recommendations": ["<actionable fix>", ...],
  "uncertainty": "<null or one sentence if uncertain>"
}

Rules:
- "finding_type" MUST be exactly one of the listed types.
- "key_nodes" must be class/method names from the source code shown.
- Write explanation for a senior developer.`

function buildNaivePrompt(content: string, query: string): string {
  return `User question:\n"${query}"\n\nSource files:\n\`\`\`php\n${content}\n\`\`\``
}


export async function callNaiveRagLLM(
  naive: NaiveRagResult,
  query: string,
  llmClient: LLMClient
): Promise<LLMCallResult> {
  return llmClient.call({
    system: SYSTEM,
    user: buildNaivePrompt(naive.content, query),
    output_instructions: OUTPUT_INSTRUCTIONS,
  })
}
