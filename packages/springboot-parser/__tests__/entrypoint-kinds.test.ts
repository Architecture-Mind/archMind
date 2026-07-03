import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { parseSpringBootProject } from "../src/adapter.js"

function writeJava(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content)
}

describe("parseSpringBootProject — non-HTTP entrypoint kinds", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "archmind-entrypoint-kinds-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("@KafkaListener method is emitted as a queue entrypoint", () => {
    writeJava(dir, "OrderConsumer.java", `
      package com.example.orders;
      import org.springframework.kafka.annotation.KafkaListener;
      import org.springframework.stereotype.Component;

      @Component
      public class OrderConsumer {
        private final OrderService orderService;
        public OrderConsumer(OrderService orderService) {
          this.orderService = orderService;
        }

        @KafkaListener(topics = "orders-created", groupId = "order-service")
        public void onOrderCreated(String payload) {
          orderService.process(payload);
        }
      }
    `)
    writeJava(dir, "OrderService.java", `
      package com.example.orders;
      public interface OrderService {
        void process(String payload);
      }
    `)

    const graphs = parseSpringBootProject(dir)
    expect(graphs).toHaveLength(1)

    const graph = graphs[0]
    expect(graph.method).toBe("MESSAGE")
    expect(graph.path).toBe("orders-created")
    expect(graph.source).toEqual({
      type:    "queue",
      id:      "KafkaListener:orders-created",
      trigger: "orders-created",
      metadata: { annotation: "KafkaListener", destination: "orders-created", groupId: "order-service" },
    })
  })

  test("@Scheduled method is emitted as a cron entrypoint", () => {
    writeJava(dir, "ReportJob.java", `
      package com.example.jobs;
      import org.springframework.scheduling.annotation.Scheduled;
      import org.springframework.stereotype.Component;

      @Component
      public class ReportJob {
        private final ReportService reportService;
        public ReportJob(ReportService reportService) {
          this.reportService = reportService;
        }

        @Scheduled(cron = "0 0 * * * *")
        public void generateHourlyReport() {
          reportService.generate();
        }
      }
    `)
    writeJava(dir, "ReportService.java", `
      package com.example.jobs;
      public interface ReportService {
        void generate();
      }
    `)

    const graphs = parseSpringBootProject(dir)
    expect(graphs).toHaveLength(1)

    const graph = graphs[0]
    expect(graph.method).toBe("SCHEDULE")
    expect(graph.path).toBe("0 0 * * * *")
    expect(graph.source).toEqual({
      type:    "cron",
      id:      "ReportJob::generateHourlyReport",
      trigger: "0 0 * * * *",
      metadata: { expression: "0 0 * * * *" },
    })
  })
})
