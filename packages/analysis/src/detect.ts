import type { RouteInfo, FindingInfo, ArchMindUserConfig } from "@kidkender/archmind-protocol"
import { MUTATION_METHODS } from "@kidkender/archmind-protocol"

const DEFAULT_CREDENTIAL_RE = /login|signin|auth|token|password/i

export function detectFindings(
  route: Omit<RouteInfo, "findings">,
  userConfig?: ArchMindUserConfig
): FindingInfo[] {
  const { method, path, authGates, authzChecks, services, symbol, isPublic, throttled } = route

  if (isPublic) return []

  const findings: FindingInfo[] = []

  // 1. broken_access_control — mutation with NO auth whatsoever (CRITICAL)
  if (MUTATION_METHODS.has(method) && authGates.length === 0 && authzChecks.length === 0) {
    findings.push({
      type:     "broken_access_control",
      severity: "CRITICAL",
      summary:  `${method} ${path} has NO authentication — completely unprotected mutation endpoint`,
    })
  }

  // 2. missing_authorization — authenticated but no role/ownership check (HIGH)
  if (MUTATION_METHODS.has(method) && authGates.length > 0 && authzChecks.length === 0) {
    findings.push({
      type:     "missing_authorization",
      severity: "HIGH",
      summary:  `${method} ${path} is authenticated but has no role/ownership check — any logged-in user can perform this mutation`,
    })
  }

  // 3. exposed_read_endpoint — public GET with business logic (LOW)
  if (method === "GET" && authGates.length === 0 && services.length > 0) {
    findings.push({
      type:     "exposed_read_endpoint",
      severity: "LOW",
      summary:  `GET ${path} has no auth guard but calls ${services.length} service(s) — business logic is publicly accessible`,
    })
  }

  // 4. no_rate_limiting — unprotected POST matching credential endpoint path patterns (HIGH).
  // Path matching is a heuristic: graph-based credential detection requires DTO field extraction
  // (not yet in RouteInfo). Patterns are configurable via archmind.json `credentialPaths`.
  if (!throttled && authGates.length === 0 && method === "POST") {
    const credentialRe = userConfig?.credentialPaths?.length
      ? new RegExp(userConfig.credentialPaths.join("|"), "i")
      : DEFAULT_CREDENTIAL_RE
    if (credentialRe.test(path)) {
      findings.push({
        type:     "no_rate_limiting",
        severity: "HIGH",
        summary:  `${method} ${path} looks like an auth endpoint with no rate limiting — vulnerable to brute force`,
      })
    }
  }

  // 5. fat_controller — ≥5 distinct service classes (LOW)
  if (services.length >= 5) {
    const classes = new Set(services.map(s => s.split("::")[0]).filter(Boolean))
    if (classes.size >= 5) {
      findings.push({
        type:     "fat_controller",
        severity: "LOW",
        summary:  `${symbol} depends on ${classes.size} distinct services — violates Single Responsibility`,
      })
    }
  }

  return findings
}
