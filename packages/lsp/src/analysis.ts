import type { AnalysisResult } from "@kidkender/archmind-protocol"
import { buildIndexes } from "@kidkender/archmind-protocol"
import { analyzeProject } from "@kidkender/archmind-analysis"

export class AnalysisService {
  constructor(private readonly projectRoot: string) {}

  async analyze(): Promise<AnalysisResult> {
    const routes  = await analyzeProject(this.projectRoot)
    const findings = routes.flatMap(r => r.findings)
    // graph is not needed by the LSP server (routesByFile builds from routes only)
    const indexes  = buildIndexes([], routes)
    return { graph: [], routes, findings, indexes }
  }
}
