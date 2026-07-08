import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { parseRouteFile } from "../route-parser.js"
import { parseConstantClass } from "../constant-resolver.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FIXTURES   = join(__dirname, "fixtures")

function fixture(name: string): string {
  return join(FIXTURES, name)
}

describe("parseRouteFile — simple routes", () => {
  let graphs: ReturnType<typeof parseRouteFile>

  beforeAll(() => {
    graphs = parseRouteFile(fixture("routes-simple.php"))
  })

  test("extracts 2 routes", () => {
    expect(graphs).toHaveLength(2)
  })

  test("GET /health has no middleware", () => {
    const g = graphs.find((g) => g.path === "/health")
    expect(g).toBeDefined()
    expect(g!.nodes).toHaveLength(1)
    expect(g!.nodes[0].type).toBe("ir:business_handler")
  })

  test("POST /tasks has no middleware", () => {
    const g = graphs.find((g) => g.method === "POST" && g.path === "/tasks")
    expect(g).toBeDefined()
    expect(g!.nodes[0].symbol).toBe("TaskController::store")
  })
})

describe("parseRouteFile — nested middleware groups", () => {
  let graphs: ReturnType<typeof parseRouteFile>

  beforeAll(() => {
    const constants = parseConstantClass(fixture("Permissions.php"))
    graphs = parseRouteFile(fixture("routes-nested.php"), { constants })
  })

  test("extracts 3 routes", () => {
    expect(graphs).toHaveLength(3)
  })

  test("PUT /tasks/{task} has correct entrypoint", () => {
    const g = graphs.find((g) => g.entrypoint === "PUT /tasks/{task}")
    expect(g).toBeDefined()
  })

  test("PUT /tasks/{task} inherits full middleware stack", () => {
    const g = graphs.find((g) => g.entrypoint === "PUT /tasks/{task}")!
    const types = g.nodes.map((n) => n.type)
    expect(types).toEqual([
      "ir:auth_gate",
      "ir:auth_gate",
      "ir:authz_check",
      "ir:business_handler",
    ])
  })

  test("permission arg is resolved from constant (task.update not raw constant name)", () => {
    const g = graphs.find((g) => g.entrypoint === "PUT /tasks/{task}")!
    const perm = g.nodes.find((n) => n.type === "ir:authz_check")
    expect(perm?.args).toEqual(["task.update"])
  })

  test("DELETE /tasks/{task} has permission:task.delete", () => {
    const g = graphs.find((g) => g.method === "DELETE")!
    const perm = g.nodes.find((n) => n.type === "ir:authz_check")
    expect(perm?.args).toEqual(["task.delete"])
  })

  test("edges form a complete chain", () => {
    const g = graphs.find((g) => g.entrypoint === "PUT /tasks/{task}")!
    expect(g.edges).toHaveLength(3)
    expect(g.edges[0].relation).toBe("next_middleware")
    expect(g.edges[0].traceability).toBe("static")
    expect(g.edges[0].from).toBe(g.nodes[0].id)
    expect(g.edges[0].to).toBe(g.nodes[1].id)
  })

  test("path prefix is applied", () => {
    const paths = graphs.map((g) => g.path)
    expect(paths.every((p) => p.startsWith("/tasks"))).toBe(true)
  })
})

describe("parseRouteFile — require includes", () => {
  let graphs: ReturnType<typeof parseRouteFile>

  beforeAll(() => {
    graphs = parseRouteFile(fixture("routes-with-require.php"))
  })

  test("follows require and finds routes in sub-file", () => {
    expect(graphs).toHaveLength(2)
  })

  test("routes inherit middleware from parent file's groups", () => {
    for (const g of graphs) {
      const types = g.nodes.map((n) => n.type)
      expect(types).toContain("ir:auth_gate")
      expect(types).toContain("ir:auth_gate")  // ResolveTenant
    }
  })
})

describe("parseRouteFile — Route::namespace() groups", () => {
  let graphs: ReturnType<typeof parseRouteFile>

  beforeAll(() => {
    graphs = parseRouteFile(fixture("routes-namespace.php"))
  })

  test("extracts 4 routes", () => {
    expect(graphs).toHaveLength(4)
  })

  test("bare controller under Route::namespace() (fluent form) resolves to the group's namespace, not App\\Http\\Controllers", () => {
    const g = graphs.find((g) => g.path === "/invoices")!
    expect(g.nodes[0].symbol).toBe("InvoiceController::index")
    expect(g.nodes[0].file).toBe("Modules/Accounting/Http/Controllers/InvoiceController.php")
  })

  test("relative sub-namespace controller string (Akaunting's Sales\\Invoices pattern) resolves relative to the group namespace, not as an already-complete FQCN", () => {
    const g = graphs.find((g) => g.path === "/invoices/sent")!
    expect(g.nodes[0].symbol).toBe("Sales\\Invoices::markSent")
    expect(g.nodes[0].file).toBe("Modules/Accounting/Http/Controllers/Sales/Invoices.php")
  })

  test("bare controller under Route::group(['namespace' => ...]) (options-array form) resolves correctly", () => {
    const g = graphs.find((g) => g.path === "/bills")!
    expect(g.nodes[0].symbol).toBe("BillController::index")
    expect(g.nodes[0].file).toBe("Modules/Billing/Http/Controllers/BillController.php")
  })

  test("route outside any namespace group still falls back to App\\Http\\Controllers", () => {
    const g = graphs.find((g) => g.path === "/health")!
    expect(g.nodes[0].symbol).toBe("HealthController::check")
    expect(g.nodes[0].file).toBe("app/Http/Controllers/HealthController.php")
  })
})

describe("parseRouteFile — opts.wrappingNamespace (RouteServiceProvider-level default)", () => {
  test("seeds the outer namespace for a relative sub-namespace controller string (Akaunting's Sales\\Invoices pattern)", () => {
    const graphs = parseRouteFile(fixture("routes-simple.php"), { wrappingNamespace: "App\\Http\\Controllers" })
    const g = graphs.find((g) => g.method === "POST" && g.path === "/tasks")!
    expect(g.nodes[0].symbol).toBe("TaskController::store")
  })

  test("an inner Route::namespace() group overrides the outer wrappingNamespace", () => {
    const graphs = parseRouteFile(fixture("routes-namespace.php"), { wrappingNamespace: "App\\Http\\Controllers" })
    const g = graphs.find((g) => g.path === "/invoices")!
    expect(g.nodes[0].file).toBe("Modules/Accounting/Http/Controllers/InvoiceController.php")
  })

  test("a route with no inner namespace group falls back to wrappingNamespace instead of App\\Http\\Controllers", () => {
    const graphs = parseRouteFile(fixture("routes-namespace.php"), { wrappingNamespace: "Custom\\Base" })
    const g = graphs.find((g) => g.path === "/health")!
    expect(g.nodes[0].symbol).toBe("HealthController::check")
    expect(g.nodes[0].file).toBe("Custom/Base/HealthController.php")
  })
})

describe("parseConstantClass", () => {
  test("parses PHP class constants into a map", () => {
    const map = parseConstantClass(fixture("Permissions.php"))
    expect(map["Permissions"]).toBeDefined()
    expect(map["Permissions"]["TASK_VIEW"]).toBe("task.view")
    expect(map["Permissions"]["TASK_UPDATE"]).toBe("task.update")
    expect(map["Permissions"]["TASK_DELETE"]).toBe("task.delete")
  })
})
