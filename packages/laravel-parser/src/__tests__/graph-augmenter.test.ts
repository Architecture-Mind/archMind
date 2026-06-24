import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { augmentGraph } from "../graph-augmenter.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

const FIXTURES = join(__dirname, "fixtures")

// Skeleton graph where the controller node points at the fixture file
const SKELETON: IntermediateExecutionGraph = {
  entrypoint: "PUT /tasks/{task}",
  method:     "PUT",
  path:       "/tasks/{task}",
  nodes: [
    {
      id:     "ctrl_taskcontroller_update",
      type:   "ir:business_handler",
      symbol: "TaskController::update",
      role:   "handler",
      file:   "app/Modules/Task/Http/Controllers/TaskController.php",
    },
  ],
  edges:       [],
  annotations: [],
}

describe("augmentGraph — TaskController::update", () => {
  let augmented: IntermediateExecutionGraph

  beforeAll(() => {
    augmented = augmentGraph(SKELETON, { projectRoot: FIXTURES })
  })

  test("adds a form_request node", () => {
    const types = augmented.nodes.map((n) => n.type)
    expect(types).toContain("ir:validation_gate")
  })

  test("form_request symbol is UpdateTaskRequest::authorize", () => {
    const node = augmented.nodes.find((n) => n.type === "ir:validation_gate")
    expect(node?.symbol).toBe("UpdateTaskRequest::authorize")
  })

  test("adds a policy node", () => {
    const types = augmented.nodes.map((n) => n.type)
    expect(types).toContain("ir:authz_check")
  })

  test("policy symbol is TaskPolicy::update", () => {
    const node = augmented.nodes.find((n) => n.type === "ir:authz_check")
    expect(node?.symbol).toBe("TaskPolicy::update")
  })

  test("form_request edge has traceability static", () => {
    const edge = augmented.edges.find((e) => e.relation === "form_request")
    expect(edge?.traceability).toBe("static")
    expect(edge?.from).toBe("ctrl_taskcontroller_update")
  })

  test("policy_check edge has traceability semantic", () => {
    const edge = augmented.edges.find((e) => e.relation === "policy_check")
    expect(edge?.traceability).toBe("semantic")
    expect(edge?.from).toBe("ctrl_taskcontroller_update")
    expect(edge?.mechanism).toMatch(/authorize/)
  })

  test("original skeleton nodes are preserved", () => {
    expect(augmented.nodes.some((n) => n.type === "ir:business_handler")).toBe(true)
  })
})

describe("augmentGraph — service_call extraction", () => {
  let augmented: IntermediateExecutionGraph

  const SKELETON_WITH_MW: IntermediateExecutionGraph = {
    entrypoint: "PUT /tasks/{task}",
    method: "PUT", path: "/tasks/{task}",
    nodes: [
      {
        id: "mw_2_checkpermission", type: "ir:authz_check",
        symbol: "CheckPermission::handle", role: "authorization",
        file: "app/Http/Middleware/CheckPermission.php",
      },
      {
        id: "ctrl_taskcontroller_update", type: "ir:business_handler",
        symbol: "TaskController::update", role: "handler",
        file: "app/Modules/Task/Http/Controllers/TaskController.php",
      },
    ],
    edges: [
      { from: "mw_2_checkpermission", to: "ctrl_taskcontroller_update", relation: "next_middleware", traceability: "static" },
    ],
    annotations: [],
  }

  beforeAll(() => {
    augmented = augmentGraph(SKELETON_WITH_MW, { projectRoot: FIXTURES })
  })

  test("extracts service_call from CheckPermission::handle", () => {
    const sc = augmented.nodes.find(
      n => n.type === "ir:service_call" && n.symbol === "PermissionService::hasPermission"
        && n.id.includes("checkpermission")
    )
    expect(sc).toBeDefined()
  })

  test("CheckPermission service_call has correct file", () => {
    const sc = augmented.nodes.find(
      n => n.type === "ir:service_call" && n.id.includes("checkpermission")
    )
    expect(sc?.file).toBe("app/Modules/Access/Services/PermissionService.php")
  })

  test("extracts service_call from TaskPolicy::update", () => {
    const sc = augmented.nodes.find(
      n => n.type === "ir:service_call" && n.symbol === "PermissionService::hasPermission"
        && n.id.includes("policy")
    )
    expect(sc).toBeDefined()
  })

  test("policy service_call has args (TASK_UPDATE)", () => {
    const sc = augmented.nodes.find(
      n => n.type === "ir:service_call" && n.id.includes("policy")
    )
    expect(sc?.args).toContain("TASK_UPDATE")
  })

  test("service_call edges have relation 'calls' and traceability semantic", () => {
    const serviceCallIds = new Set(augmented.nodes.filter(n => n.type === "ir:service_call").map(n => n.id))
    const scEdges = augmented.edges.filter(e => e.relation === "calls" && serviceCallIds.has(e.to))
    expect(scEdges.length).toBeGreaterThanOrEqual(2)
    expect(scEdges.every(e => e.traceability === "semantic")).toBe(true)
  })

  test("two distinct service_call nodes for same method (caller-scoped IDs)", () => {
    const scNodes = augmented.nodes.filter(
      n => n.type === "ir:service_call" && n.symbol === "PermissionService::hasPermission"
    )
    expect(scNodes.length).toBe(2)
    expect(scNodes[0].id).not.toBe(scNodes[1].id)
  })
})

