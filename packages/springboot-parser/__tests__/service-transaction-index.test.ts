import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { buildServiceTransactionIndex } from "../src/service-transaction-index.js"

function writeJava(dir: string, name: string, content: string): string {
  const file = join(dir, name)
  writeFileSync(file, content)
  return file
}

describe("buildServiceTransactionIndex — resolves @Transactional through the interface/impl split", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "archmind-svctxn-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("class-level @Transactional on an Impl class applies to all its methods, resolved via the interface name", () => {
    const iface = writeJava(dir, "WithdrawalService.java", `
      public interface WithdrawalService {
        void withdraw(String userId);
      }
    `)
    const impl = writeJava(dir, "WithdrawalServiceImpl.java", `
      @Transactional
      public class WithdrawalServiceImpl implements WithdrawalService {
        public void withdraw(String userId) { }
      }
    `)

    const index = buildServiceTransactionIndex([iface, impl])

    // Controller injects the interface type "WithdrawalService", calls .withdraw(...)
    expect(index.isTransactional("WithdrawalService", "withdraw", dir)).toBe(true)
  })

  test("method-level @Transactional only covers the annotated method", () => {
    const impl = writeJava(dir, "OrderServiceImpl.java", `
      public class OrderServiceImpl implements OrderService {
        @Transactional
        public void createOrder(String id) { }
        public void listOrders() { }
      }
    `)
    const index = buildServiceTransactionIndex([impl])

    expect(index.isTransactional("OrderService", "createOrder", dir)).toBe(true)
    expect(index.isTransactional("OrderService", "listOrders", dir)).toBe(false)
  })

  test("service with no @Transactional anywhere resolves to false", () => {
    const impl = writeJava(dir, "PlainServiceImpl.java", `
      public class PlainServiceImpl implements PlainService {
        public void doThing() { }
      }
    `)
    const index = buildServiceTransactionIndex([impl])

    expect(index.isTransactional("PlainService", "doThing", dir)).toBe(false)
  })

  test("unresolvable field type (no matching class or interface) resolves to false", () => {
    const index = buildServiceTransactionIndex([])
    expect(index.isTransactional("UnknownService", "anyMethod", dir)).toBe(false)
  })

  test("direct class name (no interface indirection) also resolves", () => {
    const impl = writeJava(dir, "WalletService.java", `
      @Transactional(readOnly = true)
      public class WalletService {
        public void transfer(String id) { }
      }
    `)
    const index = buildServiceTransactionIndex([impl])
    expect(index.isTransactional("WalletService", "transfer", dir)).toBe(true)
  })
})
