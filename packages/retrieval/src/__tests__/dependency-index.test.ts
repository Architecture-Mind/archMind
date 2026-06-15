import { buildDependencyIndex, queryDependents, indexStats } from "../dependency-index.js"
import type { IntermediateExecutionGraph } from "@archmind/protocol"

// ---- Fixture graphs --------------------------------------------------

const ORDER_CREATE: IntermediateExecutionGraph = {
  entrypoint: "POST /orders",
  method: "POST", path: "/orders",
  nodes: [
    { id: "ctrl", type: "ir:business_handler", symbol: "OrderController::store", role: "handler" },
    { id: "svc1", type: "ir:service_call", symbol: "OrderService::create", role: "service" },
    { id: "svc2", type: "ir:service_call", symbol: "CartService::carts", role: "service" },
    { id: "svc3", type: "ir:service_call", symbol: "AccountTransactionService::create", role: "service" },
  ],
  edges: [], annotations: [],
}

const ORDER_ADMIN: IntermediateExecutionGraph = {
  entrypoint: "GET /admin/orders",
  method: "GET", path: "/admin/orders",
  nodes: [
    { id: "ctrl", type: "ir:business_handler", symbol: "AdminOrderController::index", role: "handler" },
    { id: "svc1", type: "ir:service_call", symbol: "OrderService::list", role: "service" },
  ],
  edges: [], annotations: [],
}

const ORDER_SHOW: IntermediateExecutionGraph = {
  entrypoint: "GET /orders/{order}",
  method: "GET", path: "/orders/{order}",
  nodes: [
    { id: "ctrl", type: "ir:business_handler", symbol: "OrderController::show", role: "handler" },
    { id: "svc1", type: "ir:service_call", symbol: "OrderService::findById", role: "service" },
  ],
  edges: [], annotations: [],
}

const CART_ROUTE: IntermediateExecutionGraph = {
  entrypoint: "POST /cart/add",
  method: "POST", path: "/cart/add",
  nodes: [
    { id: "ctrl", type: "ir:business_handler", symbol: "CartController::addToCart", role: "handler" },
    { id: "svc1", type: "ir:service_call", symbol: "CartService::add", role: "service" },
    { id: "svc2", type: "ir:service_call", symbol: "CartService::carts", role: "service" },
  ],
  edges: [], annotations: [],
}

const NO_SERVICES: IntermediateExecutionGraph = {
  entrypoint: "GET /health",
  method: "GET", path: "/health",
  nodes: [
    { id: "ctrl", type: "ir:business_handler", symbol: "HealthController::index", role: "handler" },
  ],
  edges: [], annotations: [],
}

// Side-effect fixture graphs (Phase 21)
const INVOICE_CREATE: IntermediateExecutionGraph = {
  entrypoint: "POST /api/v1/invoices",
  method: "POST", path: "/api/v1/invoices",
  nodes: [
    { id: "ctrl", type: "ir:business_handler", symbol: "InvoicesController::store", role: "handler" },
    { id: "job1", type: "ir:queue_job",        symbol: "GenerateInvoicePdfJob",     role: "side_effect" },
    { id: "res1", type: "ir:api_resource",     symbol: "InvoiceResource::toArray",  role: "response" },
  ],
  edges: [], annotations: [],
}

const INVOICE_PDF: IntermediateExecutionGraph = {
  entrypoint: "GET /invoices/view/{email_log}",
  method: "GET", path: "/invoices/view/{email_log}",
  nodes: [
    { id: "ctrl", type: "ir:business_handler", symbol: "InvoicePdfController::getPdf",   role: "handler" },
    { id: "mail", type: "ir:mail",             symbol: "InvoiceViewedMail::build",        role: "side_effect" },
  ],
  edges: [], annotations: [],
}

const ORDER_NOTIFY: IntermediateExecutionGraph = {
  entrypoint: "POST /orders/complete",
  method: "POST", path: "/orders/complete",
  nodes: [
    { id: "ctrl",  type: "ir:business_handler", symbol: "OrderController::complete",           role: "handler" },
    { id: "notif", type: "ir:notification",      symbol: "OrderCompletedNotification::toArray", role: "side_effect" },
    { id: "evt",   type: "ir:event_dispatch",    symbol: "OrderCompleted",                      role: "side_effect" },
    { id: "job1",  type: "ir:queue_job",         symbol: "GenerateInvoicePdfJob",               role: "side_effect" },
  ],
  edges: [], annotations: [],
}

const ALL_GRAPHS = [ORDER_CREATE, ORDER_ADMIN, ORDER_SHOW, CART_ROUTE, NO_SERVICES]
const ALL_GRAPHS_V2 = [...ALL_GRAPHS, INVOICE_CREATE, INVOICE_PDF, ORDER_NOTIFY]

