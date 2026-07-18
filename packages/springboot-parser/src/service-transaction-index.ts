import { readFileSync } from "fs"
import Parser from "tree-sitter"
// @ts-ignore
import Java from "tree-sitter-java"
import { moduleRootOf } from "./security-config-parser.js"

const _parser = new Parser()
_parser.setLanguage(Java)

interface ClassTransactionInfo {
  classTransactional:  boolean
  methodTransactional: Set<string>
}

export interface ServiceTransactionIndex {
  /** True if a call to `fieldType::method`, made from a controller in `callerModule`, executes inside a transaction. */
  isTransactional(fieldType: string, method: string, callerModule: string): boolean
}

// Composite key so same-named classes in different Maven modules (a real
// occurrence in multi-module repos, e.g. two unrelated `NoticeServiceImpl`
// classes) never shadow each other — only a same-module match counts.
function key(module: string, simpleName: string): string {
  return `${module}::${simpleName}`
}

/**
 * Scan Java source for @Transactional on service classes and build a lookup
 * keyed by (module, class name) and by (module, implemented interface name).
 *
 * Spring convention puts @Transactional on the *Impl class, while controllers
 * inject the interface type — so `fieldType` (the injected type) often does
 * not match the class carrying the annotation. This index bridges that gap,
 * scoped per-module so it can't cross-attribute transaction info between
 * unrelated modules that happen to reuse the same simple class name.
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

    const module = moduleRootOf(file)

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
        byClassName.set(key(module, className), { classTransactional, methodTransactional })
      }

      // Record implemented interfaces so a controller-injected interface type
      // (e.g. "WithdrawalService") resolves to its impl (e.g. "WithdrawalServiceImpl").
      const interfacesText = classNode.childForFieldName("interfaces")?.text ?? ""
      for (const m of interfacesText.matchAll(/\b([A-Z]\w*)\b/g)) {
        const iface = m[1]!
        const ifaceKey = key(module, iface)
        const list = interfaceToImpls.get(ifaceKey) ?? []
        list.push(key(module, className))
        interfaceToImpls.set(ifaceKey, list)
      }
    }
  }

  function lookup(fieldType: string, module: string): ClassTransactionInfo | null {
    const direct = byClassName.get(key(module, fieldType))
    if (direct) return direct

    const impls = interfaceToImpls.get(key(module, fieldType)) ?? []
    for (const implKey of impls) {
      const info = byClassName.get(implKey)
      if (info) return info
    }
    return null
  }

  return {
    isTransactional(fieldType: string, method: string, callerModule: string): boolean {
      const info = lookup(fieldType, callerModule)
      if (!info) return false
      return info.classTransactional || info.methodTransactional.has(method)
    },
  }
}

function getModifiersText(node: Parser.SyntaxNode): string {
  return node.children.find((c) => c.type === "modifiers")?.text ?? ""
}
