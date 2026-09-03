import { join } from "path"
import { existsSync, readFileSync } from "fs"
import type {
  IntermediateExecutionGraph,
  ExecutionNode,
  ExecutionEdge,
  GraphAnnotation,
  ProjectConfig,
} from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES, IR_EDGE_RELATIONS, IR_VERSION } from "@kidkender/archmind-protocol"

const ADAPTER_VERSION = "0.1.0"

// ---- Cached parse-op wrappers --------------------------------------------

type CtrlL1   = ReturnType<typeof parseControllerMethod>
type ApiRes   = ReturnType<typeof parseApiResource>
type TxnRes   = ReturnType<typeof parseTransactions>
type IsoRes   = ReturnType<typeof parseIsolation>

function ctrlL1(cache: ParseCache<unknown> | null, filePath: string, method: string): CtrlL1 {
  if (!cache) return parseControllerMethod(filePath, method)
  return (cache as ParseCache<CtrlL1>).compute(filePath, method, () => parseControllerMethod(filePath, method))
}

function apiRes(cache: ParseCache<unknown> | null, filePath: string): ApiRes {
  if (!cache) return parseApiResource(filePath)
  return (cache as ParseCache<ApiRes>).compute(filePath, "parseApiResource", () => parseApiResource(filePath))
}

function txnRes(cache: ParseCache<unknown> | null, filePath: string, methodName: string): TxnRes {
  if (!cache) return parseTransactions(filePath, methodName)
  return (cache as ParseCache<TxnRes>).compute(filePath, `parseTransactions::${methodName}`, () => parseTransactions(filePath, methodName))
}

function isoRes(cache: ParseCache<unknown> | null, filePath: string, opts: { tenantSignals: string[]; tenantContainerKeys: string[] }, methodName: string): IsoRes {
  if (!cache) return parseIsolation(filePath, opts, methodName)
  // opts are constant per project root, so discriminator doesn't need to include them
  return (cache as ParseCache<IsoRes>).compute(filePath, `parseIsolation::${methodName}`, () => parseIsolation(filePath, opts, methodName))
}

type GuardRes = ReturnType<typeof detectGuardClause>

function guardRes(cache: ParseCache<unknown> | null, filePath: string, methodName: string): GuardRes {
  if (!cache) return detectGuardClause(filePath, methodName)
  return (cache as ParseCache<GuardRes>).compute(filePath, `guardClause::${methodName}`, () => detectGuardClause(filePath, methodName))
}

type AuditRes = ReturnType<typeof parseAuditLogCalls>

function auditRes(cache: ParseCache<unknown> | null, filePath: string, auditSinks: string[], methodName: string): AuditRes {
  if (!cache) return parseAuditLogCalls(filePath, auditSinks, methodName)
  return (cache as ParseCache<AuditRes>).compute(filePath, `auditLog::${auditSinks.join(",")}::${methodName}`, () => parseAuditLogCalls(filePath, auditSinks, methodName))
}
import { parseControllerMethod, parseFormRequestAuthorize, detectParamDrivenBranch, type ServiceCall, type ModelParam, type StandaloneDispatch, type NotificationDispatch, type ConditionalBranch } from "./controller-parser.js"
import type { ListenerEntry } from "./event-listener-mapper.js"
import { middlewareToNode } from "./middleware-mapper.js"
import { parseEventListeners } from "./event-listener-mapper.js"
import { parseConstantClass } from "./constant-resolver.js"
import { extractPermissionNodes } from "./permission-extractor/constants.js"
import { buildHierarchyEdges } from "./permission-extractor/hierarchy.js"
import { parseTransactions } from "./transaction-parser.js"
import { parseIsolation } from "./isolation-parser.js"
import { detectGuardClause } from "./guard-clause-parser.js"
import { parseAuditLogCalls } from "./audit-log-parser.js"
import { DEFAULT_PROJECT_CONFIG, fqcnToPath, resolvePolicyFile } from "./project-config.js"
import { parseApiResource, type NestedResourceRef } from "./resource-parser.js"
import { ParseCache } from "./parse-cache.js"

// ---- Public API -------------------------------------------------------

/**
 * Controls which service branches to expand recursively.
 *
 * - "all"         — expand everything up to depth/budget limits (default)
 * - "auth"        — only expand auth/permission/policy/guard services
 * - "transaction" — only expand services that contain DB::transaction
 * - "tenant"      — only expand tenant/scope/isolation services
 */
export type ExpansionFocus = "all" | "auth" | "transaction" | "tenant"

export interface AugmentOptions {
  projectRoot: string
  /**
   * Optional project configuration. When provided, overrides the default
   * hardcoded assumptions (PSR-4 namespaces, policy paths, permission files, etc.).
   * Falls back to DEFAULT_PROJECT_CONFIG when omitted.
   */
  config?: ProjectConfig
  /**
   * Optional expansion focus. When set, only service call nodes matching the
   * focus domain are recursively expanded — all other service calls are kept as
   * terminal nodes. Defaults to "all" (expand everything).
   */
  expansionFocus?: ExpansionFocus
  /**
   * @deprecated Use config.permissionConstantFiles instead.
   * Still accepted for backwards compatibility — merged with config if both present.
   */
  permissionConstantFiles?: string[]
  /**
   * Optional parse-op memoization cache. When provided, expensive tree-sitter
   * parse operations (parseControllerMethod, parseApiResource, parseTransactions,
   * parseIsolation) are memoized by file content hash.
   *
   * Scope: one ParseCache instance per project_root. Never share across projects.
   * Pass the same instance on repeated augmentGraph calls to get cache hits.
   */
  cache?: ParseCache<unknown>
}

/**
 * Augment a skeleton graph with L1 nodes (FormRequest, policy) by analysing
 * the controller method body. Requires the BUSINESS_HANDLER node to have a
 * `file` field pointing to the controller PHP file (relative to projectRoot).
 *
 * Also extracts service_call nodes from:
 * - The controller action method
 * - Middleware nodes that have a file field (parses their handle() method)
 * - Policy nodes added during augmentation (file inferred from class name)
 */
