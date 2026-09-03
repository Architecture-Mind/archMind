import { walk, stringLiteralValue, parseGo } from "./ast.js"
import type { SyntaxNode } from "./ast.js"

/**
 * Resolves Go const identifiers (e.g. `model.RoleAdmin`) back to their
 * declared literal value, the equivalent of Laravel's `Permission::TASK_DELETE`
 * class-constant resolution — but via Go const declarations instead of a PHP
 * class body. Matched by short name only across all provided files, same
 * "resolve by name across the whole project" approach used for functions.
 *
 * Only string-literal-valued consts resolve (`iota`-based numeric enums,
 * common for internal-only values, are left unresolved — their identifier
 * text is already meaningful for the args a caller cares about, e.g. a role
 * name, and iota's underlying int carries no semantic value on its own).
 */
export function buildConstRegistry(files: { content: string }[]): Map<string, string> {
  const registry = new Map<string, string>()
  for (const file of files) {
    const root = parseGo(file.content)
    for (const node of walk(root)) {
      if (node.type !== "const_declaration") continue
      for (const spec of node.namedChildren) {
        if (spec.type !== "const_spec") continue
        registerConstSpec(spec, registry)
      }
    }
  }
  return registry
}

function registerConstSpec(spec: SyntaxNode, registry: Map<string, string>): void {
  const nameNode = spec.namedChildren.find((c) => c.type === "identifier")
  const valueList = spec.namedChildren.find((c) => c.type === "expression_list")
  if (!nameNode || !valueList) return
  const valueNode = valueList.namedChildren[0]
  if (!valueNode) return
  const value = stringLiteralValue(valueNode)
  if (value !== null) registry.set(nameNode.text, value)
}

/**
 * Resolves a possibly-qualified identifier expression (`model.RoleAdmin` or
 * bare `RoleAdmin`) to its const value, or returns the original text
 * unresolved when no matching const declaration was found.
 */
export function resolveConstExpr(exprText: string, registry: Map<string, string>): string {
  const shortName = exprText.includes(".") ? exprText.slice(exprText.lastIndexOf(".") + 1) : exprText
  return registry.get(shortName) ?? exprText
}
