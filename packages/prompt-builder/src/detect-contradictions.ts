import type { Finding } from "@kidkender/archmind-explainer"

export interface Contradiction {
  a: Finding
  b: Finding
  sharedNodes: string[]
}

export function detectContradictions(findings: Finding[]): Contradiction[] {
  const result: Contradiction[] = []

  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      const nodesA = new Set(findings[i].provenance.supporting_nodes)
      const sharedNodes = findings[j].provenance.supporting_nodes.filter((n) => nodesA.has(n))
      if (sharedNodes.length > 0 && findings[i].type !== findings[j].type) {
        result.push({ a: findings[i], b: findings[j], sharedNodes })
      }
    }
  }

  return result
}

export function serializeContradictions(contradictions: Contradiction[]): string {
  if (contradictions.length === 0) return ""

  const lines: string[] = ["Competing interpretations (findings sharing nodes):"]
  for (const c of contradictions) {
    const typeA = c.a.type.toUpperCase().replace(/-/g, "_")
    const typeB = c.b.type.toUpperCase().replace(/-/g, "_")
    lines.push(
      `  • ${typeA} vs ${typeB} — shared nodes: ${c.sharedNodes.join(", ")}`
    )
    lines.push(
      `    Both findings apply to the same execution points. Explain which interpretation takes precedence and why.`
    )
  }
  return lines.join("\n")
}