export function augmentGraph(
  graph: IntermediateExecutionGraph,
  opts: AugmentOptions
): IntermediateExecutionGraph {
  const config = opts.config ?? DEFAULT_PROJECT_CONFIG
  const cache  = opts.cache ?? null

  // Merge legacy permissionConstantFiles with config (backwards compat)
  const permFiles = [
    ...config.permissionConstantFiles,
    ...(opts.permissionConstantFiles ?? []),
  ]

  const newNodes:       ExecutionNode[]   = [...graph.nodes]
  const newEdges:       ExecutionEdge[]   = [...graph.edges]
  const newAnnotations: GraphAnnotation[] = [...graph.annotations]

  // ---- Controller L1 pass ------------------------------------------
  const ctrlNode = graph.nodes.find((n) => n.type === IR_NODE_TYPES.BUSINESS_HANDLER)
  if (ctrlNode?.file) {
    const [ctrlClass, methodName] = ctrlNode.symbol.split("::")
    if (methodName) {
      const filePath = join(opts.projectRoot, ctrlNode.file)
      const l1 = ctrlL1(cache, filePath, methodName)
      if (l1) {
        // Backfill line number onto the business_handler node for editor CodeLens anchoring
        if (l1.methodLine) {
          const ctrlInNew = newNodes.find(n => n.id === ctrlNode.id)
          if (ctrlInNew) ctrlInNew.line = l1.methodLine
        }

        // FormRequest nodes
        for (const fr of l1.formRequests) {
          const id = `fr_${fr.shortName.toLowerCase().replace(/[^a-z0-9]/g, "_")}`
          const frFile = fqcnToPath(fr.fqcn, config.namespaces) ?? undefined
          const frPath = frFile ? join(opts.projectRoot, frFile) : undefined
          const authzBody = frPath ? parseFormRequestAuthorize(frPath) : undefined
          newNodes.push({
            id,
            type:   IR_NODE_TYPES.VALIDATION_GATE,
            symbol: `${fr.shortName}::authorize`,
            role:   "validation",
            file:   frFile,
            ...(authzBody ? { detail: authzBody } : {}),
          })
          newEdges.push({
            from:         ctrlNode.id,
            to:           id,
            relation:     "form_request",
            traceability: "static",
          })
        }

        // Policy nodes — include inferred file so they can be augmented below
        const addedPolicyNodes: ExecutionNode[] = []
        for (const auth of l1.authorizeCalls) {
          const policyClass = inferPolicyClass(ctrlClass ?? "")
          const policyFile  = resolvePolicyFile(opts.projectRoot, policyClass, config.policyPaths)
          const id = `policy_${policyClass.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${auth.ability}`
          const policyNode: ExecutionNode = {
            id,
            type: IR_NODE_TYPES.AUTHZ_CHECK,
            symbol: `${policyClass}::${auth.ability}`,
            role:   "authorization",
            file:   policyFile,
          }
          newNodes.push(policyNode)
          addedPolicyNodes.push(policyNode)

          // Annotate when the policy class file doesn't exist — structural fact, deterministic
          if (!existsSync(join(opts.projectRoot, policyFile))) {
            newAnnotations.push({
              type:        "missing_policy",
              nodes:       [id],
              description: `${policyClass} referenced in ${ctrlNode.symbol} but class file not found at ${policyFile}`,
              severity:    "high",
              confidence:  "HIGH",
            })
          }
          newEdges.push({
            from:         ctrlNode.id,
            to:           id,
            relation:     "policy_check",
            traceability: "semantic",
            mechanism:    auth.mechanism,
          })
        }

        // RESOURCE nodes — route-model-binding params (IR v1.1)
        emitResourceNodes(newNodes, newEdges, ctrlNode, l1.modelParams, addedPolicyNodes, l1.authorizeCalls)

        // API_RESOURCE nodes — JsonResource returns (IR v1.2)
        emitApiResourceNodes(newNodes, newEdges, ctrlNode, l1.returnedResources, opts.projectRoot, config, cache)

        // Standalone dispatch nodes — Jobs/Events dispatched outside DB::transaction() (IR v1.3)
        emitStandaloneDispatchNodes(newNodes, newEdges, ctrlNode, l1.standaloneDispatches, opts.projectRoot, config.namespaces)

        // Notification + Mail side-effect nodes (IR v1.4)
        emitNotificationNodes(newNodes, newEdges, ctrlNode, l1.standaloneNotifications)

        // Constructor middleware pass — inject auth nodes not present at route level
        injectConstructorMiddleware(newNodes, newEdges, ctrlNode.id, l1.constructorMiddleware, methodName)

        // Service calls from controller action
        const ctrlServiceNodes = addServiceCallNodes(newNodes, newEdges, ctrlNode.id, l1.serviceCalls, config.namespaces, opts.projectRoot, cache)

        // Conditional branches driven by a request parameter (IR v1.5 Phase 6, narrow cut)
        addConditionalBranchNodes(newNodes, newEdges, ctrlNode.id, l1.conditionalBranches, config.namespaces, opts.projectRoot, cache)

        // Same-class self-call guard clauses (IR v1.5 Phase 4, same-class self-call extension)
        if (l1.selfGuardCalls.length > 0) {
          addSelfGuardClauseNodes(newNodes, newEdges, ctrlNode.id, ctrlNode.file, ctrlClass, l1.selfGuardCalls, ctrlServiceNodes)
        }

        // Service calls from policy methods
        const policyServiceNodes: ExecutionNode[] = []
        for (const policyNode of addedPolicyNodes) {
          if (!policyNode.file) continue
          const [, policyMethod] = policyNode.symbol.split("::")
          if (!policyMethod) continue
          const policyL1 = ctrlL1(cache, join(opts.projectRoot, policyNode.file), policyMethod)
          if (policyL1) {
            const created = addServiceCallNodes(newNodes, newEdges, policyNode.id, policyL1.serviceCalls, config.namespaces, opts.projectRoot, cache)
            policyServiceNodes.push(...created)
          }
        }

        // ---- Recursive service expansion (Phase 4) ----------------------
        const expansionRoots = [
          ...ctrlServiceNodes,
          ...policyServiceNodes,
        ].filter((n) => !!n.file && matchesExpansionFocus(n, opts.expansionFocus))

        if (expansionRoots.length > 0) {
          const visited = new Set<string>()
          const budget  = { remaining: MAX_EXPANSION_NODES }
          expandServiceCalls(
            newNodes, newEdges,
            expansionRoots,
            opts.projectRoot, config,
            MAX_SERVICE_DEPTH - 1,
            visited, budget,
            opts.expansionFocus,
            cache
          )
        }
      }
    }
  }

  // ---- Middleware service_call pass ------------------------------------
  const mwTypes = new Set<string>([IR_NODE_TYPES.AUTH_GATE, IR_NODE_TYPES.AUTHZ_CHECK])
  for (const mwNode of graph.nodes) {
    if (!mwTypes.has(mwNode.type) || !mwNode.file) continue
    const filePath = join(opts.projectRoot, mwNode.file)
    const l1 = ctrlL1(cache, filePath, "handle")
    if (l1) {
      const mwServiceNodes = addServiceCallNodes(newNodes, newEdges, mwNode.id, l1.serviceCalls, config.namespaces, opts.projectRoot, cache)
      // Also expand service calls from middleware
      const mwExpandRoots = mwServiceNodes.filter((n) => !!n.file && matchesExpansionFocus(n, opts.expansionFocus))
      if (mwExpandRoots.length > 0) {
        const visited = new Set<string>()
        const budget  = { remaining: MAX_EXPANSION_NODES }
        expandServiceCalls(
          newNodes, newEdges,
          mwExpandRoots,
          opts.projectRoot, config,
          MAX_SERVICE_DEPTH - 1,
          visited, budget,
          opts.expansionFocus,
          cache
        )
      }
    }
  }

  // ---- Permission constant pass ----------------------------------------
  // permFiles is inferred project-wide (any *Permission*.php under app/), not scoped to
  // this route — emitting every constant from every such file regardless of relevance
  // let an LLM mistake "PermissionStatus is defined somewhere in this project" for "this
  // route enforces a permission check" (found on BookStack's GET /status, a genuinely
  // public route). Only emit a constant when it's tied to this route by one of two signals:
  // its class is referenced by name in a file already reachable from the route (controller,
  // service calls, middleware, FormRequest, etc.), or its literal value matches an arg
  // already captured on an auth/authz node in this graph (e.g. middleware('permission:task.delete')
  // passes the string literal, never the class name, so the graph node's `args` is the only
  // evidence available — common pattern, doesn't reintroduce the BookStack false positive
  // since an unrelated public route has no auth/authz node args to match against).
  const reachableSource = [...new Set(newNodes.map((n) => n.file).filter((f): f is string => !!f))]
    .map((relFile) => {
      try { return readFileSync(join(opts.projectRoot, relFile), "utf-8") } catch { return "" }
    })
    .join("\n")

  const reachableAuthArgs = new Set(
    newNodes
      .filter((n) => n.type === IR_NODE_TYPES.AUTH_GATE || n.type === IR_NODE_TYPES.AUTHZ_CHECK)
      .flatMap((n) => n.args ?? [])
  )

  for (const relFile of permFiles) {
    const absPath = join(opts.projectRoot, relFile)
    const map = parseConstantClass(absPath)
    for (const [className, constants] of Object.entries(map)) {
      const classReachable = reachableSource.includes(`${className}::`)
      const matchedConstants = classReachable
        ? constants
        : Object.fromEntries(
            Object.entries(constants).filter(([, value]) => reachableAuthArgs.has(value))
          )
      if (Object.keys(matchedConstants).length === 0) continue
      const permNodes = extractPermissionNodes({ [className]: matchedConstants }, relFile)
      const permEdges = buildHierarchyEdges(permNodes)
      newNodes.push(...permNodes)
      newEdges.push(...permEdges)
    }
  }

  // ---- Transaction pass ------------------------------------------------
  const ctrlNodeForTxn = graph.nodes.find((n) => n.type === IR_NODE_TYPES.BUSINESS_HANDLER)
  if (ctrlNodeForTxn?.file) {
    const [, txnMethodName] = ctrlNodeForTxn.symbol.split("::")
    if (txnMethodName) {
      const filePath = join(opts.projectRoot, ctrlNodeForTxn.file)
      const txnResult = txnRes(cache, filePath, txnMethodName)
      if (txnResult.hasTransaction) {
        // ctrlL1 is memoized by (filePath, method) — re-fetching here is a
        // cache hit, not a re-parse. Needed to resolve nested-service-call
        // wraps edges against the already-created service-call nodes.
        const txnL1 = ctrlL1(cache, filePath, txnMethodName)
        addTransactionNodes(newNodes, newEdges, ctrlNodeForTxn.id, txnResult.blocks, txnL1?.serviceCalls ?? [])
      }
    }
  }

  // ---- Event → listener tracing pass ----------------------------------
  traceEventListeners(newNodes, newEdges, opts.projectRoot, config.namespaces)

  // ---- Isolation pass --------------------------------------------------
  const ctrlNodeForIso = graph.nodes.find((n) => n.type === IR_NODE_TYPES.BUSINESS_HANDLER)
  if (ctrlNodeForIso?.file) {
    const [, isoMethodName] = ctrlNodeForIso.symbol.split("::")
    if (isoMethodName) {
      const filePath = join(opts.projectRoot, ctrlNodeForIso.file)
      const isoConv  = { tenantSignals: config.conventions.tenantSignals, tenantContainerKeys: config.conventions.tenantContainerKeys }
      const isoResult = isoRes(cache, filePath, isoConv, isoMethodName)
      addIsolationNodes(newNodes, newEdges, ctrlNodeForIso.id, isoResult)
    }
  }

  // ---- Audit log pass (IR v1.5 Phase 5) --------------------------------
  const ctrlNodeForAudit = graph.nodes.find((n) => n.type === IR_NODE_TYPES.BUSINESS_HANDLER)
  if (ctrlNodeForAudit?.file && config.conventions.auditSinks.length > 0) {
    const [, auditMethodName] = ctrlNodeForAudit.symbol.split("::")
    if (auditMethodName) {
      const filePath = join(opts.projectRoot, ctrlNodeForAudit.file)
      const auditCalls = auditRes(cache, filePath, config.conventions.auditSinks, auditMethodName)
      if (auditCalls.length > 0) {
        addAuditLogNodes(newNodes, newEdges, ctrlNodeForAudit.id, auditCalls)
      }
    }
  }

  return { ...graph, nodes: newNodes, edges: newEdges, annotations: newAnnotations, framework: "laravel", ir_ver: IR_VERSION, adapter_ver: ADAPTER_VERSION }
}

