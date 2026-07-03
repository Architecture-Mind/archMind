import { readFileSync } from "fs"
import Parser from "tree-sitter"
// @ts-ignore
import Java from "tree-sitter-java"

const _parser = new Parser()
_parser.setLanguage(Java)

interface ClassTransactionInfo {
  classTransactional:  boolean
  methodTransactional: Set<string>
}

export interface ServiceTransactionIndex {
  /** True if a call to `fieldType::method` executes inside a transaction. */
  isTransactional(fieldType: string, method: string): boolean
}

/**
 * Scan Java source for @Transactional on service classes and build a lookup
 * keyed by both the concrete class name and any interfaces it implements.
 *
 * Spring convention puts @Transactional on the *Impl class, while controllers
 * inject the interface type — so `fieldType` (the injected type) often does
 * not match the class carrying the annotation. This index bridges that gap.
 */
export function buildServiceTransactionIndex(javaFiles: string[]): ServiceTransactionIndex {
  const byClassName      = new Map<string, ClassTransactionInfo>()
  const interfaceToImpls = new Map<string, string[]>()

  for (const file of javaFiles) {
    let source: string
    try {
      source = readFileSync(file, "utf-8")
    } catch {
      continue
    }
    if (!source.includes("@Transactional") && !source.includes("implements")) continue

    let tree: Parser.Tree
    try {
      tree = _parser.parse(source)
    } catch {
      continue
    }

    for (const classNode of tree.rootNode.descendantsOfType("class_declaration")) {
      const className = classNode.childForFieldName("name")?.text
      if (!className) continue

      const classMods = getModifiersText(classNode)
      const classTransactional = classMods.includes("@Transactional")

      const methodTransactional = new Set<string>()
      const classBody = classNode.childForFieldName("body")
      if (classBody) {
        for (const methodNode of classBody.descendantsOfType("method_declaration")) {
          const mods = getModifiersText(methodNode)
          if (mods.includes("@Transactional")) {
            const methodName = methodNode.childForFieldName("name")?.text
            if (methodName) methodTransactional.add(methodName)
          }
        }
      }

      if (classTransactional || methodTransactional.size > 0) {
        byClassName.set(className, { classTransactional, methodTransactional })
      }

      // Record implemented interfaces so a controller-injected interface type
      // (e.g. "WithdrawalService") resolves to its impl (e.g. "WithdrawalServiceImpl").
      const interfacesText = classNode.childForFieldName("interfaces")?.text ?? ""
      for (const m of interfacesText.matchAll(/\b([A-Z]\w*)\b/g)) {
        const iface = m[1]!
        const list = interfaceToImpls.get(iface) ?? []
        list.push(className)
        interfaceToImpls.set(iface, list)
      }
    }
  }

  function lookup(fieldType: string): ClassTransactionInfo | null {
    const direct = byClassName.get(fieldType)
    if (direct) return direct

    const impls = interfaceToImpls.get(fieldType) ?? []
    for (const impl of impls) {
      const info = byClassName.get(impl)
      if (info) return info
    }
    return null
  }

  return {
    isTransactional(fieldType: string, method: string): boolean {
      const info = lookup(fieldType)
      if (!info) return false
      return info.classTransactional || info.methodTransactional.has(method)
    },
  }
}

function getModifiersText(node: Parser.SyntaxNode): string {
  return node.children.find((c) => c.type === "modifiers")?.text ?? ""
}
