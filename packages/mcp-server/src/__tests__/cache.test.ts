import { writeFileSync, mkdirSync, utimesSync, statSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  buildFileIndex,
  hasAnyTrackedFileChanged,
  getGraphs,
  _clearForTesting,
  _setCacheEntry,
  _setTrackedFiles,
  _getTrackedFiles,
  _isCached,
} from "../cache.js"
import type { IntermediateExecutionGraph } from "@archmind/protocol"

const FAKE_GRAPHS: IntermediateExecutionGraph[] = []

function makeTmp(prefix = "archmind-cache-test"): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function touchFile(absPath: string, content = "content"): void {
  mkdirSync(join(absPath, ".."), { recursive: true })
  writeFileSync(absPath, content)
}

function bumpMtime(absPath: string): void {
  const future = new Date(Date.now() + 10_000)
  utimesSync(absPath, future, future)
}

beforeEach(() => _clearForTesting())

// ── buildFileIndex ─────────────────────────────────────────────────────────

describe("buildFileIndex", () => {
  test("includes files referenced in node.file", () => {
    const tmp = makeTmp()
    touchFile(join(tmp, "Controller.php"))

    const graphs: IntermediateExecutionGraph[] = [{
      entrypoint: "GET /test",
      method: "GET",
      path: "/test",
      nodes: [{ id: "n1", type: "ir:business_handler", symbol: "C::m", role: "handler", file: "Controller.php" }],
      edges: [],
      annotations: [],
    }]

    const index = buildFileIndex(graphs, tmp, [])
    expect(index.has("Controller.php")).toBe(true)
    expect(index.get("Controller.php")).toBeGreaterThan(0)
  })

  test("includes route files even if not in node.file", () => {
    const tmp = makeTmp()
    mkdirSync(join(tmp, "routes"), { recursive: true })
    touchFile(join(tmp, "routes", "web.php"), "<?php Route::get('/', fn()=>'hi');")

    const index = buildFileIndex([], tmp, ["routes/web.php"])
    expect(index.has("routes/web.php")).toBe(true)
  })

  test("includes archmind.json when present", () => {
    const tmp = makeTmp()
    touchFile(join(tmp, "archmind.json"), "{}")

    const index = buildFileIndex([], tmp, [])
    expect(index.has("archmind.json")).toBe(true)
  })

  test("excludes archmind.json when absent", () => {
    const tmp = makeTmp()
    const index = buildFileIndex([], tmp, [])
    expect(index.has("archmind.json")).toBe(false)
  })

  test("skips nodes with no file property", () => {
    const tmp = makeTmp()
    const graphs: IntermediateExecutionGraph[] = [{
      entrypoint: "GET /test",
      method: "GET",
      path: "/test",
      nodes: [{ id: "n1", type: "ir:auth_gate", symbol: "Auth", role: "middleware" }],
      edges: [],
      annotations: [],
    }]
    const index = buildFileIndex(graphs, tmp, [])
    expect(index.size).toBe(0)
  })

  test("multiple graphs contribute all their node.file entries", () => {
    const tmp = makeTmp()
    touchFile(join(tmp, "A.php"))
    touchFile(join(tmp, "B.php"))

    const graphs: IntermediateExecutionGraph[] = [
      {
        entrypoint: "GET /a",
        method: "GET", path: "/a",
        nodes: [{ id: "n1", type: "ir:business_handler", symbol: "A::m", role: "handler", file: "A.php" }],
        edges: [], annotations: [],
      },
      {
        entrypoint: "POST /b",
        method: "POST", path: "/b",
        nodes: [{ id: "n2", type: "ir:business_handler", symbol: "B::m", role: "handler", file: "B.php" }],
        edges: [], annotations: [],
      },
    ]

    const index = buildFileIndex(graphs, tmp, [])
    expect(index.has("A.php")).toBe(true)
    expect(index.has("B.php")).toBe(true)
  })
})

// ── hasAnyTrackedFileChanged ───────────────────────────────────────────────

