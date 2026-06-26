# Changelog

## [0.4.1] — 2026-06-26

### Fixed

- **Aliased `use` imports now resolve correctly** — `use Foo\Bar as Baz` was storing key `Bar` instead of `Baz` in the useMap, causing namespace collisions when two controllers shared the same short class name (e.g. Crater's `InvoicesController` for Admin vs Customer). Fixed by reading `as` keyword and alias name as direct children of `namespace_use_clause` (not a wrapping `alias_clause` node that tree-sitter-php does not emit).

---

## [0.4.0] — 2026-06-11

### Added

- **NestJS parser parity** — service_call, txn_boundary, txn_write, DTOSchema, isPublic flag
- **Line numbers on ExecutionNode** — `line` field populated for all nodes
- **`ir:business_handler` node** — emitted for every controller method
- Incremental indexing — parse-op memoization for augmentation passes
