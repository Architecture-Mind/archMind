export { tokenize, type Token, type TokenKind } from "./lexer.js"
export { parse, type AqlNode } from "./parser.js"
export { evaluate, knownPredicates, type AqlResult } from "./evaluator.js"

import { parse } from "./parser.js"
import { evaluate, type AqlResult } from "./evaluator.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

/**
 * One-shot: parse and evaluate an AQL string against a set of graphs.
 *
 * @example
 * aql("FIND routes WHERE auth AND NOT transaction", graphs)
 */
export function aql(
  query: string,
  graphs: IntermediateExecutionGraph[],
): AqlResult {
  const ast = parse(query)
  return evaluate(ast, graphs)
}
