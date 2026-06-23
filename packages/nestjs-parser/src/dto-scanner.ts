import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative } from "path"
import type { DTOSchema, FieldSchema, FieldType, ValidationRule, RuleKind } from "@kidkender/archmind-protocol"

// ── File discovery ────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", ".next"])

interface FoundFile { abs: string; rel: string; content: string }

function findTsFiles(projectRoot: string): FoundFile[] {
  const results: FoundFile[] = []
  collectTs(projectRoot, projectRoot, results)
  return results
}

function collectTs(dir: string, root: string, out: FoundFile[]): void {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const abs = join(dir, entry)
    try {
      const stat = statSync(abs)
      if (stat.isDirectory()) {
        collectTs(abs, root, out)
      } else if (
        entry.endsWith(".ts") &&
        !entry.endsWith(".d.ts") &&
        !entry.endsWith(".spec.ts") &&
        !entry.endsWith(".test.ts")
      ) {
        const content = readFileSync(abs, "utf-8")
        out.push({ abs, rel: relative(root, abs), content })
      }
    } catch { continue }
  }
}

function buildClassIndex(files: FoundFile[]): Map<string, FoundFile> {
  const index = new Map<string, FoundFile>()
  const re = /export\s+class\s+(\w+)/g
  for (const file of files) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(file.content)) !== null) {
      if (!index.has(m[1])) index.set(m[1], file)
    }
  }
  return index
}

function looksLikeDTO(content: string): boolean {
  return (
    content.includes("class-validator") ||
    content.includes("@IsNotEmpty") || content.includes("@IsString") ||
    content.includes("@IsEmail")    || content.includes("@IsInt") ||
    content.includes("@IsNumber")   || content.includes("@IsBoolean") ||
    content.includes("@Min(")       || content.includes("@Max(") ||
    content.includes("@MinLength")  || content.includes("@MaxLength") ||
    content.includes("@IsOptional") || content.includes("@IsEnum") ||
    content.includes("@IsIn(")      || content.includes("@Length(") ||
    content.includes("@IsDate")     || content.includes("@IsPhoneNumber") ||
    content.includes("@IsEthereumAddress") ||
    content.includes("@IsAlphanumeric") || content.includes("@IsNumberString") ||
    content.includes("@ArrayNotEmpty")  || content.includes("@IsUUID") ||
    content.includes("@IsUrl")          || content.includes("@Matches(")
  )
}

// ── DTO file parser ───────────────────────────────────────────────────────────

export function parseDTOFile(content: string, relPath: string): DTOSchema[] {
  const schemas: DTOSchema[] = []
  const lines = content.split("\n")
  let i = 0
  while (i < lines.length) {
    const m = lines[i].match(/export\s+class\s+(\w+)/)
    if (m) {
      const { fields, endLine } = parseClassBody(lines, i)
      if (fields.length > 0) schemas.push({ className: m[1], file: relPath, fields })
      i = endLine
    } else {
      i++
    }
  }
  return schemas
}

