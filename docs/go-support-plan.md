# Go/Gin Support — Implementation Plan

> Drafted 2026-09-03, grounded in three real target repos (not a generic Go survey):
> `CRM - DG Group/crm-api`, `smart-clinic/smart-clinic-api`, `prohealth/prohealth-api`.
> Priority: MCP/AI-assist value first (`archmind_get_execution_graph`, `archmind_get_findings`
> for Claude/Cursor working in these repos) — CI topology-guard parity is a later goal, not v1.

## Why this is scoped to Gin, not "Go" in general

All three repos share the same stack and near-identical internal layout — very likely the
same personal template reused across projects:

| | crm-api | smart-clinic-api | prohealth-api |
|---|---|---|---|
| Router | `gin-gonic/gin` | `gin-gonic/gin` | `gin-gonic/gin` |
| ORM | `gorm.io/gorm` | `gorm.io/gorm` | `gorm.io/gorm` |
| Auth | `golang-jwt/jwt/v5` | `golang-jwt/jwt/v5` | `golang-jwt/jwt/v5` |
| Validation | `go-playground/validator/v10` | `go-playground/validator/v10` | `go-playground/validator/v10` |
| Layout | `cmd/`, `routes/`, `internal/{handler,service,middleware,model,dto,...}` | same | same |

No other Go web framework (net/http, Echo, Fiber, Chi) or ORM (sqlx, ent, sqlc) is represented.
Following the same lesson already written in `next-version-ideas.md` #3 ("don't build the
generic adapter kit before the second framework exists") — **v1 targets Gin + GORM only**,
narrowly scoped to this layout. Generalize later if/when a second Go shape shows up.

---

## Architectural challenges (found by reading real code, not assumed)

### 1. Route composition spans 3-4 function-call layers, not one route table

```
cmd/server/main.go        — global middleware on *gin.Engine via r.Use(...)
  routes/routes.go        — RegisterRoutes(r, ...): creates /api/v1 group,
                             applies group-level middleware, calls per-domain registrars
    routes/appointment.go — RegisterAppointmentRoutes(router gin.IRouter, handler, ...):
                             sub-group + r.POST(path, middleware..., handler.Method)
```

Closest existing precedent: Laravel's `RouteServiceProvider` prefix/middleware-wrapping
resolution (`route-service-provider-parser.ts`) already solves "resolve wrapping context
across function boundaries" — same problem, but here it's 3-4 levels deep instead of 1-2,
and resolution is via ordinary Go function calls rather than a fixed provider hook name.

### 2. Global auth middleware with a runtime skip-list — the highest-risk gap

```go
// cmd/server/main.go
r.Use(middleware.AuthMiddleware())   // applied to EVERY route

// internal/middleware/auth.go
func AuthMiddleware() gin.HandlerFunc {
    skipRoutes := map[skipKey]bool{
        {http.MethodPost, "/api/v1/auth/register"}: true,
        {http.MethodGet, "/api/v1/health"}:          true,
        // ...
    }
    return func(ctx *gin.Context) {
        if skipRoutes[skipKey{ctx.Request.Method, ctx.FullPath()}] { ctx.Next(); return }
        // ... require Bearer token ...
    }
}
```

A naive "does this route's registration chain include AuthMiddleware" check gets this
**backwards** — every route looks authenticated, including the genuinely public ones. The
parser must read the body of any globally-`Use()`d middleware for a `map[string(+string)]bool`
literal keyed by method+path, and treat matching entries as auth-exempt. This is the Go
equivalent of the BookStack false-positive class of bug already fixed once in the Laravel
parser (permission-constant reachability) — same shape of mistake, different mechanism.

### 3. Role/permission passed as typed Go const identifiers, not strings

```go
admin.GET("/stats", middleware.RequireSystemRole(model.SystemRoleAdmin), h.GetAdminDashboard)
```

`model.SystemRoleAdmin` must resolve back to its declared value in `internal/model` (Go
`const` block, often with `iota` or a typed string const) — conceptually identical to
Laravel's `Permission::TASK_DELETE` class-constant resolution, but via Go identifier lookup
instead of PHP `ClassName::CONST` text matching.

### 4. Handler methods on injected struct receivers

```go
appointmentHandler := handler.NewAppointmentHandler(c.AppointmentService)
RegisterAppointmentRoutes(api, appointmentHandler, redisClient)
// ...
appointment.POST("/", handler.RegisterAppointment)   // method value on *AppointmentHandler
```

Needs go-to-definition from the method value expression to the method declaration on the
concrete receiver type — architecturally closer to NestJS's controller-class method
resolution (already solved via ts-morph) than to Laravel's simpler `Controller@method` string.

### 5. Validation via typed DTO + struct tags, not a FormRequest class

