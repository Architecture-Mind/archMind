import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { extractRoutes } from "../extractors/route.extractor.js"
import { emitGraphs } from "../emitters/ir-emitter.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FIXTURES   = join(__dirname, "fixtures", "cron-job")

describe("extractRoutes — @Cron entrypoints", () => {
  let routes: ReturnType<typeof extractRoutes>

  beforeAll(() => {
    routes = extractRoutes({ projectRoot: FIXTURES })
  })

  test("extracts exactly one cron entrypoint (helper() is not picked up)", () => {
    expect(routes).toHaveLength(1)
  })

  test("cron route has kind \"cron\" and the raw cron expression", () => {
    const r = routes[0]
    expect(r.kind).toBe("cron")
    expect(r.method).toBe("CRON")
    expect(r.path).toBe("0 0 * * * *")
    expect(r.cron).toEqual({ expression: "0 0 * * * *" })
    expect(r.symbol).toBe("ReportService::generateHourlyReport")
  })

  test("emitGraphs produces a graph with a \"cron\" EntrypointDescriptor", () => {
    const graphs = emitGraphs(routes)
    expect(graphs).toHaveLength(1)
    expect(graphs[0].source).toEqual({
      type:    "cron",
      id:      "ReportService::generateHourlyReport",
      trigger: "0 0 * * * *",
      metadata: { expression: "0 0 * * * *" },
    })
  })
})
