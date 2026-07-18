#!/usr/bin/env node
// Ad-hoc QA accuracy benchmark for the two Spring Boot repos whose route
// extraction just got fixed (SpringBlade multi-module scanner, spring-boot-admin
// custom-stereotype detection). Mirrors run-llm-comparison.ts's methodology:
// Mode A = naive raw-source dump, Mode B = buildEvidencePackage(), scored by
// an LLM judge against a hand-written ground truth.

import { join } from "path"
import { readFileSync, existsSync, writeFileSync } from "fs"
import OpenAI from "openai"

const REPO_ROOT = "/home/ducnh/Desktop/DuckCode/Project/archMind"

const { parseSpringBootProject } = await import(join(REPO_ROOT, "packages/springboot-parser/dist/index.js"))
const { buildEvidencePackage } = await import(join(REPO_ROOT, "packages/explainer/dist/index.js"))

const envPath = join(REPO_ROOT, ".env")
for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini"
const JUDGE = "gpt-4o"

const QUESTION = "Can an unauthenticated (guest) user successfully call this endpoint? Separately: is there any authorization check beyond basic authentication required to use it?"

const CASES = [
  {
    id: "SPRINGBLADE-USER-001",
    project: "/home/ducnh/Desktop/DuckCode/TestFolder/SpringBlade",
    entrypoint: "GET /user/detail",
    sourceFile: "blade-service/blade-system/src/main/java/org/springblade/system/controller/UserController.java",
    golden_answer: "NO guest access; extra authorization IS required. The method carries @PreAuth(RoleConstant.HAS_ROLE_ADMIN) — a SpringBlade-custom annotation (org.springblade.core.secure.annotation.PreAuth), not Spring Security's standard @PreAuthorize. It requires an authenticated caller with the ADMIN role.",
  },
  {
    id: "SPRINGBLADE-LOGAPI-001",
    project: "/home/ducnh/Desktop/DuckCode/TestFolder/SpringBlade",
    entrypoint: "GET /api/detail",
    sourceFile: "blade-service/blade-log/src/main/java/org/springblade/core/log/controller/LogApiController.java",
    golden_answer: "NO guest access; extra authorization IS required. @PreAuth(RoleConstant.HAS_ROLE_ADMIN) gates this method — requires an authenticated ADMIN-role caller, same custom SpringBlade annotation as UserController.",
  },
  {
    id: "SPRINGBOOTADMIN-APPS-001",
    project: "/home/ducnh/Desktop/DuckCode/TestFolder/spring-boot-admin",
    entrypoint: "GET /applications",
    sourceFile: "spring-boot-admin-server/src/main/java/de/codecentric/boot/admin/server/web/ApplicationsController.java",
    golden_answer: "YES, guest access is allowed; NO extra authorization. spring-boot-admin-server ships with no built-in Spring Security config in this module — the class uses only the custom @AdminController marker + @ResponseBody, no @PreAuthorize/@Secured/@RolesAllowed and no SecurityFilterChain in this source tree. Auth is opt-in and configured downstream by the consuming application, not present here.",
  },
  {
    id: "SPRINGBOOTADMIN-APPS-002",
    project: "/home/ducnh/Desktop/DuckCode/TestFolder/spring-boot-admin",
    entrypoint: "DELETE /applications/{name}",
    sourceFile: "spring-boot-admin-server/src/main/java/de/codecentric/boot/admin/server/web/ApplicationsController.java",
    golden_answer: "YES, guest access is allowed; NO extra authorization. Same controller/module as GET /applications — no security annotations or filter chain present in this source tree; deregistering an application is unauthenticated by default in this library code.",
  },
]

function buildNaivePrompt(question, sourceFile, projectRoot, entrypoint) {
  const src = readFileSync(join(projectRoot, sourceFile), "utf-8")
  return `You are a Java/Spring Boot security expert. Answer the following question about this endpoint.

Endpoint: ${entrypoint}
Source file (${sourceFile}):
\`\`\`java
${src}
\`\`\`

Question: ${question}

Answer concisely and accurately based on the source above.`
}

function buildArchmindPrompt(question, pkg) {
  const sortedFacts = [...pkg.facts].sort((a, b) => {
    const tier = { high: 0, medium: 1, low: 2 }
    const t = tier[a.relevance] - tier[b.relevance]
    if (t !== 0) return t
    return (b.present ? 1 : 0) - (a.present ? 1 : 0)
  })
  const factsText = sortedFacts.map((f) => {
    const mark = f.present ? "✓" : "✗"
    const val = f.value ? ` = ${f.value}` : ""
    return `  ${mark} ${f.type}${val}`
  }).join("\n")

  const evidenceList = pkg.evidence.map((e) => {
    const detail = e.detail ? ` | ${e.detail}` : ""
    return `- [${e.role}] ${e.symbol}${detail}`
  }).join("\n")

  const path = pkg.execution_path
  const pathText = path.length ? path.join(" → ") : "(unavailable)"

  return `You are a Java/Spring Boot security expert. Answer the following question using the structured evidence below.

Question: ${question}
Intent: ${pkg.intent}

Facts (✓ = present, ✗ = absent):
${factsText}

Execution path: ${pathText}

Execution nodes:
${evidenceList}

Answer concisely and accurately. Use the facts above — do not invent information not supported by the evidence.`
}

