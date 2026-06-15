import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { parseNestJSProject } from "../adapter.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES  = join(__dirname, "fixtures", "side-effects")

describe("NestJS side-effect extraction", () => {
  let graphs: ReturnType<typeof parseNestJSProject>

  beforeAll(() => {
    graphs = parseNestJSProject(FIXTURES)
  })

  test("emits 3 graphs (create, notify, findOne)", () => {
    expect(graphs).toHaveLength(3)
  })

  describe("POST /orders — queue_job + event_dispatch", () => {
    let g: (typeof graphs)[0]

    beforeAll(() => {
      g = graphs.find((g) => g.method === "POST" && g.path === "/orders")!
    })

    test("graph exists", () => {
      expect(g).toBeDefined()
    })

    test("emits ir:queue_job node for generate-invoice job", () => {
      const jobNode = g.nodes.find((n) => n.type === "ir:queue_job")
      expect(jobNode).toBeDefined()
      expect(jobNode?.symbol).toBe("generate-invoice")
      expect(jobNode?.role).toBe("side_effect")
    })

    test("emits ir:event_dispatch node for order.created event", () => {
      const evtNode = g.nodes.find((n) => n.type === "ir:event_dispatch")
      expect(evtNode).toBeDefined()
      expect(evtNode?.symbol).toBe("order.created")
    })

    test("handler has dispatches edges to side-effect nodes", () => {
      const handlerId = g.nodes.find((n) => n.type === "ir:business_handler")!.id
      const dispatchEdges = g.edges.filter(
        (e) => e.from === handlerId && e.relation === "dispatches"
      )
      expect(dispatchEdges).toHaveLength(2)
    })

    test("auth_gate is still present (guard not dropped)", () => {
      expect(g.nodes.find((n) => n.type === "ir:auth_gate")).toBeDefined()
    })
  })

  describe("POST /orders/:id/notify — synchronous mail", () => {
    let g: (typeof graphs)[0]

    beforeAll(() => {
      g = graphs.find((g) => g.path === "/orders/:id/notify")!
    })

    test("graph exists", () => {
      expect(g).toBeDefined()
    })

    test("emits ir:mail node for sendMail call", () => {
      const mailNode = g.nodes.find((n) => n.type === "ir:mail")
      expect(mailNode).toBeDefined()
      expect(mailNode?.symbol).toBe("sendMail")
      expect(mailNode?.role).toBe("side_effect")
    })

    test("ir:mail detail marks queued: false (synchronous)", () => {
      const mailNode = g.nodes.find((n) => n.type === "ir:mail")!
      const detail = JSON.parse(mailNode.detail as string)
      expect(detail.queued).toBe(false)
    })
  })

  describe("GET /orders/:id — no side effects", () => {
    let g: (typeof graphs)[0]

    beforeAll(() => {
      g = graphs.find((g) => g.method === "GET")!
    })

    test("graph exists", () => {
      expect(g).toBeDefined()
    })

    test("no ir:queue_job, ir:event_dispatch, or ir:mail nodes", () => {
      const sideEffectTypes = new Set(["ir:queue_job", "ir:event_dispatch", "ir:mail"])
      const sideEffectNodes = g.nodes.filter((n) => sideEffectTypes.has(n.type))
      expect(sideEffectNodes).toHaveLength(0)
    })
  })
})