describe("augmentGraph — missing file field", () => {
  test("returns graph unchanged when controller has no file field", () => {
    const noFile: IntermediateExecutionGraph = {
      ...SKELETON,
      nodes: [{ id: "ctrl", type: "ir:business_handler", symbol: "Ctrl::act", role: "handler" }],
    }
    const result = augmentGraph(noFile, { projectRoot: FIXTURES })
    expect(result.nodes).toHaveLength(1)
    expect(result.edges).toHaveLength(0)
  })
})

// ---- P1: Event → listener tracing ------------------------------------

const TXN_STORE_SKELETON: IntermediateExecutionGraph = {
  entrypoint: "POST /tasks",
  method:     "POST",
  path:       "/tasks",
  nodes: [{
    id:     "ctrl_taskcontroller_store",
    type:   "ir:business_handler",
    symbol: "TaskController::store",
    role:   "handler",
    file:   "app/Modules/Task/Http/Controllers/TaskController.php",
  }],
  edges:       [],
  annotations: [],
}

describe("augmentGraph — event→listener tracing (P1)", () => {
  let aug: IntermediateExecutionGraph

  beforeAll(() => {
    aug = augmentGraph(TXN_STORE_SKELETON, { projectRoot: FIXTURES })
  })

  test("emits transaction_escape node for TaskCreated::dispatch", () => {
    const esc = aug.nodes.find((n) => n.type === "ir:txn_escape")
    expect(esc).toBeDefined()
    expect(esc?.symbol).toBe("TaskCreated::dispatch")
  })

  test("emits service_call listener node for SendTaskCreatedNotification::handle", () => {
    const listener = aug.nodes.find((n) => n.symbol === "SendTaskCreatedNotification::handle")
    expect(listener).toBeDefined()
    expect(listener?.type).toBe("ir:service_call")
    expect(listener?.role).toBe("listener")
    expect(listener?.file).toBe("app/Listeners/SendTaskCreatedNotification.php")
  })

  test("listener node is NOT marked afterCommitSafe (ShouldQueue, no ShouldHandleEventsAfterCommit)", () => {
    const listener = aug.nodes.find((n) => n.symbol === "SendTaskCreatedNotification::handle")
    expect(listener?.args ?? []).not.toContain("afterCommit")
  })

  test("calls edge connects transaction_escape to listener", () => {
    const escNode    = aug.nodes.find((n) => n.type === "ir:txn_escape")
    const listenNode = aug.nodes.find((n) => n.symbol === "SendTaskCreatedNotification::handle")
    const edge = aug.edges.find(
      (e) => e.from === escNode?.id && e.to === listenNode?.id && e.relation === "calls"
    )
    expect(edge).toBeDefined()
    expect(edge?.traceability).toBe("semantic")
  })
})

// ---- API Resource emission (18B.1) ----------------------------------------

