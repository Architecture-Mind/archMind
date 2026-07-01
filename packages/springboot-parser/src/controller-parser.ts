import { readFileSync } from "fs"
import Parser from "tree-sitter"
// @ts-ignore
import Java from "tree-sitter-java"
import type { SpringControllerMethod, AuthAnnotation, ServiceCall, DataAccessCall, EventPublication, HttpMethod } from "./types.js"

const _parser = new Parser()
_parser.setLanguage(Java)

// ---------------------------------------------------------------------------
// Annotation name constants
// ---------------------------------------------------------------------------

const CONTROLLER_ANNS = new Set(["RestController", "Controller"])
const HTTP_MAPPING_ANNS: Record<string, HttpMethod> = {
  GetMapping:     "GET",
  PostMapping:    "POST",
  PutMapping:     "PUT",
  DeleteMapping:  "DELETE",
  PatchMapping:   "PATCH",
}

const WRITE_REPO_METHODS = new Set([
  "save", "saveAll", "saveAndFlush", "saveAllAndFlush",
  "delete", "deleteById", "deleteAll", "deleteAllById",
  "deleteAllByIdInBatch", "deleteAllInBatch",
])

const MESSAGING_FIELD_PATTERNS = ["rabbitTemplate", "kafkaTemplate", "jmsTemplate", "sqsTemplate"]
const MAIL_FIELD_PATTERNS       = ["mailSender", "javaMailSender", "emailService"]
const EVENT_PUBLISHER_PATTERNS  = ["eventPublisher", "applicationEventPublisher", "publisher"]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse all Spring REST controller methods from a Java source file.
 * Returns an empty array if the file is not a controller or fails to parse.
 *
 * @param baseClassIndex  Optional map of simple class name → @RequestMapping path
 *                        for resolving inherited URL prefixes.
 */
