// ---------------------------------------------------------------------------
// schedule-parser: detects Laravel scheduled console commands/jobs
// ($schedule->command(...)->daily(), ->job(...)->hourly(), etc. inside
// app/Console/Kernel.php's schedule() method) as non-HTTP "cron" entrypoints.
// Mirrors the Spring Boot @Scheduled and NestJS @Cron entrypoint kind so all
// three frameworks emit an equivalent EntrypointDescriptor{type:"cron"}.
// ---------------------------------------------------------------------------
import { readFileSync } from "fs"
import Parser from "tree-sitter"
// @ts-ignore — tree-sitter-php lacks ambient declarations in this workspace
import PHP from "tree-sitter-php"
import type { IntermediateExecutionGraph, ExecutionNode } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

// Frequency helper → 5-field cron expression, matching Laravel's
// Illuminate\Console\Scheduling\ManagesFrequencies mapping.
const FREQUENCY_MAP: Record<string, string> = {
  everyMinute:          "* * * * *",
  everyTwoMinutes:      "*/2 * * * *",
  everyThreeMinutes:    "*/3 * * * *",
  everyFourMinutes:     "*/4 * * * *",
  everyFiveMinutes:     "*/5 * * * *",
  everyTenMinutes:      "*/10 * * * *",
  everyFifteenMinutes:  "*/15 * * * *",
  everyThirtyMinutes:   "0,30 * * * *",
  hourly:               "0 * * * *",
  daily:                "0 0 * * *",
  weekly:               "0 0 * * 0",
  monthly:              "0 0 1 * *",
  quarterly:            "0 0 1 1,4,7,10 *",
  yearly:               "0 0 1 1 *",
  weekdays:             "* * * * 1-5",
  weekends:             "* * * * 0,6",
  sundays:              "* * * * 0",
  mondays:              "* * * * 1",
  tuesdays:             "* * * * 2",
  wednesdays:           "* * * * 3",
  thursdays:            "* * * * 4",
  fridays:              "* * * * 5",
  saturdays:            "* * * * 6",
}

export interface ScheduledEntry {
  command: string  // command signature, "class:method", or job class name
  file:    string
  line:    number
}

export function parseSchedule(filePath: string): IntermediateExecutionGraph[] {
  let source: string
  let tree: ReturnType<typeof _parser.parse>
  try {
    source = readFileSync(filePath, "utf-8")
    tree = _parser.parse(source)
  } catch {
    return []
  }

  const scheduleMethod = findScheduleMethod(tree.rootNode)
  if (!scheduleMethod) return []

  const body = getFunctionBody(scheduleMethod)
  if (!body) return []

  const graphs: IntermediateExecutionGraph[] = []
  for (const stmt of body.namedChildren) {
    const chain = extractScheduleChain(stmt)
    if (!chain) continue
    graphs.push(buildGraph(chain, filePath, stmt.startPosition.row + 1))
  }
  return graphs
}

// ---- Internals -------------------------------------------------------

type SyntaxNode = Parser.SyntaxNode

interface MethodCall {
  name: string
  args: SyntaxNode[]
}

interface ScheduleChain {
  entryMethod: MethodCall  // "command" | "job" | "call" | "exec"
  frequency:   MethodCall | null
}

function findScheduleMethod(root: SyntaxNode): SyntaxNode | null {
  if (root.type === "method_declaration") {
    const nameNode = root.childForFieldName("name")
    if (nameNode?.text === "schedule") return root
  }
  for (const child of root.children) {
    const found = findScheduleMethod(child)
    if (found) return found
  }
  return null
}

function getFunctionBody(node: SyntaxNode): SyntaxNode | null {
  for (const child of node.children) {
    if (child.type === "compound_statement") return child
  }
  return null
}

/** Unwind `$schedule->command(...)->daily()` into { entryMethod, frequency }. */
function extractScheduleChain(stmt: SyntaxNode): ScheduleChain | null {
  const expr = stmt.type === "expression_statement" ? stmt.firstNamedChild : stmt
  if (!expr) return null

  const methods: MethodCall[] = []
  let cur: SyntaxNode | null = expr

  while (cur && cur.type === "member_call_expression") {
    const nameNode = cur.childForFieldName("name")
    const argsNode = cur.childForFieldName("arguments")
    methods.unshift({
      name: nameNode?.text ?? "",
      args: argsNode ? getArgNodes(argsNode) : [],
    })
    cur = cur.childForFieldName("object") ?? null
  }

  // Root of the chain must be the injected `$schedule` variable.
  if (!cur || cur.type !== "variable_name" || !cur.text.includes("schedule")) return null
  if (methods.length === 0) return null

  const entryMethod = methods[0]
  if (!["command", "job", "call", "exec"].includes(entryMethod.name)) return null

  const frequency = methods.slice(1).find((m) => m.name in FREQUENCY_MAP || m.name === "cron") ?? null

  return { entryMethod, frequency }
}

function getArgNodes(argsNode: SyntaxNode): SyntaxNode[] {
  return argsNode.children
    .filter((c) => c.type === "argument")
    .map((c) => c.firstNamedChild)
    .filter((c): c is SyntaxNode => c !== null)
}

function unquote(text: string): string {
  return text.replace(/^['"]|['"]$/g, "")
}

/** Resolve the human-readable command/job name from the entry call's first argument. */
function resolveCommandName(entryMethod: MethodCall): string {
  const arg = entryMethod.args[0]
  if (!arg) return "unknown"

  if (entryMethod.name === "job") {
    // ->job(new SendHeartbeat()) or ->job(SendHeartbeat::class)
    if (arg.type === "object_creation_expression") {
      const classNode = arg.childForFieldName("class") ?? arg.namedChildren[0]
      return classNode?.text ?? "unknown"
    }
    if (arg.type === "class_constant_access_expression") {
      return arg.children[0]?.text ?? "unknown"
    }
    return arg.text
  }

  if (arg.type === "string" || arg.type === "encapsed_string") {
    const content = arg.children.find((c) => c.type === "string_content")
    return content?.text ?? unquote(arg.text)
  }
  return unquote(arg.text)
}

/** Resolve the cron expression from a detected frequency call, defaulting to "unknown". */
function resolveExpression(frequency: MethodCall | null): string {
  if (!frequency) return "unknown"
  if (frequency.name === "cron") {
    const arg = frequency.args[0]
    if (!arg) return "unknown"
    const content = arg.type === "string" || arg.type === "encapsed_string"
      ? arg.children.find((c) => c.type === "string_content")?.text
      : undefined
    return content ?? unquote(arg.text)
  }
  return FREQUENCY_MAP[frequency.name] ?? "unknown"
}

function buildGraph(chain: ScheduleChain, file: string, line: number): IntermediateExecutionGraph {
  const command = resolveCommandName(chain.entryMethod)
  const expression = resolveExpression(chain.frequency)
  const id = `schedule:${command}`

  const node: ExecutionNode = {
    id:     `sched_${command.toLowerCase().replace(/[^a-z0-9]/g, "_")}`,
    type:   IR_NODE_TYPES.BUSINESS_HANDLER,
    symbol: command,
    role:   "handler",
    file,
    line,
  }

  return {
    entrypoint: id,
    method:     "SCHEDULE",
    path:       expression,
    source: {
      type:    "cron",
      id,
      trigger: expression,
      metadata: { command, expression },
    },
    nodes: [node],
    edges: [],
    annotations: [],
    framework: "laravel",
  }
}
