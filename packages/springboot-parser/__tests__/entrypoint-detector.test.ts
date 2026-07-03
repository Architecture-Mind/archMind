import {
  httpEntrypointDetector,
  messagingEntrypointDetector,
  scheduledEntrypointDetector,
  entrypointDetectors,
} from "../src/entrypoint-detector.js"

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

describe("messagingEntrypointDetector", () => {
  test("matches a class with @KafkaListener", () => {
    const source = `
      @Component
      public class OrderConsumer {
        @KafkaListener(topics = "orders", groupId = "order-service")
        public void consume(String payload) {}
      }
    `
    expect(messagingEntrypointDetector.matchesSource(source)).toBe(true)
  })

  test("matches a class with @RabbitListener", () => {
    expect(messagingEntrypointDetector.matchesSource("@RabbitListener(queues = \"orders\")")).toBe(true)
  })

  test("does not match a plain component", () => {
    expect(messagingEntrypointDetector.matchesSource("@Component public class Foo {}")).toBe(false)
  })

  test("kind is \"queue\"", () => {
    expect(messagingEntrypointDetector.kind).toBe("queue")
  })
})

describe("scheduledEntrypointDetector", () => {
  test("matches a class with @Scheduled", () => {
    const source = `
      @Component
      public class ReportJob {
        @Scheduled(cron = "0 0 * * * *")
        public void run() {}
      }
    `
    expect(scheduledEntrypointDetector.matchesSource(source)).toBe(true)
  })

  test("does not match a plain component", () => {
    expect(scheduledEntrypointDetector.matchesSource("@Component public class Foo {}")).toBe(false)
  })

  test("kind is \"cron\"", () => {
    expect(scheduledEntrypointDetector.kind).toBe("cron")
  })
})

describe("entrypointDetectors registry", () => {
  test("includes all three detectors", () => {
    expect(entrypointDetectors).toContain(httpEntrypointDetector)
    expect(entrypointDetectors).toContain(messagingEntrypointDetector)
    expect(entrypointDetectors).toContain(scheduledEntrypointDetector)
  })
})
