/**
 * Verify corpus gap fixes — Phase 21
 *
 * Tests 3 gap patterns against real corpus files:
 *   1. $this->dispatch() / $this->dispatchSync() (RegisterController, laravel-io)
 *   2. Job handle() body → nested event dispatch (ApproveArticle.php)
 *   3. api_resource nested refs in toArray() — direct + $this->when() closures
 *
 * Usage:
 *   node scripts/verify-corpus-gaps.mjs
 */

import { join, dirname } from "path"
import { fileURLToPath, pathToFileURL } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")

function distUrl(rel) {
  return pathToFileURL(join(ROOT, rel)).href
}

const { parseControllerMethod } = await import(distUrl("packages/laravel-parser/dist/controller-parser.js"))
const { parseApiResource }       = await import(distUrl("packages/laravel-parser/dist/resource-parser.js"))

const LARAVEL_IO = join(ROOT, "research/corpus/laravel-io/app")
const CRATER     = join(ROOT, "research/corpus/crater/app")

let pass = 0, fail = 0

function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  ✓  ${label}`)
    pass++
  } else {
    console.log(`  ✗  ${label}${detail ? `  → ${detail}` : ""}`)
    fail++
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GAP 1 — $this->dispatch() / $this->dispatchSync()
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[GAP 1] $this->dispatch() / $this->dispatchSync() — laravel-io RegisterController")

const registerCtrl = join(LARAVEL_IO, "Http/Controllers/Auth/RegisterController.php")
const reg = parseControllerMethod(registerCtrl, "register")

if (reg) {
  const dispatchClassNames = reg.standaloneDispatches.map(d => d.className)
  console.log(`  Detected dispatches: [${dispatchClassNames.join(", ")}]`)
  check("RegisterController::register detects ≥1 dispatch", reg.standaloneDispatches.length >= 1)
  check("UpdateUserIdenticonStatus detected", dispatchClassNames.includes("UpdateUserIdenticonStatus"))
  const d = reg.standaloneDispatches.find(d => d.className === "UpdateUserIdenticonStatus")
  check("Classified as job", d?.kind === "job", `got: ${d?.kind}`)
} else {
  check("Parsed RegisterController", false, "null result")
}

// ConnectGitHubAccount action (uses global dispatch())
console.log("\n  ConnectGitHubAccount.__invoke() — global dispatch() in action class")
const connectAction = join(LARAVEL_IO, "Actions/ConnectGitHubAccount.php")
const conn = parseControllerMethod(connectAction, "__invoke")
if (conn) {
  const names = conn.standaloneDispatches.map(d => d.className)
  console.log(`  Detected dispatches: [${names.join(", ")}]`)
  check("ConnectGitHubAccount detects dispatch(new UpdateUserIdenticonStatus)", names.includes("UpdateUserIdenticonStatus"))
} else {
  check("Parsed ConnectGitHubAccount", false, "null result")
}

// ─────────────────────────────────────────────────────────────────────────────
// GAP 2 — Job handle() body — nested event dispatch
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[GAP 2] Job handle() body parsing — laravel-io Jobs")

const jobs = [
  { file: "Jobs/ApproveArticle.php",  event: "ArticleWasApproved" },
  { file: "Jobs/CreateReply.php",     event: "ReplyWasCreated" },
  { file: "Jobs/CreateThread.php",    event: "ThreadWasCreated" },
]

for (const { file, event } of jobs) {
  const l1 = parseControllerMethod(join(LARAVEL_IO, file), "handle")
  if (l1) {
    const names = l1.standaloneDispatches.map(d => d.className)
    const found = l1.standaloneDispatches.find(d => d.className === event)
    check(`${file.split("/").pop()} handle() → ${event} detected`, names.includes(event))
    check(`${event} classified as event`, found?.kind === "event", `got: ${found?.kind}`)
  } else {
    check(`Parsed ${file}`, false, "null result")
  }
}

// crater: Event::dispatch() static form
console.log("\n  crater: EnableModuleController — ModuleEnabledEvent::dispatch()")
const enableCtrl = join(CRATER, "Http/Controllers/V1/Admin/Modules/EnableModuleController.php")
const enable = parseControllerMethod(enableCtrl, "__invoke")
if (enable) {
  const names = enable.standaloneDispatches.map(d => d.className)
  console.log(`  Detected dispatches: [${names.join(", ")}]`)
  const found = enable.standaloneDispatches.find(d => d.className === "ModuleEnabledEvent")
  check("ModuleEnabledEvent::dispatch() detected", names.includes("ModuleEnabledEvent"))
  check("ModuleEnabledEvent classified as event", found?.kind === "event", `got: ${found?.kind}`)
} else {
  check("Parsed EnableModuleController", false, "null result")
}

// ─────────────────────────────────────────────────────────────────────────────
// GAP 3 — api_resource nested refs in toArray()
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[GAP 3] Nested resource refs in toArray()")

// laravel-io: ArticleResource → AuthorResource::make, TagResource::collection
console.log("\n  laravel-io: ArticleResource.php")
const articleRes = join(LARAVEL_IO, "Http/Resources/ArticleResource.php")
const artInfo = parseApiResource(articleRes)
if (artInfo) {
  const names = artInfo.nestedResources.map(r => r.shortName)
  console.log(`  Nested refs detected: [${names.join(", ")}]`)
  check("AuthorResource detected (::make)", names.includes("AuthorResource"))
  const author = artInfo.nestedResources.find(r => r.shortName === "AuthorResource")
  check("AuthorResource isCollection=false", author?.isCollection === false)
  check("TagResource detected (::collection)", names.includes("TagResource"))
  const tag = artInfo.nestedResources.find(r => r.shortName === "TagResource")
  check("TagResource isCollection=true", tag?.isCollection === true)
} else {
  check("Parsed ArticleResource", false, "null result")
}

// crater: CustomerResource → AddressResource + CompanyResource inside $this->when() closures
console.log("\n  crater: CustomerResource.php — when() closures")
const customerRes = join(CRATER, "Http/Resources/Customer/CustomerResource.php")
const custInfo = parseApiResource(customerRes)
if (custInfo) {
  const names = custInfo.nestedResources.map(r => r.shortName)
  console.log(`  Nested refs detected: [${names.join(", ")}]`)
  check("AddressResource detected inside when() closure", names.includes("AddressResource"))
  check("CompanyResource detected inside when() closure", names.includes("CompanyResource"))
  check("CurrencyResource detected inside when() closure", names.includes("CurrencyResource"))
} else {
  check("Parsed CustomerResource", false, "null result")
}

// crater: InvoiceResource — direct nested resources
console.log("\n  crater: InvoiceResource.php")
const invoiceRes = join(CRATER, "Http/Resources/InvoiceResource.php")
const invInfo = parseApiResource(invoiceRes)
if (invInfo) {
  const names = invInfo.nestedResources.map(r => r.shortName)
  console.log(`  Nested refs detected: [${names.join(", ")}]`)
  check("≥1 nested resource in InvoiceResource", names.length >= 1)
} else {
  check("Parsed InvoiceResource", false, "null result — file may not exist")
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

const total = pass + fail
console.log(`\n${"─".repeat(50)}`)
console.log(`Result: ${pass}/${total} checks passed${fail > 0 ? ` (${fail} failed)` : ""}`)
console.log(fail === 0 ? "✓ ALL GAP PATTERNS DETECTED" : "✗ SOME GAPS REMAIN")