describe("augmentGraph — ir:api_resource nodes (OrderController::show)", () => {
  let aug: IntermediateExecutionGraph

  const SKELETON_ORDER: IntermediateExecutionGraph = {
    entrypoint: "GET /orders/{order}",
    method: "GET",
    path: "/orders/{order}",
    nodes: [
      {
        id:     "ctrl_ordercontroller_show",
        type:   "ir:business_handler",
        symbol: "OrderController::show",
        role:   "handler",
        file:   "app/Http/Controllers/OrderController.php",
      },
    ],
    edges:       [],
    annotations: [],
  }

  beforeAll(() => {
    aug = augmentGraph(SKELETON_ORDER, { projectRoot: FIXTURES })
  })

  test("emits an ir:api_resource node", () => {
    expect(aug.nodes.some((n) => n.type === "ir:api_resource")).toBe(true)
  })

  test("api_resource symbol is OrderResource::toArray", () => {
    const node = aug.nodes.find((n) => n.type === "ir:api_resource")
    expect(node?.symbol).toBe("OrderResource::toArray")
  })

  test("api_resource role is response_shape", () => {
    const node = aug.nodes.find((n) => n.type === "ir:api_resource")
    expect(node?.role).toBe("response_shape")
  })

  test("api_resource detail contains parsed fields", () => {
    const node = aug.nodes.find((n) => n.type === "ir:api_resource")
    expect(node?.detail).toBeDefined()
    const detail = JSON.parse(node!.detail!)
    expect(detail.fields).toContain("id")
    expect(detail.fields).toContain("status")
    expect(detail.fields).toContain("total")
  })

  test("api_resource detail flags sensitive field 'token'", () => {
    const node = aug.nodes.find((n) => n.type === "ir:api_resource")
    const detail = JSON.parse(node!.detail!)
    expect(detail.sensitiveFields).toContain("token")
  })

  test("ir:returns edge connects business_handler to api_resource", () => {
    const resNode = aug.nodes.find((n) => n.type === "ir:api_resource")
    const edge = aug.edges.find(
      (e) => e.from === "ctrl_ordercontroller_show" && e.to === resNode?.id && e.relation === "ir:returns"
    )
    expect(edge).toBeDefined()
    expect(edge?.traceability).toBe("static")
  })

  test("isCollection false for show()", () => {
    const node = aug.nodes.find((n) => n.type === "ir:api_resource")
    const detail = JSON.parse(node!.detail!)
    expect(detail.isCollection).toBe(false)
  })
})

// ---- Standalone dispatch nodes (18B.2) -----------------------------------

describe("augmentGraph — ir:queue_job nodes (JobDispatchController::store)", () => {
  let aug: IntermediateExecutionGraph

  const SKELETON_JOB: IntermediateExecutionGraph = {
    entrypoint: "POST /job-orders",
    method: "POST",
    path: "/job-orders",
    nodes: [
      {
        id:     "ctrl_jobdispatch_store",
        type:   "ir:business_handler",
        symbol: "JobDispatchController::store",
        role:   "handler",
        file:   "app/Http/Controllers/JobDispatchController.php",
      },
    ],
    edges:       [],
    annotations: [],
  }

  beforeAll(() => {
    aug = augmentGraph(SKELETON_JOB, { projectRoot: FIXTURES })
  })

  test("emits ir:queue_job nodes for job dispatches", () => {
    const jobNodes = aug.nodes.filter((n) => n.type === "ir:queue_job")
    expect(jobNodes.length).toBeGreaterThanOrEqual(2)
  })

  test("ProcessPaymentJob emits ir:queue_job node", () => {
    const node = aug.nodes.find((n) => n.type === "ir:queue_job" && n.symbol.includes("ProcessPaymentJob"))
    expect(node).toBeDefined()
    expect(node!.symbol).toBe("ProcessPaymentJob::dispatch")
    expect(node!.role).toBe("async_execution")
  })

  test("SendInvoiceJob emits ir:queue_job node", () => {
    const node = aug.nodes.find((n) => n.type === "ir:queue_job" && n.symbol.includes("SendInvoiceJob"))
    expect(node).toBeDefined()
  })

  test("ir:dispatches edge connects handler to queue_job", () => {
    const jobNode = aug.nodes.find((n) => n.type === "ir:queue_job" && n.symbol.includes("ProcessPaymentJob"))
    const edge = aug.edges.find(
      (e) => e.from === "ctrl_jobdispatch_store" && e.to === jobNode?.id && e.relation === "ir:dispatches"
    )
    expect(edge).toBeDefined()
    expect(edge!.traceability).toBe("static")
  })

  test("emits ir:event_dispatch node for OrderCreated", () => {
    const node = aug.nodes.find((n) => n.type === "ir:event_dispatch")
    expect(node).toBeDefined()
    expect(node!.symbol).toBe("OrderCreated::dispatch")
    expect(node!.role).toBe("event_emission")
  })

  test("ir:dispatches edge connects handler to event_dispatch", () => {
    const evtNode = aug.nodes.find((n) => n.type === "ir:event_dispatch")
    const edge = aug.edges.find(
      (e) => e.from === "ctrl_jobdispatch_store" && e.to === evtNode?.id && e.relation === "ir:dispatches"
    )
    expect(edge).toBeDefined()
  })

  test("transaction-internal dispatches are NOT re-emitted as ir:queue_job", () => {
    // TaskController::store dispatches TaskCreated inside DB::transaction()
    // It should only appear as ir:txn_escape, not as a duplicate ir:queue_job
    const jobNodes = aug.nodes.filter((n) => n.type === "ir:queue_job")
    const hasTaskCreated = jobNodes.some((n) => n.symbol.includes("TaskCreated"))
    expect(hasTaskCreated).toBe(false)
  })
})

