import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { parseAuditLogCalls } from "../audit-log-parser.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const FIXTURE    = join(__dirname, "fixtures/app/Services/ActivityAudit.php")

const DEFAULT_SINKS = ["Activity::add", "activity()->log"]

describe("parseAuditLogCalls — IR v1.5 Phase 5", () => {
  test("matches a static scoped call against the sink list (Activity::add)", () => {
    const calls = parseAuditLogCalls(FIXTURE, DEFAULT_SINKS)
    const call = calls.find((c) => c.symbol === "Activity::add")
    expect(call).toBeDefined()
  })

  test("matches a helper-chain call against the sink list (activity()->log)", () => {
    const calls = parseAuditLogCalls(FIXTURE, DEFAULT_SINKS)
    const call = calls.find((c) => c.symbol === "activity()->log")
    expect(call).toBeDefined()
    expect(call?.args).toContain("user.deleted")
  })

  test("does NOT match a call whose symbol isn't in the sink list (Mail::to->send)", () => {
    const calls = parseAuditLogCalls(FIXTURE, DEFAULT_SINKS)
    expect(calls.some((c) => c.symbol.startsWith("Mail::") || c.symbol.includes("send"))).toBe(false)
  })

  test("returns exactly 2 matches total for the fixture", () => {
    const calls = parseAuditLogCalls(FIXTURE, DEFAULT_SINKS)
    expect(calls).toHaveLength(2)
  })

  test("returns empty array when auditSinks is empty (feature fully off)", () => {
    const calls = parseAuditLogCalls(FIXTURE, [])
    expect(calls).toHaveLength(0)
  })

  test("returns empty array for an unreadable file", () => {
    const calls = parseAuditLogCalls("/nonexistent/path.php", DEFAULT_SINKS)
    expect(calls).toHaveLength(0)
  })
})
