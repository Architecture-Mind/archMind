import type { ArchMindUserConfig } from "@kidkender/archmind-protocol"

// Known guard name → IR type heuristic.
// Unknown custom guards emit "unknown_guard" so callers can warn the user.

const AUTH_GATE_NAMES = new Set([
  // Standard Passport / JWT guards
  "AuthGuard", "JwtAuthGuard", "JwtGuard", "LocalAuthGuard", "LocalGuard",
  "BearerAuthGuard", "ApiKeyGuard", "GoogleAuthGuard", "FacebookAuthGuard",
  "GithubAuthGuard", "PassportAuthGuard", "OAuthGuard", "ProviderGuard",
  "ThrottlerGuard",
  // App-specific JWT variants (extend JwtGuard but still perform authentication)
  "CreateShareGuard", "ShareTokenSecurity",
])
const AUTH_GATE_PATTERNS = [
  /AuthGuard$/,
  /JwtGuard$/,
  /ApiKeyGuard$/,
  /BearerGuard$/,
  /OAuthGuard$/,
  /ProviderGuard$/,
  /SsoGuard$/,
  /SessionGuard$/,
  /TokenGuard$/,
  // Token-validator classes that don't end in "Guard"
  /TokenSecurity$/,
]

const AUTHZ_CHECK_NAMES = new Set([
  "RolesGuard", "PermissionsGuard", "PolicyGuard", "AbilitiesGuard",
  "AclGuard", "CaslGuard", "RequirePermissionsGuard",
  "AdministratorGuard", "AdminGuard",
])
const AUTHZ_CHECK_PATTERNS = [
  /Roles?Guard$/,
  /Permissions?Guard$/,
  /Policy?Guard$/,
  /Abilities?Guard$/,
  /Acl?Guard$/,
  // Ownership / resource guards → authorization, not authentication
  /Owner?Guard$/,
  /Admin(istrator)?Guard$/,
  // Security guards that check access rules (not pure token validation)
  /SecurityGuard$/,
  /AccessGuard$/,
  /AuthorityGuard$/,
  /PrivilegeGuard$/,
]

// Middleware class name patterns (NestMiddleware implementations)
const AUTH_GATE_MIDDLEWARE_PATTERNS = [
  /Auth.*Middleware$/,
  /Jwt.*Middleware$/,
  /Token.*Middleware$/,
  /Bearer.*Middleware$/,
]
const AUTHZ_MIDDLEWARE_PATTERNS = [
  /Role.*Middleware$/,
  /Permission.*Middleware$/,
  /Acl.*Middleware$/,
]

export function classifyGuard(
  className: string,
  userConfig?: ArchMindUserConfig
): "ir:auth_gate" | "ir:authz_check" | "unknown_guard" {
  // User-defined overrides take precedence over built-in heuristics.
  if (userConfig?.guards?.auth_gate?.includes(className)) return "ir:auth_gate"
  if (userConfig?.guards?.authz_check?.includes(className)) return "ir:authz_check"

  if (AUTH_GATE_NAMES.has(className) || AUTH_GATE_PATTERNS.some(p => p.test(className))) {
    return "ir:auth_gate"
  }
  if (AUTHZ_CHECK_NAMES.has(className) || AUTHZ_CHECK_PATTERNS.some(p => p.test(className))) {
    return "ir:authz_check"
  }
  // NestMiddleware naming conventions
  if (AUTH_GATE_MIDDLEWARE_PATTERNS.some(p => p.test(className))) {
    return "ir:auth_gate"
  }
  if (AUTHZ_MIDDLEWARE_PATTERNS.some(p => p.test(className))) {
    return "ir:authz_check"
  }
  return "unknown_guard"
}
