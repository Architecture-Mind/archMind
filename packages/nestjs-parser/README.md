# @kidkender/archmind-nestjs-parser

Static analysis parser for NestJS projects — part of the [ArchMind](https://github.com/Architecture-Mind/ArchMind) ecosystem.

Reads your NestJS source code and produces two things:
1. **IR execution graphs** — one per HTTP route, capturing auth guards, validation gates, and side effects
2. **DTO schemas** — field-level class-validator rules for every decorated DTO class

No server required. No runtime. Pure static analysis.

---

## Installation

```bash
npm install @kidkender/archmind-nestjs-parser
```

---

## Usage

### Parse routes → IR graphs

```typescript
import { parseNestJSProject } from "@kidkender/archmind-nestjs-parser"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const graphs: IntermediateExecutionGraph[] = parseNestJSProject("/path/to/nestjs-project")

// graphs[0].entrypoint  → "POST /users"
// graphs[0].method      → "POST"
// graphs[0].path        → "/users"
// graphs[0].nodes       → ExecutionNode[] (auth gates, validation gates, ...)
// graphs[0].edges       → ExecutionEdge[]
```

### Parse DTOs → field-level validation rules

```typescript
import { parseDTOSchemas } from "@kidkender/archmind-nestjs-parser"
import type { DTOSchema } from "@kidkender/archmind-protocol"

const { schemas, index } = parseDTOSchemas("/path/to/nestjs-project")

// index.get("CreateUserDto")
// → {
//     className: "CreateUserDto",
//     file: "src/users/dto/create-user.dto.ts",
//     fields: [
//       { name: "email", type: "string", rules: [{ kind: "required" }, { kind: "email" }] },
//       { name: "age",   type: "number", rules: [{ kind: "required" }, { kind: "integer" }, { kind: "min", value: 18 }] },
//     ]
//   }
```

### Parse a single DTO file

```typescript
import { parseDTOFile } from "@kidkender/archmind-nestjs-parser"

const content = readFileSync("create-user.dto.ts", "utf-8")
const schemas = parseDTOFile(content, "src/users/dto/create-user.dto.ts")
```

---

## What gets extracted

### From routes

| What | How detected |
|------|-------------|
| HTTP method + path | `@Get`, `@Post`, `@Put`, `@Patch`, `@Delete` decorators |
| Auth guards | `@UseGuards(JwtAuthGuard)` on controller or method |
| Global guards | `APP_GUARD` provider in app module |
| Public routes | `@Public()` decorator (skips global guard) |
| DTO class name | `@Body() body: CreateUserDto` parameter type |
| Validation pipe | `@UsePipes(ValidationPipe)` |

### From DTOs

Supports all common class-validator decorators:

| Decorator | Rule emitted |
|-----------|-------------|
| `@IsNotEmpty()`, `@IsDefined()` | `required` |
| `@IsOptional()` | `optional` |
| `@IsEmail()` | `email` |
| `@IsUrl()` | `url` |
| `@IsUUID()` | `uuid` |
| `@IsInt()` | `integer` |
| `@IsBoolean()` | `boolean` |
| `@IsPositive()` / `@IsNegative()` | `positive` / `negative` |
| `@Min(N)` / `@Max(N)` | `min` / `max` |
| `@MinLength(N)` / `@MaxLength(N)` | `minLength` / `maxLength` |
| `@Length(min, max)` | `minLength` + `maxLength` |
| `@IsIn(['a', 'b'])` | `isIn` with values |
| `@IsEnum(MyEnum)` | `enum` with class name |
| `@Matches(/regex/)` | `regex` |
| `@IsPhoneNumber()` | `phone` |
| `@IsEthereumAddress()` | `ethereumAddress` |
| `@IsDate()` / `@IsDateString()` | `date` |
| `@IsAlphanumeric()` | `alphanumeric` |
| `@IsNumberString()` | `numberString` |

Multi-line decorators and `!` (definite assignment) fields are handled correctly.

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
- TypeScript project using NestJS with class-validator decorators

---

## License

MIT
