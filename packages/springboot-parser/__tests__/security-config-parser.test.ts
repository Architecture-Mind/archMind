import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parseSecurityConfigs, matchSecurityRule } from "../src/security-config-parser.js"

function writeConfig(dir: string, content: string): string {
  const file = join(dir, "SecurityConfig.java")
  writeFileSync(file, content)
  return file
}

describe("parseSecurityConfigs — role checks imply authentication", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "archmind-secconfig-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("hasRole rule resolves to BOTH auth_gate and authz_check, in that order", () => {
    const file = writeConfig(dir, `
      @Configuration
      public class SecurityConfig {
        @Bean
        public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
          http.authorizeHttpRequests(registry -> registry
            .requestMatchers("/api/public/**").hasRole("USER")
            .anyRequest().denyAll());
          return http.build();
        }
      }
    `)
    const rules = parseSecurityConfigs([file])
    const rule  = matchSecurityRule("/api/public/orders", rules)

    expect(rule).not.toBeNull()
    expect(rule!.irAuthTypes).toEqual(["ir:auth_gate", "ir:authz_check"])
  })

  test("hasAnyRole rule also resolves to BOTH auth_gate and authz_check", () => {
    const file = writeConfig(dir, `
      @Bean
      public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(registry -> registry
          .requestMatchers("/api/private/**").hasAnyRole("OPERATOR", "SUPER_ADMIN")
          .anyRequest().denyAll());
        return http.build();
      }
    `)
    const rules = parseSecurityConfigs([file])
    const rule  = matchSecurityRule("/api/private/orders", rules)

    expect(rule!.irAuthTypes).toEqual(["ir:auth_gate", "ir:authz_check"])
  })

  test("plain authenticated() resolves to only auth_gate", () => {
    const file = writeConfig(dir, `
      @Bean
      public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(registry -> registry
          .requestMatchers("/api/account/**").authenticated()
          .anyRequest().denyAll());
        return http.build();
      }
    `)
    const rules = parseSecurityConfigs([file])
    const rule  = matchSecurityRule("/api/account/profile", rules)

    expect(rule!.irAuthTypes).toEqual(["ir:auth_gate"])
  })

  test("permitAll resolves to an empty irAuthTypes (public route)", () => {
    const file = writeConfig(dir, `
      @Bean
      public SecurityFilterChain securityFilterChain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(registry -> registry
          .requestMatchers("/actuator/health").permitAll()
          .anyRequest().denyAll());
        return http.build();
      }
    `)
    const rules = parseSecurityConfigs([file])
    const rule  = matchSecurityRule("/actuator/health", rules)

    expect(rule!.irAuthTypes).toEqual([])
  })
})
