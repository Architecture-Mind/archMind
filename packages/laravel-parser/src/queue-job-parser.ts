// ---------------------------------------------------------------------------
// queue-job-parser: detects Laravel queued jobs (classes implementing
// Illuminate\Contracts\Queue\ShouldQueue) as non-HTTP "queue" entrypoints.
// Mirrors the Spring Boot @KafkaListener/@RabbitListener/@JmsListener and
// NestJS-equivalent messaging entrypoint kind so all frameworks emit an
// equivalent EntrypointDescriptor{type:"queue"}.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"
import Parser from "tree-sitter"
// @ts-ignore — tree-sitter-php lacks ambient declarations in this workspace
import PHP from "tree-sitter-php"
import type { IntermediateExecutionGraph, ExecutionNode } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

const DEFAULT_QUEUE = "default"
const SKIP_DIRS = new Set(["node_modules", "vendor", "storage", "bootstrap", ".git", "dist", "build", "coverage"])

/** Parse a single file for a ShouldQueue job class. Returns null if not a queued job. */
export function parseQueuedJob(filePath: string): IntermediateExecutionGraph | null {
  let source: string
  try {
    source = readFileSync(filePath, "utf-8")
  } catch {
    return null
  }
  // Cheap string pre-filter before paying for a tree-sitter parse.
  if (!source.includes("ShouldQueue")) return null

  let tree: ReturnType<typeof _parser.parse>
  try {
    tree = _parser.parse(source)
  } catch {
    return null
  }

  const cls = findShouldQueueClass(tree.rootNode)
  if (!cls) return null

  const className = cls.childForFieldName("name")?.text
  if (!className) return null

  const queue = resolveQueueProperty(cls) ?? DEFAULT_QUEUE
  const id = `queue:${className}`

  const node: ExecutionNode = {
    id:     `job_${className.toLowerCase().replace(/[^a-z0-9]/g, "_")}`,
    type:   IR_NODE_TYPES.BUSINESS_HANDLER,
    symbol: `${className}::handle`,
    role:   "handler",
    file:   filePath,
  }

  return {
    entrypoint: id,
    method:     "QUEUE",
    path:       queue,
    source: {
      type:    "queue",
      id,
      trigger: queue,
      metadata: { class: className, queue },
    },
    nodes: [node],
    edges: [],
    annotations: [],
    framework: "laravel",
  }
}

/** Walk a project root and parse every ShouldQueue job found. */
export function parseQueuedJobs(projectRoot: string): IntermediateExecutionGraph[] {
  const graphs: IntermediateExecutionGraph[] = []
  for (const file of findFilesContaining(projectRoot, "ShouldQueue")) {
    const graph = parseQueuedJob(file)
    if (graph) graphs.push(graph)
  }
  return graphs
}

// ---- Internals -------------------------------------------------------

type SyntaxNode = Parser.SyntaxNode

function findShouldQueueClass(root: SyntaxNode): SyntaxNode | null {
  if (root.type === "class_declaration") {
    const clause = root.children.find((c) => c.type === "class_interface_clause")
    const implementsShouldQueue = clause?.children.some((c) => c.type === "name" && c.text === "ShouldQueue")
    if (implementsShouldQueue) return root
  }
  for (const child of root.children) {
    const found = findShouldQueueClass(child)
    if (found) return found
  }
  return null
}

/** Resolve `public $queue = 'name';` from the class body, if declared. */
function resolveQueueProperty(cls: SyntaxNode): string | null {
  const body = cls.children.find((c) => c.type === "declaration_list")
  if (!body) return null

  for (const child of body.children) {
    if (child.type !== "property_declaration") continue
    const elem = child.namedChildren.find((c) => c.type === "property_element")
    if (!elem) continue
    const varName = elem.namedChildren.find((c) => c.type === "variable_name")
    if (varName?.text !== "$queue") continue
    const valueNode = elem.namedChildren.find((c) => c.type === "string" || c.type === "encapsed_string")
    if (!valueNode) continue
    const content = valueNode.children.find((c) => c.type === "string_content")
    return content?.text ?? valueNode.text.replace(/^['"]|['"]$/g, "")
  }
  return null
}

/** Find .php files (excluding vendor/tests) whose raw text contains `needle`. */
function findFilesContaining(root: string, needle: string): string[] {
  const out: string[] = []
  walkForNeedle(root, needle, out)
  return out
}

function walkForNeedle(dir: string, needle: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      walkForNeedle(full, needle, out)
      continue
    }
    if (!entry.endsWith(".php") || entry.endsWith("Test.php")) continue
    try {
      const content = readFileSync(full, "utf-8")
      if (content.includes(needle)) out.push(full)
    } catch {
      // unreadable file — skip
    }
  }
}
