import type { Decorator } from "ts-morph"
import type { GuardDescriptor } from "../types.js"
import { classifyGuard } from "../resolvers/guard.classifier.js"
import type { ArchMindUserConfig } from "@kidkender/archmind-protocol"

// Metadata decorators that carry role/permission args consumed by authz guards
const METADATA_DECORATORS = new Set(["Roles", "Permissions", "RequirePermissions"])

export function extractGuards(decorators: Decorator[], userConfig?: ArchMindUserConfig): GuardDescriptor[] {
  // First pass: collect metadata args (@Roles, @Permissions, etc.)
  const metadataArgs: string[] = []
  for (const dec of decorators) {
    if (!METADATA_DECORATORS.has(dec.getName())) continue
    const args = dec.getCallExpression()?.getArguments() ?? []
    metadataArgs.push(...args.map(a => a.getText().replace(/['"]/g, "")))
  }

  const guards: GuardDescriptor[] = []

  // Second pass: process @UseGuards(...)
  for (const dec of decorators) {
    if (dec.getName() !== "UseGuards") continue
    const callArgs = dec.getCallExpression()?.getArguments() ?? []

    for (const arg of callArgs) {
      const text = arg.getText().trim()

      // AuthGuard('strategy') — call expression with string arg e.g. AuthGuard('jwt')
      const callWithArg = text.match(/^(\w+)\(['"]([^'"]+)['"]\)$/)
      if (callWithArg) {
        const [, className, strategyArg] = callWithArg
        guards.push({ className, args: [strategyArg], irType: classifyGuard(className, userConfig) })
        continue
      }

      // AuthGuard() — call expression with no args (pre-configured factory result)
      const callNoArg = text.match(/^(\w+)\(\)$/)
      if (callNoArg) {
        const [, className] = callNoArg
        guards.push({ className, args: [], irType: classifyGuard(className, userConfig) })
        continue
      }

      // Plain class reference: RolesGuard, JwtAuthGuard, etc.
      const className = text
      const irType = classifyGuard(className, userConfig)
      guards.push({
        className,
        args: irType === "ir:authz_check" ? [...metadataArgs] : [],
        irType,
      })
    }
  }

  return guards
}
