import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { parseRouteServiceProvider } from "../route-service-provider-parser.js"
import { parseMiddlewareGroups } from "../kernel-parser.js"
import { parseRouteFile } from "../route-parser.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FIXTURES   = join(__dirname, "fixtures", "route-service-provider")

describe("parseRouteServiceProvider", () => {
  const RSP = join(FIXTURES, "app/Providers/RouteServiceProvider.php")

  test("maps routes/api.php to the 'api' group", () => {
    const wrapping = parseRouteServiceProvider(RSP, FIXTURES)
    expect(wrapping.get("routes/api.php")).toEqual(["api"])
  })

  test("maps routes/web.php to the 'web' group", () => {
    const wrapping = parseRouteServiceProvider(RSP, FIXTURES)
    expect(wrapping.get("routes/web.php")).toEqual(["web"])
  })

  test("returns empty map for missing file", () => {
    const wrapping = parseRouteServiceProvider("/nonexistent/RouteServiceProvider.php", FIXTURES)
    expect(wrapping.size).toBe(0)
  })
})

describe("IR v1.5 Phase 1 regression — BookStack/koel middleware group resolution", () => {
  const RSP = join(FIXTURES, "app/Providers/RouteServiceProvider.php")

  function wrappingMiddlewareFor(kernelFixture: string, routeFile: string): string[] {
    const kernelPath = join(FIXTURES, "app/Http", kernelFixture)
    const middlewareGroups = parseMiddlewareGroups(kernelPath)
    const wrapping = parseRouteServiceProvider(RSP, FIXTURES)
    const groupNames = wrapping.get(routeFile) ?? []
    return groupNames.flatMap((name) => middlewareGroups[name] ?? [name])
  }

  test("BookStack pattern: api group resolves to concrete ApiAuthenticate — DELETE /users/{id} gets an auth gate", () => {
    const wrappingMiddleware = wrappingMiddlewareFor("Kernel-bookstack.php", "routes/api.php")
    const graphs = parseRouteFile(join(FIXTURES, "routes/api.php"), { wrappingMiddleware })
    const g = graphs.find((g) => g.path === "/users/{id}")!
    expect(g).toBeDefined()
    const types = g.nodes.map((n) => n.type)
    expect(types).toContain("ir:auth_gate")
  })

  test("koel pattern: api group has no auth middleware — DELETE /users/{id} gets no auth gate (no false positive)", () => {
    const wrappingMiddleware = wrappingMiddlewareFor("Kernel-koel.php", "routes/api.php")
    const graphs = parseRouteFile(join(FIXTURES, "routes/api.php"), { wrappingMiddleware })
    const g = graphs.find((g) => g.path === "/users/{id}")!
    expect(g).toBeDefined()
    const types = g.nodes.map((n) => n.type)
    expect(types).not.toContain("ir:auth_gate")
    expect(types).not.toContain("ir:authz_check")
  })

  test("without Phase 1 wiring (no wrappingMiddleware), the route gets zero middleware nodes at all", () => {
    // This is the pre-Phase-1 gap: parseRouteFile alone never sees the RouteServiceProvider
    // wrapping, so a file with no inline ->middleware() calls emits nothing.
    const graphs = parseRouteFile(join(FIXTURES, "routes/api.php"))
    const g = graphs.find((g) => g.path === "/users/{id}")!
    expect(g.nodes).toHaveLength(1)
    expect(g.nodes[0].type).toBe("ir:business_handler")
  })
})
