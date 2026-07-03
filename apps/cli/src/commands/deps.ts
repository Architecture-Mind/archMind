import { buildDependencyIndex, queryDependents } from "@kidkender/archmind-retrieval"
import { parseProject, requireProject } from "../utils/parse-project.js"

export function runDeps(flags: Record<string, string>, positional: string[]): void {
  const projectRoot = requireProject(flags)
  const target      = positional[0] ?? flags["class"]

  if (!target) {
    console.error("Usage: archmind deps --project <path> <ServiceClass>")
    console.error("  Example: archmind deps --project . OrderService")
    process.exit(2)
  }

  const { graphs, routeCount } = parseProject(projectRoot)
  const index = buildDependencyIndex(graphs)
  const hits  = queryDependents(index, target)

  if (hits.length === 0) {
    console.log(`No routes depend on "${target}"`)
    console.log(`(searched ${routeCount} routes)`)
    process.exit(0)
  }

  console.log(`Routes depending on "${target}" (${hits.length}/${routeCount}):\n`)
  for (const h of hits) {
    console.log(`  ${h.entrypoint}`)
    for (const n of h.matchingNodes) {
      console.log(`    via: ${n.symbol ?? n.id}  [${n.type}]`)
      if (n.file) console.log(`    file: ${n.file}`)
    }
    console.log()
  }

  process.exit(0)
}
