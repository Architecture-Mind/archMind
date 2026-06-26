import type { WorkspaceCache } from "./cache.js"
import type { AnalysisService } from "../analysis.js"

export interface WorkspaceContext {
  root:     string
  cache:    WorkspaceCache | null
  analyzer: AnalysisService
}
