# Changelog

## [Unreleased]

## [0.8.0] - 2026-09-03

### Added
- **Go/Gin support** (`@kidkender/archmind-go-parser` 0.1.0, new package): route + auth-gate + authz-check + validation-gate + transaction-boundary extraction for Gin projects, scoped to the Gin+GORM+`internal/{handler,service,middleware,model,dto}` architecture surveyed across 3 real repos (see `docs/go-support-plan.md`). Handles route registration spanning multiple function-call layers (`main()` → `RegisterRoutes()` → `RegisterXRoutes()`), a globally-applied auth middleware exempting specific routes via a runtime `map[method+path]bool` skip-list read from the middleware's own body (not just its registration site), Go const resolution for role/permission arguments (`model.RoleAdmin` → `"admin"`), `ShouldBindJSON`/`Query`/`Uri` → DTO struct `binding` tag extraction, and GORM `.Transaction()` closure detection with one hop into a directly-called service method. Isolation (tenant scoping) is not yet implemented — flagged as an open question needing further investigation, not guessed at. Wired into `packages/analysis`, the MCP server (`archmind_get_execution_graph` etc. now auto-detect Go via `go.mod` + a `gin-gonic/gin` require), and the CLI (`archmind trace`/`findings`/`verify` all work against a Gin project — `findings`' static detectors fire correctly for Go for free, since they operate on the shared `RouteInfo` shape rather than framework-specific logic). Validated against all 3 surveyed repos end-to-end (full auto-scan, zero manual file listing): 62, 265, and 191 routes respectively, zero crashes.

### Fixed
- **Critical: the published CLI and MCP server could not start.** `@kidkender/archmind` and `@kidkender/archmind-mcp` have statically imported `@kidkender/archmind-retrieval` since the AQL/Architecture Constraints release (v0.6.0), and the CLI also statically imports `@kidkender/archmind-scorer` and `@kidkender/archmind-orchestrator` — but none of `archmind-retrieval`, `archmind-scorer`, `archmind-orchestrator`, `archmind-prompt-builder`, `archmind-llm-client`, `archmind-runtime-ingest`, or `archmind-runtime-correlator` had ever been published to npm. Both binaries have been throwing `Cannot find module` on startup for any fresh install since that release. All 7 packages are published for the first time in this release, closing the gap. Caught by running the release-process audit script (`.claude/RELEASE.md` step 0) against every package, not just the ones this release set out to touch.
- `@kidkender/archmind-laravel-parser` 0.5.2: permission-constant reachability (added in v0.7.1/v0.7.2's `graph-augmenter.ts` fix) only matched a constant referenced by class name in a reachable file — but the common `->middleware('permission:task.delete')` pattern passes only the literal string value, never the class name, so the constant was never included. Now also matches by literal value against `args` already captured on an `auth_gate`/`authz_check` node in the graph. Confirmed via the `retrieval` package's own benchmark suite: `AUTH-002` recall was silently stuck at 0.50 (should be 1.00) for a full release cycle — invisible because `retrieval` was never in CI (see the flaky-test fix below) and never published, so nothing ran its benchmark tests outside a workstation.
- `@kidkender/archmind-graph-query` 0.2.1 / `@kidkender/archmind-explainer` 0.3.2: `hasTenantContext()` checked for an `ir:tenant_context` node type that no parser has ever emitted — tenant presence is always signaled via a `runtime_injection` node instead. `detectMissingTenantScope` and the isolation trace in `trace-engine.ts` have therefore never fired for any real graph. Now also matches a `runtime_injection` node whose symbol names a tenant binding.
- `@kidkender/archmind-retrieval` (first publish, 0.1.0): `classifyNode()` looked up node relevance by raw `node.type` without normalizing legacy (pre-IR) type strings first, so any legacy-typed node classified as `LOW` and was pruned away entirely under a non-`"all"` focus, zeroing out `token_estimate`.
- Flaky test suite root-caused and fixed: Jest reusing one worker process across a package's test files, combined with a module-level `tree-sitter` `Parser` singleton per parser module, caused intermittent silently-swallowed parse failures (`laravel-parser`, `springboot-parser`) — not, as first suspected, a `tree-sitter`/grammar version mismatch (disproved: 500 heavy parses of the same singleton in plain Node, zero failures). Fixed via `maxWorkers` set high enough in both packages' `jest.config.js` that every test file always gets its own process; `go-parser`'s `jest.config.js` ships with the same setting from day one. This is very likely why the repo has never had CI on `main` — a result that changes every run isn't a gate anyone can trust — and directly explains how the `AUTH-002` and `hasTenantContext` regressions above went unnoticed for a full release cycle.
- Added `.github/workflows/ci.yml` (build + test on push/PR to `main`) — previously absent entirely.

### Changed
- `@kidkender/archmind-analysis` 0.2.0: added the Go/Gin branch to `analyzeProject()`, checked via `go.mod` + `isGinProject()` ahead of the branches that assume PHP/JS/Java.

## [0.7.2] - 2026-07-18

Catch-up release: publishes real fixes that had already landed on `main` (source-only, never version-bumped) before this release process caught the gap.

### Fixed
- `@kidkender/archmind-analysis` 0.1.1: wired Spring Boot detection (`isSpringBootProject`/`parseSpringBootProject`) into `analyzeProject()` — previously any Spring Boot project silently fell through to the Laravel analyzer and returned zero routes. Confirmed on eladmin/litemall/mall: 0 routes before, 133/223/247 after, with auth gates, service calls, and findings all populated.
- `@kidkender/archmind-laravel-parser` 0.5.1: resolves the implicit `/api` path prefix from `withRouting()`/`mapApiRoutes()` (Laravel 11/12 style bootstrapping); scopes permission-constant nodes to files actually reachable from the route graph instead of every file in the project.
- `@kidkender/archmind-nestjs-parser` 0.7.1: route-constants object references in decorator args (e.g. `@Controller(routesV1.version)`) now resolve to their literal value instead of being emitted as raw expression text — includes a recursive identifier → declaration → object-literal resolver that follows `tsconfig.json` path aliases across files. Confirmed on `domain-driven-hexagon`: routes went from `"/routesV1.version/routesV1.user.root"` to the correct `"/v1/users"`.
- `@kidkender/archmind-mcp-server` (`@kidkender/archmind-mcp`) 0.5.1: cache layer wiring updated for the RouteServiceProvider middleware/namespace and route-constants fixes above.
- `@kidkender/archmind-lsp` 0.1.3: fixed a build break introduced by `archmind-analysis`'s new `tree-sitter-java` dependency — esbuild had no loader configured for the native `.node` prebuild binaries pulled in transitively via the bundled `archmind-analysis` → `archmind-springboot-parser` chain. `tree-sitter-java` is now external (matching the same fix already applied to `archmind-analysis`'s own build) and declared as a runtime dependency.
- `@kidkender/archmind` CLI 0.7.2: rebuilt and republished — no source change, ships the `archmind-laravel-parser`/`archmind-nestjs-parser` fixes above, already present in its bundle since they predate this release's build.