export function parseControllerFile(
  filePath: string,
  baseClassIndex?: Map<string, string>,
): SpringControllerMethod[] {
  let source: string
  try {
    source = readFileSync(filePath, "utf-8")
  } catch {
    return []
  }

  let tree: ReturnType<typeof _parser.parse>
  try {
    tree = _parser.parse(source)
  } catch {
    return []
  }

  const root = tree.rootNode
  const out:  SpringControllerMethod[] = []

  // Find all class declarations in the file
  for (const classNode of root.descendantsOfType("class_declaration")) {
    const classMods = getModifiers(classNode)
    if (!classMods) continue
    if (!hasAnnotation(classMods, CONTROLLER_ANNS)) continue

    const className = classNode.childForFieldName("name")?.text ?? "UnknownController"

    // Resolve class-level path: own @RequestMapping OR inherited from base class
    let classPath = getRequestMappingPath(classMods)
    if (!classPath && baseClassIndex) {
      // superclass field text is "extends ClassName" — strip the keyword
      const superclassText = classNode.childForFieldName("superclass")?.text ?? ""
      const baseClass = superclassText.replace(/^extends\s+/, "").trim() ||
                        (extractExtendsFromSource(source, className) ?? "")
      if (baseClass && baseClassIndex.has(baseClass)) {
        classPath = baseClassIndex.get(baseClass)!
      }
    }

    const classTxn    = hasAnnotation(classMods, new Set(["Transactional"]))

    // Collect injected fields: fieldName → className
    const injectedFields = extractInjectedFields(classNode)

    // Parse each method
    const classBody = classNode.childForFieldName("body") ??
                      classNode.children.find((c) => c.type === "class_body")
    if (!classBody) continue

    for (const methodNode of classBody.descendantsOfType("method_declaration")) {
      const mods = getModifiers(methodNode)
      if (!mods) continue

      const httpMethod = getHttpMethod(mods)
      if (!httpMethod) continue   // skip non-HTTP methods

      const methodPath  = getRequestMappingPath(mods)
      const fullPath    = normalizePath(classPath, methodPath)
      const methodName  = methodNode.childForFieldName("name")?.text ?? "unknown"
      const methodTxn   = classTxn || hasAnnotation(mods, new Set(["Transactional"]))
      const readOnly    = isReadOnlyTxn(mods)

      const authAnnotations = extractAuthAnnotations(mods)
      const { hasValidation, validatedParamTypes } = extractValidationInfo(methodNode)

      const body = methodNode.childForFieldName("body") ??
                   methodNode.children.find((c) => c.type === "block")
      const serviceCalls:      ServiceCall[]      = []
      const dataAccessCalls:   DataAccessCall[]   = []
      const eventPublications: EventPublication[] = []
      const asyncCalls:        string[]           = []
      const mailCalls:         string[]           = []
      const messagingCalls:    string[]           = []

      if (body) {
        extractBodyCalls(
          body, injectedFields, methodTxn,
          serviceCalls, dataAccessCalls, eventPublications,
          asyncCalls, mailCalls, messagingCalls,
        )
      }

      out.push({
        filePath,
        className,
        methodName,
        httpMethod,
        path: fullPath,
        authAnnotations,
        hasValidation,
        validatedParamTypes,
        isTransactional: methodTxn,
        readOnly,
        serviceCalls,
        dataAccessCalls,
        eventPublications,
        asyncCalls,
        mailCalls,
        messagingCalls,
        methodLine: methodNode.startPosition.row + 1,
      })
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Annotation helpers
// ---------------------------------------------------------------------------

/** Get the `modifiers` child node (unnamed field in Java grammar). */
function getModifiers(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return node.children.find((c) => c.type === "modifiers") ?? null
}

function hasAnnotation(modifiers: Parser.SyntaxNode, names: Set<string>): boolean {
  for (const child of modifiers.children) {
    if (child.type === "marker_annotation" || child.type === "annotation") {
      const name = getAnnotationName(child)
      if (name && names.has(name)) return true
    }
  }
  return false
}

function getAnnotationName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name")
  return nameNode?.text ?? null
}

/** Extract string value from simple annotation: @Foo("value") or @Foo(value="val") */
function getAnnotationStringArg(node: Parser.SyntaxNode, argName?: string): string | null {
  const argList = node.childForFieldName("arguments")
  if (!argList) return null

  if (argName) {
    // Look for element_value_pair with matching name
    for (const child of argList.children) {
      if (child.type === "element_value_pair") {
        const key = child.childForFieldName("key")?.text
        if (key === argName) {
          const val = child.childForFieldName("value")
          return unquote(val?.text ?? "")
        }
      }
    }
    return null
  }

  // Single string literal argument
  for (const child of argList.children) {
    if (child.type === "string_literal") return unquote(child.text)
    // annotation_argument_list may directly contain the string
    if (child.type === "element_value") {
      const lit = child.children.find((c) => c.type === "string_literal")
      if (lit) return unquote(lit.text)
    }
  }
  return null
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "")
}

// ---------------------------------------------------------------------------
// HTTP method + path extraction
// ---------------------------------------------------------------------------

function getHttpMethod(modifiers: Parser.SyntaxNode): HttpMethod | null {
  for (const child of modifiers.children) {
    if (child.type !== "annotation" && child.type !== "marker_annotation") continue
    const name = getAnnotationName(child)
    if (!name) continue
    if (HTTP_MAPPING_ANNS[name]) return HTTP_MAPPING_ANNS[name]
    if (name === "RequestMapping") {
      const method = getRequestMappingMethod(child)
      return (method as HttpMethod) ?? "GET"
    }
  }
  return null
}

function getRequestMappingMethod(node: Parser.SyntaxNode): string {
  const argList = node.childForFieldName("arguments")
  if (!argList) return "GET"
  // Look for method = RequestMethod.POST
  for (const child of argList.children) {
    if (child.type === "element_value_pair") {
      const key = child.childForFieldName("key")?.text
      if (key === "method") {
        const val = child.childForFieldName("value")?.text ?? ""
        // e.g. "RequestMethod.POST" or "{RequestMethod.POST, RequestMethod.PUT}"
        if (val.includes("POST"))   return "POST"
        if (val.includes("PUT"))    return "PUT"
        if (val.includes("DELETE")) return "DELETE"
        if (val.includes("PATCH"))  return "PATCH"
        return "GET"
      }
    }
  }
  return "GET"
}

function getRequestMappingPath(modifiers: Parser.SyntaxNode): string {
  for (const child of modifiers.children) {
    if (child.type !== "annotation" && child.type !== "marker_annotation") continue
    const name = getAnnotationName(child)
    if (!name) continue
    if (name === "RequestMapping" || HTTP_MAPPING_ANNS[name] !== undefined) {
      const path = getAnnotationStringArg(child) ?? getAnnotationStringArg(child, "value") ?? getAnnotationStringArg(child, "path")
      if (path) return path
    }
  }
  return ""
}

function normalizePath(classPath: string, methodPath: string): string {
  const base = classPath.replace(/\/$/, "")
  const sub  = methodPath.startsWith("/") ? methodPath : `/${methodPath}`
  const full = base + sub
  return full || "/"
}

// ---------------------------------------------------------------------------
// Auth annotation extraction
// ---------------------------------------------------------------------------

function extractAuthAnnotations(modifiers: Parser.SyntaxNode): AuthAnnotation[] {
  const out: AuthAnnotation[] = []
  for (const child of modifiers.children) {
    if (child.type !== "annotation" && child.type !== "marker_annotation") continue
    const name = getAnnotationName(child)
    if (!name) continue

    if (name === "PreAuthorize") {
      const expr = getAnnotationStringArg(child) ?? ""
      const isAuthOnly = /^\s*isAuthenticated\(\)\s*$/.test(expr) ||
                         /^\s*!isAnonymous\(\)\s*$/.test(expr)
      out.push({ kind: "preAuthorize", expression: expr, isAuthOnly })
    }

    if (name === "Secured") {
      const expr = getAnnotationStringArg(child) ?? ""
      out.push({ kind: "secured", expression: expr, isAuthOnly: false })
    }

    if (name === "RolesAllowed") {
      const expr = getAnnotationStringArg(child) ?? ""
      out.push({ kind: "rolesAllowed", expression: expr, isAuthOnly: false })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// @Transactional readOnly check
// ---------------------------------------------------------------------------

function isReadOnlyTxn(modifiers: Parser.SyntaxNode): boolean {
  for (const child of modifiers.children) {
    if (child.type !== "annotation") continue
    if (getAnnotationName(child) !== "Transactional") continue
    const ro = getAnnotationStringArg(child, "readOnly")
    if (ro === "true") return true
    // check for element_value_pair with boolean literal
    const argList = child.childForFieldName("arguments")
    if (!argList) continue
    for (const arg of argList.children) {
      if (arg.type === "element_value_pair") {
        const key = arg.childForFieldName("key")?.text
        const val = arg.childForFieldName("value")?.text
        if (key === "readOnly" && val === "true") return true
      }
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Validation: @Valid on method parameters
// ---------------------------------------------------------------------------

function extractValidationInfo(methodNode: Parser.SyntaxNode): {
  hasValidation: boolean
  validatedParamTypes: string[]
} {
  const params = methodNode.childForFieldName("parameters")
  if (!params) return { hasValidation: false, validatedParamTypes: [] }

  const types: string[] = []

  for (const param of params.descendantsOfType("formal_parameter")) {
    const mods = getModifiers(param)
    if (!mods) continue
    const hasValid = hasAnnotation(mods, new Set(["Valid", "Validated"]))
    if (hasValid) {
      const typeNode = param.childForFieldName("type")
      if (typeNode) types.push(typeNode.text)
    }
  }

  return { hasValidation: types.length > 0, validatedParamTypes: types }
}

// ---------------------------------------------------------------------------
// Injected field map: fieldName → fieldType (class name only)
// ---------------------------------------------------------------------------

function extractInjectedFields(classNode: Parser.SyntaxNode): Map<string, string> {
  const map = new Map<string, string>()
  const body = classNode.childForFieldName("body")
  if (!body) return map

  for (const field of body.descendantsOfType("field_declaration")) {
    const type     = field.childForFieldName("type")?.text ?? ""
    // Grab the first declarator's name
    const decl = field.children.find((c) => c.type === "variable_declarator")
    const name = decl?.childForFieldName("name")?.text
    if (name && type) map.set(name, type)
  }

  // Also collect constructor parameters → private final fields
  for (const ctor of body.descendantsOfType("constructor_declaration")) {
    const params = ctor.childForFieldName("parameters")
    if (!params) continue
    for (const param of params.descendantsOfType("formal_parameter")) {
      const type = param.childForFieldName("type")?.text ?? ""
      const name = param.childForFieldName("name")?.text ?? ""
      if (name && type && !map.has(name)) map.set(name, type)
    }
  }

  return map
}

// ---------------------------------------------------------------------------
// Method body analysis
// ---------------------------------------------------------------------------

const REPO_SUFFIX_RE = /Repository|Repo$/

function extractBodyCalls(
  body:              Parser.SyntaxNode,
  injectedFields:    Map<string, string>,
  isTransactional:   boolean,
  serviceCalls:      ServiceCall[],
  dataAccessCalls:   DataAccessCall[],
  eventPublications: EventPublication[],
  asyncCalls:        string[],
  mailCalls:         string[],
  messagingCalls:    string[],
): void {
  for (const inv of body.descendantsOfType("method_invocation")) {
    const objectNode = inv.childForFieldName("object")
    const methodNode = inv.childForFieldName("name")
    if (!methodNode) continue

    const methodName = methodNode.text
    const objectName = objectNode?.text ?? ""

    // Strip `this.` prefix
    const fieldName = objectName.startsWith("this.") ? objectName.slice(5) : objectName

    // --- Event publisher ---
    if (EVENT_PUBLISHER_PATTERNS.some((p) => fieldName.toLowerCase().includes(p))) {
      if (methodName === "publishEvent" || methodName === "publish") {
        const argText = extractFirstArgText(inv)
        const className = extractNewClassName(argText) ?? argText
        eventPublications.push({ className, insideTxn: isTransactional })
        continue
      }
    }

    // --- Mail ---
    if (MAIL_FIELD_PATTERNS.some((p) => fieldName.toLowerCase().includes(p))) {
      if (methodName === "send" || methodName === "sendMessage" || methodName === "sendMimeMessage") {
        mailCalls.push(`${fieldName}::${methodName}`)
        continue
      }
    }

    // --- Messaging (Rabbit/Kafka/JMS) ---
    if (MESSAGING_FIELD_PATTERNS.some((p) => fieldName.toLowerCase().includes(p))) {
      messagingCalls.push(`${fieldName}::${methodName}`)
      continue
    }

    // --- Known injected field ---
    const fieldType = injectedFields.get(fieldName)
    if (!fieldType) continue

    if (REPO_SUFFIX_RE.test(fieldType)) {
      // Data access call
      dataAccessCalls.push({
        fieldName,
        fieldType,
        method: methodName,
        isWrite: WRITE_REPO_METHODS.has(methodName),
      })
    } else {
      // Service call
      serviceCalls.push({ fieldName, fieldType, method: methodName })
    }
  }

  // Object creation as event publication: eventPublisher.publishEvent(new OrderEvent(...))
  // Already handled via method_invocation above — the arg text contains the new expression.
}

function extractFirstArgText(inv: Parser.SyntaxNode): string {
  const args = inv.childForFieldName("arguments")
  if (!args) return ""
  const first = args.children.find((c) => c.type !== "," && c.type !== "(" && c.type !== ")")
  return first?.text ?? ""
}

function extractNewClassName(text: string): string | null {
  const m = text.match(/new\s+(\w+)\s*\(/)
  return m?.[1] ?? null
}

/**
 * Regex fallback to extract the base class name from `class Foo extends Bar`.
 * Used when tree-sitter doesn't expose the superclass field.
 */
function extractExtendsFromSource(source: string, ownClassName: string): string | null {
  // Look for "class <ownClassName> extends <Base>"
  const pattern = new RegExp(`class\\s+${ownClassName}\\s+extends\\s+(\\w+)`)
  const m = source.match(pattern)
  return m?.[1] ?? null
}
