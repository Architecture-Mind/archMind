# Changelog

## [0.4.1] — 2026-06-26

### Fixed

- Picks up `laravel-parser@0.4.1` — aliased `use` imports (`use Foo\Bar as Baz`) now resolve to the correct FQCN, fixing namespace collisions in projects with multiple same-named controllers in different namespaces
- Picks up `nestjs-parser@0.6.0` — `ir:api_resource` nodes now emitted for NestJS response DTOs (plainToInstance + return type annotation), with `@Expose/@Exclude` field extraction and sensitive field detection

---

## [0.2.0] — 2026-06-11

### Added

**NestJS support**
- Framework auto-detection (`archmind_detect_framework` tool)
- Guard classifier — maps NestJS guards to `ir:auth_gate` / `ir:authz_check`
- Decorator scanner — `@Roles()`, `@UseGuards()`, `@Permissions()` extracted into IR nodes
- Middleware scanner — global `APP_GUARD` detection
- Same IR types used for both frameworks — cross-framework queries work identically

**New MCP tools**
- `archmind_get_evidence_package` — intent-aware evidence package for a natural-language question; returns classified facts, execution path, and relevant nodes optimized as LLM context
- `archmind_trace` — trace by semantic pattern (`auth`, `event`, `transaction`, `isolation`, `request`)
- `archmind_get_dependents` — cross-route impact analysis; find all routes that use a given service class or method

**RESOURCE semantics (IR v1.1)**
- `ir:resource` nodes emitted for route-model-binding parameters
- `RESOURCE_UNPROTECTED` detector — resource accessed via binding with no per-resource ownership check
- `RESOURCE_MISMATCH` detector — authorization guards a different resource than the one accessed

**Architecture detectors**
- `fat_controller` — controller depending on 5+ distinct service classes
- `exposed_read_endpoint` — GET/HEAD route with business logic and no authentication
- `over_authorized_route` — 3+ separate authorization layers on a single route
- `dead_middleware` — middleware registered in the graph with no outgoing edges
- `circular_dependency` — service class dependency cycle (A → B → A)

**Runtime correlation**
- `archmind_get_findings` now accepts `trace_session_path` (OTLP JSON)
- `n_plus_one` detector — finds repeated queries to the same table in a single request
- `slow_query` detector — queries exceeding configurable threshold

**Evidence quality improvements**
- FormRequest `authorize()` body parsed and surfaced in evidence (`$this->user()?->isAdmin()`)
- `authz_check` fact correctly counts FormRequest delegation as authorization
- FINDING_DESCRIPTIONS in prompts prevent LLM from conflating `resource_unprotected` with "no auth at all"
- Evidence deduplication with `(×N)` notation; execution path capped at 6 nodes; fact dedup drops redundant LOW facts

### Changed

- IR types now use `ir:` prefix throughout — `ir:auth_gate`, `ir:authz_check`, `ir:business_handler`, etc.
- `archmind_get_findings` returns findings with `severity`, `confidence`, `provenance`, `reasoning`, and `recommendations` fields
- Retrieval engine focus options expanded: `auth`, `validation`, `runtime`, `transaction`, `isolation`, `all`

---

## [0.1.0] — 2025-12-01

Initial release.

- Laravel parser: routes, middleware groups, Kernel alias resolution, FormRequest, policies, constructor-injected services
- Five MCP tools: `archmind_list_entrypoints`, `archmind_get_execution_graph`, `archmind_get_findings`, `archmind_get_dependents`, `archmind_invalidate_cache`
- Static detectors: `missing_authorization`, `missing_policy`, `duplicate_authorization`, `event_before_commit`, `missing_tenant_scope`
- Retrieval engine with focus-based pruning vs naive RAG comparison
