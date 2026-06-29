import type { IntermediateExecutionGraph, ExecutionNode } from "./graph.js"

export const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

export type FindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO"

export interface FindingInfo {
  type:     string
  severity: FindingSeverity
  summary:  string
}

export interface RouteInfo {
  entrypoint:     string
  method:         string
  path:           string
  file:           string
  line:           number
  symbol:         string
  authGates:      string[]
  authzChecks:    string[]
  validations:    string[]
  services:       string[]
  findings:       FindingInfo[]
  hasTransaction: boolean
  throttled:      boolean
  framework:      string
  isPublic:       boolean
}

export interface AnalysisIndexes {
  routesByFile:        Map<string, RouteInfo[]>
  nodeById:            Map<string, ExecutionNode>
  routesByController:  Map<string, RouteInfo[]>
}

export interface AnalysisResult {
  graph:    IntermediateExecutionGraph[]
  routes:   RouteInfo[]
  findings: FindingInfo[]
  indexes:  AnalysisIndexes
}

export function buildIndexes(
  graph: IntermediateExecutionGraph[],
  routes: RouteInfo[],
): AnalysisIndexes {
  const routesByFile       = new Map<string, RouteInfo[]>()
  const routesByController = new Map<string, RouteInfo[]>()
  const nodeById           = new Map<string, ExecutionNode>()

  for (const route of routes) {
    if (route.file) {
      const existing = routesByFile.get(route.file) ?? []
      routesByFile.set(route.file, [...existing, route])
    }
    const controller = route.symbol?.split("::")?.[0]
    if (controller) {
      const existing = routesByController.get(controller) ?? []
      routesByController.set(controller, [...existing, route])
    }
  }

  for (const g of graph) {
    for (const node of g.nodes) {
      nodeById.set(node.id, node)
    }
  }

  return { routesByFile, nodeById, routesByController }
}
