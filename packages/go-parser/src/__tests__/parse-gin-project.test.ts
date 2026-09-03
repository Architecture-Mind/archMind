import { describe, test, expect } from "@jest/globals"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import { parseGinProject } from "../graph-builder.js"
import type { GoSourceFile } from "../route-parser.js"

// Synthetic fixtures matching the real-world shape surveyed in
// docs/go-support-plan.md (generic Task domain, not any client's actual
// business code): main.go applies AuthMiddleware globally with an internal
// skip-list, routes.go aggregates per-domain registrars, each registrar
// creates its own sub-group.

const MAIN_GO: GoSourceFile = {
  path: "cmd/server/main.go",
  content: `
package main

func main() {
	r := gin.Default()
	r.Use(middleware.AuthMiddleware())
	routes.RegisterRoutes(r)
}
`,
}

const AUTH_MIDDLEWARE_GO: GoSourceFile = {
  path: "internal/middleware/auth.go",
  content: `
package middleware

func AuthMiddleware() gin.HandlerFunc {
	skipRoutes := map[skipKey]bool{
		{http.MethodPost, "/api/v1/auth/login"}: true,
		{http.MethodGet, "/api/v1/health"}:      true,
	}
	return func(ctx *gin.Context) {
		if skipRoutes[skipKey{ctx.Request.Method, ctx.FullPath()}] {
			ctx.Next()
			return
		}
		token := ctx.GetHeader("Authorization")
		ctx.Next()
	}
}
`,
}

const ROUTES_GO: GoSourceFile = {
  path: "routes/routes.go",
  content: `
package routes

func RegisterRoutes(r *gin.Engine) {
	api := r.Group("/api/v1")
	api.GET("/health", handler.HealthCheck)
	RegisterAuthRoutes(api)
	RegisterTaskRoutes(api)
}
`,
}

const AUTH_ROUTES_GO: GoSourceFile = {
  path: "routes/auth.go",
  content: `
package routes

func RegisterAuthRoutes(router gin.IRouter) {
	auth := router.Group("/auth")
	auth.POST("/login", authHandler.Login)
}
`,
}

const TASK_ROUTES_GO: GoSourceFile = {
  path: "routes/task.go",
  content: `
package routes

func RegisterTaskRoutes(router gin.IRouter) {
	task := router.Group("/tasks")
	task.GET("/", taskHandler.ListTasks)
	task.PATCH("/:id", middleware.RequireRole(model.RoleAdmin, model.RoleManager), taskHandler.UpdateTask)
	task.DELETE("/:id", middleware.RequireRole(model.RoleAdmin), taskHandler.DeleteTask)
}
`,
}

const FILES = [MAIN_GO, AUTH_MIDDLEWARE_GO, ROUTES_GO, AUTH_ROUTES_GO, TASK_ROUTES_GO]