// ---- Event → listener tracing ----------------------------------------

/**
 * For every `transaction_escape` node already in the graph, look up the event
 * class in the project's EventServiceProvider $listen map and add a `service_call`
 * node for each non-afterCommit-safe listener with a `calls` edge.
 *
 * This is what closes the TXN-001 ceiling: the graph previously stopped at
 * TaskCreated::dispatch; now it continues to SendTaskCreatedNotification::handle.
 */
function traceEventListeners(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  projectRoot: string,
  namespaces: Record<string, string>
): void {
  const escapeNodes = nodes.filter((n) => n.type === IR_NODE_TYPES.TXN_ESCAPE)
  if (escapeNodes.length === 0) return

  // Lazy-load the map — only parsed once per augmentGraph call
  const listenerMap = parseEventListeners(projectRoot, namespaces)
  if (listenerMap.size === 0) return

  for (const escNode of escapeNodes) {
    // symbol: "TaskCreated::dispatch" → extract "TaskCreated"
    const eventClass = escNode.symbol.split("::")[0]
    if (!eventClass) continue

    const listeners = listenerMap.get(eventClass) ?? []

    listeners.forEach((entry, idx) => {
      const short = entry.listenerFqcn.split("\\").pop() ?? entry.listenerFqcn
      const id    = `listener_${escNode.id}_${idx}`

      if (nodes.some((n) => n.id === id)) return

      nodes.push({
        id,
        type: IR_NODE_TYPES.SERVICE_CALL,
        symbol: `${short}::handle`,
        role:   "listener",
        ...(entry.listenerFile ? { file: entry.listenerFile } : {}),
        ...(entry.isAfterCommitSafe ? { args: ["afterCommit"] } : {}),
      })
      edges.push({
        from:         escNode.id,
        to:           id,
        relation:     "calls",
        traceability: "semantic",
      })
    })
  }
}

// ---- Constructor middleware injection --------------------------------

/**
 * Inject authentication_gate / authorization_check nodes sourced from
 * $this->middleware() calls in the controller constructor.
 *
 * Only injects if the middleware applies to `methodName` (respects except/only
 * filters). Nodes are identified with a `ctor_mw_` prefix so they are distinct
 * from route-level middleware nodes — both are kept so duplicate_authorization
 * detectors can flag intentional redundancy.
 */
