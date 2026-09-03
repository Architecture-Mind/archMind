import Parser from "tree-sitter"
// @ts-ignore — tree-sitter-go has no bundled types
import Go from "tree-sitter-go"

// One Parser instance per module (matches the pattern used by laravel-parser
// and springboot-parser). Jest's per-test-file worker reuse can make heavy
// singleton reuse flaky within one process — see jest.config.js's maxWorkers.
const _parser = new Parser()
_parser.setLanguage(Go)

export type SyntaxNode = Parser.SyntaxNode

export function parseGo(source: string): SyntaxNode {
  return _parser.parse(source).rootNode
}

/** Depth-first walk of all named descendants (including the node itself). */
export function* walk(node: SyntaxNode): Generator<SyntaxNode> {
  yield node
  for (const child of node.namedChildren) yield* walk(child)
}

/** All function_declaration / method_declaration nodes in a file. */
export function findFunctionDecls(root: SyntaxNode): SyntaxNode[] {
  return [...walk(root)].filter(
    (n) => n.type === "function_declaration" || n.type === "method_declaration"
  )
}

export function functionName(fn: SyntaxNode): string | null {
  const nameNode = fn.childForFieldName("name")
  return nameNode?.text ?? null
}

/** Parameter names in declaration order, e.g. ["router", "handler"]. */
export function functionParamNames(fn: SyntaxNode): string[] {
  const params = fn.childForFieldName("parameters")
  if (!params) return []
  return params.namedChildren
    .filter((p) => p.type === "parameter_declaration")
    .flatMap((p) => p.namedChildren.filter((c) => c.type === "identifier").map((c) => c.text))
}

export function functionBody(fn: SyntaxNode): SyntaxNode | null {
  return fn.childForFieldName("body")
}

/** Unwraps pointer_type/qualified_type down to the bare type_identifier name, e.g. "*handler.AppointmentHandler" → "AppointmentHandler". */
export function bareTypeName(typeNode: SyntaxNode): string | null {
  let n: SyntaxNode | null = typeNode
  while (n && n.type === "pointer_type") n = n.namedChildren[0] ?? null
  if (!n) return null
  if (n.type === "qualified_type") return n.childForFieldName("name")?.text ?? null
  if (n.type === "type_identifier") return n.text
  return null
}

/** Parameter name → bare declared type name, e.g. {"router": "IRouter", "handler": "AppointmentHandler"}. */
export function functionParamTypes(fn: SyntaxNode): Map<string, string> {
  const params = fn.childForFieldName("parameters")
  const map = new Map<string, string>()
  if (!params) return map
  for (const p of params.namedChildren) {
    if (p.type !== "parameter_declaration") continue
    const typeNode = p.childForFieldName("type")
    const type = typeNode ? bareTypeName(typeNode) : null
    if (!type) continue
    for (const c of p.namedChildren.filter((c) => c.type === "identifier")) map.set(c.text, type)
  }
  return map
}

/** The receiver's bare type name for a method_declaration, e.g. "(h *AppointmentHandler)" → "AppointmentHandler". Null for a plain function_declaration. */
export function receiverTypeName(fn: SyntaxNode): string | null {
  const receiver = fn.childForFieldName("receiver")
  if (!receiver) return null
  const decl = receiver.namedChildren.find((c) => c.type === "parameter_declaration")
  const typeNode = decl?.childForFieldName("type")
  return typeNode ? bareTypeName(typeNode) : null
}

/**
 * For a call_expression node, returns { receiver, method } when it's a
 * selector-style call (`receiver.method(...)`), or { receiver: null, method }
 * for a bare call (`method(...)`). `receiver` is the raw text of everything
 * before the final `.field` — may itself be a call or a qualified package
 * reference (e.g. "middleware" in "middleware.AuthMiddleware(...)").
 */
export function callParts(
  call: SyntaxNode
): { receiver: string | null; method: string; args: SyntaxNode[] } | null {
  if (call.type !== "call_expression") return null
  const fnNode = call.childForFieldName("function")
  const argsNode = call.childForFieldName("arguments")
  const args = argsNode ? argsNode.namedChildren : []
  if (!fnNode) return null

  if (fnNode.type === "selector_expression") {
    const operand = fnNode.childForFieldName("operand")
    const field = fnNode.childForFieldName("field")
    if (!field) return null
    return { receiver: operand?.text ?? null, method: field.text, args }
  }
  if (fnNode.type === "identifier") {
    return { receiver: null, method: fnNode.text, args }
  }
  return null
}

/** All call_expression nodes within (and including) a subtree. */
export function findCalls(root: SyntaxNode): SyntaxNode[] {
  return [...walk(root)].filter((n) => n.type === "call_expression")
}

/** Unwraps a string literal node ("interpreted" or "raw") to its content, or null. */
export function stringLiteralValue(node: SyntaxNode): string | null {
  if (node.type === "interpreted_string_literal" || node.type === "raw_string_literal") {
    const content = node.namedChildren.find(
      (c) => c.type === "interpreted_string_literal_content" || c.type === "raw_string_literal_content"
    )
    return content ? content.text : node.text.replace(/^["`]|["`]$/g, "")
  }
  return null
}
