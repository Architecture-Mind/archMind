# @kidkender/archmind-laravel-parser

Static analysis parser for Laravel projects — part of the [ArchMind](https://github.com/Architecture-Mind/ArchMind) ecosystem.

Reads your Laravel PHP source code and produces two things:
1. **IR execution graphs** — one per HTTP route, capturing middleware chains, auth checks, service calls, and transaction patterns
2. **FormRequest schemas** — field-level validation rules extracted from `FormRequest::rules()` methods

Uses [tree-sitter-php](https://github.com/tree-sitter/tree-sitter-php) for accurate PHP AST parsing. No PHP runtime required.

---

## Installation

```bash
npm install @kidkender/archmind-laravel-parser
```

---

## Usage

### Parse FormRequest validation rules

```typescript
import { parseFormRequests } from "@kidkender/archmind-laravel-parser"
import type { DTOSchema } from "@kidkender/archmind-protocol"

const { schemas, index } = parseFormRequests("/path/to/laravel-project")

// index.get("CreateUserRequest")
// → {
//     className: "CreateUserRequest",
//     file: "app/Http/Requests/CreateUserRequest.php",
//     fields: [
//       { name: "email", type: "string", rules: [{ kind: "required" }, { kind: "email" }] },
//       { name: "age",   type: "number", rules: [{ kind: "required" }, { kind: "integer" }, { kind: "min", value: 18 }] },
//       { name: "role",  type: "string", rules: [{ kind: "required" }, { kind: "isIn", value: ["admin", "user"] }] },
//     ]
//   }
```

### Parse a single FormRequest file

```typescript
import { parseFormRequestFile } from "@kidkender/archmind-laravel-parser"

const content = readFileSync("app/Http/Requests/CreateUserRequest.php", "utf-8")
const schemas = parseFormRequestFile(content, "app/Http/Requests/CreateUserRequest.php")
```

### Parse routes → IR graphs (advanced)

```typescript
import { parseRouteFile, augmentGraph, parseKernel } from "@kidkender/archmind-laravel-parser"

// Low-level: parse a single route file
const skeletonGraphs = parseRouteFile("/path/to/project/routes/api.php", { projectRoot })

// Enrich with middleware, policies, services, transactions
const aliasMap = parseKernel("/path/to/project/app/Http/Kernel.php")
const graphs   = await augmentGraph(skeletonGraphs, { projectRoot, aliasMap })
```

---

## FormRequest rule mapping

Supports both pipe syntax and array syntax:

```php
// Pipe syntax
'email' => 'required|email|max:255'

// Array syntax
'email' => ['required', 'email', 'max:255']
```

| Laravel rule | Rule emitted | Notes |
|-------------|-------------|-------|
| `required` | `required` | |
| `nullable` / `sometimes` | `optional` | |
| `string` | *(infers type)* | Sets field type to `string` |
| `integer` / `numeric` | `integer` / *(infers type)* | Sets field type to `number` |
| `boolean` | `boolean` | |
| `array` | `array` | |
| `email` | `email` | |
| `url` | `url` | |
| `uuid` | `uuid` | |
| `date` | `date` | |
| `alpha_num` | `alphanumeric` | |
| `min:N` | `minLength` (string) or `min` (numeric) | Depends on field type |
| `max:N` | `maxLength` (string) or `max` (numeric) | Depends on field type |
| `between:min,max` | `minLength`+`maxLength` or `min`+`max` | |
| `in:a,b,c` | `isIn` with values array | |
| `regex:/pattern/` | `regex` | |

---

## What route parsing extracts

| What | How detected |
|------|-------------|
| HTTP method + path | `Route::get`, `Route::post`, `Route::apiResource`, etc. |
| Middleware groups | `->middleware(['auth', 'throttle:60,1'])` |
| Middleware aliases | Resolved from `Kernel.php` `$middlewareAliases` |
| Controller actions | FQCN resolution via `composer.json` PSR-4 autoload map |
| Invokable controllers | `Route::post('/path', MyController::class)` |
| FormRequest classes | `@Body` param type annotation in controller |
| Policy checks | `$this->authorize('update', $model)` calls |
| Transaction boundaries | `DB::transaction(function() { ... })` |
| Tenant scope | Detects queries with and without `forTenant()` / `where('tenant_id')` |

---

## Output types

All output types are from [`@kidkender/archmind-protocol`](https://www.npmjs.com/package/@kidkender/archmind-protocol):

```typescript
import type {
  IntermediateExecutionGraph,
  ExecutionNode,
  DTOSchema,
  FieldSchema,
  ValidationRule,
} from "@kidkender/archmind-protocol"
```

---

## Requirements

- Node.js 18+
- Laravel project with `FormRequest` classes (for validation extraction)

---

## License

MIT
