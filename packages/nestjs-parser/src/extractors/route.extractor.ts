import { Project, Node } from "ts-morph"
import type { Decorator } from "ts-morph"
import path from "path"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import type { NestJSSemanticRoute } from "../types.js"
import type { GuardDescriptor } from "../types.js"
import { extractGuards } from "./guard.extractor.js"
import { extractDto } from "./dto.extractor.js"
import { extractSideEffects } from "./side-effect.extractor.js"
import { extractServiceCalls } from "./service-call.extractor.js"
import { extractTransactions } from "./transaction.extractor.js"
import { extractResponseResource } from "./response.extractor.js"
import { scanCustomDecorators } from "../resolvers/decorator.scanner.js"
import type { CustomDecoratorRegistry } from "../resolvers/decorator.scanner.js"
import type { ArchMindUserConfig } from "@kidkender/archmind-protocol"

const HTTP_METHOD_MAP: Record<string, string> = {
  Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE",
  Patch: "PATCH", Options: "OPTIONS", Head: "HEAD", All: "ALL",
}

export interface RouteExtractorOptions {
  projectRoot: string
  tsConfigPath?: string
  customDecorators?: CustomDecoratorRegistry
  userConfig?: ArchMindUserConfig
  // When provided, skip Project creation and addSourceFilesAtPaths — caller is responsible
  // for refreshing changed files before calling.
  project?: Project
}

/**
 * `tsConfigFilePath` (when given) is read only for its `compilerOptions` — `paths`/`baseUrl`
 * for resolving TS path-alias imports (e.g. `@config/app.routes`) — never for its `include`,
 * since skipAddingFilesFromTsConfig still applies. Without this, path-alias imports of
 * shared route-constants objects (routesV1.version, etc.) can't be resolved cross-file.
 */
export function createNestProject(tsConfigFilePath?: string): Project {
  if (tsConfigFilePath && existsSync(tsConfigFilePath)) {
    return new Project({
      tsConfigFilePath,
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      compilerOptions: { allowJs: true, noEmit: true, skipLibCheck: true, strict: false },
    })
  }
  return new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, noEmit: true, skipLibCheck: true, strict: false },
  })
}

export function extractRoutes(options: RouteExtractorOptions): NestJSSemanticRoute[] {
  const { projectRoot, userConfig } = options
  const customDecorators = options.customDecorators ?? scanCustomDecorators(projectRoot, userConfig)

  let project: Project
  if (options.project) {
    project = options.project
  } else {
    project = createNestProject(options.tsConfigPath ?? path.join(projectRoot, "tsconfig.json"))
    project.addSourceFilesAtPaths(
      path.join(projectRoot, "**/*.controller.ts").replace(/\\/g, "/")
    )
    // @Cron jobs commonly live outside *.controller.ts (services, dedicated
    // job/task files). Cheap text pre-filter avoids loading the whole
    // project into ts-morph just to find a handful of cron methods.
    for (const file of findFilesContaining(projectRoot, "@Cron", [".controller.ts"])) {
      try { project.addSourceFileAtPath(file) } catch { /* already added or unreadable */ }
    }
  }

  const routes: NestJSSemanticRoute[] = []

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = path
      .relative(projectRoot, sourceFile.getFilePath())
      .replace(/\\/g, "/")

    for (const cls of sourceFile.getClasses()) {
      const controllerDec = cls.getDecorator("Controller")
      if (controllerDec) {
        const { prefix, version: ctrlVersion } = resolveControllerDecArgs(controllerDec)
        const controllerGuards = [
          ...extractGuards(cls.getDecorators(), userConfig),
          ...extractCustomDecoratorGuards(cls.getDecorators(), customDecorators),
        ]
        const controllerIsPublic = Boolean(cls.getDecorator("Public"))

        for (const method of cls.getMethods()) {
          const httpDec = method.getDecorators().find(d => HTTP_METHOD_MAP[d.getName()])
          if (!httpDec) continue

          const httpMethod = HTTP_METHOD_MAP[httpDec.getName()]
          const methodPath = resolveMethodPath(httpDec)
          // Method-level @Version() takes precedence over controller-level
          const version = resolveMethodVersion(method.getDecorators()) ?? ctrlVersion
          const fullPath = buildVersionedPath(prefix, methodPath, version)

          const methodIsPublic = Boolean(method.getDecorator("Public"))
          const isPublic = controllerIsPublic || methodIsPublic

          const methodGuards = [
            ...extractGuards(method.getDecorators(), userConfig),
            ...extractCustomDecoratorGuards(method.getDecorators(), customDecorators),
          ]
          // @Public() suppresses guard inheritance from controller level
          const guards = isPublic ? [] : [...controllerGuards, ...methodGuards]

          const { dto, validationPipe } = extractDto(method)
          const sideEffects  = extractSideEffects(cls, method)
          let serviceCalls: ReturnType<typeof extractServiceCalls> = []
          try { serviceCalls = extractServiceCalls(cls, method) } catch { /* skip on parse error */ }
          let transactions: ReturnType<typeof extractTransactions> = []
          try { transactions = extractTransactions(cls, method) } catch { /* skip on parse error */ }
          let responseResource: ReturnType<typeof extractResponseResource> = null
          try { responseResource = extractResponseResource(cls, method, project, projectRoot) } catch { /* skip on parse error */ }

          routes.push({
            kind: "http",
            method: httpMethod,
            path: fullPath,
            symbol: `${cls.getName() ?? "UnknownController"}::${method.getName()}`,
            controllerClass: cls.getName() ?? "UnknownController",
            file: filePath,
            line: method.getNameNode().getStartLineNumber(),
            guards,
            isPublic,
            validationPipe,
            dto,
            sideEffects,
            serviceCalls,
            transactions,
            responseResource,
          })
        }
        continue
      }

      // Non-controller class: look for @Cron-decorated methods
      // (@nestjs/schedule jobs commonly live in @Injectable() services).
      for (const method of cls.getMethods()) {
        const cronDec = method.getDecorator("Cron")
        if (!cronDec) continue

        const expression = resolveCronExpression(cronDec)
        const guards = [
          ...extractGuards(cls.getDecorators(), userConfig),
          ...extractGuards(method.getDecorators(), userConfig),
        ]
        const sideEffects = extractSideEffects(cls, method)
        let serviceCalls: ReturnType<typeof extractServiceCalls> = []
        try { serviceCalls = extractServiceCalls(cls, method) } catch { /* skip on parse error */ }
        let transactions: ReturnType<typeof extractTransactions> = []
        try { transactions = extractTransactions(cls, method) } catch { /* skip on parse error */ }

        routes.push({
          kind: "cron",
          method: "CRON",
          path: expression,
          symbol: `${cls.getName() ?? "UnknownClass"}::${method.getName()}`,
          controllerClass: cls.getName() ?? "UnknownClass",
          file: filePath,
          line: method.getNameNode().getStartLineNumber(),
          guards,
          isPublic: false,
          validationPipe: false,
          dto: null,
          sideEffects,
          serviceCalls,
          transactions,
          responseResource: null,
          cron: { expression },
        })
      }
    }
  }

  return routes
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage"])

