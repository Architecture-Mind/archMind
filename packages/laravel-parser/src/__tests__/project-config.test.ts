import { describe, test, expect, afterEach } from "@jest/globals"
import { writeFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import {
  expandRouteGlob,
  expandRouteFiles,
  resolvePolicyFile,
  resolveAliasMap,
  DEFAULT_PROJECT_CONFIG,
} from "../project-config.js"

const TMP = join(process.cwd(), "__test_projcfg_tmp__")

function makeDir(...parts: string[]): string {
  const p = join(TMP, ...parts)
  mkdirSync(p, { recursive: true })
  return p
}

function makeFile(...parts: string[]): string {
  const p = join(TMP, ...parts)
  mkdirSync(join(p, ".."), { recursive: true })
  writeFileSync(p, "<?php", "utf-8")
  return p
}

afterEach(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ---- expandRouteGlob --------------------------------------------------------

describe("expandRouteGlob — exact path", () => {
  test("returns path when file exists", () => {
    const root = makeDir("exact")
    makeFile("exact", "routes", "api.php")
    expect(expandRouteGlob(root, "routes/api.php")).toEqual(["routes/api.php"])
  })

  test("returns empty array when file does not exist", () => {
    const root = makeDir("exact_miss")
    expect(expandRouteGlob(root, "routes/api.php")).toEqual([])
  })
})

describe("expandRouteGlob — single-star wildcard", () => {
  test("matches all php files in directory", () => {
    const root = makeDir("single_star")
    makeFile("single_star", "routes", "api.php")
    makeFile("single_star", "routes", "web.php")
    makeFile("single_star", "routes", "console.php")

    const result = expandRouteGlob(root, "routes/*.php")
    expect(result).toHaveLength(3)
    expect(result).toContain("routes/api.php")
    expect(result).toContain("routes/web.php")
    expect(result).toContain("routes/console.php")
  })

  test("returns empty array when directory does not exist", () => {
    const root = makeDir("no_dir")
    expect(expandRouteGlob(root, "routes/*.php")).toEqual([])
  })

  test("matches files in subdirectory", () => {
    const root = makeDir("subdir")
    makeFile("subdir", "routes", "api", "v1.php")
    makeFile("subdir", "routes", "api", "v2.php")

    const result = expandRouteGlob(root, "routes/api/*.php")
    expect(result).toHaveLength(2)
    expect(result).toContain("routes/api/v1.php")
    expect(result).toContain("routes/api/v2.php")
  })
})

describe("expandRouteGlob — double-star recursive", () => {
  test("finds files at all levels", () => {
    const root = makeDir("double_star")
    makeFile("double_star", "routes", "api.php")
    makeFile("double_star", "routes", "v1", "users.php")
    makeFile("double_star", "routes", "v2", "admin", "tasks.php")

    const result = expandRouteGlob(root, "routes/**/*.php")
    expect(result).toHaveLength(3)
    expect(result).toContain("routes/api.php")
    expect(result).toContain("routes/v1/users.php")
    expect(result).toContain("routes/v2/admin/tasks.php")
  })

  test("returns empty array when base dir does not exist", () => {
    const root = makeDir("no_base")
    expect(expandRouteGlob(root, "routes/**/*.php")).toEqual([])
  })
})

// ---- expandRouteFiles -------------------------------------------------------

describe("expandRouteFiles", () => {
  test("deduplicates results from multiple patterns", () => {
    const root = makeDir("dedup")
    makeFile("dedup", "routes", "api.php")
    makeFile("dedup", "routes", "web.php")

    // routes/*.php and routes/api.php both match routes/api.php
    const result = expandRouteFiles(root, ["routes/*.php", "routes/api.php"])
    // api.php appears only once
    expect(result.filter((r) => r === "routes/api.php")).toHaveLength(1)
    expect(result).toContain("routes/web.php")
  })

  test("skips missing exact paths silently", () => {
    const root = makeDir("skip_missing")
    makeFile("skip_missing", "routes", "api.php")

    const result = expandRouteFiles(root, ["routes/api.php", "routes/missing.php"])
    expect(result).toEqual(["routes/api.php"])
  })

  test("returns empty array when no patterns match", () => {
    const root = makeDir("none")
    expect(expandRouteFiles(root, ["routes/*.php"])).toEqual([])
  })

  test("uses DEFAULT_PROJECT_CONFIG routeFiles as a valid input", () => {
    const root = makeDir("default")
    makeFile("default", "routes", "api.php")

    const result = expandRouteFiles(root, DEFAULT_PROJECT_CONFIG.routeFiles)
    expect(result).toEqual(["routes/api.php"])
  })
})

// ---- resolvePolicyFile -------------------------------------------------------

describe("resolvePolicyFile", () => {
  test("returns first matching policy path where file exists", () => {
    const root = makeDir("policy_match")
    makeFile("policy_match", "app", "Policies", "TaskPolicy.php")

    const result = resolvePolicyFile(root, "TaskPolicy", ["app/Policies", "app/V2/Policies"])
    expect(result).toBe("app/Policies/TaskPolicy.php")
  })

  test("returns second path when first does not contain the policy", () => {
    const root = makeDir("policy_second")
    makeFile("policy_second", "app", "V2", "Policies", "TaskPolicy.php")

    const result = resolvePolicyFile(root, "TaskPolicy", ["app/Policies", "app/V2/Policies"])
    expect(result).toBe("app/V2/Policies/TaskPolicy.php")
  })

  test("falls back to first path when no directory contains the file", () => {
    const root = makeDir("policy_fallback")

    const result = resolvePolicyFile(root, "TaskPolicy", ["app/Policies", "app/V2/Policies"])
    expect(result).toBe("app/Policies/TaskPolicy.php")
  })

  test("falls back to default when policyPaths is empty", () => {
    const root = makeDir("policy_empty_paths")

    const result = resolvePolicyFile(root, "TaskPolicy", [])
    expect(result).toBe("app/Policies/TaskPolicy.php")
  })
})

// ---- resolveAliasMap — RouteServiceProvider wrapping (IR v1.5 Phase 1) ------

describe("resolveAliasMap — RouteServiceProvider wrapping", () => {
  test("resolves BookStack-shaped api group to a concrete FQCN for the wrapped route file", () => {
    const root = makeDir("rsp_bookstack")
    mkdirSync(join(root, "app", "Http"), { recursive: true })
    writeFileSync(
      join(root, "app", "Http", "Kernel.php"),
      `<?php
namespace App\\Http;
use Illuminate\\Foundation\\Http\\Kernel as HttpKernel;
class Kernel extends HttpKernel {
    protected $middlewareGroups = [
        'api' => [\\App\\Http\\Middleware\\ApiAuthenticate::class],
    ];
}`,
      "utf-8"
    )
    mkdirSync(join(root, "app", "Providers"), { recursive: true })
    writeFileSync(
      join(root, "app", "Providers", "RouteServiceProvider.php"),
      `<?php
namespace App\\Providers;
use Illuminate\\Support\\Facades\\Route;
class RouteServiceProvider {
    public function boot() {
        Route::group(['middleware' => 'api'], function () {
            require base_path('routes/api.php');
        });
    }
}`,
      "utf-8"
    )
    makeFile("rsp_bookstack", "routes", "api.php")

    const result = resolveAliasMap(root, DEFAULT_PROJECT_CONFIG)
    expect(result.routeWrapping.get("routes/api.php")).toEqual(["App\\Http\\Middleware\\ApiAuthenticate"])
  })

  test("returns an empty routeWrapping when no RouteServiceProvider.php exists", () => {
    const root = makeDir("rsp_absent")
    mkdirSync(join(root, "app", "Http"), { recursive: true })
    writeFileSync(join(root, "app", "Http", "Kernel.php"), "<?php", "utf-8")
    makeFile("rsp_absent", "routes", "api.php")

    const result = resolveAliasMap(root, DEFAULT_PROJECT_CONFIG)
    expect(result.routeWrapping.size).toBe(0)
  })
})
