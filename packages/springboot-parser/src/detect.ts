import { existsSync, readFileSync } from "fs"
import { join } from "path"

const BUILD_FILES = ["pom.xml", "build.gradle", "build.gradle.kts"]
const MAX_MODULE_DEPTH = 6

function mentionsSpringBoot(content: string): boolean {
  return content.includes("spring-boot") || content.includes("org.springframework")
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return null
  }
}

/** `<module>foo</module>` entries from a Maven parent POM. */
function declaredMavenModules(pomSrc: string): string[] {
  return [...pomSrc.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)].map((m) => m[1]!)
}

/** `include("foo")` / `include ':foo:bar'` entries from a Gradle settings file. */
function declaredGradleModules(settingsSrc: string): string[] {
  return [...settingsSrc.matchAll(/include\s*\(?\s*['"]([^'"]+)['"]/g)]
    .map((m) => m[1]!.replace(/^:/, "").replace(/:/g, "/"))
}

/**
 * Returns true when root looks like a Spring Boot project.
 *
 * Checks the root build file first (fast path — true for single-module and
 * most multi-module repos, since the parent POM usually pulls in
 * spring-boot-starter-parent). Falls back to following the aggregator's own
 * declared `<modules>` / Gradle `include(...)` list — recursively, since
 * nested aggregators (e.g. SpringBlade's blade-ops/pom.xml has its own
 * `<modules>`) are common — when the root build file doesn't mention Spring
 * at all. A generic parent POM only declares packaging + submodules; only a
 * leaf module's own pom.xml/build.gradle may name spring-boot-starter-parent.
 *
 * Deliberately does NOT walk the filesystem generically: an unrelated nested
 * Java tool (e.g. a Laravel/NestJS repo's sidecar service) using Spring for
 * something incidental must not misclassify the whole project. Only paths
 * the project's own build manifest declares as modules are checked.
 */
export function isSpringBootProject(root: string): boolean {
  for (const f of BUILD_FILES) {
    const src = readIfExists(join(root, f))
    if (src && mentionsSpringBoot(src)) return true
  }
  return scanDeclaredModules(root, 0)
}

function scanDeclaredModules(dir: string, depth: number): boolean {
  if (depth > MAX_MODULE_DEPTH) return false

  const modules: string[] = []
  const pomSrc = readIfExists(join(dir, "pom.xml"))
  if (pomSrc) modules.push(...declaredMavenModules(pomSrc))
  for (const sf of ["settings.gradle", "settings.gradle.kts"]) {
    const src = readIfExists(join(dir, sf))
    if (src) modules.push(...declaredGradleModules(src))
  }

  for (const mod of modules) {
    const modDir = join(dir, mod)
    for (const f of BUILD_FILES) {
      const src = readIfExists(join(modDir, f))
      if (src && mentionsSpringBoot(src)) return true
    }
    if (scanDeclaredModules(modDir, depth + 1)) return true
  }

  return false
}