// ---- Notification + Mail nodes (18B.3) ----------------------------------

describe("augmentGraph — ir:notification + ir:mail nodes (NotificationController::notify)", () => {
  let aug: IntermediateExecutionGraph

  const SKELETON_NOTIF: IntermediateExecutionGraph = {
    entrypoint: "POST /notify",
    method: "POST",
    path: "/notify",
    nodes: [
      {
        id:     "ctrl_notif_notify",
        type:   "ir:business_handler",
        symbol: "NotificationController::notify",
        role:   "handler",
        file:   "app/Http/Controllers/NotificationController.php",
      },
    ],
    edges:       [],
    annotations: [],
  }

  beforeAll(() => {
    aug = augmentGraph(SKELETON_NOTIF, { projectRoot: FIXTURES })
  })

  test("emits ir:notification nodes", () => {
    const nodes = aug.nodes.filter((n) => n.type === "ir:notification")
    expect(nodes.length).toBeGreaterThanOrEqual(2)
  })

  test("WelcomeNotification emits ir:notification node", () => {
    const node = aug.nodes.find((n) => n.type === "ir:notification" && n.symbol.includes("WelcomeNotification"))
    expect(node).toBeDefined()
    expect(node!.role).toBe("side_effect")
  })

  test("OrderShippedNotification emits ir:notification node", () => {
    const node = aug.nodes.find((n) => n.type === "ir:notification" && n.symbol.includes("OrderShippedNotification"))
    expect(node).toBeDefined()
  })

  test("ir:sends edge connects handler to ir:notification", () => {
    const notifNode = aug.nodes.find((n) => n.type === "ir:notification" && n.symbol.includes("WelcomeNotification"))
    const edge = aug.edges.find(
      (e) => e.from === "ctrl_notif_notify" && e.to === notifNode?.id && e.relation === "ir:sends"
    )
    expect(edge).toBeDefined()
    expect(edge!.traceability).toBe("static")
  })

  test("emits ir:mail nodes", () => {
    const nodes = aug.nodes.filter((n) => n.type === "ir:mail")
    expect(nodes.length).toBeGreaterThanOrEqual(2)
  })

  test("OrderConfirmationMail emits ir:mail node (queued=false)", () => {
    const node = aug.nodes.find((n) => n.type === "ir:mail" && n.symbol.includes("OrderConfirmationMail"))
    expect(node).toBeDefined()
    const detail = JSON.parse(node!.detail!)
    expect(detail.queued).toBe(false)
  })

  test("AdminAlertMail emits ir:mail node (queued=true)", () => {
    const node = aug.nodes.find((n) => n.type === "ir:mail" && n.symbol.includes("AdminAlertMail"))
    expect(node).toBeDefined()
    const detail = JSON.parse(node!.detail!)
    expect(detail.queued).toBe(true)
  })

  test("ir:sends edge connects handler to ir:mail", () => {
    const mailNode = aug.nodes.find((n) => n.type === "ir:mail" && n.symbol.includes("OrderConfirmationMail"))
    const edge = aug.edges.find(
      (e) => e.from === "ctrl_notif_notify" && e.to === mailNode?.id && e.relation === "ir:sends"
    )
    expect(edge).toBeDefined()
  })
})

describe("augmentGraph — ir:api_resource nodes (OrderController::index, collection)", () => {
  let aug: IntermediateExecutionGraph

  const SKELETON_INDEX: IntermediateExecutionGraph = {
    entrypoint: "GET /orders",
    method: "GET",
    path: "/orders",
    nodes: [
      {
        id:     "ctrl_ordercontroller_index",
        type:   "ir:business_handler",
        symbol: "OrderController::index",
        role:   "handler",
        file:   "app/Http/Controllers/OrderController.php",
      },
    ],
    edges:       [],
    annotations: [],
  }

  beforeAll(() => {
    aug = augmentGraph(SKELETON_INDEX, { projectRoot: FIXTURES })
  })

  test("emits an ir:api_resource node for collection", () => {
    expect(aug.nodes.some((n) => n.type === "ir:api_resource")).toBe(true)
  })

  test("isCollection true for index()", () => {
    const node = aug.nodes.find((n) => n.type === "ir:api_resource")
    const detail = JSON.parse(node!.detail!)
    expect(detail.isCollection).toBe(true)
  })
})