function injectConstructorMiddleware(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  ctrlNodeId: string,
  middlewares: import("./controller-parser.js").ConstructorMiddleware[],
  methodName: string
): void {
  middlewares.forEach((mw, idx) => {
    // Check if this middleware applies to methodName
    if (mw.only.length > 0 && !mw.only.includes(methodName)) return
    if (mw.except.length > 0 && mw.except.includes(methodName)) return

    const slug = mw.raw.toLowerCase().replace(/[^a-z0-9]/g, "_")
    const id   = `ctor_mw_${idx}_${slug}`

    // Avoid inserting the same node twice (idempotent — safe if augment is called repeatedly)
    if (nodes.some((n) => n.id === id)) return

    const node = middlewareToNode(mw.raw, idx)
    nodes.push({ ...node, id })
    edges.push({
      from:         id,
      to:           ctrlNodeId,
      relation:     "next_middleware",
      traceability: "static",
    })
  })
}

// ---- PSR-4 helpers ----------------------------------------------------

/**
 * @deprecated Use fqcnToPath from project-config.ts with an explicit namespace map.
 * Kept for backwards compatibility with external callers.
 */
export function fqcnToRelativePath(fqcn: string): string {
  return fqcnToPath(fqcn, DEFAULT_PROJECT_CONFIG.namespaces) ?? fqcn.replace(/\\/g, "/") + ".php"
}

// ---- Helpers ----------------------------------------------------------

function inferPolicyClass(controllerClass: string): string {
  const m = controllerClass.match(/^(.+)Controller$/)
  return m ? `${m[1]}Policy` : `${controllerClass}Policy`
}

/**
 * Deterministic node ID for a service call scoped to its caller — shared by
 * addServiceCallNodes (which creates the node) and the transaction wrap-edge
 * wiring (which needs to point at an already-created node without holding a
 * reference to it).
 */
function serviceCallNodeId(sc: ServiceCall, callerNodeId: string): string {
  const idBase = `svc_${sc.serviceClass}_${sc.method}`.toLowerCase().replace(/[^a-z0-9]/g, "_")
  return `${idBase}_${callerNodeId.replace(/[^a-z0-9]/g, "_")}`
}

/**
 * Add service_call nodes and their edges from a parsed method's service calls.
 * Each node ID is scoped to the caller to allow the same service to be called
 * from multiple places (e.g. CheckPermission AND TaskPolicy both call hasPermission).
 * Returns the newly created nodes so callers can recurse into them.
 */
function addServiceCallNodes(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  callerNodeId: string,
  serviceCalls: ServiceCall[],
  namespaces: Record<string, string>,
  projectRoot: string,
  cache: ParseCache<unknown> | null = null
): ExecutionNode[] {
  const seen    = new Set<string>()
  const created: ExecutionNode[] = []

  for (const sc of serviceCalls) {
    // Scope ID by caller so same service called from different nodes creates separate nodes
    const id = serviceCallNodeId(sc, callerNodeId)

    if (seen.has(id)) continue
    seen.add(id)

    const file = sc.serviceFqcn.includes("\\") ? (fqcnToPath(sc.serviceFqcn, namespaces) ?? undefined) : undefined

    // Guard-clause detection (IR v1.5 Phase 4) — a resolvable call whose body
    // can abort the caller via throw/abort based on a precondition gets its
    // own node type instead of a generic service_call.
    const guard = file
      ? guardRes(cache, join(projectRoot, file), sc.method)
      : { isGuardClause: false, reason: null, conditionText: null }

    const node: ExecutionNode = {
      id,
      type: guard.isGuardClause ? IR_NODE_TYPES.GUARD_CLAUSE : IR_NODE_TYPES.SERVICE_CALL,
      symbol: `${sc.serviceClass}::${sc.method}`,
      role:   guard.isGuardClause ? "guard" : "service",
      ...(file               ? { file }      : {}),
      ...(sc.args.length > 0 ? { args: sc.args } : {}),
      ...(sc.mutates         ? { mutates: true } : {}),
      // The actual precondition(s) checked — without this the LLM only
      // knows "some guard exists", not what it guards against (IR v1.5
      // Phase 4 extension, found via live gpt-4o re-run).
      ...(guard.isGuardClause && guard.conditionText ? { detail: guard.conditionText } : {}),
    }

    nodes.push(node)
    created.push(node)

    edges.push({
      from:         callerNodeId,
      to:           id,
      relation:     "calls",
      traceability: "semantic",
    })

    // Cross-method extension of Phase 6 (narrow cut): this call received a
    // request-derived value as one of its arguments — check whether the
    // callee itself branches on the corresponding parameter (BookStack's
    // UserApiController::delete -> UserRepo::destroy shape, where the actual
    // if/else lives one hop away from where $request->input() was read).
    if (file && sc.requestParamArg) {
      const branch = detectParamDrivenBranch(
        join(projectRoot, file),
        sc.method,
        sc.requestParamArg.position,
        sc.requestParamArg.requestParamName
      )
      if (branch) {
        emitConditionalBranchNode(nodes, edges, id, branch, 0, namespaces, projectRoot, cache)
      }
    }
  }

  // A guard clause protects the calls that follow it in the same caller —
  // make that explicit via ir:guards edges instead of leaving it an inference
  // (IR v1.5 Phase 4).
  created.forEach((node, idx) => {
    if (node.type !== IR_NODE_TYPES.GUARD_CLAUSE) return
    for (const protectedNode of created.slice(idx + 1)) {
      edges.push({
        from:         node.id,
        to:           protectedNode.id,
        relation:     IR_EDGE_RELATIONS.GUARDS,
        traceability: "semantic",
      })
    }
  })

  return created
}

/**
 * Add ir:guard_clause nodes for same-class `$this->method()` self-calls whose
 * target is itself a guard clause (IR v1.5 Phase 4, same-class self-call
 * extension). Normal property-based service calls run guard detection
 * inside addServiceCallNodes, but a same-class self-call like
 * `$this->ensureDeletable($user)` never becomes a ServiceCall node at all —
 * it's handled by controller-parser.ts's private-method flattening instead,
 * which is why this needed a separate emission path (found via real-repo
 * regression check: BookStack's ensureDeletable() is called exactly this
 * way from inside UserRepo::destroy() and was invisible in the graph).
 *
 * Each self-guard node guards every node in `protectedNodes` — the other
 * calls made by the same caller.
 */
function addSelfGuardClauseNodes(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  callerNodeId: string,
  callerFile: string,
  classShortName: string,
  selfGuardCalls: import("./controller-parser.js").SelfGuardCall[],
  protectedNodes: ExecutionNode[]
): ExecutionNode[] {
  const created: ExecutionNode[] = []

  selfGuardCalls.forEach((sg, idx) => {
    const id = `guard_${callerNodeId}_${idx}`.replace(/[^a-z0-9_]/gi, "_")
    if (nodes.some((n) => n.id === id)) return

    const node: ExecutionNode = {
      id,
      type:   IR_NODE_TYPES.GUARD_CLAUSE,
      symbol: `${classShortName}::${sg.methodName}`,
      role:   "guard",
      file:   callerFile,
      ...(sg.conditionText ? { detail: sg.conditionText } : {}),
    }
    nodes.push(node)
    created.push(node)

    edges.push({
      from:         callerNodeId,
      to:           id,
      relation:     "calls",
      traceability: "semantic",
    })
  })

  for (const guardNode of created) {
    for (const protectedNode of protectedNodes) {
      edges.push({
        from:         guardNode.id,
        to:           protectedNode.id,
        relation:     IR_EDGE_RELATIONS.GUARDS,
        traceability: "semantic",
      })
    }
  }

  return created
}

