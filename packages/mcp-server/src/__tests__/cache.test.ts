import { writeFileSync, mkdirSync, utimesSync, statSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  buildFileIndex,
  hasAnyTrackedFileChanged,
  getGraphs,
  invalidate,
  detectFramework,
  _clearForTesting,
  _setCacheEntry,
  _setTrackedFiles,
  _getTrackedFiles,
  _isCached,
  _getNestProject,
  _getNestTrackedFiles,
  _getGoTrackedFiles,
} from "../cache.js"
import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"

const FAKE_GRAPHS: IntermediateExecutionGraph[] = []

function makeTmp(prefix = "archmind-cache-test"): string {
  // Date.now() alone collides: consecutive tests in this file can complete
  // within the same millisecond, reusing the same dir and leaking files
  // (e.g. "includes archmind.json when present" writing into the dir the
  // very next "excludes ... when absent" test then reads).
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const dir = join(tmpdir(), `${prefix}-${unique}`)
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

// ── NestJS incremental (getGraphs()) ─────────────────────────────────────────

// Minimal NestJS controller content — ts-morph parses decorators syntactically;
// skipFileDependencyResolution=true means @nestjs/common does not need to be installed.
const MINIMAL_CONTROLLER = `
import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get('/ping')
  ping() {}
}
`

function makeNestTmp(): { tmp: string; controllerFile: string } {
  const tmp = makeTmp("archmind-nest-test")
  mkdirSync(join(tmp, "src"), { recursive: true })
  // nest-cli.json triggers NestJS framework detection
  writeFileSync(join(tmp, "nest-cli.json"), "{}")
  const controllerFile = join(tmp, "src", "app.controller.ts")
  writeFileSync(controllerFile, MINIMAL_CONTROLLER)
  return { tmp, controllerFile }
}

describe("getGraphs() NestJS incremental (integration)", () => {
  test("cold parse: creates a cached Project and NestJS file index", () => {
    const { tmp, controllerFile } = makeNestTmp()

    const graphs = getGraphs(tmp)

    expect(_isCached(tmp)).toBe(true)
    expect(_getNestProject(tmp)).toBeDefined()
    const tracked = _getNestTrackedFiles(tmp)
    expect(tracked).toBeDefined()
    // Controller file should be tracked
    const hasController = [...tracked!.keys()].some(k => k.includes("app.controller.ts"))
    expect(hasController).toBe(true)
    // Graphs should contain at least the ping route
    const pingGraph = graphs.find(g => g.path.includes("ping"))
    expect(pingGraph).toBeDefined()
  }, 30_000)

  test("no-change second call returns cached result without creating new Project", () => {
    const { tmp } = makeNestTmp()

    getGraphs(tmp)
    const projectAfterCold = _getNestProject(tmp)

    // Second call — no file changes
    getGraphs(tmp)
    const projectAfterWarm = _getNestProject(tmp)

    // Same Project object — proves warm path hit cache, no new Project created
    expect(projectAfterWarm).toBe(projectAfterCold)
  }, 30_000)

  test("warm re-parse after mtime bump: updates tracked mtime", () => {
    const { tmp, controllerFile } = makeNestTmp()

    getGraphs(tmp)
    const trackedBefore = _getNestTrackedFiles(tmp)!
    const controllerKey = [...trackedBefore.keys()].find(k => k.includes("app.controller.ts"))!
    const mtimeBefore = trackedBefore.get(controllerKey)!

    bumpMtime(controllerFile)

    const t0 = Date.now()
    getGraphs(tmp)
    const warmMs = Date.now() - t0

    const trackedAfter = _getNestTrackedFiles(tmp)!
    const mtimeAfter = trackedAfter.get(controllerKey)!

    // Tracked mtime must advance — proves re-parse ran
    expect(mtimeAfter).toBeGreaterThan(mtimeBefore)
    // Project instance is reused (warm path)
    expect(_getNestProject(tmp)).toBeDefined()

    console.log(`[nest-incremental] warm-reparse=${warmMs}ms`)
  }, 30_000)

  test("invalidate clears NestJS project and tracked files", () => {
    const { tmp } = makeNestTmp()

    getGraphs(tmp)
    expect(_getNestProject(tmp)).toBeDefined()

    invalidate(tmp)

    expect(_isCached(tmp)).toBe(false)
    expect(_getNestProject(tmp)).toBeUndefined()
    expect(_getNestTrackedFiles(tmp)).toBeUndefined()
  }, 30_000)
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

// ── Go/Gin (integration) ─────────────────────────────────────────────────

const GIN_GO_MOD = `module example.com/ginapp

go 1.22

require github.com/gin-gonic/gin v1.10.0
`

const GIN_MAIN_GO = `package main

func main() {
	r := gin.Default()
	routes.RegisterRoutes(r)
}
`

const GIN_ROUTES_GO = `package routes

func RegisterRoutes(r *gin.Engine) {
	r.GET("/ping", handler.Ping)
}
`

function makeGinTmp(): { tmp: string; mainFile: string } {
  const tmp = makeTmp("archmind-go-test")
  writeFileSync(join(tmp, "go.mod"), GIN_GO_MOD)
  mkdirSync(join(tmp, "cmd", "server"), { recursive: true })
  const mainFile = join(tmp, "cmd", "server", "main.go")
  writeFileSync(mainFile, GIN_MAIN_GO)
  mkdirSync(join(tmp, "routes"), { recursive: true })
  writeFileSync(join(tmp, "routes", "routes.go"), GIN_ROUTES_GO)
  return { tmp, mainFile }
}

describe("getGraphs() Go/Gin (integration)", () => {
  test("detectFramework returns \"go\" for a project with go.mod requiring gin-gonic/gin", () => {
    const { tmp } = makeGinTmp()
    expect(detectFramework(tmp)).toBe("go")
  })

  test("cold parse: extracts the route and caches it", () => {
    const { tmp } = makeGinTmp()

    const graphs = getGraphs(tmp)

    expect(_isCached(tmp)).toBe(true)
    expect(graphs.some((g) => g.entrypoint === "GET /ping")).toBe(true)
    const tracked = _getGoTrackedFiles(tmp)
    expect(tracked).toBeDefined()
    expect([...tracked!.keys()].some((k) => k.includes("main.go"))).toBe(true)
  })

  test("no-change second call returns the cached result without re-parsing", () => {
    const { tmp } = makeGinTmp()
    const graphs1 = getGraphs(tmp)
    const graphs2 = getGraphs(tmp)
    expect(graphs2).toBe(graphs1) // same array reference — proves cache hit
  })

  test("re-parses after a tracked file's mtime changes", () => {
    const { tmp, mainFile } = makeGinTmp()
    getGraphs(tmp)
    const before = _getGoTrackedFiles(tmp)!.get(join("cmd", "server", "main.go"))!

    bumpMtime(mainFile)
    getGraphs(tmp)

    const after = _getGoTrackedFiles(tmp)!.get(join("cmd", "server", "main.go"))!
    expect(after).toBeGreaterThan(before)
  })

  test("invalidate clears the cache and tracked Go files", () => {
    const { tmp } = makeGinTmp()
    getGraphs(tmp)
    expect(_isCached(tmp)).toBe(true)

    invalidate(tmp)

    expect(_isCached(tmp)).toBe(false)
    expect(_getGoTrackedFiles(tmp)).toBeUndefined()
  })
})
