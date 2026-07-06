import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { detectGuardClause } from "../guard-clause-parser.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)
const USER_REPO  = join(__dirname, "fixtures/app/Services/UserRepo.php")

describe("detectGuardClause — IR v1.5 Phase 4", () => {
  test("matches a leading if/throw guard (ensureDeletable exact shape)", () => {
    const result = detectGuardClause(USER_REPO, "ensureDeletable")
    expect(result.isGuardClause).toBe(true)
    expect(result.reason).toBe("leading_if_throw")
  })

  test("matches guard-naming convention when the guard if is not the first statement", () => {
    const result = detectGuardClause(USER_REPO, "verifyOwnership")
    expect(result.isGuardClause).toBe(true)
    expect(result.reason).toBe("guard_naming_with_throw")
  })

  test("does NOT flag a throw buried deep inside unrelated loop logic", () => {
    const result = detectGuardClause(USER_REPO, "processItems")
    expect(result.isGuardClause).toBe(false)
    expect(result.reason).toBeNull()
  })

  test("does NOT flag a plain method with no throw at all", () => {
    const result = detectGuardClause(USER_REPO, "destroy")
    expect(result.isGuardClause).toBe(false)
  })

  test("returns false for a nonexistent method", () => {
    const result = detectGuardClause(USER_REPO, "doesNotExist")
    expect(result.isGuardClause).toBe(false)
  })

  test("returns false for an unreadable file", () => {
    const result = detectGuardClause("/nonexistent/path.php", "ensureDeletable")
    expect(result.isGuardClause).toBe(false)
  })
})
