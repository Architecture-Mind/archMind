# Changelog

## [Unreleased]

### Added
- **`archmind verify --constraints <path.yml>`** — run custom Architecture Constraints (AQL rules) in CI, not just the built-in topology invariants. Missing file/package is a hard error (exit 2) when the flag is explicitly passed, vs. silent skip when unset and no default `.archmind/constraints.yml` exists.
- Test suite for `@kidkender/archmind-constraints` (`loadConstraints`, `checkConstraints`) — first coverage for this package.
- `docs/architecture-constraints.md` — predicate reference and example rule sets (RBAC coverage, transaction-escape, tenant isolation).

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