/**
 * Add ir:conditional_branch nodes for request-parameter-driven if/else found
 * in the caller's method, plus the then/else calls as their own nodes with
 * explicit ir:controls edges from the branch — "this call only executes in
 * this branch" as a visible edge instead of an inference (IR v1.5 Phase 6,
 * narrow cut: request-param-driven conditions only).
 */
function addConditionalBranchNodes(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  callerNodeId: string,
  branches: ConditionalBranch[],
  namespaces: Record<string, string>,
  projectRoot: string,
  cache: ParseCache<unknown> | null
): void {
  branches.forEach((branch, idx) => {
    emitConditionalBranchNode(nodes, edges, callerNodeId, branch, idx, namespaces, projectRoot, cache)
  })
}

/**
 * Emit a single ir:conditional_branch node under `callerNodeId`, plus its
 * then/else calls with explicit ir:controls edges. Shared by same-method
 * detection (addConditionalBranchNodes) and the cross-method extension in
 * addServiceCallNodes (branch found one hop inside a directly-called
 * service method — see detectParamDrivenBranch).
 */
function emitConditionalBranchNode(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  callerNodeId: string,
  branch: ConditionalBranch,
  idx: number,
  namespaces: Record<string, string>,
  projectRoot: string,
  cache: ParseCache<unknown> | null
): void {
  const id = `branch_${callerNodeId}_${idx}`.replace(/[^a-z0-9_]/gi, "_")
  if (nodes.some((n) => n.id === id)) return

  nodes.push({
    id,
    type:   IR_NODE_TYPES.CONDITIONAL_BRANCH,
    symbol: branch.conditionText,
    role:   "control_flow",
    detail: branch.paramName,
  })
  edges.push({
    from:         callerNodeId,
    to:           id,
    relation:     "calls",
    traceability: "static",
  })

  const thenNodes = addServiceCallNodes(nodes, edges, id, branch.thenCalls, namespaces, projectRoot, cache)
  const elseNodes = addServiceCallNodes(nodes, edges, id, branch.elseCalls, namespaces, projectRoot, cache)

  for (const n of [...thenNodes, ...elseNodes]) {
    edges.push({
      from:         id,
      to:           n.id,
      relation:     IR_EDGE_RELATIONS.CONTROLS,
      traceability: "semantic",
    })
  }
}

const MAX_SERVICE_DEPTH  = 3
const MAX_EXPANSION_NODES = 50

/**
 * Returns true if a service_call node should be recursively expanded given the focus.
 * When focus is "all" (or undefined), every node is eligible.
 */
function matchesExpansionFocus(node: ExecutionNode, focus: ExpansionFocus | undefined): boolean {
  if (!focus || focus === "all") return true
  const sym = node.symbol.toLowerCase()
  switch (focus) {
    case "auth":
      return /auth|permission|policy|guard|gate|authoriz|role/.test(sym)
    case "transaction":
      return /transaction|txn|order|payment|checkout|cart|store|create|update|delete/.test(sym)
    case "tenant":
      return /tenant|scope|isolat|organization|context/.test(sym)
  }
}

/**
 * Semantic priority score for a service_call node during budget-constrained expansion.
 * Higher score = expanded first when budget is running low.
 */
function serviceSemanticWeight(node: ExecutionNode): number {
  const sym = node.symbol.toLowerCase()
  if (/auth|permission|policy|guard|gate|idempotenc|authoriz/.test(sym)) return 4
  if (/tenant|scope|isolat/.test(sym)) return 3
  if (/transaction|txn|audit|log/.test(sym)) return 2
  if (/cache|notify|notification|event|dispatch/.test(sym)) return 1
  return 0 // DTO, helper, builder, formatter — lowest priority
}

/**
 * Recursively expand service_call nodes by parsing their method bodies.
 * For each service node with a resolvable file:
 *   - runs transaction detection
 *   - runs isolation/query detection
 *   - extracts further service calls (depth - 1)
 *
 * Bounded by maxDepth, a visited set (prevents cycles), and a node budget.
 * When budget falls below 50%, nodes are sorted by semantic weight so
 * auth/tenant/transaction services are expanded before low-value helpers.
 */
function expandServiceCalls(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  serviceNodes: ExecutionNode[],
  projectRoot: string,
  config: ProjectConfig,
  depth: number,
  visited: Set<string>,
  budget: { remaining: number },
  focus?: ExpansionFocus,
  cache: ParseCache<unknown> | null = null
): void {
  if (depth <= 0 || serviceNodes.length === 0 || budget.remaining <= 0) return

  // When budget is scarce (< 50%), prioritize semantically important services
  const ordered = budget.remaining < MAX_EXPANSION_NODES / 2
    ? [...serviceNodes].sort((a, b) => serviceSemanticWeight(b) - serviceSemanticWeight(a))
    : serviceNodes

  const nextServiceNodes: ExecutionNode[] = []

  for (const scNode of ordered) {
    if (!scNode.file || budget.remaining <= 0) continue
    const [, methodName] = scNode.symbol.split("::")
    if (!methodName) continue

    const visitKey = `${scNode.file}::${methodName}`
    if (visited.has(visitKey)) continue
    visited.add(visitKey)

    const filePath = join(projectRoot, scNode.file)
    const isoConv  = { tenantSignals: config.conventions.tenantSignals, tenantContainerKeys: config.conventions.tenantContainerKeys }
    // Memoized by (filePath, method) — fetched once here and reused below so
    // the transaction pass can resolve nested-service-call wraps edges.
    const l1 = ctrlL1(cache, filePath, methodName)

    // Transaction pass inside service method
    try {
      const txnResult = txnRes(cache, filePath, methodName)
      if (txnResult.hasTransaction) {
        addTransactionNodes(nodes, edges, scNode.id, txnResult.blocks, l1?.serviceCalls ?? [])
        budget.remaining -= txnResult.blocks.length * 3
      }
    } catch { /* file unreadable or parse error — skip gracefully */ }

    // Isolation/query pass inside service method
    try {
      const isoResult = isoRes(cache, filePath, isoConv, methodName)
      addIsolationNodes(nodes, edges, scNode.id, isoResult)
      budget.remaining -= isoResult.modelQueries.length
    } catch { /* skip */ }

    // Audit-log pass inside service method (IR v1.5 Phase 5)
    try {
      if (config.conventions.auditSinks.length > 0) {
        const auditCalls = auditRes(cache, filePath, config.conventions.auditSinks, methodName)
        if (auditCalls.length > 0) {
          addAuditLogNodes(nodes, edges, scNode.id, auditCalls)
          budget.remaining -= auditCalls.length
        }
      }
    } catch { /* skip */ }

    // Deeper service calls from this service method
    try {
      let newSvcNodes: ExecutionNode[] = []
      if (l1 && l1.serviceCalls.length > 0) {
        newSvcNodes = addServiceCallNodes(nodes, edges, scNode.id, l1.serviceCalls, config.namespaces, projectRoot, cache)
        budget.remaining -= newSvcNodes.length
        nextServiceNodes.push(
          ...newSvcNodes.filter((n) => !!n.file && matchesExpansionFocus(n, focus))
        )
      }
      // Same-method request-param branches found at this depth too — Phase 6
      // previously only ran this pass at the top-level controller action.
      if (l1 && l1.conditionalBranches.length > 0) {
        addConditionalBranchNodes(nodes, edges, scNode.id, l1.conditionalBranches, config.namespaces, projectRoot, cache)
        budget.remaining -= l1.conditionalBranches.length
      }
      // Same-class self-call guard clauses at this depth too (IR v1.5 Phase 4,
      // same-class self-call extension) — e.g. UserRepo::destroy calling
      // $this->ensureDeletable($user) one hop below the controller action.
      if (l1 && l1.selfGuardCalls.length > 0) {
        const [scClass] = scNode.symbol.split("::")
        const guardNodes = addSelfGuardClauseNodes(nodes, edges, scNode.id, scNode.file, scClass ?? "", l1.selfGuardCalls, newSvcNodes)
        budget.remaining -= guardNodes.length
      }
    } catch { /* skip */ }
  }

  expandServiceCalls(nodes, edges, nextServiceNodes, projectRoot, config, depth - 1, visited, budget, focus, cache)
}

