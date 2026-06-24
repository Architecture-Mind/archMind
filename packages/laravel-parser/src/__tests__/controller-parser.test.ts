import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { readFileSync } from "fs"
import { parseControllerMethod, extractUseMap } from "../controller-parser.js"
import Parser from "tree-sitter"
// @ts-ignore
import PHP from "tree-sitter-php"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

const FIXTURES = join(__dirname, "fixtures")
const TASK_CTRL = join(FIXTURES, "app/Modules/Task/Http/Controllers/TaskController.php")

// ---- parseControllerMethod -----------------------------------------------

describe("parseControllerMethod — TaskController::update", () => {
  let result: ReturnType<typeof parseControllerMethod>

  beforeAll(() => {
    result = parseControllerMethod(TASK_CTRL, "update")
  })

  test("returns non-null result", () => {
    expect(result).not.toBeNull()
  })

  test("extracts UpdateTaskRequest from method signature", () => {
    expect(result!.formRequests).toHaveLength(1)
    expect(result!.formRequests[0].shortName).toBe("UpdateTaskRequest")
  })

  test("resolves UpdateTaskRequest to FQCN via use map", () => {
    expect(result!.formRequests[0].fqcn).toBe(
      "App\\Modules\\Task\\Requests\\UpdateTaskRequest"
    )
  })

  test("captures param name", () => {
    expect(result!.formRequests[0].paramName).toBe("$request")
  })

  test("does not include untyped $id parameter as FormRequest", () => {
    const names = result!.formRequests.map((fr) => fr.shortName)
    expect(names).not.toContain("int")
    expect(names).not.toContain("$id")
    expect(names).toHaveLength(1)
  })

  test("extracts one authorize() call", () => {
    expect(result!.authorizeCalls).toHaveLength(1)
  })

  test("authorize() ability is 'update'", () => {
    expect(result!.authorizeCalls[0].ability).toBe("update")
  })

  test("authorize() mechanism text includes '$this->authorize'", () => {
    expect(result!.authorizeCalls[0].mechanism).toMatch(/\$this->authorize/)
  })
})

describe("parseControllerMethod — TaskController::index (viewAny)", () => {
  test("extracts viewAny authorize call", () => {
    const result = parseControllerMethod(TASK_CTRL, "index")
    expect(result).not.toBeNull()
    expect(result!.authorizeCalls).toHaveLength(1)
    expect(result!.authorizeCalls[0].ability).toBe("viewAny")
  })

  test("no FormRequest in index method", () => {
    const result = parseControllerMethod(TASK_CTRL, "index")
    expect(result!.formRequests).toHaveLength(0)
  })
})

describe("parseControllerMethod — non-existent method", () => {
  test("returns empty L1 for missing method", () => {
    const result = parseControllerMethod(TASK_CTRL, "nonexistent")
    expect(result).not.toBeNull()
    expect(result!.formRequests).toHaveLength(0)
    expect(result!.authorizeCalls).toHaveLength(0)
  })
})

describe("parseControllerMethod — file not found", () => {
  test("returns null for missing file", () => {
    const result = parseControllerMethod("/nonexistent/path/Controller.php", "update")
    expect(result).toBeNull()
  })
})

// ---- P0: Constructor middleware extraction ---------------------------------

const MW_CTRL = join(FIXTURES, "app/Http/Controllers/MiddlewareController.php")

describe("parseControllerMethod — constructor middleware (P0)", () => {
  test("extracts $this->middleware() with except filter", () => {
    const result = parseControllerMethod(MW_CTRL, "protectedAction")
    expect(result).not.toBeNull()
    expect(result!.constructorMiddleware).toHaveLength(2)
    expect(result!.constructorMiddleware[0].raw).toBe("auth:web,subdealer")
    expect(result!.constructorMiddleware[0].except).toEqual(["publicAction", "anotherPublic"])
    expect(result!.constructorMiddleware[0].only).toEqual([])
  })

  test("extracts second middleware with no filters", () => {
    const result = parseControllerMethod(MW_CTRL, "protectedAction")
    expect(result!.constructorMiddleware[1].raw).toBe("verified")
    expect(result!.constructorMiddleware[1].except).toEqual([])
    expect(result!.constructorMiddleware[1].only).toEqual([])
  })

  test("returns empty constructorMiddleware when no __construct", () => {
    const result = parseControllerMethod(TASK_CTRL, "update")
    expect(result).not.toBeNull()
    expect(result!.constructorMiddleware).toHaveLength(0)
  })

  test("constructorMiddleware still returned when method not found", () => {
    const result = parseControllerMethod(MW_CTRL, "nonexistent")
    expect(result).not.toBeNull()
    expect(result!.constructorMiddleware).toHaveLength(2)
  })
})

