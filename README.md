# ArchMind

**Semantic execution graph engine for Laravel, NestJS, and Spring Boot — built for AI assistants and CI.**

ArchMind parses your app into a structured execution graph and gives AI assistants (Claude, Cursor, Copilot) the minimal relevant subgraph for a query — achieving comparable or better answer quality at a fraction of the tokens that naive file-dump RAG uses.

---

## Why execution graphs beat naive RAG

Naive RAG dumps raw source files into the LLM context. ArchMind retrieves only the nodes relevant to the question — authentication gates, policy checks, transaction boundaries, tenant isolation — and nothing else.

### Benchmark results (real repos, hand-verified ground truth, real GPT-4o calls — not simulated)

| Benchmark | Sample | archMind | Baseline (raw file dump) |
|---|---|---|---|
| Guest-access / authorization accuracy — 5 real Laravel apps (invoiceninja, monica, akaunting, koel, BookStack) | 50 hand-verified entrypoints | 66% correct, 98% correct+partial | 68% correct, 100% correct+partial |
| Token cost, same benchmark | 50 entrypoints | **5.08× fewer prompt tokens** (14,517 vs 73,712) | baseline |
| Guest-access / authorization accuracy — 5 fresh, previously-unseen repos across Laravel/Spring Boot/NestJS (panel, attendize, spring-petclinic, SpringBlade, nestjs-boilerplate) | 20 entrypoints | **90% correct** (18/20), 0 incorrect | 65% correct (13/20), 5 confidently incorrect |
| Token cost, same cross-framework set | 24 calls | **73.4% fewer prompt tokens** (7,116 vs 26,764) | baseline |

**Read the accuracy numbers honestly:** on Laravel alone, raw accuracy is statistically tied with a naive file dump — the win there is almost entirely token efficiency (same answer quality, 1/5th the context). The larger accuracy edge shows up on the cross-framework sample, and traces to a specific mechanism, not "the LLM likes archMind more": ArchMind's evidence package marks facts as explicitly **present or ABSENT** (e.g. `✗ auth_middleware`), which lets the model correctly infer "no auth required" instead of reading silence as ambiguity — a raw file dump gives the model no equivalent signal to reason from, so it hedges to `UNCLEAR` far more often (5 of the baseline's misses were exactly this).

ArchMind's accuracy pass has also surfaced real, previously undocumented security issues in the repos it was tested against — including an unauthenticated multi-tenant data exposure and a path-traversal-adjacent unguarded file endpoint — precisely because the graph's explicit absence-marking caught missing auth that a raw-file read past over.

**Where it doesn't win:** deeper reasoning benchmarks (cross-file causality, multi-turn sessions) show archMind edging ahead but with concrete, documented gaps — transaction-scope flattening (the graph knows *a* transaction exists but not precisely which downstream calls are inside it) and an accessor-vs-terminal-mutation gap (a relationship accessor is captured as touched, without confirming the chained `.delete()` on it actually ran). These are IR-granularity ceilings, not retrieval-reach problems, and are being worked on incrementally rather than glossed over.

The difference compounds on large codebases where a single route touches dozens of files.

---

## MCP Server (Claude Code / AI assistants)

ArchMind ships an MCP server that gives AI assistants structured execution graph access.

```bash
npm install -g @kidkender/archmind-mcp
```

Add to your MCP settings:

```json
{
  "archmind": {
    "command": "archmind-mcp"
  }
}
```

Ask Claude: *"Why is authorization checked twice on POST /orders?"* — it calls `archmind_get_execution_graph` and reasons over the actual execution path, not a raw file dump.

### MCP tools

| Tool | What it does |
|------|-------------|
| `archmind_list_entrypoints` | All routes in the project |
| `archmind_get_execution_graph` | Execution graph for a specific route (with optional focus pruning) |
| `archmind_get_findings` | Static detectors — auth gaps, transaction anomalies, isolation issues |
| `archmind_get_dependents` | Cross-route impact: what breaks if I change `OrderService`? |
| `archmind_invalidate_cache` | Force re-parse after source changes |

---

## CI: topology guard

ArchMind also runs as a zero-config CI check. It saves a baseline of your execution topology and **fails the build if a transaction boundary, auth middleware, or tenant scope disappears from any route**.

```bash
npm install -g @kidkender/archmind
archmind verify --project .
```

No AI model. No API key. Works offline.