/**
 * Add transaction_boundary, transactional_write, and transaction_escape nodes
 * for each DB::transaction() block found in the controller file.
 *
 * @param callerServiceCalls The same caller's already-resolved service calls
 * (from parseControllerMethod), used to link `ir:wraps` edges to service-call
 * nodes that were called directly inside the transaction closure — e.g.
 * `DB::transaction(fn () => $this->userRepo->create(...))`, where the real
 * write happens one hop inside `UserRepo::create()`, not in the closure text
 * itself (IR v1.5 Phase 3, nested-service-call extension — found via
 * real-repo regression check on BookStack's `UserApiController::create`).
 */
function addTransactionNodes(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  callerNodeId: string,
  blocks: import("./transaction-parser.js").TransactionBlock[],
  callerServiceCalls: ServiceCall[] = []
): void {
  blocks.forEach((block, blockIdx) => {
    const txnId = `txn_${callerNodeId}_${blockIdx}`

    nodes.push({
      id:     txnId,
      type: IR_NODE_TYPES.TXN_BOUNDARY,
      symbol: "DB::transaction",
      role:   "atomicity",
    })
    edges.push({
      from:         callerNodeId,
      to:           txnId,
      relation:     "opens_transaction",
      traceability: "static",
    })

    // Transactional writes — WRAPS makes containment explicit so retrieval/
    // prompt-building can tell "inside this transaction" from "not" (IR v1.5 Phase 3).
    block.writes.forEach((w, wIdx) => {
      const writeId = `txn_write_${callerNodeId}_${blockIdx}_${wIdx}`
      nodes.push({
        id:     writeId,
        type: IR_NODE_TYPES.TXN_WRITE,
        symbol: `${w.className}::${w.operation}`,
        role:   "persistence",
        mutates: true,
      })
      edges.push({
        from:         txnId,
        to:           writeId,
        relation:     IR_EDGE_RELATIONS.WRAPS,
        traceability: "static",
      })
    })

    // Transaction escapes (dispatches — fire before commit)
    block.dispatches.forEach((d, dIdx) => {
      const escapeId = `txn_escape_${callerNodeId}_${blockIdx}_${dIdx}`
      nodes.push({
        id:     escapeId,
        type: IR_NODE_TYPES.TXN_ESCAPE,
        symbol: `${d.className}::dispatch`,
        role:   "side_effect",
      })
      edges.push({
        from:         txnId,
        to:           escapeId,
        relation:     IR_EDGE_RELATIONS.WRAPS,
        traceability: "static",
      })
      edges.push({
        from:         escapeId,
        to:           txnId,
        relation:     "escapes_transaction",
        traceability: "static",
      })
    })

    // Nested service calls made directly inside the closure — wrap the
    // already-created service-call node for each one that resolves, instead
    // of only pattern-matched raw writes (IR v1.5 Phase 3 extension).
    for (const nc of block.nestedServiceCalls) {
      const match = callerServiceCalls.find(
        (sc) => sc.method === nc.method && (nc.propertyName === "" || sc.propertyName === nc.propertyName)
      )
      if (!match) continue
      const targetId = serviceCallNodeId(match, callerNodeId)
      if (!nodes.some((n) => n.id === targetId)) continue
      edges.push({
        from:         txnId,
        to:           targetId,
        relation:     IR_EDGE_RELATIONS.WRAPS,
        traceability: "semantic",
      })
    }
  })
}

/**
 * Add unscoped_query / tenant_scoped_query nodes for each model query found
 * in the controller file, plus missing_tenant_scope edges for unscoped ones.
 */
function addIsolationNodes(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  callerNodeId: string,
  isoResult: import("./isolation-parser.js").IsolationParseResult
): void {
  // Emit a runtime_injection node if tenant is read from container
  if (isoResult.readsTenantFromContainer) {
    const injId = `tenant_injection_${callerNodeId}`
    if (!nodes.some((n) => n.id === injId)) {
      nodes.push({
        id:     injId,
        type: IR_NODE_TYPES.RUNTIME_INJECT,
        symbol: "app()->instance('tenant', $tenant)",
        role:   "runtime",
      })
    }
  }

  isoResult.modelQueries.forEach((q, idx) => {
    const nodeType = q.hastenantConstraint ? IR_NODE_TYPES.SCOPED_QUERY : IR_NODE_TYPES.UNSCOPED_QUERY
    const id = `iso_query_${callerNodeId}_${idx}`

    nodes.push({
      id,
      type:   nodeType,
      symbol: `${q.model}::${q.operation}`,
      role:   "data_access",
    })
    edges.push({
      from:         callerNodeId,
      to:           id,
      relation:     "calls",
      traceability: "static",
    })

    if (!q.hastenantConstraint && isoResult.readsTenantFromContainer) {
      const injId = `tenant_injection_${callerNodeId}`
      edges.push({
        from:         id,
        to:           injId,
        relation:     "missing_tenant_scope",
        traceability: "semantic",
      })
    }
  })

  // Write-path: emit unscoped_write nodes for INSERT/CREATE/SAVE without tenant
  isoResult.modelWrites.forEach((w, idx) => {
    if (w.hasTenantConstraint) return
    const id = `iso_write_${callerNodeId}_${idx}`
    nodes.push({
      id,
      type:   IR_NODE_TYPES.UNSCOPED_WRITE,
      symbol: `${w.model}::${w.operation}`,
      role:   "data_access",
    })
    edges.push({
      from:         callerNodeId,
      to:           id,
      relation:     "calls",
      traceability: "static",
    })
    if (isoResult.readsTenantFromContainer) {
      const injId = `tenant_injection_${callerNodeId}`
      edges.push({
        from:         id,
        to:           injId,
        relation:     "missing_tenant_scope",
        traceability: "semantic",
      })
    }
  })
}

