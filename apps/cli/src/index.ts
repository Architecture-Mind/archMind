import { parseConstantClass, parseRouteFile, augmentGraph } from "@archmind/laravel-parser"
import { loadGoldenTrace, scoreTrace } from "@archmind/scorer"
import { ClaudeLLMClient, MockLLMClient, OpenAILLMClient } from "@archmind/llm-client"
import { Orchestrator, runAnswerBenchmark, runConversationBenchmark } from "@archmind/orchestrator"
import type { ConversationContext, QueryMode } from "@archmind/orchestrator"
import { resolve, dirname, relative } from "path"
import { writeFileSync } from "fs"
import { createInterface } from "readline"
import { runTrace as runTraceProject } from "./commands/trace.js"
import { runVerify } from "./commands/verify.js"
import { runFindings } from "./commands/findings.js"
import { runDeps } from "./commands/deps.js"
import { runBaseline } from "./commands/baseline.js"
import { runDiff } from "./commands/diff.js"
import { runBenchmark } from "./commands/benchmark.js"
import { runQuery } from "./commands/query.js"
import { runContext } from "./commands/context.js"
import { runSnapshot } from "./commands/snapshot.js"
import { runHistory } from "./commands/history.js"
import { runExplain } from "./commands/explain.js"
import { runVisualize } from "./commands/visualize.js"

function parseFlags(rawArgs: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {}
  const positional: string[] = []
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i].startsWith("--")) {
      const key = rawArgs[i].slice(2)
      const next = rawArgs[i + 1]
      if (next && !next.startsWith("--")) {
        flags[key] = next
        i++
      } else {
        flags[key] = ""
      }
    } else {
      positional.push(rawArgs[i])
    }
  }
  return { flags, positional }
}

function main(): void {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === "--help" || command === "-h") {
    console.log([
      "",
      "archmind — execution topology intelligence for Laravel and NestJS",
      "",
      "Deterministic commands (no LLM required):",
      "  archmind trace     --project <path> [\"METHOD /route\"] [--json]            Show execution graph",
      "  archmind verify    --project <path> [--label <n>] [--update]              Topology regression check",
      "                     --baseline-dir <path>                                   Override baseline storage dir",
      "  archmind diff      --project <path> [--label <n>] [--format text|markdown|json]  Topology diff (PR-ready)",
      "  archmind findings  --project <path> [\"METHOD /route\"] [--json]            List static findings",
      "  archmind deps      --project <path> <ServiceClass>                        Cross-route impact",
      "  archmind baseline  update|verify --project <path>                         Manage baseline",
      "                     --baseline-dir <path>                                   Default: <project>/.archmind/baselines",
      "  archmind benchmark --project <path> --pains-dir <dir>                     Run semantic-pain benchmark",
      "                     [--id <LARAVEL-AUTH-001>] [--framework laravel|nestjs]",
      "                     [--output results.json] [--explain]",
      "  archmind query     --project <path> \"<AQL>\"                               Architecture Query Language",
      "                     e.g. \"FIND routes WHERE auth AND NOT transaction\"",
      "  archmind context   --project <path> [\"METHOD /route\"] [--json]            AI semantic context for a route",
      "  archmind snapshot  --project <path> [--label <n>]                         Save timestamped topology snapshot",
      "  archmind history   --project <path> \"METHOD /route\"                       Route topology timeline",
      "                     --list                                                  List all snapshots",
      "                     --diff --from <id> --to <id>                           Diff two snapshots",
      "  archmind explain   --project <path> --route \"METHOD /path\"                Show execution path + findings",
      "                     --project <path> --finding <type>                       All routes with this finding",
      "  archmind visualize --project <path> [--output report.html] [--open]        Execution Timeline HTML report",
      "",
      "  Frameworks: Laravel (auto-detected via composer.json / artisan)",
      "              NestJS  (auto-detected via package.json / nest-cli.json)",
      "",
      "Research/eval commands (require API key):",
      "  archmind query    <routes-file> --ask \"<question>\" --entrypoint \"METHOD /path\"",
      "  archmind chat     <routes-file> --entrypoint \"METHOD /path\"",
      "  archmind score    <routes-file> --golden <yaml-file>",
      "  archmind benchmark-answers <routes-file> --golden-answers <dir>",
      "  archmind benchmark-convs   <routes-file> --golden-convs <dir>",
      "",
      "  ANTHROPIC_API_KEY required for query/chat/benchmark (Claude, default).",
      "  OPENAI_API_KEY required when --openai flag is used.",
    ].join("\n"))
    process.exit(0)
  }

  const { flags, positional } = parseFlags(args.slice(1))

  // ---- Deterministic commands (no LLM) ------------------------------------

  if (command === "trace" && ("project" in flags)) {
    runTraceProject(flags, positional)
    return
  }

  if (command === "verify") {
    runVerify(flags).catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(2)
    })
    return
  }

  if (command === "findings") {
    runFindings(flags, positional)
    return
  }

  if (command === "deps") {
    runDeps(flags, positional)
    return
  }

  if (command === "baseline") {
    runBaseline(positional[0], flags)
    return
  }

  if (command === "diff") {
    runDiff(flags).catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(2)
    })
    return
  }

  if (command === "benchmark") {
    runBenchmark(flags).catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(2)
    })
    return
  }

  if (command === "query") {
    runQuery(flags, positional)
    return
  }

  if (command === "context") {
    runContext(flags, positional)
    return
  }

  if (command === "snapshot") {
    runSnapshot(flags)
    return
  }

  if (command === "history") {
    runHistory(flags, positional)
    return
  }

  if (command === "explain") {
    runExplain(flags)
    return
  }

  if (command === "visualize") {
    runVisualize(flags).catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(2)
    })
    return
  }

  // ---- Legacy research commands (keep working) ----------------------------

  if (command === "trace") {
    runTrace(args.slice(1))
  } else if (command === "score") {
    runScore(args.slice(1))
  } else if (command === "query") {
    runQuery(args.slice(1)).catch((err: unknown) => {
      console.error("Error:", err instanceof Error ? err.message : String(err))
      process.exit(1)
    })
  } else if (command === "chat") {
    runChat(args.slice(1)).catch((err: unknown) => {
      console.error("Error:", err instanceof Error ? err.message : String(err))
      process.exit(1)
    })
  } else if (command === "benchmark-answers") {
    runBenchmarkAnswers(args.slice(1)).catch((err: unknown) => {
      console.error("Error:", err instanceof Error ? err.message : String(err))
      process.exit(1)
    })
  } else if (command === "benchmark-convs") {
    runBenchmarkConvs(args.slice(1)).catch((err: unknown) => {
      console.error("Error:", err instanceof Error ? err.message : String(err))
      process.exit(1)
    })
  } else {
    console.error(`Unknown command: ${command}`)
    process.exit(1)
  }
}

function parseLegacyFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1] ?? ""
      i++
    } else if (!flags["_"]) {
      flags["_"] = args[i]
    }
  }
  return flags
}

function runTrace(args: string[]): void {
  const flags = parseLegacyFlags(args)
  if (!flags["_"]) { console.error("Missing routes file"); process.exit(1) }

  const routesFile = resolve(flags["_"])
  const constants  = flags["constants"] ? parseConstantClass(resolve(flags["constants"])) : undefined
  const graphs     = parseRouteFile(routesFile, { constants })
  const result     = { routes_found: graphs.length, graphs }
  const json       = JSON.stringify(result, null, 2)

  if (flags["out"]) {
    writeFileSync(resolve(flags["out"]), json, "utf-8")
    console.log(`Wrote ${graphs.length} route(s) to ${flags["out"]}`)
  } else {
    console.log(json)
  }
}

function runScore(args: string[]): void {
  const flags = parseLegacyFlags(args)
  if (!flags["_"])      { console.error("Missing routes file"); process.exit(1) }
  if (!flags["golden"]) { console.error("Missing --golden <yaml-file>"); process.exit(1) }

  const routesFile = resolve(flags["_"])
  const goldenFile = resolve(flags["golden"])
  const constants  = flags["constants"] ? parseConstantClass(resolve(flags["constants"])) : undefined

  const graphs = parseRouteFile(routesFile, { constants })
  const golden = loadGoldenTrace(goldenFile)
  const report = scoreTrace(golden, graphs)

  console.log(`\n=== ${report.golden_id} ===`)
  console.log(`Entrypoint : ${report.entrypoint}`)
  console.log(`Route found: ${report.route_found ? "YES" : "NO"}`)

  if (report.route_found) {
    const s = report.skeleton
    console.log(`\nSkeleton recall: ${(s.recall * 100).toFixed(0)}% (${s.matched}/${s.total} nodes)`)
    console.log(`Edge recall    : ${(report.edge_recall * 100).toFixed(0)}%`)

    console.log("\nNode matches:")
    for (const m of s.matches) {
      const status = m.extracted_id ? `✓ ${m.extracted_id}  [${m.match_reason}]` : "✗ not found"
      console.log(`  ${m.golden_id.padEnd(28)} → ${status}`)
    }

    if (report.deeper.total > 0) {
      console.log(`\nDeeper nodes (${report.deeper.total}) — ${report.deeper.reason}:`)
      console.log(`  ${report.deeper.nodes.join(", ")}`)
    }
  }

  console.log(`\n${report.summary}`)
}

