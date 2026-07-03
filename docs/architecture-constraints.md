# Architecture Constraints — custom CI rules with AQL

`archmind verify` ships with built-in invariants (transaction boundary, auth gate, tenant scope
regressions). Architecture Constraints let a team define **its own** rules on top, written as
[AQL](../packages/aql) queries, and enforce them in CI the same way.

A constraint rule is a query that finds routes **violating** a policy. If the query matches
one or more routes, that rule is reported as a violation.

---

## Quick start

```bash
archmind verify --project . --constraints .archmind/constraints.yml
```

If `--constraints` is omitted, `archmind verify` still auto-loads `.archmind/constraints.yml`
from the project root when present (silently skipped if absent). Passing `--constraints`
explicitly makes a missing file a hard error (exit code 2) — useful in CI where you want to
catch a typo'd path instead of silently skipping the check.

## File format

```yaml
version: 1
rules:
  - name: mutation-requires-auth
    query: FIND routes WHERE mutation AND no-auth
    severity: HIGH
    message: Mutating routes must require authentication

  - name: writes-need-transaction
    query: FIND routes WHERE mutation AND no-transaction
    severity: MEDIUM
    message: Writes should be wrapped in a transaction boundary

  - name: unscoped-data-access
    query: FIND routes WHERE unscoped-access
    severity: CRITICAL
    message: Route reads/writes data without tenant scoping
```

`severity` is one of `INFO`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` — informational only, it does
not change pass/fail (any violation fails `archmind verify`).

## Available predicates

| Predicate | True when... |
|-----------|---------------|
| `auth` / `authenticated` | route has an auth gate node |
| `no-auth` / `public` / `unauthenticated` | route has no auth gate |
| `authorization` / `policy` | route has an authorization/policy check |
| `no-authorization` / `no-policy` | route has no authorization check |
| `missing-authorization` | authenticated but has no authorization check |
| `mutation` / `write` | route is a mutating HTTP method (POST/PUT/PATCH/DELETE) |
| `readonly` / `read` | route is GET/HEAD |
| `transaction` | route has a transaction boundary |
| `no-transaction` | route has no transaction boundary |
| `transaction-escape` | an event/side-effect escapes the transaction |
| `tenant-scoped` / `tenant` | route has tenant context resolved |
| `unscoped` / `unscoped-access` | route accesses data without tenant scoping |
| `async` / `async-dispatch` / `queue` / `event` | route dispatches an async job/event |

Combine with `AND`, `OR`, `NOT`, and parentheses:

```
FIND routes WHERE mutation AND NOT (auth AND authorization)
```

## Example rule sets

### RBAC coverage — every route must check both auth and policy

```yaml
rules:
  - name: no-missing-authorization
    query: FIND routes WHERE missing-authorization
    severity: HIGH
    message: Authenticated route has no authorization/policy check
```

### Layering — writes must not escape the transaction as raw events

```yaml
rules:
  - name: no-transaction-escape
    query: FIND routes WHERE transaction-escape
    severity: MEDIUM
    message: Event dispatched inside a transaction can fire before commit — move it after
```

### Tenant isolation

```yaml
rules:
  - name: no-unscoped-writes
    query: FIND routes WHERE mutation AND unscoped-access
    severity: CRITICAL
    message: Mutating route writes data without a tenant scope check
```

## CI integration

```yaml
# .github/workflows/topology-guard.yml
- name: Architecture constraints
  run: archmind verify --project . --constraints .archmind/constraints.yml
```

A violation fails the step with exit code 1; an explicitly-passed but missing constraints file
fails with exit code 2 so a bad CI config doesn't silently pass.