```go
var req dto.RegisterAppointmentRequest
if err := ctx.ShouldBindJSON(&req); err != nil { ... }
// dto.RegisterAppointmentRequest field: `binding:"required,uuid"`
```

Same IR concept as Laravel's `ir:validation_gate`, different mechanism: resolve the bound
struct type, parse its `binding:"..."` tags instead of a FormRequest's `authorize()`/`rules()`.

### 6. Transaction boundary — directly transferable technique

```go
err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error { ... })
```

Same closure-boundary-detection technique as Laravel's `DB::transaction(function () {...})`
— `transaction-parser.ts`'s approach ports over with minimal changes.

---

## Recommended package shape

New package `packages/go-parser`, mirroring `laravel-parser`'s internal structure:

```
packages/go-parser/
  src/
    route-parser.ts          — walks cmd/server/main.go → routes.go → routes/*.go,
                                resolves group prefixes + per-route middleware chains
    middleware-mapper.ts     — classifies middleware calls (auth/role/rate-limit/...),
                                and for globally-Use()'d ones, extracts skip-list literals
    handler-parser.ts        — resolves handler.Method values to their struct-method decl,
                                extracts ShouldBind* calls + bound DTO type
    dto-binding-parser.ts    — parses `binding:"..."` struct tags on a resolved DTO type
    const-resolver.ts        — resolves a Go identifier (model.RoleAdmin) to its const value
    transaction-parser.ts    — detects db.Transaction(func(tx *gorm.DB) error {...}) closures
    project-config.ts        — path/layout conventions (cmd/server entry file name,
                                routes dir, internal/ package names) — configurable like
                                Laravel's DEFAULT_PROJECT_CONFIG, not hardcoded
```

Add `tree-sitter-go` as the grammar. Apply the lesson from this session's flaky-test
incident up front: verify the `tree-sitter` / `tree-sitter-go` version pair with a plain-Node
smoke script (no Jest) before wiring in, and set `maxWorkers` generously in this package's
`jest.config.js` from day one rather than discovering the same Jest-worker-reuse bug again.

No changes needed to `@kidkender/archmind-protocol` — this is a new adapter emitting the
existing IR vocabulary (`ir:business_handler`, `ir:auth_gate`, `ir:authz_check`,
`ir:validation_gate`, `ir:txn_boundary`, etc.).

---

## Phased delivery — MCP/AI-assist value first

Each phase gates on a real benchmark against the three target repos before moving to the
next one, following the same discipline already used for Laravel's IR v1.5 fixes: **read the
source and write ground truth by hand first, then run the parser — never tune the parser
against its own output.**

### Phase A — routes + auth gate (highest priority, ships first)

- Resolve full route path + method by walking `main.go` → `routes.go` → `routes/*.go`
- Emit `ir:auth_gate` for global `AuthMiddleware`, correctly honoring the skip-list (§2 above)
- Ground truth: hand-verify ~15-20 routes spread across all three repos before checking
  parser output (mirrors the invoiceninja/monica/akaunting benchmark method)
- This alone unblocks the main MCP value: `archmind_get_execution_graph` /
  `archmind_get_findings` giving Claude/Cursor an accurate "is this route protected" answer
  for these repos, which today requires reading 3-4 files by hand every time

### Phase B — authorization + validation depth

- `RequireRole`/`RequireSystemRole` → `ir:authz_check`, with role constants resolved via §3
- `ShouldBindJSON`/`ShouldBindQuery`/`ShouldBindUri` → `ir:validation_gate` referencing the
  DTO struct + its `binding` tags

### Phase C — transaction + isolation

- GORM `.Transaction()` closures → `ir:txn_boundary` (§6)
- Investigate whether `internal/context` tenant/hospital-scoping accessors (e.g.
  `context.HospitalRole(c)`, seen in `role.go`) map cleanly onto the existing isolation IR
  (`ir:unscoped_query` / `ir:tenant_scoped_query`) or need a Go-specific variant — open
  question, not yet answered by the repos surveyed here

CI topology-guard parity (the `archmind verify` / `.github/workflows` template style already
shipped for Laravel) is an explicit **non-goal for v1** — revisit once Phase A-C are stable
and benchmarked, per the stated priority (MCP/AI-assist first).

---

## Open questions for whoever picks this up

1. Phase C's tenant/isolation mapping (`internal/context` accessors) needs a fourth repo or
   closer reading before design — don't guess the IR shape from one pattern.
2. Should `internal/service` business-logic expansion (the Go equivalent of Laravel's
   service-call recursive expansion) be in scope for v1, or is handler-level L1 enough to
   start delivering MCP value? Recommend starting with handler-level only, same as Laravel's
   original v1 before service-call expansion was added.
