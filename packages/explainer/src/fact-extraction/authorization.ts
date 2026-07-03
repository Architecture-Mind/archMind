import type { IntermediateExecutionGraph, ExecutionNode } from "@kidkender/archmind-protocol"
import type { AuthorizationCheckFact } from "./types.js"

// Normalize to a short ability token:
//   "task.update"           → "update"
//   "TASK_UPDATE"           → "update"
//   "Permission::TASK_UPDATE" → "update"   (strip class prefix first)
//   "update"               → "update"
export function normalizeAbility(raw: string): string {
  const s = raw.trim()

  // "ClassName::CONSTANT" — normalize just the constant part recursively
  if (s.includes("::")) {
    const constant = s.split("::").pop()!
    return normalizeAbility(constant)
  }

  if (s.includes(".")) {
    const parts = s.split(".")
    return parts[parts.length - 1]!.toLowerCase()
  }

  if (/^[A-Z][A-Z0-9_]+$/.test(s)) {
    const parts = s.split("_")
    return (parts[1] ?? parts[0])!.toLowerCase()
  }

  return s.toLowerCase()
}

function extractPermissionFromArgs(args: string[] | undefined): string | null {
  if (!args || args.length === 0) return null
  return args[0] ?? null
}

function extractPermissionFromMechanism(mechanism: string | undefined): string | null {
  if (!mechanism) return null
  // e.g. "$this->authorize('update', $task)" or "Gate::allows('task.update')"
  const match = mechanism.match(/['"]([^'"]+)['"]/)
  return match ? (match[1] ?? null) : null
}

function classifyLayer(node: ExecutionNode): AuthorizationCheckFact["layer"] {
  const t = node.type.toLowerCase()
  // IR types (preferred)
  if (t === "ir:auth_gate")           return "middleware"
  if (t === "ir:authz_check")         return "policy"
  if (t === "ir:service_call")        return "service"
  if (t === "ir:permission_constant") return "constant"
  // Legacy type strings (backwards compat)
  if (t === "middleware" || t === "authorization_check" || t === "authentication_gate") return "middleware"
  if (t === "policy")       return "policy"
  if (t === "service_call") return "service"
  if (t === "permission")   return "constant"
  return "unknown"
}

function inferConfidence(node: ExecutionNode, permission: string | null): AuthorizationCheckFact["confidence"] {
  if (permission !== null) return "HIGH"
  if (node.role) return "MEDIUM"
  return "LOW"
}

const AUTH_NODE_TYPES = new Set([
  // IR types
  "ir:auth_gate",
  "ir:authz_check",
  "ir:service_call",
  "ir:permission_constant",
  // Legacy types (backwards compat)
  "middleware",
  "authentication_gate",
  "authorization_check",
  "policy",
  "service_call",
  "permission",
])

// ir:validation_gate::authorize and form_request are handled by the validation gate extractor
const EXCLUDED_NODE_TYPES = new Set([
  // IR types
  "ir:business_handler",
  "ir:entrypoint",
  "ir:validation_gate",
  "ir:resource",
  // Legacy types
  "controller_action",
  "controller",
  "form_request",
  "entrypoint",
])

function isAuthorizationNode(node: ExecutionNode): boolean {
  const t = node.type.toLowerCase()
  if (EXCLUDED_NODE_TYPES.has(t)) return false
  if (AUTH_NODE_TYPES.has(t)) return true

  const sym = node.symbol.toLowerCase()
  return (
    sym.includes("permission") ||
    sym.includes("authorize") ||
    sym.includes("gate") ||
    sym.includes("policy")
  )
}

export function extractAuthorizationFacts(
  graph: IntermediateExecutionGraph
): AuthorizationCheckFact[] {
  const facts: AuthorizationCheckFact[] = []

  for (const node of graph.nodes) {
    if (!isAuthorizationNode(node)) continue

    const edge = graph.edges.find((e) => e.to === node.id || e.from === node.id)
    const mechanism = edge?.mechanism ?? null

    const permission =
      extractPermissionFromArgs(node.args) ??
      extractPermissionFromMechanism(mechanism ?? undefined)

    const ability = permission ? normalizeAbility(permission) : null
    const layer = classifyLayer(node)
    const confidence = inferConfidence(node, permission)

    facts.push({
      kind: "authorization_check",
      nodeId: node.id,
      symbol: node.symbol,
      permission,
      ability,
      layer,
      mechanism,
      confidence,
    })
  }

  return facts
}