/** Find .ts files (excluding any suffix in `excludeSuffixes` and test/spec files) whose raw text contains `needle`. */
function findFilesContaining(root: string, needle: string, excludeSuffixes: string[]): string[] {
  const out: string[] = []
  walkForNeedle(root, needle, excludeSuffixes, out)
  return out
}

function walkForNeedle(dir: string, needle: string, excludeSuffixes: string[], out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      walkForNeedle(full, needle, excludeSuffixes, out)
      continue
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts") || entry.endsWith(".test.ts")) continue
    if (excludeSuffixes.some((suffix) => entry.endsWith(suffix))) continue
    try {
      const content = readFileSync(full, "utf-8")
      if (content.includes(needle)) out.push(full)
    } catch {
      // unreadable file — skip
    }
  }
}

/**
 * Resolve a route/prefix argument that isn't a literal — e.g. `@Controller(routesV1.version)`
 * or `@Post(routesV1.user.root)` referencing a shared route-constants object — by walking
 * identifier → variable declaration → object literal → property chains back to a literal.
 * Found via real-repo blind test (domain-driven-hexagon): without this, the raw expression
 * text ("routesV1.version") was emitted as the path segment instead of its resolved value.
 */
/**
 * Route-constants objects (e.g. domain-driven-hexagon's `routesV1`) commonly live in a
 * shared config file, not the controller file itself. The Project only ever loads
 * *.controller.ts files (skipFileDependencyResolution: true — see createNestProject), so
 * ts-morph's own symbol resolution can't see across that import. Resolve the relative
 * import path by hand and lazily add the target file to the project on demand.
 */
function resolveCrossFileDeclaration(identifier: Node): Node | undefined {
  if (!Node.isIdentifier(identifier)) return undefined
  const name = identifier.getText()
  const sourceFile = identifier.getSourceFile()

  for (const imp of sourceFile.getImportDeclarations()) {
    const named = imp.getNamedImports().find((ni) => (ni.getAliasNode()?.getText() ?? ni.getName()) === name)
    if (!named) continue

    const exportedName = named.getName()

    // ts-morph resolves both relative and (with paths/baseUrl configured — see
    // createNestProject) TS path-alias specifiers, lazily loading the target file
    // into the project if it exists on disk and isn't already added.
    const targetFile = imp.getModuleSpecifierSourceFile()
    if (targetFile) {
      const varDecl = targetFile.getVariableDeclaration(exportedName)
      if (varDecl) return varDecl
    }

    // Fallback for relative specifiers when module resolution didn't kick in.
    const specifier = imp.getModuleSpecifierValue()
    if (!specifier.startsWith(".")) return undefined
    const baseDir = sourceFile.getDirectoryPath()
    const project  = sourceFile.getProject()
    for (const suffix of [".ts", ".tsx", "/index.ts"]) {
      const candidate = path.resolve(baseDir, specifier + suffix)
      if (!existsSync(candidate)) continue
      const file = project.getSourceFile(candidate) ?? project.addSourceFileAtPath(candidate)
      const varDecl = file.getVariableDeclaration(exportedName)
      if (varDecl) return varDecl
    }
    return undefined
  }
  return undefined
}