// ---- buildDependencyIndex -------------------------------------------

describe("buildDependencyIndex", () => {
  const index = buildDependencyIndex(ALL_GRAPHS)

  test("indexes exact service symbols", () => {
    expect(index.bySymbol.has("OrderService::create")).toBe(true)
    expect(index.bySymbol.has("CartService::carts")).toBe(true)
  })

  test("bySymbol maps symbol to correct entrypoints", () => {
    const eps = index.bySymbol.get("OrderService::create")!
    expect(eps.has("POST /orders")).toBe(true)
    expect(eps.size).toBe(1)
  })

  test("bySymbol de-duplicates: CartService::carts appears in two routes", () => {
    const eps = index.bySymbol.get("CartService::carts")!
    expect(eps.has("POST /orders")).toBe(true)
    expect(eps.has("POST /cart/add")).toBe(true)
    expect(eps.size).toBe(2)
  })

  test("byClass groups all methods on OrderService", () => {
    const eps = index.byClass.get("OrderService")!
    expect(eps.has("POST /orders")).toBe(true)
    expect(eps.has("GET /admin/orders")).toBe(true)
    expect(eps.has("GET /orders/{order}")).toBe(true)
    expect(eps.size).toBe(3)
  })

  test("byClass for CartService covers both routes", () => {
    const eps = index.byClass.get("CartService")!
    expect(eps.size).toBe(2)
  })

  test("routes without service_call nodes are in graphsByEntrypoint but not bySymbol", () => {
    expect(index.graphsByEntrypoint.has("GET /health")).toBe(true)
    const allEps = [...index.bySymbol.values()].flatMap((s) => [...s])
    expect(allEps).not.toContain("GET /health")
  })

  test("non-existent class returns undefined from byClass", () => {
    expect(index.byClass.get("PaymentService")).toBeUndefined()
  })
})

// ---- queryDependents — exact symbol ---------------------------------

describe("queryDependents — exact symbol", () => {
  const index = buildDependencyIndex(ALL_GRAPHS)

  test("exact match returns correct routes", () => {
    const hits = queryDependents(index, "OrderService::create")
    expect(hits).toHaveLength(1)
    expect(hits[0].entrypoint).toBe("POST /orders")
  })

  test("matching nodes in hit contain only the queried symbol", () => {
    const hits = queryDependents(index, "OrderService::create")
    expect(hits[0].matchingNodes).toHaveLength(1)
    expect(hits[0].matchingNodes[0].symbol).toBe("OrderService::create")
  })

  test("returns empty array for non-existent symbol", () => {
    const hits = queryDependents(index, "NonExistentService::doThing")
    expect(hits).toHaveLength(0)
  })

  test("results are sorted by entrypoint", () => {
    const hits = queryDependents(index, "CartService::carts")
    expect(hits).toHaveLength(2)
    expect(hits[0].entrypoint < hits[1].entrypoint).toBe(true)
  })
})

// ---- queryDependents — class-only -----------------------------------

describe("queryDependents — class-only match", () => {
  const index = buildDependencyIndex(ALL_GRAPHS)

  test("class match returns all routes using any method", () => {
    const hits = queryDependents(index, "OrderService")
    expect(hits).toHaveLength(3)
    const eps = hits.map((h) => h.entrypoint)
    expect(eps).toContain("POST /orders")
    expect(eps).toContain("GET /admin/orders")
    expect(eps).toContain("GET /orders/{order}")
  })

  test("matching nodes include all matching symbols in each route", () => {
    const hits = queryDependents(index, "CartService")
    const cartAddHit = hits.find((h) => h.entrypoint === "POST /cart/add")!
    expect(cartAddHit.matchingNodes).toHaveLength(2)
    const symbols = cartAddHit.matchingNodes.map((n) => n.symbol)
    expect(symbols).toContain("CartService::add")
    expect(symbols).toContain("CartService::carts")
  })

  test("class-only query returns empty for non-existent class", () => {
    const hits = queryDependents(index, "PaymentService")
    expect(hits).toHaveLength(0)
  })
})

// ---- indexStats -----------------------------------------------------

describe("indexStats", () => {
  const index = buildDependencyIndex(ALL_GRAPHS)
  const stats = indexStats(index)

  test("totalRoutes matches input graph count", () => {
    expect(stats.totalRoutes).toBe(ALL_GRAPHS.length)
  })

  test("totalSymbols counts distinct service method symbols", () => {
    // OrderService::create, OrderService::list, OrderService::findById,
    // CartService::add, CartService::carts, AccountTransactionService::create = 6
    expect(stats.totalSymbols).toBe(6)
  })

  test("totalClasses counts distinct service class names", () => {
    // OrderService, CartService, AccountTransactionService = 3
    expect(stats.totalClasses).toBe(3)
  })

  test("topSymbols contains CartService::carts as highest (2 routes)", () => {
    expect(stats.topSymbols[0].symbol).toBe("CartService::carts")
    expect(stats.topSymbols[0].routeCount).toBe(2)
  })
})