// ---- Phase 5C: private method traversal (depth 1) -----------------------

const ROLE_CTRL = join(FIXTURES, "app/Modules/Role/Http/Controllers/RoleController.php")

describe("parseControllerMethod — private method traversal (depth 1)", () => {
  let result: ReturnType<typeof parseControllerMethod>

  beforeAll(() => {
    result = parseControllerMethod(ROLE_CTRL, "assign")
  })

  test("returns non-null result", () => {
    expect(result).not.toBeNull()
  })

  test("extracts authorize() from public method body", () => {
    expect(result!.authorizeCalls.some((a) => a.ability === "assign")).toBe(true)
  })

  test("extracts service call from private helper validateRequestedRoleLevel", () => {
    const svcSymbols = result!.serviceCalls.map((sc) => sc.serviceClass + "::" + sc.method)
    expect(svcSymbols).toContain("PermissionService::checkRoleHierarchy")
  })

  test("extracts service call from public method body (roleService.assignRole)", () => {
    const svcSymbols = result!.serviceCalls.map((sc) => sc.serviceClass + "::" + sc.method)
    expect(svcSymbols).toContain("RoleService::assignRole")
  })

  test("does NOT traverse into ensureNotSelfAssign (not called from assign)", () => {
    const svcSymbols = result!.serviceCalls.map((sc) => sc.method)
    expect(svcSymbols).not.toContain("assertNotSelf")
    expect(svcSymbols).not.toContain("lockForAssign")
  })

  test("service calls are deduplicated (no double-counting from depth-1)", () => {
    const keys = result!.serviceCalls.map((sc) => `${sc.propertyName}::${sc.method}`)
    const unique = new Set(keys)
    expect(keys.length).toBe(unique.size)
  })
})

// ---- extractUseMap -------------------------------------------------------

describe("extractUseMap from controller file", () => {
  let useMap: Map<string, string>

  beforeAll(() => {
    const parser = new Parser()
    parser.setLanguage((PHP as { php?: unknown }).php ?? PHP)
    const src  = readFileSync(TASK_CTRL, "utf-8")
    const tree = parser.parse(src)
    useMap = extractUseMap(tree.rootNode)
  })

  test("maps UpdateTaskRequest to its FQCN", () => {
    expect(useMap.get("UpdateTaskRequest")).toBe(
      "App\\Modules\\Task\\Requests\\UpdateTaskRequest"
    )
  })

  test("maps TaskService to its FQCN", () => {
    expect(useMap.get("TaskService")).toBe(
      "App\\Modules\\Task\\Services\\TaskService"
    )
  })
})

// ---- returnedResources — OrderController (18B.1) -------------------------

const ORDER_CTRL = join(FIXTURES, "app/Http/Controllers/OrderController.php")

describe("parseControllerMethod — OrderController::show returnedResources", () => {
  let result: ReturnType<typeof parseControllerMethod>

  beforeAll(() => {
    result = parseControllerMethod(ORDER_CTRL, "show")
  })

  test("returns non-null result", () => {
    expect(result).not.toBeNull()
  })

  test("detects one returned resource", () => {
    expect(result!.returnedResources).toHaveLength(1)
  })

  test("shortName is OrderResource", () => {
    expect(result!.returnedResources[0].shortName).toBe("OrderResource")
  })

  test("fqcn resolved via use map", () => {
    expect(result!.returnedResources[0].fqcn).toBe("App\\Http\\Resources\\OrderResource")
  })

  test("isCollection is false for new OrderResource()", () => {
    expect(result!.returnedResources[0].isCollection).toBe(false)
  })
})

describe("parseControllerMethod — OrderController::index returnedResources (collection)", () => {
  let result: ReturnType<typeof parseControllerMethod>

  beforeAll(() => {
    result = parseControllerMethod(ORDER_CTRL, "index")
  })

  test("detects one returned resource", () => {
    expect(result!.returnedResources).toHaveLength(1)
  })

  test("shortName is OrderResource", () => {
    expect(result!.returnedResources[0].shortName).toBe("OrderResource")
  })

  test("isCollection is true for ::collection() call", () => {
    expect(result!.returnedResources[0].isCollection).toBe(true)
  })
})

// ---- standaloneDispatches — JobDispatchController (18B.2) ----------------

const JOB_CTRL = join(FIXTURES, "app/Http/Controllers/JobDispatchController.php")

