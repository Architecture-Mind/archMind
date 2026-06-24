import { readFileSync } from "fs"
import Parser from "tree-sitter"
// @ts-ignore
import PHP from "tree-sitter-php"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

// ---- Public API -------------------------------------------------------

export interface TransactionBlock {
  /** Short class name of each event/job dispatched inside the transaction */
  dispatches: DispatchCall[]
  /** Eloquent model writes (create/update/delete/save) inside the transaction */
  writes: ModelWrite[]
}

export interface DispatchCall {
  /** e.g. "TaskCreated" */
  className: string
  /** "event" | "job" — best-effort from naming convention */
  kind: "event" | "job" | "unknown"
  /** raw call text for traceability */
  callText: string
}

export interface ModelWrite {
  /** e.g. "Task" */
  className: string
  /** "create" | "update" | "delete" | "save" | "upsert" */
  operation: "create" | "update" | "delete" | "save" | "upsert"
  callText: string
}

export interface TransactionParseResult {
  /** true if at least one DB::transaction() was found in the file */
  hasTransaction: boolean
  blocks: TransactionBlock[]
}

export function parseTransactions(filePath: string): TransactionParseResult {
  let source: string
  let tree: ReturnType<typeof _parser.parse>
  try {
    source = readFileSync(filePath, "utf-8")
    tree = _parser.parse(source)
  } catch {
    return { hasTransaction: false, blocks: [] }
  }
  const root  = tree.rootNode
  const blocks: TransactionBlock[] = []

  gatherTransactionBlocks(root, blocks)

  return { hasTransaction: blocks.length > 0, blocks }
}

// ---- Tree traversal ---------------------------------------------------

function gatherTransactionBlocks(
  node: Parser.SyntaxNode,
  blocks: TransactionBlock[]
): void {
  if (isDbTransactionCall(node)) {
    const closure = findClosureArg(node)
    if (closure) {
      const block: TransactionBlock = { dispatches: [], writes: [] }
      gatherDispatchesAndWrites(closure, block)
      blocks.push(block)
      // Don't descend further into this closure — it's already captured
      return
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherTransactionBlocks(child, blocks)
  }
}

// Matches: DB::transaction(...) or \DB::transaction(...)
// tree-sitter PHP uses "scoped_call_expression" for ClassName::method() calls.
// The class name is children[0] (no named field), method is childForFieldName("name").
function isDbTransactionCall(node: Parser.SyntaxNode): boolean {
  if (node.type !== "scoped_call_expression") return false
  const cls  = (node.children as Parser.SyntaxNode[])[0]
  const name = node.childForFieldName("name")
  const clsText = cls?.text.replace(/^\\/, "")
  return clsText === "DB" && name?.text === "transaction"
}

// Find the closure/arrow-function passed as first argument
function findClosureArg(callNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const argsNode = callNode.childForFieldName("arguments")
  if (!argsNode) return null

  for (const arg of argsNode.children as Parser.SyntaxNode[]) {
    if (arg.type !== "argument") continue
    const val = arg.firstNamedChild
    if (!val) continue
    if (val.type === "anonymous_function" ||
        val.type === "arrow_function") {
      return val
    }
  }
  return null
}

// Walk the closure body collecting dispatches and model writes
function gatherDispatchesAndWrites(
  node: Parser.SyntaxNode,
  block: TransactionBlock
): void {
  // ClassName::dispatch(...) or Model::create(...) — scoped (static) calls
  if (node.type === "scoped_call_expression") {
    const cls  = (node.children as Parser.SyntaxNode[])[0]
    const name = node.childForFieldName("name")
    const clsText = cls?.text.replace(/^\\/, "") ?? ""

    if (name?.text === "dispatch" && clsText !== "DB") {
      block.dispatches.push({
        className: clsText,
        kind:      classifyDispatch(clsText),
        callText:  node.text,
      })
    }

    const writeOp = staticWriteOp(name?.text ?? "")
    if (writeOp && clsText) {
      block.writes.push({
        className: clsText,
        operation: writeOp,
        callText:  node.text,
      })
    }
  }

  // $model->save() / $model->delete() / $model->update() — instance writes
  if (node.type === "member_call_expression") {
    const name = node.childForFieldName("name")
    const op   = instanceWriteOp(name?.text ?? "")
    if (op) {
      block.writes.push({
        className: "unknown",
        operation: op,
        callText:  node.text,
      })
    }

    // dispatch(new SomeJob()) — standalone dispatch() helper call handled separately
  }

  // dispatch(new SomeEvent(...)) — global helper
  if (node.type === "function_call_expression") {
    const fn = node.childForFieldName("function")
    if (fn?.text === "dispatch") {
      const arg = firstArgClassName(node)
      if (arg) {
        block.dispatches.push({
          className: arg,
          kind:      classifyDispatch(arg),
          callText:  node.text,
        })
      }
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherDispatchesAndWrites(child, block)
  }
}

// ---- Helpers ----------------------------------------------------------

export function classifyDispatch(className: string): "event" | "job" | "unknown" {
  const name = className.split("\\").pop() ?? className
  if (/Event|Was[A-Z]|Created|Updated|Deleted|Fired|Dispatched/.test(name)) return "event"
  if (/Job|Process|Send|Queue|Handle/.test(name)) return "job"
  return "unknown"
}

function staticWriteOp(methodName: string): ModelWrite["operation"] | null {
  if (methodName === "create")          return "create"
  if (methodName === "upsert")          return "upsert"
  if (methodName === "updateOrCreate")  return "upsert"
  if (methodName === "insert")          return "create"
  if (methodName === "firstOrCreate")   return "create"
  return null
}

function instanceWriteOp(methodName: string): ModelWrite["operation"] | null {
  if (methodName === "save")   return "save"
  if (methodName === "update") return "update"
  if (methodName === "delete") return "delete"
  if (methodName === "forceDelete") return "delete"
  return null
}

function firstArgClassName(callNode: Parser.SyntaxNode): string | null {
  const argsNode = callNode.childForFieldName("arguments")
  if (!argsNode) return null

  for (const arg of argsNode.children as Parser.SyntaxNode[]) {
    if (arg.type !== "argument") continue
    const val = arg.firstNamedChild
    if (!val) continue
    // new SomeClass(...)
    if (val.type === "object_creation_expression") {
      const cls = val.childForFieldName("class")
      return cls?.text.replace(/^\\/, "") ?? null
    }
  }
  return null
}
