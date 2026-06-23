import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative } from "path"
import type { DTOSchema, FieldSchema, FieldType, ValidationRule } from "@kidkender/archmind-protocol"

// ── File discovery ────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["vendor", "node_modules", ".git", "storage", "bootstrap/cache"])

interface PhpFile { abs: string; rel: string; content: string }

function findPhpFiles(projectRoot: string): PhpFile[] {
  const results: PhpFile[] = []
  collectPhp(projectRoot, projectRoot, results)
  return results
}

function collectPhp(dir: string, root: string, out: PhpFile[]): void {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const abs = join(dir, entry)
    try {
      const stat = statSync(abs)
      if (stat.isDirectory()) {
        collectPhp(abs, root, out)
      } else if (entry.endsWith(".php")) {
        const content = readFileSync(abs, "utf-8")
        out.push({ abs, rel: relative(root, abs), content })
      }
    } catch { continue }
  }
}

// ── FormRequest PHP parser ────────────────────────────────────────────────────

const CLASS_PATTERN        = /class\s+(\w+)\s+extends\s+FormRequest/g
const RULES_RETURN_PATTERN = /public\s+function\s+rules\s*\(\s*\)[^{]*\{[^[]*return\s*\[/s
const PIPE_ENTRY           = /['"](\w+)['"]\s*=>\s*'([^']+)'/g
const ARRAY_ENTRY_START    = /['"](\w+)['"]\s*=>\s*\[/g

/**
 * Parses a single PHP file and returns DTOSchema[] for each FormRequest class found.
 */
export function parseFormRequestFile(content: string, relPath: string): DTOSchema[] {
  const schemas: DTOSchema[] = []
  CLASS_PATTERN.lastIndex = 0
  let classMatch: RegExpExecArray | null

  while ((classMatch = CLASS_PATTERN.exec(content)) !== null) {
    const className  = classMatch[1]
    const afterClass = content.slice(classMatch.index)
    const returnMatch = RULES_RETURN_PATTERN.exec(afterClass)
    if (!returnMatch) continue

    const openBracketPos = classMatch.index + returnMatch[0].length - 1
    const rulesBody      = extractBracketedContent(content, openBracketPos)
    if (rulesBody === null) continue

    const fields = parseRulesBody(rulesBody)
    if (fields.length > 0) schemas.push({ className, file: relPath, fields })
  }

  return schemas
}

function extractBracketedContent(content: string, startPos: number): string | null {
  let depth = 0
  for (let i = startPos; i < content.length; i++) {
    if (content[i] === "[") depth++
    else if (content[i] === "]") {
      if (--depth === 0) return content.slice(startPos + 1, i)
    }
  }
  return null
}

function parseRulesBody(body: string): FieldSchema[] {
  const fields: FieldSchema[] = []
  const pipeEntries = new Map<string, string>()

  {
    const re = new RegExp(PIPE_ENTRY.source, "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      pipeEntries.set(m[1], m[2])
      fields.push(buildField(m[1], m[2].split("|").map(s => s.trim()).filter(Boolean)))
    }
  }

  {
    const re = new RegExp(ARRAY_ENTRY_START.source, "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      const name = m[1]
      if (pipeEntries.has(name)) continue
      const inner = extractBracketedContent(body, m.index + m[0].length - 1)
      if (inner === null) continue
      const parts: string[] = []
      const litRe = /['"]([^'"]+)['"]/g
      let lit: RegExpExecArray | null
      while ((lit = litRe.exec(inner)) !== null) parts.push(lit[1])
      fields.push(buildField(name, parts))
    }
  }

  return fields
}

function buildField(name: string, ruleParts: string[]): FieldSchema {
  const rules: ValidationRule[] = []
  let inferredType: FieldType = "string"

  for (const part of ruleParts) {
    if (part === "integer" || part === "numeric") { inferredType = "number"; if (part === "integer") rules.push({ kind: "integer" }); continue }
    if (part === "boolean") { inferredType = "boolean"; rules.push({ kind: "boolean" }); continue }
    if (part === "array")   { inferredType = "array";   rules.push({ kind: "array" });   continue }
    if (part === "string")  { continue }

    if (part === "nullable" || part === "sometimes") { rules.push({ kind: "optional" }); continue }

    const ZERO: Record<string, ValidationRule["kind"]> = {
      required: "required", email: "email", url: "url", uuid: "uuid",
      alpha: "alphanumeric", alpha_num: "alphanumeric", date: "date",
    }
    if (part in ZERO) { rules.push({ kind: ZERO[part] }); continue }

    const minM = part.match(/^min:(\d+(?:\.\d+)?)$/)
    if (minM) { rules.push({ kind: inferredType === "number" ? "min" : "minLength", value: parseFloat(minM[1]) }); continue }

    const maxM = part.match(/^max:(\d+(?:\.\d+)?)$/)
    if (maxM) { rules.push({ kind: inferredType === "number" ? "max" : "maxLength", value: parseFloat(maxM[1]) }); continue }

    const inM = part.match(/^in:(.+)$/)
    if (inM) { rules.push({ kind: "isIn", value: inM[1].split(",").map(s => s.trim()) }); continue }

    const rxM = part.match(/^regex:(.+)$/)
    if (rxM) { rules.push({ kind: "regex", value: rxM[1] }); continue }

    const btM = part.match(/^between:(\d+),(\d+)$/)
    if (btM) {
      const lo = parseFloat(btM[1]), hi = parseFloat(btM[2])
      if (inferredType === "number") { rules.push({ kind: "min", value: lo }, { kind: "max", value: hi }) }
      else { rules.push({ kind: "minLength", value: lo }, { kind: "maxLength", value: hi }) }
      continue
    }
  }

  return { name, type: inferredType, rules }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scans a Laravel project for FormRequest classes and extracts their validation rules.
 *
 * @param projectRoot - Absolute path to the Laravel project root
 */
export function parseFormRequests(projectRoot: string): {
  schemas: DTOSchema[]
  index:   Map<string, DTOSchema>
} {
  const schemas: DTOSchema[] = []
  const index   = new Map<string, DTOSchema>()

  for (const { content, rel } of findPhpFiles(projectRoot)) {
    if (!content.includes("FormRequest")) continue
    for (const schema of parseFormRequestFile(content, rel)) {
      schemas.push(schema)
      index.set(schema.className, schema)
    }
  }

  return { schemas, index }
}
