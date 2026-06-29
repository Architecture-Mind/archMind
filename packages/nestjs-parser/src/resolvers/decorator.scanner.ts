/**
 * Custom decorator scanner.
 *
 * Finds exported functions in *.decorator(s).ts files that call
 * applyDecorators() containing UseGuards(), and builds a registry:
 *
 *   "Auth" → [{ className: "AuthGuard", irType: "ir:auth_gate" }, ...]
 *
 * Lets the route extractor detect guards applied via @Auth() style
 * custom decorators instead of @UseGuards() directly.
 */

import { readdirSync, statSync } from "fs"
import { join } from "path"
import { Project, SyntaxKind } from "ts-morph"
import type { CallExpression, Node } from "ts-morph"
import { classifyGuard } from "./guard.classifier.js"
import type { GuardDescriptor } from "../types.js"
import type { ArchMindUserConfig } from "@kidkender/archmind-protocol"

export type CustomDecoratorRegistry = Map<string, GuardDescriptor[]>

export function scanCustomDecorators(projectRoot: string, userConfig?: ArchMindUserConfig): CustomDecoratorRegistry {
  const registry: CustomDecoratorRegistry = new Map()

  const files = findDecoratorFiles(projectRoot)
  if (!files.length) return registry

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, noEmit: true, skipLibCheck: true, strict: false },
  })
  project.addSourceFilesAtPaths(files.map(f => f.replace(/\\/g, "/")))

  for (const sourceFile of project.getSourceFiles()) {
    // Regular exported functions
    for (const fn of sourceFile.getFunctions()) {
      if (!fn.isExported()) continue
      const name = fn.getName()
      if (!name) continue
      const guards = extractFromNode(fn, userConfig)
      if (guards.length) registry.set(name, guards)
    }

    // Exported arrow functions / variable declarations
    for (const varDecl of sourceFile.getVariableDeclarations()) {
      const name = varDecl.getName()
      const init = varDecl.getInitializer()
      if (!init) continue
      const arrowFn = init.asKind(SyntaxKind.ArrowFunction)
        ?? init.asKind(SyntaxKind.FunctionExpression)
      if (!arrowFn) continue
      const guards = extractFromNode(arrowFn, userConfig)
      if (guards.length) registry.set(name, guards)
    }
  }

  return registry
}

// ---- Internal helpers ----------------------------------------------------

function findDecoratorFiles(root: string): string[] {
  const results: string[] = []
  function walk(dir: string, depth = 0) {
    if (depth > 6) return
    try {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist" || entry === ".git") continue
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full, depth + 1)
        else if (entry.endsWith(".decorator.ts") || entry.endsWith(".decorators.ts")) results.push(full)
      }
    } catch {}
  }
  walk(root)
  return results
}

/** Walk a function/arrow body, find applyDecorators(UseGuards(...), ...) and extract guards. */
function extractFromNode(node: Node, userConfig?: ArchMindUserConfig): GuardDescriptor[] {
  const calls = node.getDescendantsOfKind(SyntaxKind.CallExpression)

  for (const call of calls) {
    if (call.getExpression().getText() !== "applyDecorators") continue

    for (const arg of call.getArguments()) {
      // arg might be UseGuards(...) itself or contain it nested
      const candidates: CallExpression[] = [
        ...(arg.isKind(SyntaxKind.CallExpression) ? [arg as CallExpression] : []),
        ...arg.getDescendantsOfKind(SyntaxKind.CallExpression),
      ]

      for (const inner of candidates) {
        if (inner.getExpression().getText() !== "UseGuards") continue
        return parseUseGuardsArgs(inner, userConfig)
      }
    }
  }

  return []
}

function parseUseGuardsArgs(useGuardsCall: CallExpression, userConfig?: ArchMindUserConfig): GuardDescriptor[] {
  const guards: GuardDescriptor[] = []

  for (const arg of useGuardsCall.getArguments()) {
    const text = arg.getText().trim()

    // AuthGuard('jwt') — string arg
    const withStr = text.match(/^(\w+)\(['"]([^'"]+)['"]\)$/)
    if (withStr) {
      guards.push({ className: withStr[1], args: [withStr[2]], irType: classifyGuard(withStr[1], userConfig) })
      continue
    }

    // AuthGuard({ public: ... }) — object arg factory
    const withObj = text.match(/^(\w+)\(\{/)
    if (withObj) {
      guards.push({ className: withObj[1], args: [], irType: classifyGuard(withObj[1], userConfig) })
      continue
    }

    // AuthGuard() — no-arg factory
    const noArg = text.match(/^(\w+)\(\)$/)
    if (noArg) {
      guards.push({ className: noArg[1], args: [], irType: classifyGuard(noArg[1], userConfig) })
      continue
    }

    // Plain class reference: RolesGuard
    if (/^\w+$/.test(text)) {
      guards.push({ className: text, args: [], irType: classifyGuard(text, userConfig) })
    }
  }

  return guards
}
