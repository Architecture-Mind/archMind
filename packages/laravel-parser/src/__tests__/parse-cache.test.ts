/**
 * ParseCache tests — verification gate: cached ≡ uncached.
 *
 * The invariant that makes the cache trustworthy:
 *   cold build  == warm build  == no-cache build
 *
 * Secondary tests verify hit/miss tracking and invalidation.
 */

import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { ParseCache } from "../parse-cache.js"
import { augmentGraph, type AugmentOptions } from "../graph-augmenter.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES  = join(__dirname, "fixtures")

// Minimal skeleton for TaskController::update (augments with FormRequest + Policy)
const TASK_UPDATE_SKELETON: IntermediateExecutionGraph = {
  entrypoint: "PUT /tasks/{task}",
  method: "PUT",
  path: "/tasks/{task}",
  nodes: [
    {
      id:     "ctrl_taskcontroller_update",
      type:   "ir:business_handler",
      symbol: "TaskController::update",
      role:   "handler",
      file:   "app/Modules/Task/Http/Controllers/TaskController.php",
    },
  ],
  edges: [],
  annotations: [],
}

const OPTS: AugmentOptions = { projectRoot: FIXTURES }

// ── cached ≡ uncached ─────────────────────────────────────────────────────

describe("ParseCache — cached ≡ uncached invariant", () => {
  test("warm-cache build equals cold build (same graph structure)", () => {
    const cache = new ParseCache<unknown>()
    const optsWithCache: AugmentOptions = { ...OPTS, cache }

    const cold1 = augmentGraph(TASK_UPDATE_SKELETON, OPTS)
    const warm  = augmentGraph(TASK_UPDATE_SKELETON, optsWithCache)
    const warm2 = augmentGraph(TASK_UPDATE_SKELETON, optsWithCache)

    expect(warm.nodes).toEqual(cold1.nodes)
    expect(warm.edges).toEqual(cold1.edges)
    expect(warm2.nodes).toEqual(cold1.nodes)
  })

  test("no-cache third build equals cached build", () => {
    const cache = new ParseCache<unknown>()
    const optsWithCache: AugmentOptions = { ...OPTS, cache }

    // warm up cache
    augmentGraph(TASK_UPDATE_SKELETON, optsWithCache)
    // cached result
    const cached  = augmentGraph(TASK_UPDATE_SKELETON, optsWithCache)
    // fresh no-cache build
    const noCacheFresh = augmentGraph(TASK_UPDATE_SKELETON, OPTS)

    expect(cached.nodes).toEqual(noCacheFresh.nodes)
    expect(cached.edges).toEqual(noCacheFresh.edges)
  })
})

// ── hit / miss tracking ───────────────────────────────────────────────────

describe("ParseCache — hit/miss tracking", () => {
  test("first augmentGraph call results in misses (files are parsed)", () => {
    const cache = new ParseCache<unknown>()
    augmentGraph(TASK_UPDATE_SKELETON, { ...OPTS, cache })
    expect(cache.misses).toBeGreaterThan(0)
    expect(cache.hits).toBe(0)
  })

  test("second augmentGraph call on same skeleton gets cache hits", () => {
    const cache = new ParseCache<unknown>()
    augmentGraph(TASK_UPDATE_SKELETON, { ...OPTS, cache })
    const missesAfterCold = cache.misses

    augmentGraph(TASK_UPDATE_SKELETON, { ...OPTS, cache })
    expect(cache.hits).toBeGreaterThan(0)
    // misses should not increase (files unchanged)
    expect(cache.misses).toBe(missesAfterCold)
  })

  test("cache.size grows after first build", () => {
    const cache = new ParseCache<unknown>()
    expect(cache.size).toBe(0)
    augmentGraph(TASK_UPDATE_SKELETON, { ...OPTS, cache })
    expect(cache.size).toBeGreaterThan(0)
  })

  test("cache.clear() resets stats and size", () => {
    const cache = new ParseCache<unknown>()
    augmentGraph(TASK_UPDATE_SKELETON, { ...OPTS, cache })
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.hits).toBe(0)
    expect(cache.misses).toBe(0)
  })
})

// ── content change → cache miss ───────────────────────────────────────────

describe("ParseCache — content change invalidation", () => {
  test("modified file content causes cache miss on next build", () => {
    // Write a temp PHP file and parse it
    const tmpDir  = join(tmpdir(), `archmind-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    const tmpPhp  = join(tmpDir, "Dummy.php")
    writeFileSync(tmpPhp, "<?php class Dummy {}")

    const cache = new ParseCache<unknown>()

    // First compute — miss
    cache.compute(tmpPhp, "test", () => "result-v1")
    expect(cache.misses).toBe(1)
    expect(cache.hits).toBe(0)

    // Same content — hit
    cache.compute(tmpPhp, "test", () => "result-v1")
    expect(cache.hits).toBe(1)

    // Modify file — cache should miss again
    writeFileSync(tmpPhp, "<?php class Dummy { public function newMethod() {} }")
    const result = cache.compute(tmpPhp, "test", () => "result-v2")

    expect(cache.misses).toBe(2)
    expect(result).toBe("result-v2")
  })
})

// ── mutation isolation ────────────────────────────────────────────────────

describe("ParseCache — mutation isolation (freeze-on-return)", () => {
  test("mutating a cached result does not affect subsequent cache hits", () => {
    const cache = new ParseCache<{ value: number }>()
    const tmpDir = join(tmpdir(), `archmind-mut-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    const tmpPhp = join(tmpDir, "MutTest.php")
    writeFileSync(tmpPhp, "<?php class MutTest {}")

    // Store value=1
    cache.compute(tmpPhp, "mut", () => ({ value: 1 }))

    // Get result and mutate it
    const r1 = cache.compute(tmpPhp, "mut", () => ({ value: 1 }))
    r1.value = 999

    // Next hit should return original, not mutated value
    const r2 = cache.compute(tmpPhp, "mut", () => ({ value: 1 }))
    expect(r2.value).toBe(1)
  })
})