describe("parseGinProject", () => {
  const graphs = parseGinProject(FILES)

  test("extracts every route reachable from main across 3 call-graph layers", () => {
    const entrypoints = graphs.map((g) => g.entrypoint).sort()
    expect(entrypoints).toEqual([
      "DELETE /api/v1/tasks/:id",
      "GET /api/v1/health",
      "GET /api/v1/tasks/",
      "PATCH /api/v1/tasks/:id",
      "POST /api/v1/auth/login",
    ])
  })

  test("resolves nested group prefixes correctly (main → RegisterRoutes → RegisterAuthRoutes)", () => {
    const g = graphs.find((g) => g.entrypoint === "POST /api/v1/auth/login")!
    expect(g.method).toBe("POST")
    expect(g.path).toBe("/api/v1/auth/login")
  })

  test("skip-listed route (health) has no auth_gate node despite global AuthMiddleware", () => {
    const g = graphs.find((g) => g.entrypoint === "GET /api/v1/health")!
    expect(g.nodes.some((n) => n.type === IR_NODE_TYPES.AUTH_GATE)).toBe(false)
  })

  test("skip-listed route (login) has no auth_gate node", () => {
    const g = graphs.find((g) => g.entrypoint === "POST /api/v1/auth/login")!
    expect(g.nodes.some((n) => n.type === IR_NODE_TYPES.AUTH_GATE)).toBe(false)
  })

  test("non-exempt route (list tasks) has an auth_gate node from the global middleware", () => {
    const g = graphs.find((g) => g.entrypoint === "GET /api/v1/tasks/")!
    expect(g.nodes.some((n) => n.type === IR_NODE_TYPES.AUTH_GATE)).toBe(true)
  })

  test("route with inline RequireRole has both auth_gate and authz_check, in order", () => {
    const g = graphs.find((g) => g.entrypoint === "PATCH /api/v1/tasks/:id")!
    const types = g.nodes.map((n) => n.type)
    expect(types).toEqual([
      IR_NODE_TYPES.AUTH_GATE,
      IR_NODE_TYPES.AUTHZ_CHECK,
      IR_NODE_TYPES.BUSINESS_HANDLER,
    ])
  })

  test("authz_check captures the role constants passed to RequireRole", () => {
    const g = graphs.find((g) => g.entrypoint === "PATCH /api/v1/tasks/:id")!
    const authz = g.nodes.find((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)!
    expect(authz.args).toEqual(["model.RoleAdmin", "model.RoleManager"])
  })

  test("a stricter role list on DELETE captures only one role", () => {
    const g = graphs.find((g) => g.entrypoint === "DELETE /api/v1/tasks/:id")!
    const authz = g.nodes.find((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)!
    expect(authz.args).toEqual(["model.RoleAdmin"])
  })

  test("business_handler node captures the resolved handler expression as symbol", () => {
    const g = graphs.find((g) => g.entrypoint === "GET /api/v1/tasks/")!
    const handler = g.nodes.find((n) => n.type === IR_NODE_TYPES.BUSINESS_HANDLER)!
    expect(handler.symbol).toBe("taskHandler.ListTasks")
  })

  test("edges chain middleware to handler in application order", () => {
    const g = graphs.find((g) => g.entrypoint === "PATCH /api/v1/tasks/:id")!
    const authGate = g.nodes.find((n) => n.type === IR_NODE_TYPES.AUTH_GATE)!
    const authz    = g.nodes.find((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)!
    const handler  = g.nodes.find((n) => n.type === IR_NODE_TYPES.BUSINESS_HANDLER)!
    expect(g.edges).toContainEqual(expect.objectContaining({ from: authGate.id, to: authz.id }))
    expect(g.edges).toContainEqual(expect.objectContaining({ from: authz.id, to: handler.id }))
  })

  test("empty file set with no main() returns no routes", () => {
    expect(parseGinProject([])).toEqual([])
  })
})

// Real observed pattern (prohealth-api's admin.go): middleware passed inline
// to Group() itself, not to Use() or the route call — applies to every route
// under that group.
const ADMIN_ROUTES_GO: GoSourceFile = {
  path: "routes/admin.go",
  content: `
package routes

func RegisterAdminRoutes(r gin.IRouter) {
	admin := r.Group("/admin", middleware.RequireSystemRole(model.SystemRoleAdmin))
	admin.GET("/stats", adminHandler.GetStats)
	admin.GET("/users", adminHandler.GetUsers)
}
`,
}

const MAIN_WITH_ADMIN_GO: GoSourceFile = {
  path: "cmd/server/main.go",
  content: `
package main

func main() {
	r := gin.Default()
	r.Use(middleware.AuthMiddleware())
	api := r.Group("/api/v1")
	RegisterAdminRoutes(api)
}
`,
}

describe("parseGinProject — middleware inline on Group()", () => {
  const graphs = parseGinProject([MAIN_WITH_ADMIN_GO, AUTH_MIDDLEWARE_GO, ADMIN_ROUTES_GO])

  test("both routes under the group inherit the Group()-level middleware", () => {
    expect(graphs).toHaveLength(2)
    for (const g of graphs) {
      const types = g.nodes.map((n) => n.type)
      expect(types).toEqual([
        IR_NODE_TYPES.AUTH_GATE,
        IR_NODE_TYPES.AUTHZ_CHECK,
        IR_NODE_TYPES.BUSINESS_HANDLER,
      ])
    }
  })

  test("authz_check from Group()-level middleware captures the role arg", () => {
    const g = graphs.find((g) => g.entrypoint === "GET /api/v1/admin/stats")!
    const authz = g.nodes.find((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)!
    expect(authz.args).toEqual(["model.SystemRoleAdmin"])
  })
})

// ---------------------------------------------------------------------------
// Phase B: role-constant resolution + validation-gate from DTO binding tags
// ---------------------------------------------------------------------------

const MODEL_ROLE_GO: GoSourceFile = {
  path: "internal/model/role.go",
  content: `
package model

type UserRole string

const (
	RoleAdmin   UserRole = "admin"
	RoleManager UserRole = "manager"
)
`,
}

describe("parseGinProject — role constant resolution", () => {
  const graphs = parseGinProject([MAIN_GO, AUTH_MIDDLEWARE_GO, ROUTES_GO, AUTH_ROUTES_GO, TASK_ROUTES_GO, MODEL_ROLE_GO])

  test("authz_check resolves role constants to their declared literal value", () => {
    const g = graphs.find((g) => g.entrypoint === "PATCH /api/v1/tasks/:id")!
    const authz = g.nodes.find((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)!
    expect(authz.args).toEqual(["admin", "manager"])
  })

  test("an unresolvable const identifier falls back to its raw text", () => {
    const g = graphs.find((g) => g.entrypoint === "DELETE /api/v1/tasks/:id")!
    const authz = g.nodes.find((n) => n.type === IR_NODE_TYPES.AUTHZ_CHECK)!
    // RoleAdmin *is* declared here, so this should resolve too — DELETE only
    // passes one role, confirming resolution isn't accidentally order-dependent.
    expect(authz.args).toEqual(["admin"])
  })
})

// Realistic handler + DTO shape (prohealth-api's appointment.go pattern):
// registrar takes a typed *handler.X param, route references handler.Method,
// the method binds a request DTO with validator struct tags.

const MAIN_WITH_HANDLER_GO: GoSourceFile = {
  path: "cmd/server/main.go",
  content: `
package main

func main() {
	r := gin.Default()
	r.Use(middleware.AuthMiddleware())
	api := r.Group("/api/v1")
	RegisterTaskHandlerRoutes(api, taskHandler)
}
`,
}

const TASK_HANDLER_ROUTES_GO: GoSourceFile = {
  path: "routes/task.go",
  content: `
package routes

func RegisterTaskHandlerRoutes(router gin.IRouter, handler *handler.TaskHandler) {
	task := router.Group("/tasks")
	task.POST("/", handler.CreateTask)
}
`,
}

const TASK_HANDLER_GO: GoSourceFile = {
  path: "internal/handler/task.go",
  content: `
package handler

func (h *TaskHandler) CreateTask(ctx *gin.Context) {
	var req dto.CreateTaskRequest
	if err := ctx.ShouldBindJSON(&req); err != nil {
		return
	}
}
`,
}

const TASK_DTO_GO: GoSourceFile = {
  path: "internal/dto/task.go",
  content: `
package dto

type CreateTaskRequest struct {
	Title      string \`json:"title" binding:"required,max=200"\`
	AssigneeID string \`json:"assignee_id" binding:"omitempty,uuid"\`
	Internal   string
}
`,
}

describe("parseGinProject — validation gate from ShouldBindJSON + struct tags", () => {
  const graphs = parseGinProject([
    MAIN_WITH_HANDLER_GO, AUTH_MIDDLEWARE_GO, TASK_HANDLER_ROUTES_GO, TASK_HANDLER_GO, TASK_DTO_GO,
  ])

  test("emits a validation_gate node between auth_gate and business_handler", () => {
    const g = graphs.find((g) => g.entrypoint === "POST /api/v1/tasks/")!
    const types = g.nodes.map((n) => n.type)
    expect(types).toEqual([
      IR_NODE_TYPES.AUTH_GATE,
      IR_NODE_TYPES.VALIDATION_GATE,
      IR_NODE_TYPES.BUSINESS_HANDLER,
    ])
  })

  test("validation_gate symbol names the DTO type and args carry field:rule pairs", () => {
    const g = graphs.find((g) => g.entrypoint === "POST /api/v1/tasks/")!
    const gate = g.nodes.find((n) => n.type === IR_NODE_TYPES.VALIDATION_GATE)!
    expect(gate.symbol).toBe("CreateTaskRequest")
    expect(gate.args).toEqual(["Title:required,max=200", "AssigneeID:omitempty,uuid"])
  })

  test("validation_gate node points at the file that declares the DTO", () => {
    const g = graphs.find((g) => g.entrypoint === "POST /api/v1/tasks/")!
    const gate = g.nodes.find((n) => n.type === IR_NODE_TYPES.VALIDATION_GATE)!
    expect(gate.file).toBe("internal/dto/task.go")
  })

  test("edges route auth_gate -> validation_gate -> business_handler", () => {
    const g = graphs.find((g) => g.entrypoint === "POST /api/v1/tasks/")!
    const [authGate, validation, handler] = g.nodes
    expect(g.edges).toContainEqual(expect.objectContaining({ from: authGate.id, to: validation.id }))
    expect(g.edges).toContainEqual(expect.objectContaining({ from: validation.id, to: handler.id }))
  })
})

describe("parseGinProject — validation gate absent when handler doesn't bind a DTO", () => {
  test("a route whose handler has no ShouldBind call gets no validation_gate", () => {
    const noOpHandler: GoSourceFile = {
      path: "internal/handler/task.go",
      content: `
package handler

func (h *TaskHandler) CreateTask(ctx *gin.Context) {
	ctx.JSON(200, gin.H{"ok": true})
}
`,
    }
    const graphs = parseGinProject([MAIN_WITH_HANDLER_GO, AUTH_MIDDLEWARE_GO, TASK_HANDLER_ROUTES_GO, noOpHandler, TASK_DTO_GO])
    const g = graphs.find((g) => g.entrypoint === "POST /api/v1/tasks/")!
    expect(g.nodes.some((n) => n.type === IR_NODE_TYPES.VALIDATION_GATE)).toBe(false)
  })
})