function parseMode(flags: Record<string, string>): QueryMode {
  const raw = flags["mode"]
  if (raw === "teach" || raw === "debug") return raw
  return "review"
}

async function runQuery(args: string[]): Promise<void> {
  const flags = parseLegacyFlags(args)
  if (!flags["_"])           { console.error("Missing routes file"); process.exit(1) }
  if (!flags["ask"])         { console.error("Missing --ask \"<question>\""); process.exit(1) }
  if (!flags["entrypoint"])  { console.error('Missing --entrypoint "METHOD /path"'); process.exit(1) }

  const routesFile  = resolve(flags["_"])
  const projectRoot = flags["project-root"] ? resolve(flags["project-root"]) : dirname(routesFile)
  const constants   = flags["constants"] ? parseConstantClass(resolve(flags["constants"])) : undefined
  const useMock    = "mock" in flags
  const useOpenAI  = "openai" in flags
  const mode       = parseMode(flags)

  const skeletons = parseRouteFile(routesFile, { constants })
  const graphs = skeletons.map((g) =>
    augmentGraph(g, { projectRoot, permissionConstantFiles: constants ? [flags["constants"]] : [] })
  )

  let llmClient
  if (useMock) {
    llmClient = new MockLLMClient()
  } else if (useOpenAI) {
    llmClient = new OpenAILLMClient({
      apiKey: process.env.OPENAI_API_KEY ?? "",
      model: flags["model"] ?? undefined,
    })
  } else {
    llmClient = new ClaudeLLMClient({
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      model: flags["model"] ?? undefined,
    })
  }

  const orc = new Orchestrator({ graphs, llmClient })

  console.log(`\nQuerying: ${flags["entrypoint"]}`)
  console.log(`Question: ${flags["ask"]}`)
  console.log(`Mode:     ${mode}\n`)

  const result = await orc.query(flags["entrypoint"], flags["ask"], undefined, mode)

  console.log("─".repeat(72))
  console.log(`Finding:      ${result.response.finding_type}`)
  console.log(`Severity:     ${result.response.severity}`)
  console.log(`Confidence:   ${result.response.confidence}`)
  console.log(`Findings:     ${result.findings_count} detected`)
  console.log(`Tokens (est): ${result.token_estimate}`)
  if (result.explanation_failed) {
    console.log("⚠  Explanation generation failed — showing raw finding")
  }
  console.log("─".repeat(72))
  console.log("\nExplanation:\n")
  console.log(result.response.explanation)

  if (result.response.recommendations.length > 0) {
    console.log("\nRecommendations:")
    for (const rec of result.response.recommendations) {
      console.log(`  • ${rec}`)
    }
  }

  if (result.response.uncertainty) {
    console.log(`\nUncertainty: ${result.response.uncertainty}`)
  }
}

