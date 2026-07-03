import type { AnalysisResult } from "@kidkender/archmind-protocol"

export interface WorkspaceCache {
  analysis:         AnalysisResult
  analysisVersion:  number            // increments on each re-analysis
  documentVersions: Map<string, number>  // uri → LSP document version at analysis time
  lastAnalyzed:     number            // Date.now()
}
