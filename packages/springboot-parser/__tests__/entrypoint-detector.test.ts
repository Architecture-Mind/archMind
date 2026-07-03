import { httpEntrypointDetector, entrypointDetectors } from "../src/entrypoint-detector.js"

describe("httpEntrypointDetector", () => {
  test("matches a REST controller with a mapping annotation", () => {
    const source = `
      @RestController
      @RequestMapping("/orders")
      public class OrderController {
        @GetMapping
        public List<Order> list() { return null; }
      }
    `
    expect(httpEntrypointDetector.matchesSource(source)).toBe(true)
  })

  test("does not match a plain service class", () => {
    const source = `
      @Service
      public class OrderService {
        public void create() {}
      }
    `
    expect(httpEntrypointDetector.matchesSource(source)).toBe(false)
  })

  test("does not match a @Controller with no mapping annotation", () => {
    const source = `
      @Controller
      public class OrderController {}
    `
    expect(httpEntrypointDetector.matchesSource(source)).toBe(false)
  })

  test("kind is \"http\"", () => {
    expect(httpEntrypointDetector.kind).toBe("http")
  })
})

describe("entrypointDetectors registry", () => {
  test("includes the HTTP detector", () => {
    expect(entrypointDetectors).toContain(httpEntrypointDetector)
  })
})