async function runBenchmarkAnswers(args: string[]): Promise<void> {
  const flags = parseLegacyFlags(args)
  if (!flags["_"])              { console.error("Missing routes file"); process.exit(1) }
  if (!flags["golden-answers"]) { console.error("Missing --golden-answers <dir>"); process.exit(1) }

  const routesFile       = resolve(flags["_"])
  const goldenAnswersDir = resolve(flags["golden-answers"])
  const projectRoot      = flags["project-root"] ? resolve(flags["project-root"]) : dirname(routesFile)
  const constantsAbsPath = flags["constants"] ? resolve(flags["constants"]) : undefined
  const constants        = constantsAbsPath ? parseConstantClass(constantsAbsPath) : undefined
  const useMock          = "mock" in flags
  const useOpenAI        = "openai" in flags

  const skeletons = parseRouteFile(routesFile, { constants })
  const graphs = skeletons.map((g) =>
    augmentGraph(g, {
      projectRoot,
      permissionConstantFiles: constantsAbsPath
        ? [relative(projectRoot, constantsAbsPath)]
        : [],
    })
  )

  let llmMode: string
  let llmClient
  if (useMock) {
    llmMode = "mock"
    llmClient = new MockLLMClient()
  } else if (useOpenAI) {
    llmMode = `openai:${flags["model"] ?? "default"}`
    llmClient = new OpenAILLMClient({
      apiKey: process.env.OPENAI_API_KEY ?? "",
      model: flags["model"] ?? undefined,
    })
  } else {
    llmMode = `claude:${flags["model"] ?? "default"}`
    llmClient = new ClaudeLLMClient({
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      model: flags["model"] ?? undefined,
    })
  }

  console.log(`\nRunning answer benchmark (${llmMode})…`)
  console.log(`  Routes:         ${routesFile}`)
  console.log(`  Golden answers: ${goldenAnswersDir}\n`)

  const snapshot = await runAnswerBenchmark(graphs, llmClient, goldenAnswersDir, llmMode)

  console.log("─".repeat(72))
  for (const t of snapshot.traces) {
    const s = t.score
    const status = s.passed ? "PASS" : "FAIL"
    console.log(`[${status}] ${t.golden_id}  score=${s.combined_score.toFixed(2)}`)
    if (!s.finding_type.pass) {
      console.log(`       finding_type: expected=${s.finding_type.expected}  got=${s.finding_type.actual}`)
    }
    if (!s.severity.pass) {
      console.log(`       severity:     expected=${s.severity.expected}  got=${s.severity.actual}`)
    }
    if (s.key_nodes.missing.length > 0) {
      console.log(`       missing key_nodes: ${s.key_nodes.missing.join(", ")}`)
    }
    if (s.explanation.missing.length > 0) {
      console.log(`       missing explanation phrases: ${s.explanation.missing.join(", ")}`)
    }
    if (s.recommendations.missing_groups.length > 0) {
      console.log(`       missing recommendation groups: ${JSON.stringify(s.recommendations.missing_groups)}`)
    }
    if (t.explanation_failed) {
      console.log(`       ⚠  explanation_failed — fell back to raw detector output`)
    }
  }
  console.log("─".repeat(72))
  console.log(`\nTotal: ${snapshot.passed}/${snapshot.total} passed`)
  console.log(`Avg combined score: ${snapshot.avg_combined_score.toFixed(3)}`)

  if (flags["out"]) {
    writeFileSync(resolve(flags["out"]), JSON.stringify(snapshot, null, 2), "utf-8")
    console.log(`\nSnapshot written to ${flags["out"]}`)
  }
}

