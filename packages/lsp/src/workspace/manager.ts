import type { WorkspaceContext } from "./context.js"
import { AnalysisService } from "../analysis.js"

export class WorkspaceManager {
  private readonly contexts = new Map<string, WorkspaceContext>()

  getOrCreate(root: string): WorkspaceContext {
    if (!this.contexts.has(root)) {
      this.contexts.set(root, {
        root,
        cache:    null,
        analyzer: new AnalysisService(root),
      })
    }
    return this.contexts.get(root)!
  }

  get(root: string): WorkspaceContext | undefined {
    return this.contexts.get(root)
  }

  all(): WorkspaceContext[] {
    return Array.from(this.contexts.values())
  }

  invalidate(root: string): void {
    const ctx = this.contexts.get(root)
    if (ctx) ctx.cache = null
  }
}