/**
 * Add ir:audit_log nodes for calls matching a configured audit-sink symbol
 * (e.g. Activity::add, activity()->log) — a durable audit trail that neither
 * pipeline could otherwise tell apart from a generic service call
 * (IR v1.5 Phase 5).
 */
function addAuditLogNodes(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  callerNodeId: string,
  calls: import("./audit-log-parser.js").AuditLogCall[]
): void {
  calls.forEach((call, idx) => {
    const id = `audit_${callerNodeId}_${idx}`.replace(/[^a-z0-9_]/gi, "_")
    if (nodes.some((n) => n.id === id)) return

    nodes.push({
      id,
      type:   IR_NODE_TYPES.AUDIT_LOG,
      symbol: call.symbol,
      role:   "side_effect",
      ...(call.args.length > 0 ? { args: call.args } : {}),
    })
    edges.push({
      from:         callerNodeId,
      to:           id,
      relation:     "calls",
      traceability: "static",
    })
  })
}

// ---- RESOURCE node emission (IR v1.1) ---------------------------------

import type { AuthorizeCall } from "./controller-parser.js"

/**
 * Emit ir:resource nodes for route-model-binding params.
 *
 * For each ModelParam:
 *   - Emit RESOURCE node with role "accessed_resource"
 *   - Emit ir:accesses edge: BUSINESS_HANDLER → RESOURCE
 *
 * For each AuthorizeCall that has a modelVar matching a param:
 *   - Find the AUTHZ_CHECK node added for that call
 *   - Emit ir:authorizes edge: AUTHZ_CHECK → RESOURCE
 */
function emitResourceNodes(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  ctrlNode: ExecutionNode,
  modelParams: ModelParam[],
  policyNodes: ExecutionNode[],
  authorizeCalls: AuthorizeCall[]
): void {
  for (const mp of modelParams) {
    const resourceId = `resource_${mp.className.toLowerCase()}_${ctrlNode.id}`

    if (!nodes.some((n) => n.id === resourceId)) {
      nodes.push({
        id:     resourceId,
        type:   IR_NODE_TYPES.RESOURCE,
        symbol: mp.className,
        role:   "accessed_resource",
      })
    }

    // BUSINESS_HANDLER accesses RESOURCE
    edges.push({
      from:         ctrlNode.id,
      to:           resourceId,
      relation:     IR_EDGE_RELATIONS.ACCESSES,
      traceability: "static",
    })

    // Wire AUTHZ_CHECK → RESOURCE for each authorize call that targets this param
    for (const auth of authorizeCalls) {
      if (auth.modelVar !== mp.paramName) continue
      // Find the policy node that corresponds to this authorize call (matched by ability)
      const policyNode = policyNodes.find(
        (p) => p.symbol.endsWith(`::${auth.ability}`)
      )
      if (!policyNode) continue
      edges.push({
        from:         policyNode.id,
        to:           resourceId,
        relation:     IR_EDGE_RELATIONS.AUTHORIZES,
        traceability: "semantic",
        mechanism:    auth.mechanism,
      })
    }
  }
}

// ─── Standalone dispatch nodes (IR v1.3) ─────────────────────────────────────

/**
 * Emit ir:queue_job / ir:event_dispatch nodes for Job::dispatch() and
 * event(new Event()) calls found OUTSIDE DB::transaction() closures.
 *
 * For event dispatches, attempt to trace into listeners via EventServiceProvider.
 */
function emitStandaloneDispatchNodes(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  ctrlNode: ExecutionNode,
  dispatches: StandaloneDispatch[],
  projectRoot: string,
  namespaces: Record<string, string>,
  expandJobBodies = true
): void {
  if (dispatches.length === 0) return

  // Lazy-load listener map only if there are events to trace
  const hasEvents = dispatches.some((d) => d.kind === "event")
  const listenerMap = hasEvents ? parseEventListeners(projectRoot, namespaces) : new Map()

  const seen = new Set<string>()

  for (const d of dispatches) {
    const slug = d.className.toLowerCase().replace(/[^a-z0-9]/g, "_")

    if (d.kind === "job") {
      const id = `job_${slug}_${ctrlNode.id}`
      if (seen.has(id)) continue
      seen.add(id)

      const file = d.fqcn.includes("\\") ? (fqcnToPath(d.fqcn, namespaces) ?? undefined) : undefined
      const jobNode: ExecutionNode = {
        id,
        type:   IR_NODE_TYPES.QUEUE_JOB,
        symbol: `${d.className}::dispatch`,
        role:   "async_execution",
        ...(file ? { file } : {}),
      }
      nodes.push(jobNode)
      edges.push({
        from:         ctrlNode.id,
        to:           id,
        relation:     IR_EDGE_RELATIONS.DISPATCHES,
        traceability: "static",
      })

      // Parse job's handle() body for nested dispatches (depth-1)
      if (expandJobBodies) {
        expandJobBody(nodes, edges, jobNode, projectRoot, namespaces)
      }

    } else if (d.kind === "event") {
      const id = `evt_${slug}_${ctrlNode.id}`
      if (seen.has(id)) continue
      seen.add(id)

      nodes.push({
        id,
        type:   IR_NODE_TYPES.EVENT_DISPATCH,
        symbol: `${d.className}::dispatch`,
        role:   "event_emission",
      })
      edges.push({
        from:         ctrlNode.id,
        to:           id,
        relation:     IR_EDGE_RELATIONS.DISPATCHES,
        traceability: "static",
      })

      // Trace into listeners
      const listeners = listenerMap.get(d.className) ?? []
      listeners.forEach((entry: ListenerEntry, idx: number) => {
        const short     = entry.listenerFqcn.split("\\").pop() ?? entry.listenerFqcn
        const listenId  = `listener_${id}_${idx}`
        nodes.push({
          id:     listenId,
          type:   IR_NODE_TYPES.SERVICE_CALL,
          symbol: `${short}::handle`,
          role:   "listener",
          ...(entry.listenerFile ? { file: entry.listenerFile } : {}),
          ...(entry.isAfterCommitSafe ? { args: ["afterCommit"] } : {}),
        })
        edges.push({
          from:         id,
          to:           listenId,
          relation:     "calls",
          traceability: "semantic",
        })
      })
    }
  }
}

// ─── Job handle() body parsing (depth-1) ─────────────────────────────────────

/**
 * Parse a Job class's handle() method and emit any nested dispatches or
 * notifications as child nodes of the job node. Limited to depth 1 to
 * prevent runaway recursion across job chains.
 */
