/**
 * Wire ArchMind OTLP instrumentation into a corpus Laravel repo.
 *
 * What it does:
 *   1. Copies ServiceProvider + Middleware to the target app/
 *   2. Registers the provider in bootstrap/providers.php (Laravel 11+)
 *      or config/app.php (Laravel ≤10)
 *   3. Appends OTEL env vars to the target .env
 *   4. Installs the open-telemetry PHP SDK via composer (if not present)
 *
 * Usage:
 *   node scripts/install-corpus-instrumentation.mjs <repo-root> [service-name]
 *
 * Example:
 *   node scripts/install-corpus-instrumentation.mjs research/corpus/laravel-io laravel-io
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "fs"
import { join, resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { execSync } from "child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const OTEL_SETUP = join(ROOT, "research", "corpus", "otel-setup")

function log(msg) { console.log(`[install] ${msg}`) }
function warn(msg) { console.warn(`[install] WARN: ${msg}`) }

// ─── Detect Laravel version ───────────────────────────────────────────────────

function detectLaravelVersion(repoRoot) {
  const composerLock = join(repoRoot, "composer.lock")
  if (!existsSync(composerLock)) return null
  try {
    const lock = JSON.parse(readFileSync(composerLock, "utf-8"))
    const framework = lock.packages?.find(p => p.name === "laravel/framework")
    return framework?.version ?? null
  } catch {
    return null
  }
}

function isLaravel11Plus(version) {
  if (!version) return true // assume modern
  const major = parseInt(version.replace(/[^0-9]/, ""), 10)
  return major >= 11
}

// ─── File copy ────────────────────────────────────────────────────────────────

function copyInstrumentationFiles(repoRoot) {
  const providerDest = join(repoRoot, "app", "Providers", "ArchMindOtelServiceProvider.php")
  const middlewareDest = join(repoRoot, "app", "Http", "Middleware", "ArchMindOtelMiddleware.php")

  mkdirSync(join(repoRoot, "app", "Providers"), { recursive: true })
  mkdirSync(join(repoRoot, "app", "Http", "Middleware"), { recursive: true })

  copyFileSync(join(OTEL_SETUP, "ArchMindOtelServiceProvider.php"), providerDest)
  copyFileSync(join(OTEL_SETUP, "ArchMindOtelMiddleware.php"), middlewareDest)

  log(`Copied ServiceProvider → app/Providers/ArchMindOtelServiceProvider.php`)
  log(`Copied Middleware      → app/Http/Middleware/ArchMindOtelMiddleware.php`)
}

// ─── Provider registration ────────────────────────────────────────────────────

function registerProviderLaravel11(repoRoot) {
  const providersFile = join(repoRoot, "bootstrap", "providers.php")
  if (!existsSync(providersFile)) {
    warn("bootstrap/providers.php not found — register provider manually.")
    return
  }

  let content = readFileSync(providersFile, "utf-8")
  if (content.includes("ArchMindOtelServiceProvider")) {
    log("ServiceProvider already registered in bootstrap/providers.php")
    return
  }

  // Insert before the closing bracket of the return array
  content = content.replace(
    /(\];\s*)$/,
    `    App\\Providers\\ArchMindOtelServiceProvider::class,\n$1`
  )
  writeFileSync(providersFile, content)
  log("Registered ServiceProvider in bootstrap/providers.php")
}

function registerProviderLaravel10(repoRoot) {
  const appConfig = join(repoRoot, "config", "app.php")
  if (!existsSync(appConfig)) {
    warn("config/app.php not found — register provider manually.")
    return
  }

  let content = readFileSync(appConfig, "utf-8")
  if (content.includes("ArchMindOtelServiceProvider")) {
    log("ServiceProvider already registered in config/app.php")
    return
  }

  // Find the providers array and append before closing
  content = content.replace(
    /(App\\Providers\\RouteServiceProvider::class,?\s*\n\s*\])/,
    `$1\n        App\\Providers\\ArchMindOtelServiceProvider::class,`
  )
  writeFileSync(appConfig, content)
  log("Registered ServiceProvider in config/app.php")
}

// ─── Middleware registration (Laravel 11) ─────────────────────────────────────

function registerMiddlewareLaravel11(repoRoot) {
  const appFile = join(repoRoot, "bootstrap", "app.php")
  if (!existsSync(appFile)) {
    warn("bootstrap/app.php not found — register middleware manually.")
    return
  }

  let content = readFileSync(appFile, "utf-8")
  if (content.includes("ArchMindOtelMiddleware")) {
    log("Middleware already registered in bootstrap/app.php")
    return
  }

  // Append middleware via ->withMiddleware() if block exists, else warn
  if (content.includes("->withMiddleware(")) {
    content = content.replace(
      /(->withMiddleware\(function\s*\(Middleware\s*\$middleware\)\s*\{)/,
      `$1\n        $middleware->append(\\App\\Http\\Middleware\\ArchMindOtelMiddleware::class);`
    )
    writeFileSync(appFile, content)
    log("Registered Middleware in bootstrap/app.php")
  } else {
    warn("Could not auto-register middleware. Add manually:\n  $middleware->append(\\App\\Http\\Middleware\\ArchMindOtelMiddleware::class);")
  }
}

// ─── Env vars ─────────────────────────────────────────────────────────────────

function appendOtelEnv(repoRoot, serviceName) {
  const envFile = join(repoRoot, ".env")
  if (!existsSync(envFile)) {
    warn(".env not found — create it from .env.example first.")
    return
  }

  let content = readFileSync(envFile, "utf-8")
  if (content.includes("OTEL_ENABLED")) {
    log("OTEL vars already in .env")
    return
  }

  const otelBlock = `
# ArchMind OTLP instrumentation
OTEL_ENABLED=true
OTEL_SERVICE_NAME=${serviceName}
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
`
  writeFileSync(envFile, content + otelBlock)
  log(`Appended OTEL vars to .env (service=${serviceName})`)
}

// ─── Composer SDK install ─────────────────────────────────────────────────────

function installOtelSdk(repoRoot) {
  const composerJson = JSON.parse(readFileSync(join(repoRoot, "composer.json"), "utf-8"))
  const deps = { ...composerJson.require, ...composerJson["require-dev"] }

  const sdkPackage = "open-telemetry/sdk"
  if (deps[sdkPackage] || deps["open-telemetry/opentelemetry-auto-laravel"]) {
    log("OpenTelemetry SDK already in composer.json — skipping install")
    return
  }

  log("Installing OpenTelemetry PHP SDK via composer...")
  try {
    // HTTP transport only — grpc extension not required
    execSync(
      "composer require open-telemetry/sdk open-telemetry/exporter-otlp open-telemetry/sem-conv --no-interaction",
      { cwd: repoRoot, stdio: "inherit" }
    )
    log("OpenTelemetry SDK installed")
  } catch (e) {
    warn(`composer require failed: ${e.message}\nInstall manually: composer require open-telemetry/sdk open-telemetry/exporter-otlp open-telemetry/sem-conv`)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [repoPath, serviceNameArg] = process.argv.slice(2)

  if (!repoPath) {
    console.error("Usage: node install-corpus-instrumentation.mjs <repo-root> [service-name]")
    process.exit(1)
  }

  const repoRoot = resolve(repoPath)
  const serviceName = serviceNameArg ?? repoRoot.split(/[\\/]/).at(-1) ?? "laravel-app"

  if (!existsSync(repoRoot)) {
    console.error(`Repo not found: ${repoRoot}`)
    process.exit(1)
  }

  log(`Target: ${repoRoot}`)
  log(`Service name: ${serviceName}`)

  const version = detectLaravelVersion(repoRoot)
  const isModern = isLaravel11Plus(version)
  log(`Laravel version: ${version ?? "unknown"} (${isModern ? "11+" : "≤10"} style registration)`)

  // 1. Copy files
  copyInstrumentationFiles(repoRoot)

  // 2. Register provider
  if (isModern) {
    registerProviderLaravel11(repoRoot)
    registerMiddlewareLaravel11(repoRoot)
  } else {
    registerProviderLaravel10(repoRoot)
  }

  // 3. Env vars
  appendOtelEnv(repoRoot, serviceName)

  // 4. SDK (skip if vendor doesn't exist yet — run after composer install)
  const vendorExists = existsSync(join(repoRoot, "vendor"))
  if (vendorExists) {
    installOtelSdk(repoRoot)
  } else {
    warn("vendor/ not found — run 'composer install' in the repo first, then re-run this script to install the OTLP SDK.")
  }

  log("")
  log("Done. Next steps:")
  log("  1. node scripts/otlp-collector.mjs          # start OTLP collector on :4318")
  log(`  2. cd ${repoRoot} && php artisan serve        # start the app`)
  log("  3. Hit a few routes (browser or curl)")
  log(`  4. node scripts/generate-gap-report.mjs research/corpus/traces/${serviceName} ${repoRoot}`)
}

main().catch(e => { console.error(e); process.exit(1) })
