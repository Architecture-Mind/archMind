import { readFileSync } from "fs"

/**
 * A resolved security rule from a SecurityFilterChain bean.
 * Rules are ordered from most-specific to least-specific (as they appear in the config).
 */
export interface SecurityRule {
  pattern:       string                              // e.g. "/*/api/public/**"
  type:          "permit" | "authenticated" | "role" | "deny"
  roles:         string[]                            // for type === "role"
  irAuthType:    "ir:auth_gate" | "ir:authz_check" | null  // null = public
}

/**
 * Scan Java files for SecurityFilterChain beans and extract requestMatchers rules.
 * Returns rules sorted by specificity: most-specific patterns first, catch-alls last.
 * When multiple `anyRequest()` rules exist (multiple FilterChains), the most restrictive wins.
 */
export function parseSecurityConfigs(javaFiles: string[]): SecurityRule[] {
  const rawRules: SecurityRule[] = []

  for (const file of javaFiles) {
    let src: string
    try {
      src = readFileSync(file, "utf-8")
    } catch {
      continue
    }

    if (
      !src.includes("SecurityFilterChain") &&
      !src.includes("authorizeHttpRequests") &&
      !src.includes("authorizeRequests")
    ) {
      continue
    }

    rawRules.push(...extractRulesFromSource(src))
  }

  // Sort: most-specific (fewest wildcards, longer literal prefix) first
  // `/**` catch-alls go last; within catch-alls, denyAll > authenticated > permitAll
  return deduplicateAndSort(rawRules)
}

function deduplicateAndSort(rules: SecurityRule[]): SecurityRule[] {
  // Separate catch-all rules from specific rules
  const specific  = rules.filter((r) => r.pattern !== "/**")
  const catchAlls = rules.filter((r) => r.pattern === "/**")

  // Sort specific rules: patterns with no wildcard before those with * before **
  specific.sort((a, b) => specificityScore(b.pattern) - specificityScore(a.pattern))

  // For catch-alls: prefer deny > authenticated > role > permit (most restrictive wins)
  const restrictiveness = (r: SecurityRule) =>
    r.type === "deny" ? 3 : r.type === "authenticated" ? 2 : r.type === "role" ? 1 : 0
  const bestCatchAll = catchAlls.sort((a, b) => restrictiveness(b) - restrictiveness(a))[0]

  return bestCatchAll ? [...specific, bestCatchAll] : specific
}

/** Higher score = more specific (should match first). */
function specificityScore(pattern: string): number {
  // Exact paths score high, ** wildcards score low
  const stars  = (pattern.match(/\*\*/g) ?? []).length
  const single = (pattern.match(/(?<!\*)\*(?!\*)/g) ?? []).length
  const len    = pattern.length
  return len - stars * 10 - single * 5
}

// ---------------------------------------------------------------------------
// Rule extraction from a single source file
// ---------------------------------------------------------------------------

function extractRulesFromSource(src: string): SecurityRule[] {
  const rules: SecurityRule[] = []

  // Find all .requestMatchers(...).hasRole/hasAnyRole/permitAll/denyAll patterns
  // We use a sliding window regex over the source

  // Pattern 1: .requestMatchers("pattern").someAuth()
  // Pattern 2: .requestMatchers(method, "pattern").someAuth()
  // Pattern 3: .requestMatchers(CONSTANT).someAuth()

  const rulePattern =
    /\.requestMatchers\s*\(([^)]+)\)\s*\.\s*(permitAll|denyAll|authenticated|hasRole|hasAnyRole|hasAuthority|hasAnyAuthority)\s*\(([^)]*)\)/g

  let m: RegExpExecArray | null
  while ((m = rulePattern.exec(src)) !== null) {
    const rawArgs   = m[1]
    const authFn    = m[2]
    const authArgs  = m[3]

    const patterns = extractPatterns(rawArgs)
    const rule     = buildRule(authFn, authArgs)

    for (const pattern of patterns) {
      rules.push({ pattern, ...rule })
    }
  }

  // Pattern for .anyRequest().denyAll() / .anyRequest().authenticated()
  const anyPattern = /\.anyRequest\s*\(\s*\)\s*\.\s*(permitAll|denyAll|authenticated|hasRole|hasAnyRole)\s*\(([^)]*)\)/g
  while ((m = anyPattern.exec(src)) !== null) {
    rules.push({ pattern: "/**", ...buildRule(m[1], m[2]) })
  }

  return rules
}

function extractPatterns(rawArgs: string): string[] {
  // rawArgs can be:
  //   "pattern"
  //   HttpMethod.POST, "pattern"
  //   CONSTANT_ARRAY (skip — too complex to resolve statically)
  //   {"/path1", "/path2"}  — array literal

  const patterns: string[] = []

  // Extract all string literals
  const stringPattern = /["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = stringPattern.exec(rawArgs)) !== null) {
    const val = m[1]
    // Skip HTTP method names
    if (/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(val)) continue
    // Skip MIME types
    if (val.includes("/") || val.startsWith("/") || val.includes("*")) {
      patterns.push(val.startsWith("/") ? val : "/" + val)
    }
  }

  return patterns
}

function buildRule(
  authFn: string,
  authArgs: string,
): Omit<SecurityRule, "pattern"> {
  switch (authFn) {
    case "permitAll":
      return { type: "permit", roles: [], irAuthType: null }

    case "denyAll":
      return { type: "deny", roles: [], irAuthType: null }

    case "authenticated":
      return { type: "authenticated", roles: [], irAuthType: "ir:auth_gate" }

    case "hasRole":
    case "hasAnyRole": {
      const roles = extractStringArgs(authArgs)
      // Role check regardless of whether we could resolve the role name from enum refs
      return { type: "role", roles, irAuthType: "ir:authz_check" }
    }

    case "hasAuthority":
    case "hasAnyAuthority": {
      const roles = extractStringArgs(authArgs)
      return { type: "role", roles, irAuthType: "ir:authz_check" }
    }

    default:
      return { type: "authenticated", roles: [], irAuthType: "ir:auth_gate" }
  }
}

function extractStringArgs(raw: string): string[] {
  const out: string[] = []
  const m = raw.matchAll(/["']([^"']+)["']/g)
  for (const match of m) out.push(match[1])
  return out
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

/** Convert a Spring requestMatchers pattern to a RegExp. */
function patternToRegex(pattern: string): RegExp {
  // Escape regex special chars except * and ?
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "DOUBLESTAR")
    .replace(/\*/g, "[^/]*")
    .replace(/DOUBLESTAR/g, ".*")
    .replace(/\?/g, "[^/]")
  return new RegExp(`^${escaped}(/.*)?$`)
}

/**
 * Find the first matching security rule for a given route path.
 * Returns null if no rule matches (should not happen with anyRequest() catch-all).
 */
export function matchSecurityRule(path: string, rules: SecurityRule[]): SecurityRule | null {
  // Normalise: ensure leading slash
  const normPath = path.startsWith("/") ? path : "/" + path

  for (const rule of rules) {
    try {
      if (patternToRegex(rule.pattern).test(normPath)) return rule
    } catch {
      // invalid regex — skip
    }
  }
  return null
}
