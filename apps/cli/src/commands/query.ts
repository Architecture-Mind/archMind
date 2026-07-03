import { parseProject, requireProject } from "../utils/parse-project.js"

export function runQuery(flags: Record<string, string>, positional: string[]): void {
  const projectRoot = requireProject(flags)
  const aqlStr      = flags["q"] ?? flags["query"] ?? positional[0]
  const json        = "json" in flags

  if (!aqlStr) {
    console.error([
      "Usage: archmind query --project <path> \"<AQL>\"",
      "",
      "Examples:",
      "  archmind query --project . \"FIND routes WHERE auth AND NOT transaction\"",
      "  archmind query --project . \"FIND routes WHERE mutation AND missing-authorization\"",
      "  archmind query --project . \"MATCH controller -> service\"",
      "",
      "Predicates:",
      "  auth, no-auth, public",
      "  authorization, no-authorization, missing-authorization",
      "  mutation, readonly",
      "  transaction, no-transaction, transaction-escape",
      "  tenant-scoped, unscoped",
      "  async-dispatch, queue",
    ].join("\n"))
    process.exit(2)
  }

  // Dynamic import keeps @kidkender/archmind-aql out of the CLI's static dependency tree.
  // The package is a devDependency resolved at build time via the workspace.
  let aqlFn: (q: string, g: unknown[]) => { routes: unknown[]; count: number; entrypoints: string[] }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@kidkender/archmind-aql")
    aqlFn = mod.aql
  } catch {
    console.error("Error: @kidkender/archmind-aql package not found. Run npm install.")
    process.exit(2)
  }

  const { graphs } = parseProject(projectRoot)

  let result: ReturnType<typeof aqlFn>
  try {
    result = aqlFn(aqlStr, graphs)
  } catch (e) {
    console.error(`AQL error: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  }

  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Query: ${aqlStr}`)
  console.log(`Found: ${result.count} route(s)\n`)

  if (result.count === 0) {
    console.log("(no routes matched)")
    return
  }

  for (const ep of result.entrypoints) {
    console.log(`  ${ep}`)
  }
}
