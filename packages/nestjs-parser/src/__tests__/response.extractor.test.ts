import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { parseNestJSProject } from "../adapter.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES  = join(__dirname, "fixtures", "response-resource")

describe("NestJS ir:api_resource extraction", () => {
  let graphs: ReturnType<typeof parseNestJSProject>

  beforeAll(() => {
    graphs = parseNestJSProject(FIXTURES)
  })

  test("emits 2 graphs (store + show)", () => {
    expect(graphs).toHaveLength(2)
  })

  describe("POST /invoices — plainToInstance signal", () => {
    let g: (typeof graphs)[0]

    beforeAll(() => {
      g = graphs.find(g => g.method === "POST")!
    })

    test("graph exists", () => {
      expect(g).toBeDefined()
    })

    test("emits ir:api_resource node", () => {
      const node = g.nodes.find(n => n.type === "ir:api_resource")
      expect(node).toBeDefined()
    })

    test("symbol is InvoiceResponseDto::serialize", () => {
      const node = g.nodes.find(n => n.type === "ir:api_resource")
      expect(node?.symbol).toBe("InvoiceResponseDto::serialize")
    })

    test("emits responds_with edge from handler", () => {
      const handler = g.nodes.find(n => n.type === "ir:business_handler")!
      const resource = g.nodes.find(n => n.type === "ir:api_resource")!
      const edge = g.edges.find(e => e.from === handler.id && e.to === resource.id && e.relation === "responds_with")
      expect(edge).toBeDefined()
    })

    test("detects sensitive field apiKey", () => {
      const node = g.nodes.find(n => n.type === "ir:api_resource")!
      const detail = JSON.parse(node.detail ?? "{}")
      expect(detail.sensitiveFields).toContain("apiKey")
    })

    test("excludedByDefault is true (class-level @Exclude)", () => {
      const node = g.nodes.find(n => n.type === "ir:api_resource")!
      const detail = JSON.parse(node.detail ?? "{}")
      expect(detail.excludedByDefault).toBe(true)
    })

    test("exposed fields include id, total, status, apiKey", () => {
      const node = g.nodes.find(n => n.type === "ir:api_resource")!
      const detail = JSON.parse(node.detail ?? "{}")
      expect(detail.fields).toContain("id")
      expect(detail.fields).toContain("total")
      expect(detail.fields).toContain("status")
      expect(detail.fields).not.toContain("internalNotes")
    })
  })

  describe("GET /invoices/:id — return type annotation signal", () => {
    let g: (typeof graphs)[0]

    beforeAll(() => {
      g = graphs.find(g => g.method === "GET")!
    })

    test("graph exists", () => {
      expect(g).toBeDefined()
    })

    test("emits ir:api_resource node from return type annotation", () => {
      const node = g.nodes.find(n => n.type === "ir:api_resource")
      expect(node).toBeDefined()
      expect(node?.symbol).toBe("InvoiceResponseDto::serialize")
    })
  })
})
