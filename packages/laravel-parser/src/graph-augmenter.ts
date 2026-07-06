import { join } from "path"
import { existsSync } from "fs"
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

function txnRes(cache: ParseCache<unknown> | null, filePath: string): TxnRes {
  if (!cache) return parseTransactions(filePath)
  return (cache as ParseCache<TxnRes>).compute(filePath, "parseTransactions", () => parseTransactions(filePath))
}

function isoRes(cache: ParseCache<unknown> | null, filePath: string, opts: { tenantSignals: string[]; tenantContainerKeys: string[] }): IsoRes {
  if (!cache) return parseIsolation(filePath, opts)
  // opts are constant per project root, so discriminator doesn't need to include them
  return (cache as ParseCache<IsoRes>).compute(filePath, "parseIsolation", () => parseIsolation(filePath, opts))
}

type GuardRes = ReturnType<typeof detectGuardClause>

function guardRes(cache: ParseCache<unknown> | null, filePath: string, methodName: string): GuardRes {
  if (!cache) return detectGuardClause(filePath, methodName)
  return (cache as ParseCache<GuardRes>).compute(filePath, `guardClause::${methodName}`, () => detectGuardClause(filePath, methodName))
}
import { parseControllerMethod, parseFormRequestAuthorize, type ServiceCall, type ModelParam, type StandaloneDispatch, type NotificationDispatch } from "./controller-parser.js"
import type { ListenerEntry } from "./event-listener-mapper.js"
import { middlewareToNode } from "./middleware-mapper.js"
import { parseEventListeners } from "./event-listener-mapper.js"
import { parseConstantClass } from "./constant-resolver.js"
import { extractPermissionNodes } from "./permission-extractor/constants.js"
import { buildHierarchyEdges } from "./permission-extractor/hierarchy.js"
import { parseTransactions } from "./transaction-parser.js"
import { parseIsolation } from "./isolation-parser.js"
import { detectGuardClause } from "./guard-clause-parser.js"
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
  for (const relFile of permFiles) {
    const absPath = join(opts.projectRoot, relFile)
    const map = parseConstantClass(absPath)
    const permNodes = extractPermissionNodes(map, relFile)
    const permEdges = buildHierarchyEdges(permNodes)
    newNodes.push(...permNodes)
    newEdges.push(...permEdges)
  }

  // ---- Transaction pass ------------------------------------------------
  const ctrlNodeForTxn = graph.nodes.find((n) => n.type === IR_NODE_TYPES.BUSINESS_HANDLER)
  if (ctrlNodeForTxn?.file) {
    const filePath = join(opts.projectRoot, ctrlNodeForTxn.file)
    const txnResult = txnRes(cache, filePath)
    if (txnResult.hasTransaction) {
      addTransactionNodes(newNodes, newEdges, ctrlNodeForTxn.id, txnResult.blocks)
    }
  }

  // ---- Event → listener tracing pass ----------------------------------
  traceEventListeners(newNodes, newEdges, opts.projectRoot, config.namespaces)

  // ---- Isolation pass --------------------------------------------------
  const ctrlNodeForIso = graph.nodes.find((n) => n.type === IR_NODE_TYPES.BUSINESS_HANDLER)
  if (ctrlNodeForIso?.file) {
    const filePath = join(opts.projectRoot, ctrlNodeForIso.file)
    const isoConv  = { tenantSignals: config.conventions.tenantSignals, tenantContainerKeys: config.conventions.tenantContainerKeys }
    const isoResult = isoRes(cache, filePath, isoConv)
    addIsolationNodes(newNodes, newEdges, ctrlNodeForIso.id, isoResult)
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
    const idBase = `svc_${sc.serviceClass}_${sc.method}`.toLowerCase().replace(/[^a-z0-9]/g, "_")
    const id     = `${idBase}_${callerNodeId.replace(/[^a-z0-9]/g, "_")}`

    if (seen.has(id)) continue
    seen.add(id)

    const file = sc.serviceFqcn.includes("\\") ? (fqcnToPath(sc.serviceFqcn, namespaces) ?? undefined) : undefined

    // Guard-clause detection (IR v1.5 Phase 4) — a resolvable call whose body
    // can abort the caller via throw/abort based on a precondition gets its
    // own node type instead of a generic service_call.
    const guard = file
      ? guardRes(cache, join(projectRoot, file), sc.method)
      : { isGuardClause: false, reason: null }

    const node: ExecutionNode = {
      id,
      type: guard.isGuardClause ? IR_NODE_TYPES.GUARD_CLAUSE : IR_NODE_TYPES.SERVICE_CALL,
      symbol: `${sc.serviceClass}::${sc.method}`,
      role:   guard.isGuardClause ? "guard" : "service",
      ...(file               ? { file }      : {}),
      ...(sc.args.length > 0 ? { args: sc.args } : {}),
      ...(sc.mutates         ? { mutates: true } : {}),
    }

    nodes.push(node)
    created.push(node)

    edges.push({
      from:         callerNodeId,
      to:           id,
      relation:     "calls",
      traceability: "semantic",
    })
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

    // Transaction pass inside service method
    try {
      const txnResult = txnRes(cache, filePath)
      if (txnResult.hasTransaction) {
        addTransactionNodes(nodes, edges, scNode.id, txnResult.blocks)
        budget.remaining -= txnResult.blocks.length * 3
      }
    } catch { /* file unreadable or parse error — skip gracefully */ }

    // Isolation/query pass inside service method
    try {
      const isoResult = isoRes(cache, filePath, isoConv)
      addIsolationNodes(nodes, edges, scNode.id, isoResult)
      budget.remaining -= isoResult.modelQueries.length
    } catch { /* skip */ }

    // Deeper service calls from this service method
    try {
      const l1 = ctrlL1(cache, filePath, methodName)
      if (l1 && l1.serviceCalls.length > 0) {
        const newSvcNodes = addServiceCallNodes(nodes, edges, scNode.id, l1.serviceCalls, config.namespaces, projectRoot, cache)
        budget.remaining -= newSvcNodes.length
        nextServiceNodes.push(
          ...newSvcNodes.filter((n) => !!n.file && matchesExpansionFocus(n, focus))
        )
      }
    } catch { /* skip */ }
  }

  expandServiceCalls(nodes, edges, nextServiceNodes, projectRoot, config, depth - 1, visited, budget, focus, cache)
}

/**
 * Add transaction_boundary, transactional_write, and transaction_escape nodes
 * for each DB::transaction() block found in the controller file.
 */
function addTransactionNodes(
  nodes: ExecutionNode[],
  edges: ExecutionEdge[],
  callerNodeId: string,
  blocks: import("./transaction-parser.js").TransactionBlock[]
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
