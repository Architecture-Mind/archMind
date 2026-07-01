import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import type { SemanticAdapter } from "@kidkender/archmind-protocol"
import { findJavaFiles, isControllerFile } from "./scanner.js"
import { parseControllerFile } from "./controller-parser.js"
import { emitGraph } from "./ir-emitter.js"

export class SpringBootAdapter implements SemanticAdapter {
  parseProject(root: string): IntermediateExecutionGraph[] {
    const javaFiles = findJavaFiles(root).filter(isControllerFile)
    const graphs: IntermediateExecutionGraph[] = []

    for (const file of javaFiles) {
      try {
        const methods = parseControllerFile(file)
        for (const m of methods) {
          graphs.push(emitGraph(m))
        }
      } catch {
        // skip files that fail to parse
      }
    }

    return graphs
  }
}

export function parseSpringBootProject(root: string): IntermediateExecutionGraph[] {
  return new SpringBootAdapter().parseProject(root)
}