// ---- Empty graph list -----------------------------------------------

describe("buildDependencyIndex — edge cases", () => {
  test("empty graph list produces empty index", () => {
    const index = buildDependencyIndex([])
    expect(index.bySymbol.size).toBe(0)
    expect(index.byClass.size).toBe(0)
    expect(index.graphsByEntrypoint.size).toBe(0)
  })

  test("queryDependents on empty index returns empty array", () => {
    const index = buildDependencyIndex([])
    expect(queryDependents(index, "OrderService::create")).toHaveLength(0)
    expect(queryDependents(index, "OrderService")).toHaveLength(0)
  })
})

// ---- Side-effect node types (Phase 21) ------------------------------

describe("buildDependencyIndex — side-effect node types", () => {
  const index = buildDependencyIndex(ALL_GRAPHS_V2)

  test("indexes ir:queue_job by symbol", () => {
    expect(index.bySymbol.has("GenerateInvoicePdfJob")).toBe(true)
  })

  test("queue_job dispatched from multiple routes appears in both", () => {
    const eps = index.bySymbol.get("GenerateInvoicePdfJob")!
    expect(eps.has("POST /api/v1/invoices")).toBe(true)
    expect(eps.has("POST /orders/complete")).toBe(true)
    expect(eps.size).toBe(2)
  })

  test("indexes ir:mail by symbol", () => {
    expect(index.bySymbol.has("InvoiceViewedMail::build")).toBe(true)
    const eps = index.bySymbol.get("InvoiceViewedMail::build")!
    expect(eps.has("GET /invoices/view/{email_log}")).toBe(true)
    expect(eps.size).toBe(1)
  })

  test("indexes ir:mail by class (no-method query)", () => {
    const eps = index.byClass.get("InvoiceViewedMail")!
    expect(eps.has("GET /invoices/view/{email_log}")).toBe(true)
  })

  test("indexes ir:api_resource by symbol", () => {
    expect(index.bySymbol.has("InvoiceResource::toArray")).toBe(true)
  })

  test("indexes ir:notification by class", () => {
    const eps = index.byClass.get("OrderCompletedNotification")!
    expect(eps.has("POST /orders/complete")).toBe(true)
  })

  test("indexes ir:event_dispatch by class", () => {
    const eps = index.byClass.get("OrderCompleted")!
    expect(eps.has("POST /orders/complete")).toBe(true)
  })

  test("business_handler nodes are NOT indexed", () => {
    expect(index.bySymbol.has("InvoicesController::store")).toBe(false)
    expect(index.byClass.has("InvoicesController")).toBe(false)
  })
})

describe("queryDependents — side-effect types", () => {
  const index = buildDependencyIndex(ALL_GRAPHS_V2)

  test("exact queue_job symbol returns correct routes", () => {
    const hits = queryDependents(index, "GenerateInvoicePdfJob")
    expect(hits).toHaveLength(2)
    const eps = hits.map((h) => h.entrypoint).sort()
    expect(eps[0]).toBe("POST /api/v1/invoices")
    expect(eps[1]).toBe("POST /orders/complete")
  })

  test("matchingNodes for queue_job hit include only the job node", () => {
    const hits = queryDependents(index, "GenerateInvoicePdfJob")
    const invoiceHit = hits.find((h) => h.entrypoint === "POST /api/v1/invoices")!
    expect(invoiceHit.matchingNodes).toHaveLength(1)
    expect(invoiceHit.matchingNodes[0].type).toBe("ir:queue_job")
  })

  test("exact mail symbol (with method) returns correct route", () => {
    const hits = queryDependents(index, "InvoiceViewedMail::build")
    expect(hits).toHaveLength(1)
    expect(hits[0].entrypoint).toBe("GET /invoices/view/{email_log}")
  })

  test("class-only query for mail class returns route via byClass", () => {
    const hits = queryDependents(index, "InvoiceViewedMail")
    expect(hits).toHaveLength(1)
    expect(hits[0].entrypoint).toBe("GET /invoices/view/{email_log}")
  })

  test("class-only query for notification class returns route", () => {
    const hits = queryDependents(index, "OrderCompletedNotification")
    expect(hits).toHaveLength(1)
    expect(hits[0].entrypoint).toBe("POST /orders/complete")
  })

  test("service_call nodes are still indexed alongside side-effect nodes", () => {
    const hits = queryDependents(index, "OrderService::create")
    expect(hits).toHaveLength(1)
    expect(hits[0].entrypoint).toBe("POST /orders")
  })
})
