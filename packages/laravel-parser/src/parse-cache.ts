import { createHash } from "crypto"
import { readFileSync } from "fs"

/**
 * Content-hash memoization cache for expensive file-parse operations.
 *
 * Key = SHA-256(file content)[0..15] + "::" + discriminator
 * Scope: one instance per project_root (never share across projects — config
 *   differences must not collide, and project-scoping makes config constant).
 *
 * Results are deep-cloned on return so consumers can't mutate shared state.
 */
export class ParseCache<V> {
  private readonly store = new Map<string, V>()
  private _hits   = 0
  private _misses = 0

  /**
   * Return a cached result or compute it via factory.
   *
   * discriminator must encode EVERY argument that affects the result:
   *   - parseControllerMethod → methodName
   *   - parseIsolation        → JSON(options) (but options are constant per project root)
   *
   * The factory receives the file content so it doesn't need to re-read the file.
   * Note: we read the file once here for hashing; the caller's parser may read it
   * again internally (acceptable — local files, TOCTOU risk is negligible).
   */
  compute(filePath: string, discriminator: string, factory: () => V): V {
    let hash: string
    try {
      const content = readFileSync(filePath, "utf-8")
      hash = createHash("sha256").update(content).digest("hex").slice(0, 16)
    } catch {
      // Unreadable file — compute without caching
      return factory()
    }

    const key = `${hash}::${discriminator}`
    const cached = this.store.get(key)

    if (cached !== undefined) {
      this._hits++
      return structuredClone(cached)
    }

    this._misses++
    const result = factory()
    if (result !== null && result !== undefined) {
      this.store.set(key, structuredClone(result) as V)
    }
    return result
  }

  get hits()   { return this._hits }
  get misses() { return this._misses }
  get size()   { return this.store.size }

  stats() {
    return { hits: this._hits, misses: this._misses, size: this.store.size }
  }

  clear() {
    this.store.clear()
    this._hits   = 0
    this._misses = 0
  }
}