describe("parseControllerMethod — JobDispatchController::store standaloneDispatches", () => {
  let result: ReturnType<typeof parseControllerMethod>

  beforeAll(() => {
    result = parseControllerMethod(JOB_CTRL, "store")
  })

  test("returns non-null result", () => {
    expect(result).not.toBeNull()
  })

  test("detects 3 standalone dispatches total", () => {
    expect(result!.standaloneDispatches).toHaveLength(3)
  })

  test("ProcessPaymentJob classified as job (static dispatch)", () => {
    const d = result!.standaloneDispatches.find((d) => d.className === "ProcessPaymentJob")
    expect(d).toBeDefined()
    expect(d!.kind).toBe("job")
    expect(d!.fqcn).toBe("App\\Jobs\\ProcessPaymentJob")
  })

  test("SendInvoiceJob classified as job (global dispatch() helper)", () => {
    const d = result!.standaloneDispatches.find((d) => d.className === "SendInvoiceJob")
    expect(d).toBeDefined()
    expect(d!.kind).toBe("job")
  })

  test("OrderCreated classified as event", () => {
    const d = result!.standaloneDispatches.find((d) => d.className === "OrderCreated")
    expect(d).toBeDefined()
    expect(d!.kind).toBe("event")
  })
})

describe("parseControllerMethod — OrderController::store returnedResources", () => {
  let result: ReturnType<typeof parseControllerMethod>

  beforeAll(() => {
    result = parseControllerMethod(ORDER_CTRL, "store")
  })

  test("detects resource return after create", () => {
    expect(result!.returnedResources).toHaveLength(1)
    expect(result!.returnedResources[0].shortName).toBe("OrderResource")
    expect(result!.returnedResources[0].isCollection).toBe(false)
  })
})

// ---- standaloneNotifications — NotificationController (18B.3) ------------

const NOTIF_CTRL = join(FIXTURES, "app/Http/Controllers/NotificationController.php")

describe("parseControllerMethod — NotificationController::notify standaloneNotifications", () => {
  let result: ReturnType<typeof parseControllerMethod>

  beforeAll(() => {
    result = parseControllerMethod(NOTIF_CTRL, "notify")
  })

  test("returns non-null result", () => {
    expect(result).not.toBeNull()
  })

  test("detects 4 standalone notifications total", () => {
    expect(result!.standaloneNotifications).toHaveLength(4)
  })

  test("WelcomeNotification classified as notification (Notification::send)", () => {
    const d = result!.standaloneNotifications.find((d) => d.className === "WelcomeNotification")
    expect(d).toBeDefined()
    expect(d!.kind).toBe("notification")
    expect(d!.queued).toBe(false)
    expect(d!.fqcn).toBe("App\\Notifications\\WelcomeNotification")
  })

  test("OrderShippedNotification classified as notification ($user->notify)", () => {
    const d = result!.standaloneNotifications.find((d) => d.className === "OrderShippedNotification")
    expect(d).toBeDefined()
    expect(d!.kind).toBe("notification")
  })

  test("OrderConfirmationMail classified as mail (Mail::to()->send)", () => {
    const d = result!.standaloneNotifications.find((d) => d.className === "OrderConfirmationMail")
    expect(d).toBeDefined()
    expect(d!.kind).toBe("mail")
    expect(d!.queued).toBe(false)
  })

  test("AdminAlertMail classified as mail and queued (Mail::to()->queue)", () => {
    const d = result!.standaloneNotifications.find((d) => d.className === "AdminAlertMail")
    expect(d).toBeDefined()
    expect(d!.kind).toBe("mail")
    expect(d!.queued).toBe(true)
  })
})

// ---- $this->dispatch() / dispatchSync() — ThisDispatchController --------

const THIS_CTRL = join(FIXTURES, "app/Http/Controllers/ThisDispatchController.php")

describe("parseControllerMethod — ThisDispatchController::store $this->dispatch()", () => {
  let result: ReturnType<typeof parseControllerMethod>

  beforeAll(() => {
    result = parseControllerMethod(THIS_CTRL, "store")
  })

  test("detects 1 standalone dispatch via $this->dispatch()", () => {
    expect(result!.standaloneDispatches).toHaveLength(1)
  })

  test("ProcessReportJob classified as job", () => {
    const d = result!.standaloneDispatches.find((d) => d.className === "ProcessReportJob")
    expect(d).toBeDefined()
    expect(d!.kind).toBe("job")
  })
})

describe("parseControllerMethod — ThisDispatchController::register $this->dispatchSync()", () => {
  let result: ReturnType<typeof parseControllerMethod>

  beforeAll(() => {
    result = parseControllerMethod(THIS_CTRL, "register")
  })

  test("detects 1 dispatch via $this->dispatchSync()", () => {
    expect(result!.standaloneDispatches).toHaveLength(1)
  })

  test("RegisterUserJob classified as job", () => {
    const d = result!.standaloneDispatches.find((d) => d.className === "RegisterUserJob")
    expect(d).toBeDefined()
    expect(d!.kind).toBe("job")
  })
})
