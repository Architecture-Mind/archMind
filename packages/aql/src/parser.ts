// ---------------------------------------------------------------------------
// AQL Parser — produces an AST from token stream
//
// Grammar:
//   statement  := FIND ROUTES WHERE expr
//               | MATCH path_expr
//   expr       := or_expr
//   or_expr    := and_expr ( OR and_expr )*
//   and_expr   := unary   ( AND unary )*
//   unary      := NOT unary | primary
//   primary    := PREDICATE | LPAREN expr RPAREN
//   path_expr  := PREDICATE ( ARROW PREDICATE )+
// ---------------------------------------------------------------------------

import { type Token, tokenize } from "./lexer.js"

// ---------------------------------------------------------------------------
// AST node types
// ---------------------------------------------------------------------------

export type AqlNode =
  | { kind: "find";      expr: AqlNode }
  | { kind: "match";     path: string[] }
  | { kind: "and";       left: AqlNode; right: AqlNode }
  | { kind: "or";        left: AqlNode; right: AqlNode }
  | { kind: "not";       expr: AqlNode }
  | { kind: "predicate"; name: string }

// ---------------------------------------------------------------------------
// Recursive-descent parser
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[]
  private pos = 0

  constructor(input: string) {
    this.tokens = tokenize(input)
  }

  parse(): AqlNode {
    const node = this.statement()
    if (this.peek().kind !== "EOF") {
      throw new SyntaxError(`AQL: unexpected token "${this.peek().value}" at pos ${this.peek().pos}`)
    }
    return node
  }

  private statement(): AqlNode {
    if (this.peek().kind === "FIND") {
      this.consume("FIND")
      this.consume("ROUTES")
      this.consume("WHERE")
      return { kind: "find", expr: this.expr() }
    }
    if (this.peek().kind === "MATCH") {
      this.consume("MATCH")
      return this.matchExpr()
    }
    // Implicit FIND WHERE (shorthand: just the predicate expression)
    return { kind: "find", expr: this.expr() }
  }

  private matchExpr(): AqlNode {
    const path: string[] = [this.consume("PREDICATE").value]
    while (this.peek().kind === "ARROW") {
      this.consume("ARROW")
      path.push(this.consume("PREDICATE").value)
    }
    return { kind: "match", path }
  }

  private expr(): AqlNode {
    return this.orExpr()
  }

  private orExpr(): AqlNode {
    let left = this.andExpr()
    while (this.peek().kind === "OR") {
      this.consume("OR")
      left = { kind: "or", left, right: this.andExpr() }
    }
    return left
  }

  private andExpr(): AqlNode {
    let left = this.unary()
    while (this.peek().kind === "AND") {
      this.consume("AND")
      left = { kind: "and", left, right: this.unary() }
    }
    return left
  }

  private unary(): AqlNode {
    if (this.peek().kind === "NOT") {
      this.consume("NOT")
      return { kind: "not", expr: this.unary() }
    }
    return this.primary()
  }

  private primary(): AqlNode {
    if (this.peek().kind === "LPAREN") {
      this.consume("LPAREN")
      const node = this.expr()
      this.consume("RPAREN")
      return node
    }
    const tok = this.consume("PREDICATE")
    return { kind: "predicate", name: tok.value.toLowerCase() }
  }

  private peek(): Token {
    return this.tokens[this.pos]!
  }

  private consume(expected: Token["kind"]): Token {
    const tok = this.tokens[this.pos]
    if (!tok || tok.kind !== expected) {
      throw new SyntaxError(
        `AQL: expected ${expected} but got "${tok?.value ?? "EOF"}" at pos ${tok?.pos ?? -1}`
      )
    }
    this.pos++
    return tok
  }
}

export function parse(input: string): AqlNode {
  return new Parser(input).parse()
}
