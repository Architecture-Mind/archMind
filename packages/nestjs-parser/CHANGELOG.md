# Changelog

## [0.6.0] — 2026-06-26

### Added

- **`ir:api_resource` detection** — NestJS response serialization is now captured as an IR node. Two detection signals:
  - Explicit `plainToInstance(ClassName, ...)` / `plainToClass(ClassName, ...)` call in the method body
  - Return type annotation ending in `Dto | Resource | Response | Payload | Output | View` (e.g. `Promise<InvoiceResponseDto>`)
- **`@Expose` / `@Exclude` field scanning** — when the response DTO class is found in the project, its `@Expose()`-decorated properties are extracted into `detail.fields`; class-level `@Exclude()` sets `detail.excludedByDefault: true`
- **Sensitive field detection** — fields matching `secret|token|password|api?key|...` are flagged in `detail.sensitiveFields`
- **`responds_with` edge** — business_handler → api_resource edge added with `traceability: "static"`
- **Cross-framework Pattern 6** — equivalence test: auth + side-effects (`ir:queue_job` + `ir:event_dispatch`) same IR in Laravel and NestJS
- **Cross-framework Pattern 7** — equivalence test: auth + api_resource (`JsonResource::toArray` ≡ `plainToInstance(DTO)`) same IR in Laravel and NestJS

---

## [0.5.0] — 2026-06-11

### Added

- NestJS transaction detection — `ir:txn_boundary` + `ir:txn_write` (DataSource.transaction, QueryRunner)
- Cross-framework Pattern 5 — auth + transaction equivalence test