## [0.7.1] - 2026-07-18

### Added
- Spring Boot (`@kidkender/archmind-springboot-parser` 0.4.0): unrecognized-but-auth-shaped annotations (SpringBlade's `@PreAuth`, Apache Shiro's `@RequiresRoles`/`@RequiresPermissions`/`@RequiresUser`/`@RequiresAuthentication`, and other common custom-framework security annotations) are now emitted as `ir:unknown_middleware` instead of being silently dropped — surfaces "there IS a security check here, but its exact shape is unknown" instead of the LLM reading absence-of-a-known-node as no-auth.
- `@kidkender/archmind-explainer` 0.3.1: `buildEvidencePackage()` now surfaces `ir:unknown_middleware` as a fact (`unknown_security`, HIGH relevance for the `auth` intent). This node type already existed in the protocol (used by Laravel's middleware-mapper for unresolved middleware) but was never read by fact extraction — evidence packages silently swallowed every "honest don't know" signal before this fix, for both Laravel and Spring Boot.

### Fixed
- Spring Boot (`@kidkender/archmind-springboot-parser` 0.4.0): multi-module Maven scanner (`findJavaFiles`) now recurses to arbitrary depth instead of one level below the root — real multi-module repos nest modules deeper (e.g. `blade-service/blade-demo/src/main/java`). Confirmed on `chillzhuang/SpringBlade`: route extraction went from 9 to 182 routes (15 of 18 `src/main/java` trees were previously unscanned).
- Spring Boot: controller classes using a custom stereotype instead of `@RestController`/`@Controller` (e.g. Spring Boot Admin's `@AdminController`, a plain marker annotation wired through a project-specific `HandlerMapping`) are now detected via method-level HTTP mapping annotations (`@GetMapping`/`@PostMapping`/etc.), which are a reliable signal on their own. Confirmed on `codecentric/spring-boot-admin`: 0 → 21 routes.
- Spring Boot: `SecurityFilterChain` rule matching, `@Transactional` service-layer resolution, and inherited base-class URL-prefix resolution are now all scoped per Maven module (keyed by module root + simple name, not bare simple name). Fixes real cross-module leakage found via QA benchmarking: a demo/sample module's `SecurityFilterChain` was incorrectly gating controllers in an unrelated library module purely because both lived under the same multi-module repo root; the same unscoped-lookup pattern existed for `@Transactional` resolution and base-class path inheritance (confirmed via duplicate simple class names — e.g. two unrelated `NoticeServiceImpl` classes — in `SpringBlade`).
- Spring Boot: `isSpringBootProject()` now follows the build manifest's own declared `<modules>` (Maven, recursively through nested aggregator POMs) / Gradle `include(...)` when the root `pom.xml`/`build.gradle` doesn't mention Spring at all, instead of only trusting the root file. Does not walk the filesystem generically — only manifest-declared module paths are checked, so an unrelated nested Java tool using Spring incidentally cannot misclassify a non-Spring-Boot repo.
- `@kidkender/archmind` CLI: rebuilt and republished to ship the `archmind-springboot-parser` 0.4.0 and `archmind-explainer` 0.3.1 fixes above (both are bundled into the CLI's single build artifact).

## [0.7.0] - 2026-07-08

### Added
- **IR v1.5 — Semantic Fidelity** (`@kidkender/archmind-protocol` 0.5.0, `@kidkender/archmind-laravel-parser` 0.5.0): closes the gaps identified in `research/semantic-ir/v1.5-semantic-fidelity-plan.md`, all regression-checked against real koel/BookStack/InvoiceNinja/Monica/Akaunting source, not just unit fixtures:
  - Middleware group wrapping resolved to concrete FQCNs from `RouteServiceProvider.php`/`Kernel.php`, instead of falling back to bare group names.
  - Mutation chains folded into service-call nodes, exposed via a new `ExecutionNode.mutates` flag.
  - Transaction containment made explicit via a new `ir:wraps` edge relation — a mutating call with no `ir:wraps` edge now renders as a positive, visible "NOT wrapped in a transaction" statement instead of something the LLM has to infer.
  - Guard clauses (`if (...) throw/abort`) and the calls they protect are classified as `ir:guard_clause`.
  - Audit/activity-log sinks (`Activity::add`, `activity()->log`, configurable via `conventions.auditSinks`) classified as `ir:audit_log` instead of a generic service call.
  - Control-flow forks driven by request parameters are emitted as `ir:conditional_branch` nodes, carrying the driving param name in `node.detail`.
  - Relative sub-namespace controller resolution and RouteServiceProvider-level `->namespace($this->namespace)` wrapping — fixes Akaunting's `Route::resource('invoices', 'Sales\Invoices', ...)` pattern, previously mis-resolved as an already-complete FQCN. Also broadens RouteServiceProvider discovery to custom-named providers (e.g. `app/Providers/Route.php`).
- Laravel: standalone Bus/Action dispatch detection — `Bus::dispatch()`, `ClassName::dispatch()/dispatchSync()/dispatchNow()`, and the `laravel-actions` `Action::run()` pattern are now recognized as job/event dispatches, not just constructor-injected service calls.
- Laravel: method-scoped parsing applied consistently across isolation/transaction/audit-log parsing, fixing a file-wide contamination bug where one method's writes/queries leaked into a sibling method's graph.
- New `queue-job-parser.ts` and `schedule-parser.ts` — queued job dispatch and console `Schedule::command()`/`Schedule::call()` extraction as first-class entrypoints.
- `serialize-graph` (`@kidkender/archmind-prompt-builder` 0.2.0): renders `[MUTATES]`, `node.detail`, and a new "Unwrapped mutations" summary section reflecting the new IR v1.5 node/edge types.

### Fixed
- All three bugs found via blind-testing archMind against real repos outside the benchmark suite (InvoiceNinja, Monica, Akaunting): method-scoped isolation analysis no longer leaks a sibling method's writes/queries into the current method's graph; CQRS-style static dispatch (`ClassName::dispatchSync()`) is now detected; and relative sub-namespace controller strings resolve against the enclosing namespace instead of being treated as already-complete FQCNs.

## [0.6.0] - 2026-07-04

### Added
- **`archmind verify --constraints <path.yml>`** — run custom Architecture Constraints (AQL rules) in CI, not just the built-in topology invariants. Missing file/package is a hard error (exit 2) when the flag is explicitly passed, vs. silent skip when unset and no default `.archmind/constraints.yml` exists.
- Test suite for `@kidkender/archmind-constraints` (`loadConstraints`, `checkConstraints`) — first coverage for this package.
- `docs/architecture-constraints.md` — predicate reference and example rule sets (RBAC coverage, transaction-escape, tenant isolation).
- **Non-HTTP entrypoints**: Spring Boot now detects `@KafkaListener`/`@RabbitListener`/`@JmsListener` (as `type: "queue"`) and `@Scheduled` jobs (as `type: "cron"`) as first-class entrypoints, not just `@RestController` routes. Detection runs on `@Service`/`@Component` classes too, not only classes annotated `@Controller`. New `EntrypointDetector` abstraction (`@kidkender/archmind-springboot-parser` 0.3.0) makes adding further kinds additive.
- NestJS: `@Cron` (`@nestjs/schedule`) jobs are now detected as `cron` entrypoints on `@Injectable()` services, not just HTTP routes (`@kidkender/archmind-nestjs-parser` 0.7.0).
- `EntrypointDescriptor.trigger` (`@kidkender/archmind-protocol` 0.4.0) — a normalized, human-readable "what causes this" string with the same meaning across every adapter for a given entrypoint `type` (HTTP: `"METHOD /path"`, queue: destination name, cron: raw schedule expression). Fixes an inconsistency where Spring Boot and NestJS used different metadata key names for the same `type: "cron"` shape.
- Cross-framework conformance test proving Spring `@Scheduled + @Transactional` and NestJS `@Cron` + `dataSource.transaction(...)` produce equivalent IR shape (`cron` entrypoint + `txn_boundary` + `txn_write`).

### Fixed
- Spring Boot: role/permission checks (`hasRole`, `hasAnyRole`, `hasAuthority`, `@Secured`, `@RolesAllowed`, role-based `@PreAuthorize`) now emit BOTH an `auth_gate` and `authz_check` node instead of only `authz_check`. A role check inherently requires authentication first — the previous behavior made `no-auth`/`public` AQL predicates false-positive on every role-protected route. Found by running ArchMind against a real 15-module, 1128-file production Spring Boot monorepo, where it affected 391/400 (98%) of parsed routes. First test coverage added for `@kidkender/archmind-springboot-parser`.
- Spring Boot: transaction boundary detection now resolves `@Transactional` through the service layer, not just the controller. New `service-transaction-index.ts` bridges the interface/impl split (`@Transactional` on `FooServiceImpl`, injected as `FooService`) so a service call from a controller correctly emits `ir:txn_boundary`. Previously 0/400 routes in the same real monorepo showed a transaction boundary despite 108 service files using `@Transactional` — after the fix, 373/400 (93%) do.
- CLI: `archmind verify`/`trace`/etc. no longer report `"Parsed N routes from 0 file(s)"` for Spring Boot and NestJS projects — `fileCount` was hardcoded to 0 for both frameworks; it now reflects the real controller file count.

### Changed
- **Known limitation**: NestJS global guards (`APP_GUARD`) are currently applied uniformly to `cron` entrypoints. The real NestJS runtime only evaluates guards inside HTTP/RPC execution contexts, so this doesn't reflect actual runtime behavior for scheduled jobs. Does not affect graph generation; may affect auth analysis accuracy for cron routes specifically.

## [0.5.0] - 2026-07-01

### Added
- **Spring Boot parser** (`@kidkender/archmind-springboot-parser` 0.2.0) — SecurityFilterChain path-based auth parsing, base-class `@RequestMapping` inheritance resolution, multi-module Maven project support
- **`archmind visualize`** — Execution Timeline HTML report, shows layer-by-layer flow (Auth → Validation → Handler → Transaction → Services → Side Effects) for every route
- **`archmind_get_context` MCP tool** (`@kidkender/archmind-mcp` 0.5.0) — returns a compact semantic context object (security posture, transaction state, risk level) instead of raw graph nodes
- **AQL** (`@kidkender/archmind-aql` 0.2.0) — Architecture Query Language for querying execution graphs
- **Architecture Constraints** (`@kidkender/archmind-constraints` 0.2.0) — define and enforce structural rules on execution graphs
- **AI Context API** (`@kidkender/archmind-context` 0.2.0) — `buildSemanticContext()` for LLM-ready route summaries
- **GraphQuery extensions** (`@kidkender/archmind-graph-query` 0.2.0) — `toNodes()`, `fromNodes()`, `byId()`, `byIds()`, `toMap()` on EdgeQuery/NodeQuery
- **CI/CD release workflow** — GitHub Actions auto-publishes changed packages on tag push with topological ordering and npm provenance

### Fixed
- `findings --json` stdout truncation on large projects — replaced `process.exit()` with `process.exitCode` so stdout flushes before process terminates
- Spring Boot: `superclass` field in tree-sitter Java grammar includes "extends " prefix — stripped before base class lookup

### Changed
- Detectors fully migrated to GraphQuery API — no more direct `graph.nodes.find/filter` access in any detector
- `@kidkender/archmind-explainer` 0.3.0 — `event-before-commit`, `missing-tenant-scope`, `resource-mismatch`, `privilege-hierarchy`, `circular-dependency`, `double-permission-check` detectors now use fluent GraphQuery API

## [0.4.0] - 2026-06-15

### Added
- NestJS incremental parsing — cached ts-morph Project + module file staleness tracking
- Laravel incremental parsing
- IR v2 stable — `validateGraph()` + parser conformance tests
- Behavior diff — semantic change descriptions

### Changed
- `@kidkender/archmind-protocol` 0.3.0 — stable IR v2 schema
- `@kidkender/archmind-explainer` 0.2.0
- `@kidkender/archmind` CLI 0.4.0
