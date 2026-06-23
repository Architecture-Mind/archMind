# @kidkender/archmind-protocol

Shared type vocabulary for the [ArchMind](https://github.com/Architecture-Mind/ArchMind) ecosystem.

Every package in the ArchMind system — parsers, enrichers, testers, reporters — speaks the same language by importing from here. No duplicate type definitions, no cross-package drift.

---

## Installation

```bash
npm install @kidkender/archmind-protocol
```

Zero runtime code. Zero dependencies. Types only.

---

## What's inside

### IR Graph types

The execution graph model — one graph per HTTP entrypoint.

```typescript
import type {
  ExecutionNode,
  ExecutionEdge,
  IntermediateExecutionGraph,
} from "@kidkender/archmind-protocol"
```

| Type | Description |
|------|-------------|
| `ExecutionNode` | A single node: auth gate, validation gate, service call, DB query, etc. |
| `ExecutionEdge` | Directed relationship between two nodes |
| `IntermediateExecutionGraph` | Full graph for one HTTP route (nodes + edges + annotations) |
| `GraphAnnotation` | Security/quality finding attached to the graph |

### Validation contract types

Field-level validation rules — framework-agnostic. Used by both NestJS (class-validator) and Laravel (FormRequest) parsers to describe DTO/request fields.

```typescript
import type {
  DTOSchema,
  FieldSchema,
  FieldType,
  ValidationRule,
  RuleKind,
} from "@kidkender/archmind-protocol"
```

| Type | Description |
|------|-------------|
| `DTOSchema` | A validated class with its file path and field list |
| `FieldSchema` | One field: name, inferred type, list of validation rules |
| `ValidationRule` | One rule: `{ kind: "email" }` or `{ kind: "min", value: 18 }` |
| `FieldType` | `"string" \| "number" \| "boolean" \| "object" \| "array" \| "unknown"` |
| `RuleKind` | Full union of supported rule kinds (`"required"`, `"email"`, `"min"`, `"isIn"`, ...) |

### IR constants

```typescript
import { IR_NODE_TYPES, IR_EDGE_RELATIONS } from "@kidkender/archmind-protocol"

IR_NODE_TYPES.AUTH_GATE        // "ir:auth_gate"
IR_NODE_TYPES.VALIDATION_GATE  // "ir:validation_gate"
```

### Runtime correlation types

Types for OpenTelemetry-based runtime intelligence.

```typescript
import type {
  OtelSpan,
  TraceSession,
  CorrelatedSession,
} from "@kidkender/archmind-protocol"
```

---

## Supported RuleKinds

| Kind | Source | Description |
|------|--------|-------------|
| `required` | `@IsNotEmpty`, `required` | Field must be present and non-empty |
| `optional` | `@IsOptional`, `nullable`, `sometimes` | Field may be absent |
| `email` | `@IsEmail`, `email` | Must be valid email format |
| `url` | `@IsUrl`, `url` | Must be valid URL |
| `uuid` | `@IsUUID`, `uuid` | Must be valid UUID |
| `min` / `max` | `@Min`, `@Max`, `min:N`, `max:N` (numeric) | Numeric bounds |
| `minLength` / `maxLength` | `@MinLength`, `@MaxLength`, `min:N`/`max:N` (string) | String length bounds |
| `integer` | `@IsInt`, `integer` | Must be integer |
| `positive` / `negative` | `@IsPositive`, `@IsNegative` | Sign constraint |
| `boolean` | `@IsBoolean`, `boolean` | Must be boolean |
| `array` | `@IsArray`, `array` | Must be array |
| `arrayMinSize` / `arrayMaxSize` | `@ArrayMinSize`, `@ArrayMaxSize` | Array length bounds |
| `enum` | `@IsEnum(MyEnum)` | Must match enum values |
| `isIn` | `@IsIn([...])`, `in:a,b,c` | Must be one of allowed values |
| `regex` | `@Matches(/pattern/)`, `regex:/pattern/` | Must match regex |
| `date` | `@IsDate`, `@IsDateString`, `date` | Must be a date |
| `phone` | `@IsPhoneNumber` | Must be a valid phone number |
| `ethereumAddress` | `@IsEthereumAddress` | Must be a valid Ethereum address |
| `alphanumeric` | `@IsAlphanumeric`, `alpha_num` | Letters and digits only |
| `numberString` | `@IsNumberString` | Digits-only string |

---

## Used by

- [`@kidkender/archmind-nestjs-parser`](https://www.npmjs.com/package/@kidkender/archmind-nestjs-parser) — NestJS route + DTO parser
- [`@kidkender/archmind-laravel-parser`](https://www.npmjs.com/package/@kidkender/archmind-laravel-parser) — Laravel route + FormRequest parser
- [`@kidkender/archtest`](https://www.npmjs.com/package/@kidkender/archtest) — API contract testing CLI

---

## License

MIT
