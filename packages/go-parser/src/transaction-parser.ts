import { walk, callParts, functionParamTypes } from "./ast.js"
import type { SyntaxNode } from "./ast.js"

export interface TransactionBoundary {
  /** Raw text of the full call, e.g. "s.db.WithContext(ctx).Transaction(...)" (closure body omitted by tree-sitter's own text truncation is not applied — kept short via symbol instead). */
  line: number
}

/**
 * Detects the GORM `db.Transaction(func(tx *gorm.DB) error { ... })` closure
 * pattern — same closure-boundary-detection technique as Laravel's
 * `DB::transaction(function () {...})` (transaction-parser.ts there).
 * Returns every match found anywhere in `body` (v1: presence detection only,
 * not which specific downstream calls fall inside it — same
 * transaction-scope-flattening limitation Laravel's IR currently has, see
 * README's "Where it doesn't win").
 */
export function findTransactionBoundaries(body: SyntaxNode): TransactionBoundary[] {
  const found: TransactionBoundary[] = []
  for (const node of walk(body)) {
    const parts = callParts(node)
    if (!parts || parts.method !== "Transaction") continue
    const closure = parts.args[parts.args.length - 1]
    if (!closure || closure.type !== "func_literal") continue
    const paramTypes = functionParamTypes(closure)
    const isGormClosure = [...paramTypes.values()].includes("DB")
    if (!isGormClosure) continue
    found.push({ line: node.startPosition.row + 1 })
  }
  return found
}
