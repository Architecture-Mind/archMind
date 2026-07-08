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
  /**
   * `$this->prop->method()` / `$this->method()` call sites found directly
   * inside the closure — a write may happen one hop away, inside the
   * callee, invisible to this file's own pattern-matching (e.g. BookStack's
   * `DB::transaction(fn () => $this->userRepo->create(...))`, where the
   * actual `User::create()` write lives inside `UserRepo::create()`, not in
   * the closure text itself). Raw syntax only — no FQCN/file resolution
   * here, since this module has no namespace-map context; the graph
   * augmenter cross-references these against the service-call nodes it
   * already creates for the same caller to link `ir:wraps` (IR v1.5 Phase 3,
   * nested-service-call extension — found via real-repo regression check on
   * BookStack's `UserApiController::create`).
   */
  nestedServiceCalls: NestedServiceCall[]
}

export interface NestedServiceCall {
  /** injected property name, e.g. "userRepo" — empty string for a self-call ($this->method()) */
  propertyName: string
  method: string
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

/**
 * @param methodName When given, scopes the scan to that method's body only —
 * required for correct results whenever the caller represents a single
 * method (e.g. one route's business_handler or one service-call node).
 * Omitting it scans the whole file and can misattribute an unrelated
 * method's `DB::transaction()` to a node for a different method in the same
 * file (found via real-repo regression check on BookStack's
 * `UserApiController.php`, where `create()`'s transaction was bleeding into
 * `delete()`'s graph — IR v1.5 Phase 3 fix).
 */
export function parseTransactions(filePath: string, methodName?: string): TransactionParseResult {
  let source: string
  let tree: ReturnType<typeof _parser.parse>
  try {
    source = readFileSync(filePath, "utf-8")
    tree = _parser.parse(source)
  } catch {
    return { hasTransaction: false, blocks: [] }
  }

  const scanRoot = methodName ? findMethod(tree.rootNode, methodName) : tree.rootNode
  if (!scanRoot) return { hasTransaction: false, blocks: [] }

  const blocks: TransactionBlock[] = []
  gatherTransactionBlocks(scanRoot, blocks)

  return { hasTransaction: blocks.length > 0, blocks }
}

// ---- Method finder ------------------------------------------------------

function findMethod(root: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  for (const child of root.children) {
    const found = findMethodIn(child, name)
    if (found) return found
  }
  return null
}

function findMethodIn(node: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  if (node.type === "method_declaration") {
    const nameNode = node.childForFieldName("name")
    if (nameNode?.text === name) return node
  }
  for (const child of node.children) {
    const found = findMethodIn(child, name)
    if (found) return found
  }
  return null
}

// ---- Tree traversal ---------------------------------------------------

function gatherTransactionBlocks(
  node: Parser.SyntaxNode,
  blocks: TransactionBlock[]
): void {
  if (isDbTransactionCall(node)) {
    const closure = findClosureArg(node)
    if (closure) {
      const block: TransactionBlock = { dispatches: [], writes: [], nestedServiceCalls: [] }
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

    // $this->prop->method() / $this->method() — a write may live one hop
    // inside the callee, invisible to this file's own pattern-matching.
    const objNode = node.childForFieldName("object")
    if (objNode?.type === "member_access_expression") {
      const innerObj = objNode.childForFieldName("object")
      const propNode = objNode.childForFieldName("name")
      if (innerObj?.text === "$this" && propNode && name) {
        block.nestedServiceCalls.push({ propertyName: propNode.text, method: name.text })
      }
    } else if (objNode?.type === "variable_name" && objNode.text === "$this" && name) {
      block.nestedServiceCalls.push({ propertyName: "", method: name.text })
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

export function classifyDispatch(fqcnOrShort: string): "event" | "job" | "unknown" {
  const parts = fqcnOrShort.split("\\")
  const name  = parts[parts.length - 1] ?? fqcnOrShort
  // Namespace-based classification is most reliable when FQCN is available.
  // "Actions" (laravel-actions package convention) executes synchronously like
  // a job — classified as "job" rather than adding a third dispatch kind.
  if (parts.includes("Jobs") || parts.includes("Actions")) return "job"
  if (parts.includes("Events")) return "event"
  // Name-based heuristics for short names or unconventional namespaces
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
