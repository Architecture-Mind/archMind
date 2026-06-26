# @kidkender/archmind-lsp

Language Server for [ArchMind](https://github.com/kidkender/archmind) — provides **inlay hints** and **hover analysis** for Laravel and NestJS route handlers in any LSP-compatible editor.

## What it shows

For every route handler, the LSP annotates:

- 🔒 Authentication guards (`AuthGuard`, `JwtGuard`, …)
- 🌐 Public routes (no auth required)
- ⚠️ Missing authorization
- ✅ Validation / DTO class
- ⚙️ Injected services called
- ⟲ Transaction boundary
- ⛔ Security findings (`missing_authorization`, `exposed_read_endpoint`, …)

Hover over the annotated line to see full security analysis with finding explanations.

## Installation

```bash
npm install -g @kidkender/archmind-lsp
```

Verify:

```bash
archmind-lsp --version
```

## Editor setup

### Zed

Install the [ArchMind Zed extension](https://github.com/kidkender/archmind-ide) — it auto-discovers `archmind-lsp` from PATH.

Enable inlay hints in Zed settings (`~/.config/zed/settings.json`):

```json
{
  "inlay_hints": {
    "enabled": true,
    "show_background": true
  }
}
```

### VS Code

Use the [ArchMind VS Code extension](https://marketplace.visualstudio.com/items?itemName=kidkender.archmind).

### Other editors (Neovim, Helix, …)

Point your LSP client at `archmind-lsp --stdio`. The server speaks standard LSP over stdin/stdout and supports:

- `textDocument/inlayHint`
- `textDocument/hover`

## Supported frameworks

| Framework | Detection |
|-----------|-----------|
| Laravel   | `artisan` / `composer.json` in project root |
| NestJS    | `nest-cli.json` in project root |

## Requirements

- Node.js ≥ 18
- Project must be a Laravel or NestJS project (auto-detected)

## Related packages

| Package | Description |
|---------|-------------|
| [`@kidkender/archmind-mcp`](https://www.npmjs.com/package/@kidkender/archmind-mcp) | MCP server for AI assistants (Claude, Cursor, …) |
| [`@kidkender/archmind-laravel-parser`](https://www.npmjs.com/package/@kidkender/archmind-laravel-parser) | Laravel PHP → execution graph parser |
| [`@kidkender/archmind-nestjs-parser`](https://www.npmjs.com/package/@kidkender/archmind-nestjs-parser) | NestJS TypeScript → execution graph parser |

## License

MIT
