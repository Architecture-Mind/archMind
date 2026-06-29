# ArchMind

**Semantic execution graph engine for Laravel — built for AI assistants and CI.**

ArchMind parses your Laravel app into a structured execution graph and gives AI assistants (Claude, Cursor, Copilot) the minimal relevant subgraph for a query — achieving higher answer quality at a fraction of the tokens that naive file-dump RAG uses.

---

## Why execution graphs beat naive RAG

Naive RAG dumps raw source files into the LLM context. ArchMind retrieves only the nodes relevant to the question — authentication gates, policy checks, transaction boundaries, tenant isolation — and nothing else.

| Approach | LLM answer quality | Token usage |
|----------|-------------------|-------------|
| ArchMind (execution graph) | **0.75** | baseline |
| Naive RAG (file dump) | 0.63 | 3–15× more |

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

## Supported Laravel patterns

- Route groups with nested middleware inheritance
- `Route::apiResource()` / `Route::resource()` with `.only()` / `.except()`
- Constructor-injected services (PHP 8 promoted properties)
- `DB::transaction()` blocks with event dispatches and after-commit listeners
- Tenant isolation (`tenant_id`, `app('tenant')`, `whereTenantId`)
- Event → listener tracing via `EventServiceProvider::$listen`
- Kernel aliases (Laravel ≤10) and `bootstrap/app.php` (Laravel 11/12)

---

## Requirements

- Node.js ≥ 18
- A Laravel project (≥8, tested on 10/11/12)

## License

MIT