function buildJudgePrompt(question, goldenAnswer, candidateAnswer) {
  return `You are an expert code reviewer evaluating an answer about Spring Boot endpoint security.

Question: ${question}

Golden Answer (ground truth):
${goldenAnswer}

Candidate Answer:
${candidateAnswer}

Rate the candidate answer from 0.0 to 1.0 based on:
- Factual accuracy (does it correctly answer guest-access and extra-authorization?)
- Completeness (does it cover the key points in the golden answer?)
- Specificity (does it mention specific annotations/classes where relevant?)

Respond ONLY with a JSON object:
{"score": <0.0 to 1.0>, "reasoning": "<one sentence>"}`
}

async function callLLM(prompt, model) {
  const start = Date.now()
  const response = await client.chat.completions.create({
    model,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  })
  return {
    answer: response.choices[0]?.message?.content ?? "",
    prompt_tokens: response.usage?.prompt_tokens ?? 0,
    completion_tokens: response.usage?.completion_tokens ?? 0,
    latency_ms: Date.now() - start,
  }
}

async function callJudge(question, goldenAnswer, candidateAnswer) {
  const prompt = buildJudgePrompt(question, goldenAnswer, candidateAnswer)
  const result = await callLLM(prompt, JUDGE)
  try {
    const parsed = JSON.parse(result.answer.match(/\{[\s\S]*\}/)?.[0] ?? "{}")
    return { score: Math.min(1, Math.max(0, Number(parsed.score) || 0)), reasoning: String(parsed.reasoning || "") }
  } catch {
    return { score: 0, reasoning: "judge parse error" }
  }
}

const projectCache = new Map()
function graphsFor(projectRoot) {
  if (!projectCache.has(projectRoot)) {
    projectCache.set(projectRoot, parseSpringBootProject(projectRoot))
  }
  return projectCache.get(projectRoot)
}

const results = []

for (const c of CASES) {
  console.log(`\n[${c.id}] ${c.entrypoint}`)
  const graphs = graphsFor(c.project)
  const graph = graphs.find((g) => g.entrypoint?.toLowerCase() === c.entrypoint.toLowerCase())
  if (!graph) {
    console.log(`  SKIP: no graph found for ${c.entrypoint} (routes_found=${graphs.length})`)
    continue
  }

  const promptA = buildNaivePrompt(QUESTION, c.sourceFile, c.project, c.entrypoint)
  const resultA = await callLLM(promptA, MODEL)
  const judgeA = await callJudge(QUESTION, c.golden_answer, resultA.answer)

  const pkg = buildEvidencePackage(QUESTION, graph)
  const promptB = buildArchmindPrompt(QUESTION, pkg)
  const resultB = await callLLM(promptB, MODEL)
  const judgeB = await callJudge(QUESTION, c.golden_answer, resultB.answer)

  console.log(`  Baseline (raw source): score=${judgeA.score.toFixed(2)} tokens=${resultA.prompt_tokens}  ${judgeA.reasoning}`)
  console.log(`  ArchMind (evidence):   score=${judgeB.score.toFixed(2)} tokens=${resultB.prompt_tokens}  ${judgeB.reasoning}`)
  console.log(`  archmind answer: ${resultB.answer.replace(/\n/g, " ").slice(0, 200)}`)

  results.push({
    id: c.id, entrypoint: c.entrypoint, golden_answer: c.golden_answer,
    baseline: { answer: resultA.answer, tokens: resultA.prompt_tokens, score: judgeA.score, reasoning: judgeA.reasoning },
    archmind: { answer: resultB.answer, tokens: resultB.prompt_tokens, score: judgeB.score, reasoning: judgeB.reasoning },
  })
}

const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
console.log("\n=== Summary ===")
console.log(`  avg_score_baseline = ${avg(results.map(r => r.baseline.score)).toFixed(3)}`)
console.log(`  avg_score_archmind = ${avg(results.map(r => r.archmind.score)).toFixed(3)}`)
console.log(`  avg_tokens_baseline = ${avg(results.map(r => r.baseline.tokens)).toFixed(0)}`)
console.log(`  avg_tokens_archmind = ${avg(results.map(r => r.archmind.tokens)).toFixed(0)}`)

writeFileSync(join(REPO_ROOT, "research/springboot-postfix-qa-results.json"), JSON.stringify(results, null, 2))
console.log(`\nSaved: research/springboot-postfix-qa-results.json`)