```
POST /orders  [before refactor]           POST /orders  [after refactor]
├─ 🔑 auth:sanctum                        ├─ 🔑 auth:sanctum
├─ ⚙ ResolveTenant                        └─ 📋 OrderController::store
├─ 📋 OrderController::store
│   └─ 🔄 DB::transaction          ←   GONE
│       ├─ Order::create
│       └─ OrderCreated (event)
```

```
✘ TOPOLOGY REGRESSION: POST /orders
  lost: [transaction_boundary]

If this is intentional, run: archmind verify --project . --update
```

### What it catches

| Scenario | How it's detected |
|----------|------------------|
| `DB::transaction()` removed from a route | `transaction_boundary` lost → CI fails |
| Auth middleware accidentally dropped | `authentication_gate` lost → CI fails |
| Tenant scope removed from model query | `unscoped_write` gained → CI fails |
| Route with auth but no policy/gate | `missing_authorization` finding |
| Policy class referenced but file missing | `missing_policy` finding |

### CI Integration

```yaml
# .github/workflows/topology-guard.yml
- uses: actions/setup-node@v4
  with:
    node-version: '20'

- name: Install archmind
  run: npm install -g @kidkender/archmind

- name: Verify topology
  run: archmind verify --project .
  # Fails if DB::transaction, auth middleware, or tenant scope disappears from any route
```

First-time setup (run once, commit the result):

```bash
archmind verify --project . --update
git add .archmind/baselines/
git commit -m "chore: add topology baseline"
```

---

## CLI commands

```bash
# Trace the execution graph of any route
archmind trace --project . "POST /orders"

# Find security gaps across all routes
archmind findings --project .

# Save baseline, then verify on every PR
archmind verify --project . --update   # save
archmind verify --project .            # check (exit 1 if regression)

# What routes are affected if I change this service?
archmind deps --project . OrderService
```

### Example: trace output

```
POST /api/orders
└─ 🔑 auth:sanctum  [authentication_gate]
   └─ ⚙ ResolveTenant::handle  [middleware]
      └─ 📋 OrderController::store  [controller_action]
         ├─ ✅ StoreOrderRequest  [form_request]
         └─ ⚡ OrderService::createOrder  [service_call]
            └─ 🔄 DB::transaction  [transaction_boundary]
               ├─ Order::create  [transactional_write]
               └─ ⚡ OrderCreated → NotifyUser  [transaction_escape]
```

### Example: findings output

```
POST /api/vaults
  ! HIGH    missing_authorization
            Route is authenticated but has no policy or gate — any logged-in user can create vaults

DELETE /api/vaults/{id}
  ! HIGH    missing_authorization
            Route is authenticated but has no policy or gate — any logged-in user can delete vaults

4 finding(s) across 4 route(s)
```

---

## Supported frameworks

### Laravel

- Route groups with nested middleware inheritance
- `Route::apiResource()` / `Route::resource()` with `.only()` / `.except()`
- Constructor-injected services (PHP 8 promoted properties)
- `DB::transaction()` blocks with event dispatches and after-commit listeners
- Tenant isolation (`tenant_id`, `app('tenant')`, `whereTenantId`)
- Event → listener tracing via `EventServiceProvider::$listen`
- Kernel aliases (Laravel ≤10) and `bootstrap/app.php` (Laravel 11/12)

### Spring Boot

- HTTP routes (`@RestController`/`@Controller` + method-level `@*Mapping`), including custom stereotypes that skip the standard annotation but still carry method-level mappings (e.g. Spring Boot Admin's `@AdminController`)
- Multi-module Maven projects, at arbitrary nesting depth — and Gradle multi-module via `settings.gradle`
- Non-HTTP entrypoints: `@KafkaListener`/`@RabbitListener`/`@JmsListener` (queue) and `@Scheduled` (cron)
- `@PreAuthorize`/`@Secured`/`@RolesAllowed` and role/permission checks (`hasRole`, `hasAuthority`) resolved to both an auth gate and an authorization check
- `SecurityFilterChain` rule resolution, scoped per Maven module so an unrelated module's security config can't leak onto your controllers
- `@Transactional` resolved through the interface/impl split, scoped per module
- Unrecognized but auth-shaped custom annotations (e.g. SpringBlade's `@PreAuth`, Apache Shiro's `@RequiresRoles`) are surfaced as an explicit "unknown security signal" rather than silently read as no-auth

### NestJS

- Controller decorators and route method mapping
- `@Cron` (`@nestjs/schedule`) jobs as first-class cron entrypoints
- Route-constants object references resolved in decorator arguments

---

## Requirements

- Node.js ≥ 18
- A Laravel (≥8, tested on 10/11/12), NestJS, or Spring Boot (Maven or Gradle) project

## License

MIT
