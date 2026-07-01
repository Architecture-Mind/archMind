// ---------------------------------------------------------------------------
// AQL Lexer
// Tokenises strings like: FIND routes WHERE auth AND NOT transaction
// ---------------------------------------------------------------------------

export type TokenKind =
  | "FIND" | "ROUTES" | "WHERE" | "AND" | "OR" | "NOT" | "MATCH"
  | "LPAREN" | "RPAREN" | "ARROW"
  | "PREDICATE"    // any identifier not matched as a keyword
  | "EOF"

export interface Token {
  kind:  TokenKind
  value: string
  pos:   number
}

const KEYWORDS: Record<string, TokenKind> = {
  find:   "FIND",
  routes: "ROUTES",
  route:  "ROUTES",
  where:  "WHERE",
  and:    "AND",
  or:     "OR",
  not:    "NOT",
  match:  "MATCH",
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < input.length) {
    // skip whitespace
    if (/\s/.test(input[i])) { i++; continue }

    // arrow ->
    if (input[i] === "-" && input[i + 1] === ">") {
      tokens.push({ kind: "ARROW", value: "->", pos: i })
      i += 2; continue
    }

    if (input[i] === "(") { tokens.push({ kind: "LPAREN", value: "(", pos: i }); i++; continue }
    if (input[i] === ")") { tokens.push({ kind: "RPAREN", value: ")", pos: i }); i++; continue }

    // identifier or keyword: letters, digits, hyphens, underscores
    if (/[a-zA-Z_]/.test(input[i])) {
      const start = i
      while (i < input.length && /[\w-]/.test(input[i])) i++
      const word = input.slice(start, i)
      const kind = KEYWORDS[word.toLowerCase()] ?? "PREDICATE"
      tokens.push({ kind, value: word, pos: start })
      continue
    }

    // skip unknown chars silently
    i++
  }

  tokens.push({ kind: "EOF", value: "", pos: input.length })
  return tokens
}
