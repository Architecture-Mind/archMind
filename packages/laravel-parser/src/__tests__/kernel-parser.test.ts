import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { parseKernel } from "../kernel-parser.js"
import { parseRouteFile } from "../route-parser.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FIXTURES   = join(__dirname, "fixtures")

describe("parseKernel", () => {
  test("parses $middlewareAliases from Kernel.php", () => {
    const map = parseKernel(join(FIXTURES, "app/Http/Kernel.php"))
    expect(map["role"]).toBe("App\\Http\\Middleware\\EnsureUserHasRole")
    expect(map["tenant"]).toBe("App\\Http\\Middleware\\ResolveTenant")
    expect(map["auth"]).toBe("App\\Http\\Middleware\\Authenticate")
  })

  test("returns empty map for missing file", () => {
    const map = parseKernel("/nonexistent/Kernel.php")
    expect(map).toEqual({})
  })

  test("all expected aliases present", () => {
    const map = parseKernel(join(FIXTURES, "app/Http/Kernel.php"))
    expect(Object.keys(map)).toEqual(
      expect.arrayContaining(["auth", "role", "tenant", "permission", "verified", "throttle"])
    )
  })
})

describe("parseRouteFile — alias resolution", () => {
  const KERNEL = join(FIXTURES, "app/Http/Kernel.php")

  test("without aliasMap: role:admin emits honest unknown_middleware node", () => {
    const graphs = parseRouteFile(join(FIXTURES, "routes-alias.php"))
    const g = graphs.find((g) => g.path === "/reports")!
    const roleNode = g.nodes.find((n) => n.symbol === "role:admin")
    expect(roleNode).toBeDefined()
    expect(roleNode!.type).toBe("ir:unknown_middleware")
  })

  test("with aliasMap: role:admin resolves to authorization_check", () => {
    const aliasMap = parseKernel(KERNEL)
    const graphs = parseRouteFile(join(FIXTURES, "routes-alias.php"), { aliasMap })
    const g = graphs.find((g) => g.path === "/reports")!
    const roleNode = g.nodes.find((n) => n.symbol === "EnsureUserHasRole")
    expect(roleNode).toBeDefined()
    expect(roleNode!.type).toBe("ir:authz_check")
    expect(roleNode!.args).toEqual(["admin"])
  })

  test("with aliasMap: role node has file path derived from FQCN", () => {
    const aliasMap = parseKernel(KERNEL)
    const graphs = parseRouteFile(join(FIXTURES, "routes-alias.php"), { aliasMap })
    const g = graphs.find((g) => g.path === "/reports")!
    const roleNode = g.nodes.find((n) => n.symbol === "EnsureUserHasRole")!
    expect(roleNode.file).toBe("app/Http/Middleware/EnsureUserHasRole.php")
  })

  test("with aliasMap: auth:sanctum still resolves as authentication_gate (not overridden)", () => {
    const aliasMap = parseKernel(KERNEL)
    const graphs = parseRouteFile(join(FIXTURES, "routes-alias.php"), { aliasMap })
    const g = graphs.find((g) => g.path === "/reports")!
    const authNode = g.nodes.find((n) => n.type === "ir:auth_gate")
    expect(authNode).toBeDefined()
    expect(authNode!.symbol).toBe("auth:sanctum")
  })

  test("with aliasMap: tenant alias in nested group resolves to ResolveTenant, honestly unclassified", () => {
    const aliasMap = parseKernel(KERNEL)
    const graphs = parseRouteFile(join(FIXTURES, "routes-alias.php"), { aliasMap })
    const g = graphs.find((g) => g.path === "/projects/{project}")!
    expect(g).toBeDefined()
    const tenantNode = g.nodes.find((n) => n.symbol === "ResolveTenant")
    expect(tenantNode).toBeDefined()
    // ResolveTenant doesn't match any known auth/authz allowlist pattern — it should
    // NOT be guessed as an auth_gate (IR v1.5 plan, Phase 1 bullet 4).
    expect(tenantNode!.type).toBe("ir:unknown_middleware")
  })

  test("with aliasMap: /projects/{project} has full inherited middleware stack", () => {
    const aliasMap = parseKernel(KERNEL)
    const graphs = parseRouteFile(join(FIXTURES, "routes-alias.php"), { aliasMap })
    const g = graphs.find((g) => g.path === "/projects/{project}")!
    const types = g.nodes.map((n) => n.type)
    expect(types).toContain("ir:auth_gate")          // auth:sanctum
    expect(types).toContain("ir:unknown_middleware") // ResolveTenant
    expect(types).toContain("ir:business_handler")
  })
})
