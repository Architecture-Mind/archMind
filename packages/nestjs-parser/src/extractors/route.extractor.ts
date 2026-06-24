import { Project } from "ts-morph"
import type { Decorator } from "ts-morph"
import path from "path"
import type { NestJSSemanticRoute } from "../types.js"
import type { GuardDescriptor } from "../types.js"
import { extractGuards } from "./guard.extractor.js"
import { extractDto } from "./dto.extractor.js"
import { extractSideEffects } from "./side-effect.extractor.js"
import { extractServiceCalls } from "./service-call.extractor.js"
import { scanCustomDecorators } from "../resolvers/decorator.scanner.js"
import type { CustomDecoratorRegistry } from "../resolvers/decorator.scanner.js"

const HTTP_METHOD_MAP: Record<string, string> = {
  Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE",
  Patch: "PATCH", Options: "OPTIONS", Head: "HEAD", All: "ALL",
}

export interface RouteExtractorOptions {
  projectRoot: string
  tsConfigPath?: string
  customDecorators?: CustomDecoratorRegistry
}

export function extractRoutes(options: RouteExtractorOptions): NestJSSemanticRoute[] {
  const { projectRoot } = options
  const customDecorators = options.customDecorators ?? scanCustomDecorators(projectRoot)

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, noEmit: true, skipLibCheck: true, strict: false },
  })

  project.addSourceFilesAtPaths(
    path.join(projectRoot, "**/*.controller.ts").replace(/\\/g, "/")
  )

  const routes: NestJSSemanticRoute[] = []

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = path
      .relative(projectRoot, sourceFile.getFilePath())
      .replace(/\\/g, "/")

    for (const cls of sourceFile.getClasses()) {
      const controllerDec = cls.getDecorator("Controller")
      if (!controllerDec) continue

      const { prefix, version: ctrlVersion } = resolveControllerDecArgs(controllerDec)
      const controllerGuards = [
        ...extractGuards(cls.getDecorators()),
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
          ...extractGuards(method.getDecorators()),
          ...extractCustomDecoratorGuards(method.getDecorators(), customDecorators),
        ]
        // @Public() suppresses guard inheritance from controller level
        const guards = isPublic ? [] : [...controllerGuards, ...methodGuards]

        const { dto, validationPipe } = extractDto(method)
        const sideEffects  = extractSideEffects(cls, method)
        let serviceCalls: ReturnType<typeof extractServiceCalls> = []
        try { serviceCalls = extractServiceCalls(cls, method) } catch { /* skip on parse error */ }

        routes.push({
          method: httpMethod,
          path: fullPath,
          symbol: `${cls.getName() ?? "UnknownController"}::${method.getName()}`,
          controllerClass: cls.getName() ?? "UnknownController",
          file: filePath,
          guards,
          isPublic,
          validationPipe,
          dto,
          sideEffects,
          serviceCalls,
        })
      }
    }
  }

  return routes
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
  const raw = text.replace(/['"` ]/g, "")
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
  return args[0].getText().replace(/['"]/g, "")
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
