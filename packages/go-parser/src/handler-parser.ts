import { walk, callParts, receiverTypeName, functionName } from "./ast.js"
import type { SyntaxNode } from "./ast.js"

export interface HandlerMethod {
  node: SyntaxNode
  file: string
  line: number
}

/** Registry keyed "ReceiverType.MethodName", e.g. "OrderHandler.CreateOrder". */
export function buildMethodRegistry(files: { path: string; root: SyntaxNode }[]): Map<string, HandlerMethod> {
  const registry = new Map<string, HandlerMethod>()
  for (const file of files) {
    for (const node of walk(file.root)) {
      if (node.type !== "method_declaration") continue
      const receiver = receiverTypeName(node)
      const name = functionName(node)
      if (!receiver || !name) continue
      registry.set(`${receiver}.${name}`, { node, file: file.path, line: node.startPosition.row + 1 })
    }
  }
  return registry
}

const BIND_METHOD_KIND: Record<string, string> = {
  ShouldBindJSON:  "json",
  ShouldBindQuery: "query",
  ShouldBindUri:   "uri",
  ShouldBind:      "body",
  BindJSON:        "json",
}

export interface BindCall {
  kind: string
  /** The bound variable's name, e.g. "req" out of `ctx.ShouldBindJSON(&req)`. */
  varName: string
}

/** Every ShouldBind-family / Bind-family call directly in a handler method's body. */
export function findBindCalls(body: SyntaxNode): BindCall[] {
  const calls: BindCall[] = []
  for (const node of walk(body)) {
    const parts = callParts(node)
    if (!parts) continue
    const kind = BIND_METHOD_KIND[parts.method]
    if (!kind || parts.args.length === 0) continue
    const argNode = parts.args[0]
    const varName = argNode.type === "unary_expression" ? argNode.childForFieldName("operand")?.text : argNode.text
    if (varName) calls.push({ kind, varName })
  }
  return calls
}

/**
 * Resolves `varName`'s declared struct type within `body` — covers both
 * `var req dto.X` and `req := dto.X{}` — returning the bare type name
 * (e.g. "CreateOrderRequest").
 */
export function resolveVarDtoType(body: SyntaxNode, varName: string): string | null {
  for (const node of walk(body)) {
    if (node.type === "var_declaration") {
      for (const spec of node.namedChildren) {
        if (spec.type !== "var_spec") continue
        const name = spec.namedChildren.find((c) => c.type === "identifier")
        if (name?.text !== varName) continue
        const typeNode = spec.namedChildren.find(
          (c) => c.type === "qualified_type" || c.type === "type_identifier"
        )
        if (!typeNode) continue
        return typeNode.type === "qualified_type" ? typeNode.childForFieldName("name")?.text ?? null : typeNode.text
      }
    }
    if (node.type === "short_var_declaration") {
      const left  = node.childForFieldName("left")  ?? node.namedChildren[0]
      const right = node.childForFieldName("right") ?? node.namedChildren[1]
      if (left?.namedChildren[0]?.text !== varName) continue
      const rhs = right?.namedChildren[0]
      if (rhs?.type !== "composite_literal") continue
      const typeNode = rhs.namedChildren.find((c) => c.type === "qualified_type" || c.type === "type_identifier")
      if (!typeNode) continue
      return typeNode.type === "qualified_type" ? typeNode.childForFieldName("name")?.text ?? null : typeNode.text
    }
  }
  return null
}
