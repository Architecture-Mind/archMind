# Changelog

All notable changes to `@kidkender/archmind` will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.3.0] — 2026-06-23

### Added
- **NestJS support** — auto-detects NestJS projects via `package.json` or `nest-cli.json`; `archmind trace` now works on both Laravel and NestJS codebases
- **`--json` flag** on `trace` and `findings` commands — machine-readable output for CI pipelines and tooling integration (used by `@kidkender/archtest`)
- **Framework label** shown in `trace` output (Laravel / NestJS)
- **`ir:queue_job`** node type — standalone async job dispatches extracted from controllers and services
- **`ir:event_dispatch`** node type — event dispatches outside transaction blocks
- **`ir:notification`** and **`ir:mail`** node types — notification and mailable side-effect nodes
- **`ir:api_resource`** node type — Laravel JsonResource returns with field-level extraction from `toArray()`

### Fixed
- **Invokable controllers** (`Route::get('/path', Controller::class)`) were silently skipped — now parsed correctly with `action = __invoke`
- **Non-App PSR-4 namespaces** (e.g. `Crater\\`, `Domain\\`) produced wrong controller file paths — file resolution now uses composer.json autoload map instead of hardcoded `App\\` prefix

---

## [0.2.1] — 2025-12-01

### Fixed
- Windows: `.cjs` bin file now wrapped with `node` when invoked via `ARCHMIND_BIN`

---

## [0.2.0] — 2025-11-15

### Added
- `archmind verify` command — snapshot-based topology regression check
- `archmind deps` — cross-route impact analysis for service class changes
- `archmind baseline` — save/compare baseline snapshots
- Isolation detector: unscoped queries, missing tenant constraints
- Transaction detector: side effects that escape `DB::transaction()`

---

## [0.1.0] — 2025-10-01

### Added
- Initial release: `archmind trace` and `archmind findings`
- Laravel route parser (tree-sitter PHP AST)
- Auth gate, policy, FormRequest node types
- Constructor middleware injection
- Permission constant resolution
