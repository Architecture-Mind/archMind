import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import { parseSpringBootProject } from "../src/adapter.js"

function writeJava(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content)
}

describe("parseSpringBootProject — transaction boundary via service layer", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "archmind-adapter-txn-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("emits ir:txn_boundary when the injected interface's Impl class is @Transactional", () => {
    writeJava(dir, "WithdrawalController.java", `
      package net.sparkminds.wallet.controller;
      import org.springframework.web.bind.annotation.*;

      @RestController
      @RequestMapping("/api/withdrawal")
      public class WithdrawalController {
        private final WithdrawalService withdrawalService;
        public WithdrawalController(WithdrawalService withdrawalService) {
          this.withdrawalService = withdrawalService;
        }

        @PostMapping
        public void withdraw(@RequestBody String userId) {
          withdrawalService.withdraw(userId);
        }
      }
    `)
    writeJava(dir, "WithdrawalService.java", `
      package net.sparkminds.wallet.service;
      public interface WithdrawalService {
        void withdraw(String userId);
      }
    `)
    writeJava(dir, "WithdrawalServiceImpl.java", `
      package net.sparkminds.wallet.service.impl;
      import org.springframework.transaction.annotation.Transactional;

      @Transactional
      public class WithdrawalServiceImpl implements WithdrawalService {
        public void withdraw(String userId) { }
      }
    `)

    const graphs = parseSpringBootProject(dir)
    expect(graphs).toHaveLength(1)

    const types = graphs[0]!.nodes.map((n) => n.type)
    expect(types).toContain(IR_NODE_TYPES.TXN_BOUNDARY)
  })

  test("does NOT emit ir:txn_boundary when the service has no @Transactional anywhere", () => {
    writeJava(dir, "OrderController.java", `
      package net.sparkminds.orders.controller;
      import org.springframework.web.bind.annotation.*;

      @RestController
      @RequestMapping("/api/orders")
      public class OrderController {
        private final OrderService orderService;
        public OrderController(OrderService orderService) {
          this.orderService = orderService;
        }

        @GetMapping
        public void listOrders() {
          orderService.list();
        }
      }
    `)
    writeJava(dir, "OrderService.java", `
      package net.sparkminds.orders.service;
      public interface OrderService {
        void list();
      }
    `)
    writeJava(dir, "OrderServiceImpl.java", `
      package net.sparkminds.orders.service.impl;
      public class OrderServiceImpl implements OrderService {
        public void list() { }
      }
    `)

    const graphs = parseSpringBootProject(dir)
    const types  = graphs[0]!.nodes.map((n) => n.type)
    expect(types).not.toContain(IR_NODE_TYPES.TXN_BOUNDARY)
  })
})