function parseClassBody(lines: string[], startLine: number): { fields: FieldSchema[]; endLine: number } {
  const fields: FieldSchema[] = []
  let depth = 0
  let pendingDecorators: string[] = []
  let i = startLine

  while (i < lines.length && !lines[i].includes("{")) i++
  if (i >= lines.length) return { fields, endLine: i }

  for (const ch of lines[i]) {
    if (ch === "{") depth++
    if (ch === "}") depth--
  }
  i++

  while (i < lines.length && depth > 0) {
    const line = lines[i].trim()

    for (const ch of lines[i]) {
      if (ch === "{") depth++
      if (ch === "}") depth--
    }
    if (depth <= 0) break

    const decMatch = line.match(/^@(\w+)(\((.*))?$/)
    if (decMatch) {
      let decLine = line
      let open  = (decLine.match(/\(/g) ?? []).length
      let close = (decLine.match(/\)/g) ?? []).length
      while (open > close && i + 1 < lines.length) {
        i++
        decLine += lines[i].trim()
        open  += (lines[i].match(/\(/g) ?? []).length
        close += (lines[i].match(/\)/g) ?? []).length
      }
      pendingDecorators.push(decLine)
      i++
      continue
    }

    const fieldMatch = line.match(/^(?:readonly\s+)?(\w+)[?!]?:\s*([\w\[\]<>|&\s]+?)(?:\s*=.*)?;?\s*$/)
    if (fieldMatch && pendingDecorators.length > 0 && depth === 1) {
      fields.push(buildFieldSchema(fieldMatch[1], fieldMatch[2].trim(), pendingDecorators))
      pendingDecorators = []
      i++
      continue
    }

    if (line && !line.startsWith("//") && !line.startsWith("*") && pendingDecorators.length > 0) {
      if (line.includes("(") && line.includes(")")) pendingDecorators = []
    }
    i++
  }

  return { fields, endLine: i }
}

function buildFieldSchema(name: string, rawType: string, decorators: string[]): FieldSchema {
  const rules: ValidationRule[] = []
  const tsType = inferTsType(rawType)
  for (const dec of decorators) rules.push(...parseDecorator(dec))

  const hasRequired = rules.some(r => r.kind === "required")
  const hasOptional = rules.some(r => r.kind === "optional")
  if (!hasRequired && !hasOptional) rules.unshift({ kind: "required" })

  return { name, type: tsType, rules }
}

function inferTsType(raw: string): FieldType {
  const t = raw.toLowerCase().replace(/\s/g, "")
  if (t === "string" || t === "string|null" || t === "null|string") return "string"
  if (t === "number" || t === "number|null" || t === "null|number") return "number"
  if (t === "boolean"|| t === "boolean|null"|| t === "null|boolean") return "boolean"
  if (t.endsWith("[]") || t.startsWith("array<")) return "array"
  if (t === "object"  || t.startsWith("record<")) return "object"
  return "unknown"
}

const ZERO_ARG_RULES: Record<string, RuleKind> = {
  IsNotEmpty: "required", IsOptional: "optional", IsString: "required",
  IsInt: "integer", IsNumber: "required", IsBoolean: "boolean",
  IsEmail: "email", IsUrl: "url", IsUUID: "uuid",
  IsArray: "array", IsPositive: "positive", IsNegative: "negative",
  IsDefined: "required", IsNotEmptyObject: "required",
  IsDate: "date", IsDateString: "date", IsPhoneNumber: "phone",
  IsEthereumAddress: "ethereumAddress", IsAlphanumeric: "alphanumeric",
  IsNumberString: "numberString", ArrayNotEmpty: "array",
}

function parseDecorator(line: string): ValidationRule[] {
  const body    = line.startsWith("@") ? line.slice(1) : line
  const paren   = body.indexOf("(")
  const name    = paren === -1 ? body : body.slice(0, paren)
  const argsStr = paren === -1 ? "" : body.slice(paren + 1, body.lastIndexOf(")"))

  if (name in ZERO_ARG_RULES) return [{ kind: ZERO_ARG_RULES[name] }]

  const num = parseFloat(argsStr)
  switch (name) {
    case "Min":          return !isNaN(num) ? [{ kind: "min",          value: num }] : []
    case "Max":          return !isNaN(num) ? [{ kind: "max",          value: num }] : []
    case "MinLength":    return !isNaN(num) ? [{ kind: "minLength",    value: num }] : []
    case "MaxLength":    return !isNaN(num) ? [{ kind: "maxLength",    value: num }] : []
    case "ArrayMinSize": return !isNaN(num) ? [{ kind: "arrayMinSize", value: num }] : []
    case "ArrayMaxSize": return !isNaN(num) ? [{ kind: "arrayMaxSize", value: num }] : []
    case "Length": {
      const parts = argsStr.split(",").map(s => parseFloat(s.trim()))
      const rules: ValidationRule[] = []
      if (!isNaN(parts[0])) rules.push({ kind: "minLength", value: parts[0] })
      if (parts[1] !== undefined && !isNaN(parts[1])) rules.push({ kind: "maxLength", value: parts[1] })
      return rules
    }
    case "IsEnum": {
      const e = argsStr.trim()
      return e ? [{ kind: "enum", value: e }] : []
    }
    case "IsIn": {
      const m = argsStr.match(/\[([^\]]*)\]/)
      const values = m ? [...m[1].matchAll(/['"]([^'"]*)['"]/g)].map(x => x[1]) : []
      return [{ kind: "isIn", value: values }]
    }
    case "Matches": {
      const m = argsStr.match(/^\/(.+)\/([gimsuy]*)$/)
      return m ? [{ kind: "regex", value: `/${m[1]}/${m[2]}` }] : []
    }
  }
  return []
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scans a NestJS project and returns all DTOSchema[] extracted from
 * class-validator annotated classes.
 *
 * @param projectRoot - Absolute path to the NestJS project root
 * @returns Map of className → DTOSchema, and flat array of all schemas
 */
export function parseDTOSchemas(projectRoot: string): {
  schemas: DTOSchema[]
  index:   Map<string, DTOSchema>
} {
  const files      = findTsFiles(projectRoot)
  const classIndex = buildClassIndex(files)
  const schemas: DTOSchema[] = []
  const index = new Map<string, DTOSchema>()

  for (const [className, file] of classIndex) {
    if (!looksLikeDTO(file.content)) continue
    const parsed = parseDTOFile(file.content, file.rel)
    for (const schema of parsed) {
      schemas.push(schema)
      index.set(schema.className, schema)
    }
  }

  return { schemas, index }
}