describe("hasAnyTrackedFileChanged", () => {
  test("returns false when no tracked files for this project", () => {
    expect(hasAnyTrackedFileChanged("/nonexistent/project")).toBe(false)
  })

  test("returns false when all tracked files are unchanged", () => {
    const tmp = makeTmp()
    const file = join(tmp, "a.php")
    touchFile(file)
    const mtime = statSync(file).mtimeMs

    _setTrackedFiles(tmp, new Map([["a.php", mtime]]))
    expect(hasAnyTrackedFileChanged(tmp)).toBe(false)
  })

  test("returns true when a tracked file's recorded mtime is stale (file changed)", () => {
    const tmp = makeTmp()
    const file = join(tmp, "b.php")
    touchFile(file)

    // Record mtime=0 as if we last parsed when the file was empty
    _setTrackedFiles(tmp, new Map([["b.php", 0]]))
    expect(hasAnyTrackedFileChanged(tmp)).toBe(true)
  })

  test("returns true when a tracked file has been deleted", () => {
    const tmp = makeTmp()
    _setTrackedFiles(tmp, new Map([["missing.php", 12345]]))
    expect(hasAnyTrackedFileChanged(tmp)).toBe(true)
  })

  test("returns true after bumpMtime advances the mtime past the recorded value", () => {
    const tmp = makeTmp()
    const file = join(tmp, "c.php")
    touchFile(file)
    const mtime = statSync(file).mtimeMs

    _setTrackedFiles(tmp, new Map([["c.php", mtime]]))
    expect(hasAnyTrackedFileChanged(tmp)).toBe(false)

    bumpMtime(file)
    expect(hasAnyTrackedFileChanged(tmp)).toBe(true)
  })

  test("returns false when archmind.json is tracked and unchanged", () => {
    const tmp = makeTmp()
    const cfg = join(tmp, "archmind.json")
    touchFile(cfg, "{}")
    const mtime = statSync(cfg).mtimeMs

    _setTrackedFiles(tmp, new Map([["archmind.json", mtime]]))
    expect(hasAnyTrackedFileChanged(tmp)).toBe(false)
  })

  test("returns true when archmind.json changes (guard config updated)", () => {
    const tmp = makeTmp()
    const cfg = join(tmp, "archmind.json")
    touchFile(cfg, "{}")
    const mtime = statSync(cfg).mtimeMs

    _setTrackedFiles(tmp, new Map([["archmind.json", mtime]]))
    bumpMtime(cfg)
    expect(hasAnyTrackedFileChanged(tmp)).toBe(true)
  })
})

// ── cache eviction logic ───────────────────────────────────────────────────

describe("cache state management", () => {
  test("injected cache entry is present and retrievable via _isCached", () => {
    const tmp = makeTmp()
    expect(_isCached(tmp)).toBe(false)
    _setCacheEntry(tmp, FAKE_GRAPHS)
    expect(_isCached(tmp)).toBe(true)
  })

  test("_clearForTesting removes both cache and trackedFiles", () => {
    const tmp = makeTmp()
    _setCacheEntry(tmp, FAKE_GRAPHS)
    _setTrackedFiles(tmp, new Map([["x.php", 1]]))

    _clearForTesting()

    expect(_isCached(tmp)).toBe(false)
    expect(_getTrackedFiles(tmp)).toBeUndefined()
  })

  test("invalidation via hasAnyTrackedFileChanged correctly drives cache eviction", () => {
    const tmp = makeTmp()
    const file = join(tmp, "tracked.php")
    touchFile(file)
    const mtime = statSync(file).mtimeMs

    _setCacheEntry(tmp, FAKE_GRAPHS)
    _setTrackedFiles(tmp, new Map([["tracked.php", mtime]]))

    // No change — cache should stay
    expect(hasAnyTrackedFileChanged(tmp)).toBe(false)
    expect(_isCached(tmp)).toBe(true)

    // Simulate a file change
    bumpMtime(file)
    expect(hasAnyTrackedFileChanged(tmp)).toBe(true)
  })
})

// ── getGraphs() auto-invalidation (integration) ────────────────────────────

describe("getGraphs() auto-invalidation (integration)", () => {
  test("re-parses when a tracked route file's mtime changes", () => {
    const tmp = makeTmp()

    // Minimal Laravel ≤10 project structure
    mkdirSync(join(tmp, "routes"), { recursive: true })
    mkdirSync(join(tmp, "app", "Http"), { recursive: true })

    const routeFile = join(tmp, "routes", "web.php")
    writeFileSync(routeFile, "<?php\nRoute::get('/ping', fn() => 'pong');")
    writeFileSync(
      join(tmp, "app", "Http", "Kernel.php"),
      "<?php\nnamespace App\\Http;\nclass Kernel extends HttpKernel { protected $middlewareAliases = []; }",
    )

    // Cold parse — populates cache + trackedFiles
    const t0 = Date.now()
    const graphs1 = getGraphs(tmp)
    const coldMs = Date.now() - t0

    expect(_isCached(tmp)).toBe(true)
    expect(_getTrackedFiles(tmp)?.has("routes/web.php")).toBe(true)

    const recordedMtime = _getTrackedFiles(tmp)!.get("routes/web.php")!

    // Advance mtime to simulate an edit
    bumpMtime(routeFile)

    // Warm re-parse — should detect the mtime change, drop cache, re-parse with warm ParseCache
    const t1 = Date.now()
    const graphs2 = getGraphs(tmp)
    const warmMs = Date.now() - t1

    // trackedFiles must reflect the new mtime (proves re-parse ran, not stale cache hit)
    const updatedMtime = _getTrackedFiles(tmp)!.get("routes/web.php")!
    expect(updatedMtime).toBeGreaterThan(recordedMtime)

    // Same route structure — same number of graphs
    expect(graphs2.length).toBe(graphs1.length)

    // Warm re-parse reuses per-file AST cache; report both for reference.
    console.log(`[incremental] cold=${coldMs}ms, warm-reparse=${warmMs}ms`)
  })
})
