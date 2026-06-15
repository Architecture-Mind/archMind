import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { getGraphs, invalidate, detectFramework } from "./cache.js"
import { retrieve, buildDependencyIndex, queryDependents, indexStats } from "@archmind/retrieval"
import { explain, buildEvidencePackage, traceByPattern } from "@archmind/explainer"
import type { TracePattern } from "@archmind/explainer"
import type { RetrievalFocus } from "@archmind/protocol"
import { PROTOCOL_VERSION } from "@archmind/protocol"
import { ingestOtlpFile } from "@archmind/runtime-ingest"
import { correlateSession, detectNPlusOne, detectSlowQuery } from "@archmind/runtime-correlator"

const FOCUS_VALUES = ["auth", "validation", "runtime", "transaction", "isolation", "side_effects", "all"] as const

export function createServer(): McpServer {
  const server = new McpServer({
    name: "archmind",
    version: "0.2.0",
  })

  server.registerTool(
    "archmind_detect_framework",
    {
      description: "Detect whether a project is Laravel or NestJS. Call this first if you are unsure which framework the project uses.",
      inputSchema: {
        project_root: z.string().describe("Absolute path to the project root"),
      },
    },
    async ({ project_root }) => {
      const framework = detectFramework(project_root)
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ project_root, framework }, null, 2),
        }],
      }
    }
  )

  server.registerTool(
    "archmind_list_entrypoints",
    {
      description: "List all HTTP entrypoints (routes) in a Laravel or NestJS project, with method, path, and node count. Framework is auto-detected from the project root.",
      inputSchema: {
        project_root: z.string().describe("Absolute path to the project root (Laravel or NestJS)"),
      },
    },
    async ({ project_root }) => {
      const graphs = getGraphs(project_root)
      const entrypoints = graphs.map((g) => ({
        entrypoint: g.entrypoint,
        method: g.method,
        path: g.path,
        node_count: g.nodes.length,
        edge_count: g.edges.length,
      }))
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ project_root, entrypoints, total: entrypoints.length }, null, 2),
          },
        ],
      }
    }
  )

  server.registerTool(
    "archmind_get_execution_graph",
    {
      description:
        "Return the semantic execution graph for a specific entrypoint in a Laravel or NestJS project. Use `focus` to narrow to a concern: auth, validation, runtime, transaction, isolation, side_effects (queue jobs / mail / notifications / API resources only), all. Framework is auto-detected.",
      inputSchema: {
        project_root: z.string().describe("Absolute path to the project root (Laravel or NestJS)"),
        entrypoint: z.string().describe('Entrypoint in "METHOD /path" format, e.g. "PUT /tasks/{task}"'),
        focus: z
          .enum(FOCUS_VALUES)
          .optional()
          .describe("Semantic focus to prune the graph. Defaults to 'all' (full graph)."),
      },
    },
    async ({ project_root, entrypoint, focus }) => {
      const graphs = getGraphs(project_root)
      const graph = graphs.find((g) => g.entrypoint === entrypoint)
      if (!graph) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `No graph found for entrypoint: ${entrypoint}` }),
            },
          ],
          isError: true,
        }
      }

      const resolvedFocus: RetrievalFocus = (focus as RetrievalFocus) ?? "all"
      const retrieved = retrieve({ entrypoint, focus: resolvedFocus }, graphs)

      const result = retrieved ?? {
        entrypoint:       graph.entrypoint,
        nodes:            graph.nodes,
        edges:            graph.edges,
        token_estimate:   Math.ceil(
          JSON.stringify({ nodes: graph.nodes, edges: graph.edges }).length / 4
        ),
        pruned:           false,
        focus:            resolvedFocus,
        protocol_version: PROTOCOL_VERSION,
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                entrypoint: result.entrypoint,
                focus: resolvedFocus,
                pruned: result.pruned,
                token_estimate: result.token_estimate,
                nodes: result.nodes,
                edges: result.edges,
                annotations: graph.annotations,
              },
              null,
              2
            ),
          },
        ],
      }
    }
  )

  server.registerTool(
    "archmind_get_findings",
    {
      description:
        "Run static and optional runtime pattern detectors on the execution graph and return semantic findings (no LLM call). Findings include security issues, authorization gaps, transaction anomalies, isolation violations, and — when a trace session is provided — runtime findings like N+1 queries and slow queries.",
      inputSchema: {
        project_root: z.string().describe("Absolute path to the project root (Laravel or NestJS)"),
        entrypoint: z.string().describe('Entrypoint in "METHOD /path" format, e.g. "PUT /tasks/{task}" or "GET /users/:id"'),
        query: z
          .string()
          .optional()
          .describe("Optional question to prioritize findings by relevance to the query."),
        trace_session_path: z
          .string()
          .optional()
          .describe("Absolute path to an OTLP JSON export file. When provided, runtime findings (N+1, slow queries) are included alongside static findings."),
      },
    },
    async ({ project_root, entrypoint, query, trace_session_path }) => {
      const graphs = getGraphs(project_root)
      const graph = graphs.find((g) => g.entrypoint === entrypoint)
      if (!graph) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `No graph found for entrypoint: ${entrypoint}` }),
            },
          ],
          isError: true,
        }
      }

      const staticFindings = explain(graph, query)

      // Runtime findings (optional)
      let runtimeFindings: Array<{ source: "runtime"; type: string; severity: string; evidence: string; nodeIds: string[]; count?: number }> = []
      let correlationRate: number | undefined

      if (trace_session_path) {
        try {
          const traceSession  = ingestOtlpFile(trace_session_path)
          const correlated    = correlateSession(traceSession, graph)
          correlationRate     = correlated.correlationRate
          const n1            = detectNPlusOne(correlated)
          const slow          = detectSlowQuery(correlated)
          runtimeFindings     = [...n1, ...slow].map((f) => ({
            source:   "runtime" as const,
            type:     f.type,
            severity: f.severity,
            evidence: f.evidence,
            nodeIds:  f.nodeIds,
            ...(f.count !== undefined ? { count: f.count } : {}),
          }))
        } catch (err) {
          runtimeFindings = []
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                entrypoint,
                static_findings: {
                  total: staticFindings.length,
                  findings: staticFindings.map((f) => ({
                    id:              f.id,
                    type:            f.type,
                    severity:        f.severity,
                    confidence:      f.confidence,
                    summary:         f.summary,
                    evidence:        f.evidence,
                    recommendations: f.recommendations ?? [],
                    uncertainty:     f.uncertainty ?? [],
                  })),
                },
                ...(trace_session_path
                  ? {
                      runtime_findings: {
                        total:            runtimeFindings.length,
                        correlation_rate: correlationRate,
                        findings:         runtimeFindings,
                      },
                    }
                  : {}),
              },
              null,
              2
            ),
          },
        ],
      }
    }
  )

  server.registerTool(
    "archmind_get_evidence_package",
    {
      description:
        "Build a structured evidence package for a question about a specific route. " +
        "Returns the minimal set of relevant nodes, execution path, top finding, and a one-paragraph summary — " +
        "formatted for direct LLM consumption. Prefer this over archmind_get_findings when you need " +
        "to reason about a specific question rather than enumerate all findings.",
      inputSchema: {
        project_root: z.string().describe("Absolute path to the project root (Laravel or NestJS)"),
        entrypoint: z.string().describe('Entrypoint in "METHOD /path" format, e.g. "PUT /products/{product}"'),
        question: z.string().describe('Natural language question, e.g. "Why is authorization duplicated?" or "Can a guest update this resource?"'),
      },
    },
    async ({ project_root, entrypoint, question }) => {
      const graphs = getGraphs(project_root)
      const graph = graphs.find((g) => g.entrypoint === entrypoint)
      if (!graph) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `No graph found for entrypoint: ${entrypoint}` }) }],
          isError: true,
        }
      }

      const pkg = buildEvidencePackage(question, graph)

      return {
        content: [{ type: "text", text: JSON.stringify(pkg, null, 2) }],
      }
    }
  )

  server.registerTool(
    "archmind_trace",
    {
      description:
        "Run a cross-route trace query across the entire project. " +
        "Returns a structured summary of how all routes relate to a specific concern.\n\n" +
        "Patterns:\n" +
        "  auth        — auth chains for every route: middleware, policies, form_requests, unprotected resources\n" +
        "  event       — routes that dispatch events, with unsafe-dispatch detection\n" +
        "  transaction — routes with DB transaction boundaries, writes, and escapes\n" +
        "  isolation   — routes with unscoped queries or writes (tenant isolation gaps)\n" +
        "  request     — full execution path for a single route (requires entrypoint)",
      inputSchema: {
        project_root: z.string().describe("Absolute path to the project root (Laravel or NestJS)"),
        pattern: z
          .enum(["auth", "event", "transaction", "isolation", "request"])
          .describe("Trace pattern to run"),
        entrypoint: z
          .string()
          .optional()
          .describe('Required for pattern="request". Entrypoint in "METHOD /path" format.'),
      },
    },
    async ({ project_root, pattern, entrypoint }) => {
      const graphs = getGraphs(project_root)
      const result = traceByPattern(pattern as TracePattern, graphs, entrypoint)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    }
  )

  server.registerTool(
    "archmind_get_dependents",
    {
      description:
        "Find all routes that depend on a service class, method, queue job, mail, notification, event, or API resource. " +
        "Use to answer 'What breaks if I change X?' or 'Which routes dispatch GenerateInvoicePdfJob?'. " +
        "Pass a class name (e.g. 'OrderService', 'GenerateInvoicePdfJob') for all usages, or a full symbol " +
        "(e.g. 'OrderService::create', 'InvoiceViewedMail::build') for a specific method.",
      inputSchema: {
        project_root: z.string().describe("Absolute path to the project root (Laravel or NestJS)"),
        symbol: z
          .string()
          .describe(
            "Service class, method, job class, mail class, or API resource to query. " +
            "Examples: 'CartService', 'PaymentService::refund', 'GenerateInvoicePdfJob', 'InvoiceResource'"
          ),
      },
    },
    async ({ project_root, symbol }) => {
      const graphs = getGraphs(project_root)
      const index  = buildDependencyIndex(graphs)
      const hits   = queryDependents(index, symbol)
      const stats  = indexStats(index)

      const result = {
        symbol,
        project_root,
        dependent_routes: hits.map((h) => ({
          entrypoint:     h.entrypoint,
          matching_nodes: h.matchingNodes.map((n) => ({ symbol: n.symbol, type: n.type, file: n.file })),
        })),
        total_dependents: hits.length,
        index_stats: {
          total_symbols: stats.totalSymbols,
          total_classes: stats.totalClasses,
        },
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    }
  )

  server.registerTool(
    "archmind_invalidate_cache",
    {
      description:
        "Invalidate the cached parse result for a project root, forcing a fresh parse on the next call. Use when the project's source files have changed.",
      inputSchema: {
        project_root: z.string().describe("Absolute path to the project root (Laravel or NestJS)"),
      },
    },
    async ({ project_root }) => {
      invalidate(project_root)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ invalidated: true, project_root }),
          },
        ],
      }
    }
  )

  return server
}
