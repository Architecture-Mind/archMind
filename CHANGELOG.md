# Changelog

## [Unreleased]

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
