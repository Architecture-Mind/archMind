import { parseProject, requireProject } from "../utils/parse-project.js"

export function runContext(flags: Record<string, string>, positional: string[]): void {
  const projectRoot = requireProject(flags)
  const entrypoint  = flags["entrypoint"] ?? flags["e"] ?? positional[0]
  const json        = "json" in flags

  const { graphs } = parseProject(projectRoot)

  let buildFn: (g: unknown, f: unknown[]) => unknown
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@kidkender/archmind-context")
    buildFn = mod.buildSemanticContext
  } catch {
    console.error("Error: @kidkender/archmind-context package not found. Run npm install.")
    process.exit(2)
  }

  if (!entrypoint) {
    // No entrypoint specified — print context for all routes
    for (const g of graphs) {
      const ctx = buildFn(g, []) as Record<string, unknown>
      if (json) {
        console.log(JSON.stringify(ctx))
      } else {
        printContext(ctx)
      }
    }
    return
  }

  const norm = entrypoint.trim().toLowerCase()
  const graph = graphs.find(
    (g) => g.entrypoint.toLowerCase() === norm ||
           g.entrypoint.toLowerCase().replace(/\{[^}]+\}/g, "{_}") === norm.replace(/\{[^}]+\}/g, "{_}")
  )

  if (!graph) {
    console.error(`No route found matching: ${entrypoint}`)
    console.error(`Available: ${graphs.map((g) => g.entrypoint).join(", ")}`)
    process.exit(2)
  }

  const ctx = buildFn(graph, []) as Record<string, unknown>

  if (json) {
    console.log(JSON.stringify(ctx, null, 2))
    return
  }

  printContext(ctx)
}

function printContext(ctx: Record<string, unknown>): void {
  const sec = ctx["security"] as Record<string, unknown>
  const txn = ctx["transaction"] as Record<string, unknown>
  const val = ctx["validation"] as Record<string, unknown>

  console.log(`\n${ctx["entrypoint"]}`)
  console.log(`  ${ctx["summary"]}`)
  console.log(`  Risk: ${(sec["risk_level"] as string)}`)
  console.log()

  console.log("  Security:")
  console.log(`    Public:        ${sec["is_public"]}`)
  console.log(`    Auth gates:    ${arr(sec["auth_gates"])}`)
  const authz = sec["authorization"] as Record<string, unknown>
  console.log(`    Authorization: ${authz["enforced"]}  ${arr(authz["checks"])}`)

  console.log("  Transaction:")
  console.log(`    Boundary:     ${txn["has_boundary"]}`)
  if ((txn["escape_risks"] as string[]).length > 0) {
    console.log(`    Escape risks: ${arr(txn["escape_risks"])}`)
  }

  console.log("  Validation:")
  console.log(`    ${arr(val["classes"]) || "(none)"}`)

  if ((ctx["services"] as string[]).length > 0) {
    console.log(`  Services:      ${arr(ctx["services"])}`)
  }
  if ((ctx["async_side_effects"] as string[]).length > 0) {
    console.log(`  Async:         ${arr(ctx["async_side_effects"])}`)
  }
  console.log()
}

function arr(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return ""
  return (v as string[]).join(", ")
}
