import { SyntaxKind } from "ts-morph"
import type { ClassDeclaration, MethodDeclaration, Node } from "ts-morph"

export interface TransactionWrite {
  entity:    string   // e.g. "Order"
  operation: string   // e.g. "save" | "insert" | "update" | "delete" | "remove"
}

export interface TransactionBlock {
  symbol:    string            // e.g. "DataSource::transaction"
  writes:    TransactionWrite[]
}

const DATASOURCE_TYPES   = /DataSource|EntityManager|Connection/
const QUERYRUNNER_TYPES  = /QueryRunner/
const WRITE_OPS          = new Set(["save", "insert", "update", "delete", "remove", "upsert", "softDelete", "recover"])
const MANAGER_PARAM_HINT = /manager|transactional|em|entityManager/i

/**
 * Scan constructor-injected fields for DataSource / EntityManager / QueryRunner types.
 */
function getDataAccessFields(cls: ClassDeclaration): Map<string, "datasource" | "queryrunner"> {
  const map = new Map<string, "datasource" | "queryrunner">()
  for (const ctor of cls.getConstructors()) {
    for (const param of ctor.getParameters()) {
      const typeName = param.getTypeNode()?.getText() ?? ""
      const fieldName = param.getName()
      if (DATASOURCE_TYPES.test(typeName))  map.set(fieldName, "datasource")
      if (QUERYRUNNER_TYPES.test(typeName)) map.set(fieldName, "queryrunner")
    }
  }
  return map
}

/**
 * Extract entity class name from manager.save(Order, dto) or manager.save(new Order()).
 * Returns first argument class name if it's a type reference, or "unknown".
 */
function extractEntityName(callExpr: Node): string {
  const call = callExpr.asKind(SyntaxKind.CallExpression)
  if (!call) return "unknown"
  const args = call.getArguments()
  if (!args.length) return "unknown"

  const first = args[0]
  // manager.save(new Order(dto))
  if (first.getKind() === SyntaxKind.NewExpression) {
    const ne = first.asKindOrThrow(SyntaxKind.NewExpression)
    return ne.getExpression().getText()
  }
  // manager.save(Order, dto)
  if (first.getKind() === SyntaxKind.Identifier) {
    const name = first.getText()
    // Exclude primitives and common DTO names
    if (/^[A-Z]/.test(name)) return name
  }
  return "unknown"
}

/**
 * Scan an arrow/function callback body for TypeORM write operations.
 * Looks for: manager.save(...), manager.insert(...), etc.
 */
function scanCallbackWrites(callback: Node): TransactionWrite[] {
  const writes: TransactionWrite[] = []
  const seen = new Set<string>()

  for (const call of callback.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression()
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue

    const prop = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression)
    const method = prop.getName()
    if (!WRITE_OPS.has(method)) continue

    // Receiver must look like a manager parameter (not this.repo.save)
    const receiver = prop.getExpression()
    if (receiver.getKind() === SyntaxKind.PropertyAccessExpression) continue // skip this.xyz.save
    if (receiver.getKind() === SyntaxKind.ThisKeyword) continue

    const receiverText = receiver.getText()
    if (!MANAGER_PARAM_HINT.test(receiverText) && !receiverText.match(/^[a-z]/)) continue

    const entity = extractEntityName(call)
    const key = `${entity}::${method}`
    if (!seen.has(key)) {
      seen.add(key)
      writes.push({ entity, operation: method })
    }
  }
  return writes
}

/**
 * Extract TypeORM transaction blocks from a method body.
 *
 * Detects:
 *   1. this.dataSource.transaction(async (manager) => { ... })
 *   2. this.entityManager.transaction(async (manager) => { ... })
 */
export function extractTransactions(
  cls: ClassDeclaration,
  method: MethodDeclaration
): TransactionBlock[] {
  const dataAccessFields = getDataAccessFields(cls)
  if (dataAccessFields.size === 0) return []

  const blocks: TransactionBlock[] = []

  for (const callExpr of method.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = callExpr.getExpression()
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue

    const prop    = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression)
    const calledMethod = prop.getName()
    if (calledMethod !== "transaction") continue

    const receiver = prop.getExpression()
    if (receiver.getKind() !== SyntaxKind.PropertyAccessExpression) continue

    const receiverProp = receiver.asKindOrThrow(SyntaxKind.PropertyAccessExpression)
    if (receiverProp.getExpression().getKind() !== SyntaxKind.ThisKeyword) continue

    const fieldName = receiverProp.getName()
    const fieldKind = dataAccessFields.get(fieldName)
    if (fieldKind !== "datasource" && fieldKind !== "queryrunner") continue

    // Found this.dataSource.transaction(...)
    const args = callExpr.getArguments()
    const callback = args[0]
    const writes = callback ? scanCallbackWrites(callback) : []

    blocks.push({
      symbol: `${fieldName}.transaction`,
      writes,
    })
  }

  return blocks
}