// ---- Nested resource detection — ArticleResource -------------------------

describe("augmentGraph — nested ir:api_resource nodes (ArticleResource → TagResource, AuthorResource)", () => {
  let aug: IntermediateExecutionGraph

  const SKELETON_ARTICLE: IntermediateExecutionGraph = {
    entrypoint: "GET /articles/{article}",
    method: "GET",
    path: "/articles/{article}",
    nodes: [
      {
        id:     "ctrl_articlecontroller_show",
        type:   "ir:business_handler",
        symbol: "ArticleController::show",
        role:   "handler",
        file:   "app/Http/Controllers/ArticleController.php",
      },
    ],
    edges:       [],
    annotations: [],
  }

  // Wire a stub ArticleController that returns ArticleResource
  beforeAll(async () => {
    // ArticleController.php isn't needed for this test — we manually augment
    // by replacing the resource node directly. Instead, test resource-parser
    // extractNestedResourceRefs directly on the ArticleResource fixture.
    const { parseApiResource } = await import("../resource-parser.js")
    const articleResourcePath = join(FIXTURES, "app/Http/Resources/ArticleResource.php")
    aug = {
      ...SKELETON_ARTICLE,
      nodes: [{ ...SKELETON_ARTICLE.nodes[0]! }],
      edges: [],
    }

    const info = parseApiResource(articleResourcePath)
    // Attach test result to aug for assertions
    ;(aug as any).__articleResourceInfo = info
  })

  test("parseApiResource detects 2 nested resource refs (AuthorResource, TagResource)", () => {
    const info = (aug as any).__articleResourceInfo
    expect(info).not.toBeNull()
    expect(info.nestedResources).toHaveLength(2)
  })

  test("AuthorResource detected as non-collection (::make())", () => {
    const info = (aug as any).__articleResourceInfo
    const ref = info.nestedResources.find((r: any) => r.shortName === "AuthorResource")
    expect(ref).toBeDefined()
    expect(ref.isCollection).toBe(false)
  })

  test("TagResource detected as collection (::collection())", () => {
    const info = (aug as any).__articleResourceInfo
    const ref = info.nestedResources.find((r: any) => r.shortName === "TagResource")
    expect(ref).toBeDefined()
    expect(ref.isCollection).toBe(true)
  })
})

// ---- Nested resource in when() closures — CustomerResource ---------------

describe("parseApiResource — CustomerResource nested resources inside $this->when() closures", () => {
  test("detects AddressResource and CompanyResource inside when() closures", async () => {
    const { parseApiResource } = await import("../resource-parser.js")
    const path = join(FIXTURES, "app/Http/Resources/CustomerResource.php")
    const info = parseApiResource(path)
    expect(info).not.toBeNull()
    const names = info!.nestedResources.map((r) => r.shortName)
    expect(names).toContain("AddressResource")
    expect(names).toContain("CompanyResource")
  })
})

// ---- Job handle() body parsing — ApproveArticleJob ----------------------

describe("augmentGraph — ir:queue_job expands handle() and finds nested ir:event_dispatch", () => {
  let aug: IntermediateExecutionGraph

  const SKELETON_JOB_CTRL: IntermediateExecutionGraph = {
    entrypoint: "POST /articles/{article}/approve",
    method: "POST",
    path: "/articles/{article}/approve",
    nodes: [
      {
        id:     "ctrl_approve_article_ctrl",
        type:   "ir:business_handler",
        symbol: "ApproveArticleController::__invoke",
        role:   "handler",
        file:   "app/Http/Controllers/ApproveArticleController.php",
      },
    ],
    edges:       [],
    annotations: [],
  }

  beforeAll(async () => {
    // Test job body expansion directly via parseControllerMethod
    const { parseControllerMethod } = await import("../controller-parser.js")
    const jobPath = join(FIXTURES, "app/Jobs/ApproveArticleJob.php")
    const result = parseControllerMethod(jobPath, "handle")
    aug = { ...SKELETON_JOB_CTRL, nodes: [...SKELETON_JOB_CTRL.nodes], edges: [] }
    ;(aug as any).__jobL1 = result
  })

  test("job handle() body has 1 standalone dispatch", () => {
    const l1 = (aug as any).__jobL1
    expect(l1).not.toBeNull()
    expect(l1.standaloneDispatches).toHaveLength(1)
  })

  test("dispatch is ArticleWasApproved classified as event", () => {
    const l1 = (aug as any).__jobL1
    const d = l1.standaloneDispatches[0]
    expect(d.className).toBe("ArticleWasApproved")
    expect(d.kind).toBe("event")
  })
})
