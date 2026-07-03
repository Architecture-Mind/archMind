# @kidkender/archmind-springboot-parser

Static analysis parser for Spring Boot projects. Extracts REST controllers, security rules, `@Transactional` boundaries, and service call graphs into [ArchMind IR](https://github.com/Architecture-Mind/archMind).

Part of the [ArchMind](https://github.com/Architecture-Mind/archMind) monorepo.

---

## Installation

```bash
npm install @kidkender/archmind-springboot-parser
```

Requires `tree-sitter` and `tree-sitter-java` as peer dependencies (native addons — must be compiled on the target machine):

```bash
npm install tree-sitter tree-sitter-java
```

---

## Usage

### Parse an entire project

```ts
import { parseSpringBootProject, isSpringBootProject } from "@kidkender/archmind-springboot-parser"

const root = "/path/to/my-spring-app"

if (isSpringBootProject(root)) {
  const graphs = parseSpringBootProject(root)
  // graphs: IntermediateExecutionGraph[]
  // one graph per REST endpoint found
  console.log(`Found ${graphs.length} routes`)
}
```

### Via the adapter interface

```ts
import { SpringBootAdapter } from "@kidkender/archmind-springboot-parser"

const adapter = new SpringBootAdapter()
const graphs = adapter.parseProject("/path/to/project")
```

### Parse a single controller file

```ts
import { parseControllerFile } from "@kidkender/archmind-springboot-parser"

const methods = parseControllerFile("/path/to/OrderController.java")
// methods: SpringControllerMethod[]
```

---

## What it detects

### Controller methods
- `@RestController` / `@Controller` classes
- `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping`, `@RequestMapping`
- Full route path — class-level prefix (`@RequestMapping`) combined with method-level path, **including inherited prefixes from abstract base classes**

### Security
- **Per-method annotations:** `@PreAuthorize`, `@Secured`, `@RolesAllowed`
- **Global `SecurityFilterChain` rules:** parses `requestMatchers().hasRole()` / `hasAnyRole()` / `permitAll()` / `denyAll()` chains and applies them to matching routes automatically

### Validation
- `@Valid` / `@Validated` on method parameters → `ir:validation_gate` node

### Transactions
- `@Transactional` on method or class (including `readOnly=true`)
- Events dispatched inside `@Transactional` → `escapes_transaction` edge

### Service & data access calls
- Injected service fields → `ir:service_call` nodes
- Repository calls (`save`, `findById`, `delete`, ...) → `ir:txn_write` or `ir:scoped_query` nodes

### Side effects
- `ApplicationEventPublisher.publishEvent()` → `ir:event_dispatch` node
- `JavaMailSender.send()` → `ir:mail` node
- `RabbitTemplate` / `KafkaTemplate` / `JmsTemplate` → `ir:queue_job` node

---

## Multi-module Maven projects

The parser automatically walks each sub-module's `src/main/java` directory:

```
my-app/
├── user/src/main/java/...
├── order/src/main/java/...
└── payment/src/main/java/...
```

All modules are scanned in a single `parseSpringBootProject()` call.

---

## Output format

Each endpoint produces one `IntermediateExecutionGraph` (ArchMind IR):

```ts
{
  entrypoint: "POST /api/public/v1/orders",
  method:     "POST",
  path:       "/api/public/v1/orders",
  framework:  "springboot",
  nodes: [
    { id: "...", type: "ir:authz_check",      symbol: "hasRole(USER)" },
    { id: "...", type: "ir:validation_gate",  symbol: "CreateOrderRequest" },
    { id: "...", type: "ir:business_handler", symbol: "OrderController::createOrder" },
    { id: "...", type: "ir:service_call",     symbol: "OrderService::createOrder" },
    { id: "...", type: "ir:txn_boundary",     symbol: "@Transactional" },
  ],
  edges: [
    { from: "...", to: "...", relation: "ir:guards",    traceability: "static" },
    { from: "...", to: "...", relation: "ir:validates", traceability: "static" },
    { from: "...", to: "...", relation: "calls",        traceability: "static" },
  ],
  annotations: []
}
```

---

## API Reference

### `isSpringBootProject(root: string): boolean`
Returns `true` if the directory contains a `pom.xml` or `build.gradle` with Spring Boot markers.

### `parseSpringBootProject(root: string): IntermediateExecutionGraph[]`
Main entry point. Scans all Java files, builds a base-class index and security rule set, then parses every controller and emits one graph per endpoint.

### `SpringBootAdapter`
Implements the `SemanticAdapter` interface from `@kidkender/archmind-protocol`. Use this when integrating with the ArchMind plugin system.

### `parseControllerFile(filePath: string, baseClassIndex?: Map<string, string>): SpringControllerMethod[]`
Low-level parser for a single `.java` file. Returns raw `SpringControllerMethod` objects before IR emission.

### `emitGraph(method: SpringControllerMethod): IntermediateExecutionGraph`
Converts a `SpringControllerMethod` to an IR graph. Useful if you want to post-process the parsed data before emitting.

---

## Limitations

- Reads **controller layer only** — does not trace into service or repository implementations
- `@Transactional` on service classes is not detected (only on controllers)
- Security rules from constants/arrays (e.g. `requestMatchers(WHITELIST_ARRAY)`) are not resolved statically
- Kotlin Spring Boot projects are not supported (Java only)
