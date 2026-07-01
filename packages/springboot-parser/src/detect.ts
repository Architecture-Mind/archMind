import { existsSync, readFileSync } from "fs"
import { join } from "path"

/** Returns true when root looks like a Spring Boot project. */
export function isSpringBootProject(root: string): boolean {
  const pom = join(root, "pom.xml")
  if (existsSync(pom)) {
    const s = readFileSync(pom, "utf-8")
    return s.includes("spring-boot") || s.includes("org.springframework")
  }
  for (const f of ["build.gradle", "build.gradle.kts"]) {
    const p = join(root, f)
    if (existsSync(p)) {
      const s = readFileSync(p, "utf-8")
      if (s.includes("org.springframework.boot") || s.includes("spring-boot")) return true
    }
  }
  return false
}