function resolveValueNode(node: Node): Node | null {
  if (Node.isIdentifier(node)) {
    // A local variable's own declaration resolves directly; an imported identifier's
    // symbol resolves to its ImportSpecifier (not a VariableDeclaration) — cross-file
    // resolution is needed in that case, not just when there's no declaration at all.
    let decl = node.getSymbol()?.getDeclarations()[0]
    if (!decl || !Node.isVariableDeclaration(decl)) {
      decl = resolveCrossFileDeclaration(node) ?? decl
    }
    if (decl && Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer()
      return init ? resolveValueNode(init) : null
    }
    return null
  }
  if (Node.isPropertyAccessExpression(node)) {
    const objNode = resolveValueNode(node.getExpression())
    if (objNode && Node.isObjectLiteralExpression(objNode)) {
      const prop = objNode.getProperty(node.getName())
      if (prop && Node.isPropertyAssignment(prop)) {
        const init = prop.getInitializer()
        return init ? resolveValueNode(init) : null
      }
    }
    return null
  }
  return node
}

function resolveStringConstant(node: Node): string | null {
  const resolved = resolveValueNode(node)
  if (!resolved) return null
  if (Node.isStringLiteral(resolved) || Node.isNoSubstitutionTemplateLiteral(resolved)) {
    return resolved.getLiteralText()
  }
  if (Node.isTemplateExpression(resolved)) {
    let out = resolved.getHead().getLiteralText()
    for (const span of resolved.getTemplateSpans()) {
      out += resolveStringConstant(span.getExpression()) ?? span.getExpression().getText()
      out += span.getLiteral().getLiteralText()
    }
    return out
  }
  return null
}

function resolveCronExpression(dec: Decorator): string {
  const args = dec.getCallExpression()?.getArguments() ?? []
  if (!args.length) return "unknown"
  return args[0].getText().replace(/^['"`]|['"`]$/g, "")
}

function resolveControllerDecArgs(dec: Decorator): { prefix: string; version: string | null } {
  const args = dec.getCallExpression()?.getArguments() ?? []
  if (!args.length) return { prefix: "/", version: null }

  const text = args[0].getText().trim()

  // Object form: @Controller({ path: 'users', version: '1' })
  if (text.startsWith("{")) {
    const pathMatch = text.match(/path:\s*['"`]([^'"`]+)['"`]/)
    const versionMatch = text.match(/version:\s*['"`]([^'"`]+)['"`]/)
    const rawPath = pathMatch?.[1] ?? ""
    const version = versionMatch?.[1] ?? null
    const prefix = rawPath ? (rawPath.startsWith("/") ? rawPath : `/${rawPath}`) : "/"
    return { prefix, version }
  }

  // String form: @Controller('users')
  const literal = /^['"`]/.test(text)
  const raw = literal ? text.replace(/['"` ]/g, "") : (resolveStringConstant(args[0]) ?? text)
  return { prefix: raw.startsWith("/") ? raw : `/${raw}`, version: null }
}

function resolveMethodVersion(decorators: Decorator[]): string | null {
  const dec = decorators.find(d => d.getName() === "Version")
  if (!dec) return null
  const args = dec.getCallExpression()?.getArguments() ?? []
  if (!args.length) return null
  return args[0].getText().replace(/['"` ]/g, "")
}

function resolveMethodPath(dec: Decorator): string {
  const args = dec.getCallExpression()?.getArguments() ?? []
  if (!args.length) return ""
  const text = args[0].getText().trim()
  if (/^['"`]/.test(text)) return text.replace(/['"]/g, "")
  return resolveStringConstant(args[0]) ?? text.replace(/['"]/g, "")
}

function joinPaths(prefix: string, suffix: string): string {
  const p = prefix === "/" ? "" : prefix.replace(/\/$/, "")
  const s = suffix ? (suffix.startsWith("/") ? suffix : `/${suffix}`) : ""
  return `${p}${s}` || "/"
}

function buildVersionedPath(prefix: string, methodPath: string, version: string | null): string {
  const basePath = joinPaths(prefix, methodPath)
  if (!version) return basePath
  const vPrefix = `/v${version}`
  return basePath === "/" ? vPrefix : `${vPrefix}${basePath}`
}

/** Resolve guards applied via custom decorators (e.g. @Auth() wrapping applyDecorators(UseGuards(...))). */
function extractCustomDecoratorGuards(
  decorators: Decorator[],
  registry: CustomDecoratorRegistry
): GuardDescriptor[] {
  const guards: GuardDescriptor[] = []
  for (const dec of decorators) {
    const name = dec.getName()
    const mapped = registry.get(name)
    if (mapped?.length) guards.push(...mapped)
  }
  return guards
}
