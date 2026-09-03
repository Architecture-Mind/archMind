import { walk } from "./ast.js"
import type { SyntaxNode } from "./ast.js"

export interface BoundField {
  name: string
  bindingTag: string | null
}

/**
 * Finds `type <name> struct { ... }` in `root` and returns each field's name
 * plus its `binding:"..."` struct-tag value (null when the field has no
 * `binding` tag). This is the Go equivalent of parsing a Laravel FormRequest's
 * `rules()` array — same "validation_gate" IR concept, different mechanism.
 */
export function findStructFields(root: SyntaxNode, typeName: string): BoundField[] | null {
  for (const node of walk(root)) {
    if (node.type !== "type_spec") continue
    if (node.childForFieldName("name")?.text !== typeName) continue
    const typeNode = node.childForFieldName("type")
    if (!typeNode || typeNode.type !== "struct_type") continue

    const fieldList = typeNode.namedChildren.find((c) => c.type === "field_declaration_list")
    if (!fieldList) return []

    return fieldList.namedChildren
      .filter((f) => f.type === "field_declaration")
      .map((f) => {
        const name = f.childForFieldName("name")?.text ?? ""
        const tagNode = f.childForFieldName("tag")
        const tagText = tagNode ? tagNode.text.replace(/^`|`$/g, "") : ""
        const bindingMatch = tagText.match(/binding:"([^"]*)"/)
        return { name, bindingTag: bindingMatch ? bindingMatch[1] : null }
      })
  }
  return null
}

/** Searches every file for `typeName` and returns its bound fields plus which file declared it. */
export function resolveDtoBinding(
  typeName: string,
  files: { path: string; root: SyntaxNode }[]
): { file: string; fields: BoundField[] } | null {
  for (const file of files) {
    const fields = findStructFields(file.root, typeName)
    if (fields !== null) return { file: file.path, fields }
  }
  return null
}
