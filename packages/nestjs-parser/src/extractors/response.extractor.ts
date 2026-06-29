import type { ClassDeclaration, MethodDeclaration } from "ts-morph"
import { Project } from "ts-morph"
import path from "path"

export interface ResponseField {
  name: string
  isSensitive: boolean
}

export interface ResponseResourceDescriptor {
  className:        string         // e.g. "UserResponseDto"
  fields:           ResponseField[]
  sensitiveFields:  string[]
  excludedByDefault: boolean       // class-level @Exclude()
}

const SENSITIVE_RE = /secret|token|password|passwd|internal|admin_|_admin|private|api_?key|_hash|hash_/i

// Patterns for class names that indicate serialized response objects
const RESPONSE_CLASS_RE = /(?:Dto|Resource|Response|Payload|Output|View)$/

/**
 * Detect the serialized response resource for a NestJS route method.
 *
 * Two signals are checked in order:
 *   1. Explicit `plainToInstance(ClassName, ...)` or `plainToClass(ClassName, ...)` call
 *   2. Return type annotation text ending in Dto|Resource|Response|Payload|Output|View
 *
 * If found, the class is scanned for @Expose() / @Exclude() decorators.
 */
export function extractResponseResource(
  cls: ClassDeclaration,
  method: MethodDeclaration,
  project: Project,
  projectRoot: string,
): ResponseResourceDescriptor | null {
  const className = detectResponseClassName(method)
  if (!className) return null

  const fields         = scanResponseClass(project, projectRoot, className)
  const sensitiveFields = fields.filter(f => f.isSensitive).map(f => f.name)
  const excludedByDefault = hasClassLevelExclude(project, className)

  return { className, fields, sensitiveFields, excludedByDefault }
}

// ─── Detection helpers ────────────────────────────────────────────────────────

function detectResponseClassName(method: MethodDeclaration): string | null {
  // Signal 1: plainToInstance(ClassName, ...) or plainToClass(ClassName, ...)
  const bodyText = method.getBody()?.getText() ?? ""
  const plainToMatch = bodyText.match(/plain(?:ToInstance|ToClass)\s*\(\s*([A-Z][A-Za-z0-9_]*)\s*,/)
  if (plainToMatch?.[1]) return plainToMatch[1]

  // Signal 2: return type annotation text — unwrap Promise<T>
  const returnTypeText = method.getReturnTypeNode()?.getText() ?? ""
  if (!returnTypeText) return null

  const unwrapped = unwrapPromise(returnTypeText)
  if (RESPONSE_CLASS_RE.test(unwrapped)) return unwrapped

  return null
}

function unwrapPromise(typeText: string): string {
  const m = typeText.match(/^Promise\s*<\s*(.+?)\s*>$/)
  return m ? m[1].trim() : typeText.trim()
}

// ─── Class scanning ───────────────────────────────────────────────────────────

function scanResponseClass(project: Project, projectRoot: string, className: string): ResponseField[] {
  // Lazily add DTO/Resource/Response source files — guard per suffix so that
  // having .dto.ts files does not block .response.ts and .resource.ts from loading.
  const dtoSuffixes = [".dto.", ".response.", ".resource."] as const
  const dtoPaths = dtoSuffixes.map(s =>
    path.join(projectRoot, `**/*${s}ts`).replace(/\\/g, "/")
  )
  for (let i = 0; i < dtoPaths.length; i++) {
    const suffix = dtoSuffixes[i]
    if (!project.getSourceFiles().some(sf => sf.getFilePath().includes(suffix))) {
      try { project.addSourceFilesAtPaths(dtoPaths[i]) } catch { /* ignore */ }
    }
  }

  for (const sf of project.getSourceFiles()) {
    const cls = sf.getClass(className)
    if (!cls) continue
    return extractExposeFields(cls)
  }

  return []
}

function extractExposeFields(cls: ClassDeclaration): ResponseField[] {
  const fields: ResponseField[] = []
  for (const prop of cls.getProperties()) {
    const hasExpose  = prop.getDecorators().some(d => d.getName() === "Expose")
    const hasExclude = prop.getDecorators().some(d => d.getName() === "Exclude")
    if (hasExclude) continue
    if (!hasExpose) continue  // only @Expose() fields are included in output
    const name = prop.getName()
    fields.push({ name, isSensitive: SENSITIVE_RE.test(name) })
  }
  return fields
}

function hasClassLevelExclude(project: Project, className: string): boolean {
  for (const sf of project.getSourceFiles()) {
    const cls = sf.getClass(className)
    if (!cls) continue
    return cls.getDecorators().some(d => d.getName() === "Exclude")
  }
  return false
}
