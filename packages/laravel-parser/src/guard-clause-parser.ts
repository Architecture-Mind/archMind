import { readFileSync } from "fs"
import Parser from "tree-sitter"
// @ts-ignore
import PHP from "tree-sitter-php"

const _parser = new Parser()
_parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)

export interface GuardClauseResult {
  isGuardClause: boolean
  reason: "leading_if_throw" | "guard_naming_with_throw" | null
}

const NO_GUARD: GuardClauseResult = { isGuardClause: false, reason: null }

/**
 * Heuristic detection of a "guard clause" method — one that can short-circuit
 * the caller's execution via throw/abort based on a precondition, e.g.
 * ensureDeletable(). See research/semantic-ir/v1.5-semantic-fidelity-plan.md,
 * Phase 4.
 *
 * A method qualifies if either:
 *   - its first top-level statement is `if (cond) { throw/abort ...; }`, or
 *   - its name matches a guard-naming convention (ensure-, assert-, guard-, or verify-prefixed)
 *     AND at least one top-level statement is a throwing/aborting `if`.
 *
 * Both checks only look at TOP-LEVEL statements of the method body (not
 * nested inside loops/closures) so a throw buried in unrelated logic deep
 * inside the method does not false-positive as a guard clause.
 */
export function detectGuardClause(filePath: string, methodName: string): GuardClauseResult {
  let source: string
  let tree: ReturnType<typeof _parser.parse>
  try {
    source = readFileSync(filePath, "utf-8")
    tree = _parser.parse(source)
  } catch {
    return NO_GUARD
  }

  const methodNode = findMethod(tree.rootNode, methodName)
  if (!methodNode) return NO_GUARD

  const body = methodNode.childForFieldName("body")
  if (!body) return NO_GUARD

  const topStatements = body.namedChildren as Parser.SyntaxNode[]

  const first = topStatements[0]
  if (first && isGuardIfStatement(first)) {
    return { isGuardClause: true, reason: "leading_if_throw" }
  }

  if (matchesGuardNaming(methodName) && topStatements.some(isGuardIfStatement)) {
    return { isGuardClause: true, reason: "guard_naming_with_throw" }
  }

  return NO_GUARD
}

// ---- Heuristic helpers -------------------------------------------------

function matchesGuardNaming(methodName: string): boolean {
  return /^(ensure|assert|guard|verify)/i.test(methodName)
}

function isThrowOrAbortExpr(node: Parser.SyntaxNode): boolean {
  if (node.type === "throw_expression") return true
  if (node.type === "function_call_expression") {
    const fn = node.childForFieldName("function")
    return fn?.text === "abort"
  }
  return false
}

function isThrowOrAbortStatement(stmt: Parser.SyntaxNode): boolean {
  if (stmt.type !== "expression_statement") return false
  const expr = (stmt.namedChildren as Parser.SyntaxNode[])[0]
  return !!expr && isThrowOrAbortExpr(expr)
}

// An `if` whose then-branch directly contains a throw/abort — "structurally
// close to entry" per the plan, not buried behind further nesting.
function isGuardIfStatement(stmt: Parser.SyntaxNode): boolean {
  if (stmt.type !== "if_statement") return false
  const thenBranch = stmt.childForFieldName("body")
  if (!thenBranch) return false
  if (thenBranch.type === "compound_statement") {
    return (thenBranch.namedChildren as Parser.SyntaxNode[]).some(isThrowOrAbortStatement)
  }
  return isThrowOrAbortStatement(thenBranch)
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
