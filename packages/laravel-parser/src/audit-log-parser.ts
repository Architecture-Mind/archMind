import { readFileSync } from "fs"
import Parser from "tree-sitter"
// @ts-ignore
import PHP from "tree-sitter-php"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

export interface AuditLogCall {
  /** e.g. "Activity::add" or "activity()->log" */
  symbol: string
  /** string literal args extracted from the call site */
  args: string[]
  /** raw call text for traceability */
  callText: string
}

/**
 * Find calls matching a configurable "audit sink" symbol list — durable
 * audit/activity-log writes like `Activity::add(...)` or the
 * spatie/laravel-activitylog `activity()->log(...)` helper. See
 * research/semantic-ir/v1.5-semantic-fidelity-plan.md, Phase 5.
 *
 * Detection is a plain symbol match against `auditSinks` (no FQCN
 * resolution) — matches the plan's "pattern-match call symbols against a
 * configurable list" posture, kept intentionally simple and extensible via
 * ProjectConfig.conventions.auditSinks.
 */
/**
 * @param methodName When given, scopes the scan to that method's body only —
 * required for correct results whenever the caller represents a single
 * method (e.g. one route's business_handler or one service-call node).
 * Omitting it scans the whole file and can misattribute an unrelated
 * method's audit-sink call to a node for a different method in the same
 * file (found via real-repo regression check on BookStack's `UserRepo.php`,
 * where `getById()` — which makes no audit calls at all — picked up 3
 * phantom `Activity::add` nodes belonging to other methods — IR v1.5
 * Phase 5 fix).
 */
export function parseAuditLogCalls(filePath: string, auditSinks: string[], methodName?: string): AuditLogCall[] {
  const sinkSet = new Set(auditSinks)
  if (sinkSet.size === 0) return []

  let source: string
  let tree: ReturnType<typeof _parser.parse>
  try {
    source = readFileSync(filePath, "utf-8")
    tree = _parser.parse(source)
  } catch {
    return []
  }

  const scanRoot = methodName ? findMethod(tree.rootNode, methodName) : tree.rootNode
  if (!scanRoot) return []

  const results: AuditLogCall[] = []
  gatherAuditLogCalls(scanRoot, sinkSet, results)
  return results
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

function gatherAuditLogCalls(
  node: Parser.SyntaxNode,
  sinkSet: Set<string>,
  results: AuditLogCall[]
): void {
  // ClassName::method(args) — e.g. Activity::add(...)
  if (node.type === "scoped_call_expression") {
    const cls  = (node.children as Parser.SyntaxNode[])[0]
    const name = node.childForFieldName("name")
    const clsText = cls?.text.replace(/^\\/, "")

    if (clsText && name?.text) {
      const symbol = `${clsText}::${name.text}`
      if (sinkSet.has(symbol)) {
        const argsNode = node.childForFieldName("arguments")
        results.push({
          symbol,
          args:     argsNode ? extractStringCallArgs(argsNode) : [],
          callText: node.text,
        })
      }
    }
  }

  // helperFn()->method(args) — e.g. activity()->log(...)
  if (node.type === "member_call_expression") {
    const objNode  = node.childForFieldName("object")
    const nameNode = node.childForFieldName("name")

    if (objNode?.type === "function_call_expression" && nameNode) {
      const fn = objNode.childForFieldName("function")
      if (fn?.text) {
        const symbol = `${fn.text}()->${nameNode.text}`
        if (sinkSet.has(symbol)) {
          const argsNode = node.childForFieldName("arguments")
          results.push({
            symbol,
            args:     argsNode ? extractStringCallArgs(argsNode) : [],
            callText: node.text,
          })
        }
      }
    }
  }

  for (const child of node.children as Parser.SyntaxNode[]) {
    gatherAuditLogCalls(child, sinkSet, results)
  }
}

function extractStringCallArgs(argsNode: Parser.SyntaxNode): string[] {
  return (argsNode.children as Parser.SyntaxNode[])
    .filter((c) => c.type === "argument")
    .flatMap((c) => {
      const val = c.firstNamedChild
      if (!val) return []
      if (val.type === "string") {
        const content = (val.children as Parser.SyntaxNode[]).find(
          (sc) => sc.type === "string_content"
        )
        return content?.text ? [content.text] : []
      }
      return []
    })
}
