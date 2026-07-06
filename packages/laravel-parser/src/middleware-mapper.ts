import type { ExecutionNode } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import { DEFAULT_PROJECT_CONFIG, fqcnToPath } from "./project-config.js"

// Maps raw Laravel middleware strings → semantic ExecutionNodes.
// This is the bridge between framework syntax and ontology primitives.
//
// Only deterministic mappings — no dynamic resolution.

interface MiddlewareMapping {
  type:   string
  role:   string
  args?:  string[]
}

/**
 * Classify a resolved FQCN by class-name heuristics.
 * Used when a middleware alias has been resolved to a concrete class.
 */
function classifyFqcn(fqcn: string): MiddlewareMapping {
  const short = fqcn.split("\\").pop() ?? fqcn
  if (/Authenticate|Guard/.test(short)) {
    return { type: IR_NODE_TYPES.AUTH_GATE, role: "authentication" }
  }
  if (/Permission|Role|Authorize|CheckAccess|HasRole|EnsureRole|EnsureUser/.test(short)) {
    return { type: IR_NODE_TYPES.AUTHZ_CHECK, role: "authorization" }
  }
  if (/Throttle|RateLimit/.test(short)) {
    return { type: "rate_limiter", role: "rate_limiting" }
  }
  // Resolved to a concrete class, but it doesn't match a known category —
  // an honest "don't know" instead of guessing auth_gate from the mere presence
  // of a middleware node (see IR v1.5 semantic-fidelity plan, Phase 1).
  return { type: IR_NODE_TYPES.UNKNOWN_MIDDLEWARE, role: "unknown" }
}

/**
 * Build an ExecutionNode from an alias-resolved middleware.
 * Used when kernel-parser has resolved the alias to a concrete FQCN.
 */
export function resolvedMiddlewareToNode(
  raw: string,     // original alias string (for stable id generation)
  fqcn: string,    // resolved fully-qualified class name
  args: string[],  // parsed args from alias (e.g. "role:admin" → ["admin"])
  index: number
): ExecutionNode {
  const mapping  = classifyFqcn(fqcn)
  const short    = fqcn.split("\\").pop() ?? fqcn
  const file     = fqcn.includes("\\")
    ? (fqcnToPath(fqcn, DEFAULT_PROJECT_CONFIG.namespaces) ?? undefined)
    : undefined
  const idBase   = raw.toLowerCase().replace(/[^a-z0-9]/g, "_")

  return {
    id:   `mw_${index}_${idBase}`,
    type: mapping.type,
    symbol: short,
    role: mapping.role,
    ...(file              ? { file }         : {}),
    ...(args.length > 0   ? { args }         : {}),
  }
}

function mapMiddleware(raw: string): MiddlewareMapping {
  // auth:sanctum, auth:api, auth:web
  if (/^auth:/.test(raw)) {
    return { type: IR_NODE_TYPES.AUTH_GATE, role: "authentication" }
  }

  // permission:TASK_UPDATE, permission:TASK_VIEW|TASK_UPDATE
  const permMatch = raw.match(/^permission:(.+)$/)
  if (permMatch) {
    return {
      type: IR_NODE_TYPES.AUTHZ_CHECK,
      role: "authorization",
      args: permMatch[1].split("|"),
    }
  }

  // throttle:60,1
  if (/^throttle:/.test(raw)) {
    return { type: "rate_limiter", role: "rate_limiting" }
  }

  // signed
  if (raw === "signed") {
    return { type: "signature_check", role: "authentication" }
  }

  // verified (email verification)
  if (raw === "verified") {
    return { type: "email_verification", role: "authentication" }
  }

  // Class-based middleware — use short class name as symbol
  if (raw.includes("\\") || /^[A-Z]/.test(raw)) {
    return { type: IR_NODE_TYPES.AUTH_GATE, role: "middleware", args: [raw] }
  }

  // Bare, unresolved string with no class/keyword signal (e.g. a group name like
  // "api" that couldn't be resolved to its concrete middleware list) — an honest
  // "don't know" instead of defaulting every unrecognized string to auth_gate,
  // which was the source of the koel false-positive (IR v1.5 plan, Phase 1).
  return { type: IR_NODE_TYPES.UNKNOWN_MIDDLEWARE, role: "unknown" }
}

export function middlewareToNode(raw: string, index: number): ExecutionNode {
  const mapping = mapMiddleware(raw.trim())
  const shortName = raw.split("\\").pop()?.replace(/::class$/, "") ?? raw

  return {
    id:     `mw_${index}_${shortName.toLowerCase().replace(/[^a-z0-9]/g, "_")}`,
    type:   mapping.type,
    symbol: shortName,
    role:   mapping.role,
    args:   mapping.args ?? (raw !== shortName ? [raw] : undefined),
  }
}
