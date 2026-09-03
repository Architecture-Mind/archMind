# ArchMind — Next Version Ideas

> Generated: 2026-06-30
> Updated: 2026-07-03 — after v0.5.0 shipped (Spring Boot parser, AQL, Architecture Constraints, AI Context API, `archmind visualize`)

---

## Shipped since last update (no longer ideas)

- ✅ **Framework #3: Spring Boot** — `@kidkender/archmind-springboot-parser`, SecurityFilterChain parsing, base-class `@RequestMapping` inheritance
- ✅ **AQL** (`@kidkender/archmind-aql`) — Architecture Query Language for querying execution graphs
- ✅ **Architecture Constraints** (`@kidkender/archmind-constraints`) — define/enforce structural rules
- ✅ **AI Context API** (`@kidkender/archmind-context`) — `buildSemanticContext()`, exposed via `archmind_get_context` MCP tool
- ✅ **`archmind visualize`** — Execution Timeline HTML report

These shipped features open up new follow-on ideas below (#5, #7) that weren't possible before.

---

## 1. Graph Diff cho PR Review

**Priority:** High impact, feasible
**Effort:** Medium
**Status:** Not started

Hiện tại CI chỉ fail/pass. Next step là sinh ra **PR comment** mô tả chính xác cái gì thay đổi trong execution graph — không phải diff code mà diff topology.

```
PR #42 — Execution Graph Changes
  POST /orders
    - DB::transaction removed      ⚠ REGRESSION
    + CacheService::store added    ℹ NEW NODE
  GET /orders
    (unchanged)
```

**Deliverables:**
- GitHub Action tự động comment vào PR
- Diff engine so sánh baseline vs current graph
- Severity tagging (REGRESSION / NEW NODE / UNCHANGED)

**Why:** Developer thấy value ngay trong workflow, không cần tự chạy CLI.

---

## 2. Benchmark CLI

**Priority:** High value, low effort (corpus đã có)
**Effort:** Low
**Status:** Not started

`research/semantic-pains` đã có 4 test cases với format đầy đủ, nhưng `duck benchmark run` chưa implement. Đây là low-hanging fruit để tự validate và publish kết quả công khai.

```bash
archmind benchmark run --framework=laravel --category=authorization
archmind benchmark run --id=pain-01
archmind benchmark run --all --output=results/baseline.json
```

**Deliverables:**
- CLI runner đọc các file markdown trong `research/semantic-pains/`
- JSON output với score, token comparison
- CI integration để tự chạy benchmark trên mỗi PR

**Why:** Tăng credibility, dễ viết blog/launch post với số liệu cụ thể. Giờ còn có thêm `archmind_get_context` để benchmark — so sánh answer quality/token cost giữa raw graph vs semantic context object.

---

## 3. Framework thứ 4: Express.js hoặc FastAPI/Django

**Priority:** Medium — mở rộng reach
**Effort:** High (nhưng thấp hơn trước — đã có 3 parser để rút pattern chung)

Đã có Laravel + NestJS + Spring Boot. Với 3 parser, giờ là lúc tách phần chung (route extraction, auth gate detection, transaction boundary detection) thành spec/interface tái sử dụng được trước khi thêm framework thứ 4 — tránh mỗi parser tự implement lại từ đầu.

**Ứng viên:**
- **Express.js** — JS ecosystem thuần, không cần PHP/Java, reach lớn
- **FastAPI/Django** — mở sang Python ecosystem, dependency injection + ORM patterns khác biệt, test được tính tổng quát của adapter interface

**Patterns cần support (Express):**
- `app.get()` / `app.post()` route definitions
- Middleware chain (`app.use()`)
- Router modules (`express.Router()`)
- Auth middleware (passport, express-jwt)
- Transaction boundaries (sequelize, typeorm)

**Why:** Node.js developer base lớn. Nhưng cân nhắc trước: có nên đầu tư vào "parser adapter kit" (interface + test conformance suite) để framework thứ 5, 6 rẻ hơn nhiều so với thêm 1 framework nữa theo kiểu cũ.

---

## 4. Auto-fix Suggestions từ Findings

**Priority:** Medium — tăng từ detector lên assistant
**Effort:** Medium
**Status:** Not started

Hiện tại `archmind findings` chỉ detect vấn đề. Bước tiếp: với mỗi finding, generate code suggestion đặt đúng vào file/dòng.

**Ví dụ:**
```
Finding: missing_authorization on POST /orders

Suggested fix — OrderController.php:24
  + $this->authorize('create', Order::class);
```

**Deliverables:**
- `archmind fix --dry-run` in ra suggested patches
- `archmind fix --apply` tự patch file
- LSP code action tích hợp vào editor

**Why:** Developer không chỉ biết vấn đề mà biết ngay cách fix.

---

## 5. AQL / Constraints trong CI topology guard

**Priority:** High — tận dụng ngay tính năng vừa ship, effort thấp
**Effort:** Low-Medium
**Status:** ✅ Done (2026-07-03) — `archmind verify --constraints <path.yml>`, test suite for `@kidkender/archmind-constraints`, `docs/architecture-constraints.md`

`archmind verify` hiện chỉ check các invariant mặc định (transaction boundary, auth gate, tenant scope). Nhưng Architecture Constraints đã ship — giờ team có thể tự định nghĩa rule riêng (vd: "mọi route dưới `/admin/*` phải có `@PreAuthorize`", "không service nào được gọi trực tiếp DB ngoài repository layer").

**Deliverables:**
- `archmind verify --constraints constraints.aql` — chạy custom rule set trong CI, không chỉ default invariants
- Docs/examples cho constraint file phổ biến (RBAC coverage, layering rules, N+1 prevention)

**Why:** Đây là moat thực sự khác biệt so với static analyzer khác — biến CI check từ "built-in rules" thành "user-defined architecture policy as code". Effort thấp vì AQL + Constraints engine đã có sẵn, chỉ cần wiring vào CLI.

---

## 6. Web UI / Graph Visualizer

**Priority:** Low-medium — tốt cho demo và onboarding
**Effort:** Medium-High
**Status:** Not started (Execution Timeline HTML report đã ship, đây là bước xa hơn — interactive/DAG)

Local web server hiển thị execution graph dạng interactive tree/DAG.

```bash
archmind serve --project . --port 4000
# → opens http://localhost:4000
```

**Features:**
- Interactive tree với collapse/expand node
- Click vào node → jump to source file + line
- Filter theo route, middleware type, finding severity
- Side-by-side diff view (baseline vs current)

**Why:** Hữu ích để demo cho team và onboarding developer mới vào codebase lạ.

---

## 7. OpenTelemetry Runtime Integration (mở rộng runtime-correlator)

**Priority:** Medium — differentiated feature
**Effort:** High
**Status:** Not started

`runtime-correlator` đã có N+1 detection. Mở rộng thêm:

| Detector | Mô tả |
|----------|-------|
| Slow query tracing | Span > threshold → map về graph node |
| Auth bypass at runtime | Request không qua auth span nhưng graph nói có |
| Tenant isolation leak | Query cross-tenant detected qua span attributes |
| Event loop starvation | Async handler không hoàn thành trong SLA |

**Why:** Static + runtime kết hợp là moat thực sự — tool khác chỉ làm được một trong hai.

---

## 8. Modular Laravel support (nwidart/laravel-modules)

**Priority:** Medium — real gap found via cross-repo benchmarking, not yet scoped into any plan
**Effort:** Medium
**Status:** Not started

Benchmarked against akaunting (642 routes) as a fresh, previously-unseen repo — archMind parsed cleanly (no crashes) but stayed almost silent (6/58 auth-gate/unknown-middleware nodes, 0 service_call/guard/txn/branch nodes despite 642 routes). Root cause: akaunting is a modular Laravel app (`nwidart/laravel-modules` or similar) — real controllers live under `modules/*/Http/Controllers/`, not `app/Http/Controllers/` as the parser assumes. This is a distinct architecture gap from the 6 gaps already fixed for IR v1.5 (koel/BookStack-driven), confirmed independently on invoiceninja and monica (both generalized cleanly with zero changes).

**Deliverables:**
- Detect `nwidart/laravel-modules`-style layouts (presence of `modules/` dir + module `.json`/service provider registration)
- Extend controller/namespace resolution (`project-config.ts`, `fqcnToPath`) to resolve module-scoped namespaces
- Add a benchmark fixture from a real modular Laravel app to `research/golden-traces` to lock in the fix

**Why:** Silent parsing on a whole class of real-world Laravel apps (module-based, common in larger commercial codebases) is worse than an explicit "unsupported" signal — it looks like a clean pass with nothing to report.

---

## 9. Tree-sitter dependency version skew causing flaky parser tests

**Priority:** High — undermines trust in the whole test suite and any CI built on top of it
**Effort:** Medium (needs careful upgrade + full regression pass, not a blind bump)
**Status:** Root-caused 2026-09-03, not yet fixed

`packages/laravel-parser` pins `tree-sitter@^0.21.0` but `tree-sitter-php@^0.23.12` — the grammar binding is built against a newer core ABI than the runtime provides. 14 files each hold a module-level `new Parser()` singleton (correct pattern in isolation), but when many of these singletons parse heavily in the *same process* (e.g. `npm test` running all 18 test suites in one Jest worker), `_parser.parse(source)` intermittently throws. Every parser module wraps that call in a bare `catch { return <empty defaults> }`, so the throw is swallowed and silently reported as "nothing found" instead of a hard failure — which is what made this invisible for so long (confirmed while fixing the AUTH-002 retrieval regression: `isolation-parser.test.ts` passes 3/3 in isolation but randomly fails when run with the other 17 suites; failure count scales with worker contention — 24-49 failures/283 tests with default parallelism, 201/283 under `-w 1` where every suite shares one process).

**Deliverables:**
- Upgrade `tree-sitter`/`tree-sitter-php` to a matched, current pair (latest `tree-sitter` is 0.25.1) and re-run the full suite for stability across multiple repeated runs, not just once
- Replace the blanket `catch { return emptyDefaults }` in each parser module with a narrower catch (file-not-found only) so a real parse failure surfaces loudly instead of reading as "no findings"
- Re-enable CI test gating only after the suite is confirmed deterministic across N repeated runs

**Why:** This is very likely *why* there's no CI on this repo at all — a red/green result that changes every run isn't a gate anyone can trust. It's also why the AUTH-002 regression (`permission-constant` reachability, fixed in `graph-augmenter.ts`) went unnoticed for a full release cycle: nobody could tell a real regression from noise.

---

## Summary Table

| Idea | Impact | Effort | Recommended Order |
|------|--------|--------|-------------------|
| Tree-sitter version skew / flaky tests (#9) | Critical | Medium | **1st** — blocks trusting any test/CI signal |
| AQL/Constraints in CI (#5) | High | Low-Medium | **2nd** — reuses shipped engine |
| Benchmark CLI (#2) | High | Low | **3rd** |
| Graph Diff PR Comment (#1) | High | Medium | **4th** |
| Modular Laravel support (#8) | Medium | Medium | **5th** |
| Auto-fix Suggestions (#4) | Medium | Medium | **6th** |
| Framework #4 + adapter kit (#3) | High | High | **7th** |
| Web UI Visualizer (#6) | Medium | High | **8th** |
| OTel Runtime Expansion (#7) | High | High | **9th** |