function expandJobBody(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  jobNode: ExecutionNode,
  projectRoot: string,
  namespaces: Record<string, string>
): void {
  if (!jobNode.file) return
  const filePath = join(projectRoot, jobNode.file)

  let l1: ReturnType<typeof parseControllerMethod>
  try {
    l1 = parseControllerMethod(filePath, "handle")
  } catch {
    return
  }
  if (!l1) return

  const seen = new Set<string>()

  // Nested job dispatches from handle()
  for (const d of l1.standaloneDispatches) {
    const slug = d.className.toLowerCase().replace(/[^a-z0-9]/g, "_")

    if (d.kind === "job") {
      const id = `job_${slug}_${jobNode.id}`
      if (seen.has(id) || nodes.some(n => n.id === id)) continue
      seen.add(id)
      const file = d.fqcn.includes("\\") ? (fqcnToPath(d.fqcn, namespaces) ?? undefined) : undefined
      nodes.push({ id, type: IR_NODE_TYPES.QUEUE_JOB, symbol: `${d.className}::dispatch`, role: "async_execution", ...(file ? { file } : {}) })
      edges.push({ from: jobNode.id, to: id, relation: IR_EDGE_RELATIONS.DISPATCHES, traceability: "static" })

    } else if (d.kind === "event") {
      const id = `evt_${slug}_${jobNode.id}`
      if (seen.has(id) || nodes.some(n => n.id === id)) continue
      seen.add(id)
      nodes.push({ id, type: IR_NODE_TYPES.EVENT_DISPATCH, symbol: `${d.className}::dispatch`, role: "event_emission" })
      edges.push({ from: jobNode.id, to: id, relation: IR_EDGE_RELATIONS.DISPATCHES, traceability: "static" })
    }
  }

  // Nested notifications/mail from handle()
  for (const n of l1.standaloneNotifications) {
    const slug = n.className.toLowerCase().replace(/[^a-z0-9]/g, "_")
    const id   = n.kind === "notification" ? `notif_${slug}_${jobNode.id}` : `mail_${slug}_${jobNode.id}`
    if (seen.has(id) || nodes.some(nd => nd.id === id)) continue
    seen.add(id)
    nodes.push({
      id,
      type:   n.kind === "notification" ? IR_NODE_TYPES.NOTIFICATION : IR_NODE_TYPES.MAIL,
      symbol: `${n.className}::${n.kind === "mail" ? "build" : "via"}`,
      role:   "side_effect",
      detail: JSON.stringify({ className: n.className, queued: n.queued }),
    })
    edges.push({ from: jobNode.id, to: id, relation: IR_EDGE_RELATIONS.SENDS, traceability: "static" })
  }
}

// ─── API Resource nodes (IR v1.2) ────────────────────────────────────────────

function emitApiResourceNodes(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  ctrlNode: ExecutionNode,
  returnedResources: Array<{ shortName: string; fqcn: string; isCollection: boolean }>,
  projectRoot: string,
  config: ProjectConfig,
  cache: ParseCache<unknown> | null = null
): void {
  const seen = new Set<string>()

  for (const rr of returnedResources) {
    if (seen.has(rr.fqcn)) continue
    seen.add(rr.fqcn)

    const id = `api_res_${rr.shortName.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${ctrlNode.id}`

    // Try to resolve the Resource file so we can parse toArray()
    const resourceFile = fqcnToPath(rr.fqcn, config.namespaces) ?? undefined
    const resourcePath = resourceFile ? join(projectRoot, resourceFile) : undefined

    // Parse toArray() to get field list and nested resource refs
    let fields: string[] = []
    let sensitiveFields: string[] = []
    let conditionalFields: string[] = []
    let isCollection = rr.isCollection
    let nestedResources: NestedResourceRef[] = []

    if (resourcePath && existsSync(resourcePath)) {
      const info = apiRes(cache, resourcePath)
      if (info) {
        fields            = info.fields.map(f => f.key)
        sensitiveFields   = info.fields.filter(f => f.isSensitive).map(f => f.key)
        conditionalFields = info.conditionalFields
        isCollection      = isCollection || info.isCollection
        nestedResources   = info.nestedResources
      }
    }

    const node: ExecutionNode = {
      id,
      type:   "ir:api_resource",
      symbol: `${rr.shortName}::toArray`,
      role:   "response_shape",
      file:   resourceFile,
      ...(fields.length > 0 ? { detail: JSON.stringify({ fields, sensitiveFields, conditionalFields, isCollection }) } : {}),
    }

    nodes.push(node)
    edges.push({
      from:         ctrlNode.id,
      to:           id,
      relation:     "ir:returns",
      traceability: "static",
    })

    // Emit nested resource nodes (depth-1 only to prevent cycles)
    emitNestedResourceNodes(nodes, edges, node, nestedResources, projectRoot, config, cache)
  }
}

/**
 * Emit ir:api_resource child nodes for resources nested inside a parent resource's toArray().
 * Depth-1 only — we do not recurse further to prevent cycles in resource graphs.
 */
function emitNestedResourceNodes(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  parentNode: ExecutionNode,
  nestedRefs: NestedResourceRef[],
  projectRoot: string,
  config: ProjectConfig,
  cache: ParseCache<unknown> | null = null
): void {
  const seen = new Set<string>()

  for (const nr of nestedRefs) {
    if (seen.has(nr.fqcn)) continue
    seen.add(nr.fqcn)

    const id = `api_res_${nr.shortName.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${parentNode.id}`
    if (nodes.some(n => n.id === id)) continue

    const resourceFile = fqcnToPath(nr.fqcn, config.namespaces) ?? undefined
    const resourcePath = resourceFile ? join(projectRoot, resourceFile) : undefined

    let fields: string[] = []
    let sensitiveFields: string[] = []
    let conditionalFields: string[] = []
    let isCollection = nr.isCollection

    if (resourcePath && existsSync(resourcePath)) {
      const info = apiRes(cache, resourcePath)
      if (info) {
        fields            = info.fields.map(f => f.key)
        sensitiveFields   = info.fields.filter(f => f.isSensitive).map(f => f.key)
        conditionalFields = info.conditionalFields
        isCollection      = isCollection || info.isCollection
      }
    }

    nodes.push({
      id,
      type:   "ir:api_resource",
      symbol: `${nr.shortName}::toArray`,
      role:   "response_shape",
      file:   resourceFile,
      ...(fields.length > 0 ? { detail: JSON.stringify({ fields, sensitiveFields, conditionalFields, isCollection }) } : {}),
    })

    edges.push({
      from:         parentNode.id,
      to:           id,
      relation:     "ir:includes",
      traceability: "static",
    })
  }
}

// ─── Notification + Mail nodes (IR v1.4) ─────────────────────────────────────

function emitNotificationNodes(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  ctrlNode: ExecutionNode,
  notifications: NotificationDispatch[]
): void {
  const seen = new Set<string>()

  for (const n of notifications) {
    if (seen.has(n.fqcn)) continue
    seen.add(n.fqcn)

    const slug = n.className.toLowerCase().replace(/[^a-z0-9]/g, "_")
    const id   = n.kind === "notification"
      ? `notif_${slug}_${ctrlNode.id}`
      : `mail_${slug}_${ctrlNode.id}`

    const nodeType = n.kind === "notification"
      ? IR_NODE_TYPES.NOTIFICATION
      : IR_NODE_TYPES.MAIL

    nodes.push({
      id,
      type:   nodeType,
      symbol: `${n.className}::${n.kind === "mail" ? "build" : "via"}`,
      role:   "side_effect",
      detail: JSON.stringify({ className: n.className, queued: n.queued }),
    })

    edges.push({
      from:         ctrlNode.id,
      to:           id,
      relation:     IR_EDGE_RELATIONS.SENDS,
      traceability: "static",
    })
  }
}