async function runBenchmarkConvs(args: string[]): Promise<void> {
  const flags = parseLegacyFlags(args)
  if (!flags["_"])            { console.error("Missing routes file"); process.exit(1) }
  if (!flags["golden-convs"]) { console.error("Missing --golden-convs <dir>"); process.exit(1) }

  const routesFile       = resolve(flags["_"])
  const goldenConvsDir   = resolve(flags["golden-convs"])
  const projectRoot      = flags["project-root"] ? resolve(flags["project-root"]) : dirname(routesFile)
  const constantsAbsPath = flags["constants"] ? resolve(flags["constants"]) : undefined
  const constants        = constantsAbsPath ? parseConstantClass(constantsAbsPath) : undefined
  const useMock          = "mock" in flags
  const useOpenAI        = "openai" in flags

  const skeletons = parseRouteFile(routesFile, { constants })
  const graphs = skeletons.map((g) =>
    augmentGraph(g, {
      projectRoot,
      permissionConstantFiles: constantsAbsPath ? [relative(projectRoot, constantsAbsPath)] : [],
    })
  )

  let llmMode: string
  let llmClient
  if (useMock) {
    llmMode = "mock"
    llmClient = new MockLLMClient()
  } else if (useOpenAI) {
    llmMode = `openai:${flags["model"] ?? "default"}`
    llmClient = new OpenAILLMClient({ apiKey: process.env.OPENAI_API_KEY ?? "", model: flags["model"] ?? undefined })
  } else {
    llmMode = `claude:${flags["model"] ?? "default"}`
    llmClient = new ClaudeLLMClient({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", model: flags["model"] ?? undefined })
  }

  console.log(`\nRunning conversation benchmark (${llmMode})…`)
  console.log(`  Routes:           ${routesFile}`)
  console.log(`  Golden convs:     ${goldenConvsDir}\n`)

  const snapshot = await runConversationBenchmark(graphs, llmClient, goldenConvsDir, llmMode)

  console.log("─".repeat(72))
  for (const entry of snapshot.entries) {
    const status = entry.score.all_passed ? "PASS" : "FAIL"
    console.log(`[${status}] ${entry.golden_id}  avg_score=${entry.score.avg_combined_score.toFixed(2)}`)
    for (const ts of entry.score.turn_scores) {
      const turnStatus = ts.passed ? "✓" : "✗"
      console.log(`       Turn ${ts.turn} ${turnStatus}  score=${ts.combined_score.toFixed(2)}  "${ts.query.slice(0, 50)}"`)
      if (ts.missing_explanation.length > 0) {
        console.log(`           missing explanation: ${ts.missing_explanation.join(", ")}`)
      }
      if (ts.missing_recommendation_groups.length > 0) {
        console.log(`           missing rec groups: ${JSON.stringify(ts.missing_recommendation_groups)}`)
      }
    }
    if (entry.explanation_failed_turns.length > 0) {
      console.log(`       ⚠  explanation_failed turns: ${entry.explanation_failed_turns.join(", ")}`)
    }
  }
  console.log("─".repeat(72))
  console.log(`\nTotal: ${snapshot.all_passed}/${snapshot.total} conversations fully passed`)
  console.log(`Avg combined score: ${snapshot.avg_combined_score.toFixed(3)}`)

  if (flags["out"]) {
    writeFileSync(resolve(flags["out"]), JSON.stringify(snapshot, null, 2), "utf-8")
    console.log(`\nSnapshot written to ${flags["out"]}`)
  }
}

async function runChat(args: string[]): Promise<void> {
  const flags = parseLegacyFlags(args)
  if (!flags["_"])          { console.error("Missing routes file"); process.exit(1) }
  if (!flags["entrypoint"]) { console.error('Missing --entrypoint "METHOD /path"'); process.exit(1) }

  const routesFile       = resolve(flags["_"])
  const projectRoot      = flags["project-root"] ? resolve(flags["project-root"]) : dirname(routesFile)
  const constantsAbsPath = flags["constants"] ? resolve(flags["constants"]) : undefined
  const constants        = constantsAbsPath ? parseConstantClass(constantsAbsPath) : undefined
  const useMock    = "mock" in flags
  const useOpenAI  = "openai" in flags
  const mode       = parseMode(flags)

  const skeletons = parseRouteFile(routesFile, { constants })
  const graphs = skeletons.map((g) =>
    augmentGraph(g, {
      projectRoot,
      permissionConstantFiles: constantsAbsPath ? [relative(projectRoot, constantsAbsPath)] : [],
    })
  )

  let llmClient
  if (useMock) {
    llmClient = new MockLLMClient()
  } else if (useOpenAI) {
    llmClient = new OpenAILLMClient({ apiKey: process.env.OPENAI_API_KEY ?? "", model: flags["model"] ?? undefined })
  } else {
    llmClient = new ClaudeLLMClient({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", model: flags["model"] ?? undefined })
  }

  const orc = new Orchestrator({ graphs, llmClient })
  const entrypoint = flags["entrypoint"]

  console.log(`\nChat session — entrypoint: ${entrypoint}  mode: ${mode}`)
  console.log(`Type your questions. Type "exit" or press Ctrl+C to quit.\n`)

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let conversation: ConversationContext | undefined

  const ask = (): void => {
    rl.question("You: ", (input: string) => {
      const query = input.trim()
      if (!query || query.toLowerCase() === "exit") {
        console.log("\nSession ended.")
        rl.close()
        return
      }

      orc.query(entrypoint, query, conversation, mode)
        .then((result) => {
          conversation = result.conversation

          console.log("\n" + "─".repeat(72))
          console.log(`Finding:    ${result.response.finding_type}  (${result.response.severity})`)
          console.log(`Confidence: ${result.response.confidence}`)
          console.log(`Turn:       ${conversation.turns.length}`)
          console.log("─".repeat(72))
          console.log("\n" + result.response.explanation)

          if (result.response.recommendations.length > 0) {
            console.log("\nRecommendations:")
            for (const rec of result.response.recommendations) {
              console.log(`  • ${rec}`)
            }
          }

          if (result.response.uncertainty) {
            console.log(`\nUncertainty: ${result.response.uncertainty}`)
          }

          console.log()
          ask()
        })
        .catch((err: unknown) => {
          console.error("Error:", err instanceof Error ? err.message : String(err))
          ask()
        })
    })
  }

  ask()
}

main()
