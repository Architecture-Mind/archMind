import { SyntaxKind } from "ts-morph"
import type { ClassDeclaration, MethodDeclaration } from "ts-morph"

export interface ServiceCallDescriptor {
  serviceClass: string  // e.g. "TaskService"
  method:       string  // e.g. "findById"
  symbol:       string  // e.g. "TaskService::findById"
}

// Infrastructure types that are NOT domain services
const INFRA_TYPE_PATTERNS = [
  /Queue/i,
  /EventEmitter/i,
  /Mailer/i,
  /Repository$/,
  /EntityManager/,
  /DataSource/,
  /Connection/,
  /Logger/i,
  /ConfigService/,
  /HttpService/,
  /HttpClient/,
]

const INFRA_DECORATOR_NAMES = new Set(["InjectQueue", "Inject", "InjectRepository"])

function isInfraType(typeName: string, decoratorNames: string[]): boolean {
  if (decoratorNames.some(d => INFRA_DECORATOR_NAMES.has(d))) return true
  return INFRA_TYPE_PATTERNS.some(p => p.test(typeName))
}

/**
 * Map constructor-injected fields to their service class name.
 * Skips infrastructure-type injections (queue, event emitter, mailer, etc).
 */
function getServiceFields(cls: ClassDeclaration): Map<string, string> {
  const map = new Map<string, string>()

  for (const ctor of cls.getConstructors()) {
    for (const param of ctor.getParameters()) {
      const decoratorNames = param.getDecorators().map(d => d.getName())
      const typeName       = param.getTypeNode()?.getText() ?? ""
      const fieldName      = param.getName()

      // Skip non-class types (primitives, generics that aren't PascalCase services)
      if (!typeName || !/^[A-Z]/.test(typeName)) continue
      if (isInfraType(typeName, decoratorNames)) continue

      map.set(fieldName, typeName)
    }
  }

  return map
}

/**
 * Scan a method body for `this.service.method()` call expressions.
 * Returns one descriptor per unique (serviceClass, method) pair.
 */
export function extractServiceCalls(
  cls: ClassDeclaration,
  method: MethodDeclaration
): ServiceCallDescriptor[] {
  const serviceFields = getServiceFields(cls)
  if (serviceFields.size === 0) return []

  const results: ServiceCallDescriptor[] = []
  const seen = new Set<string>()

  for (const callExpr of method.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = callExpr.getExpression()
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue

    const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression)
    const calledMethod = propAccess.getName()
    const receiver     = propAccess.getExpression()

    // Must be this.fieldName.method() — receiver is this.fieldName
    if (receiver.getKind() !== SyntaxKind.PropertyAccessExpression) continue

    const receiverProp = receiver.asKindOrThrow(SyntaxKind.PropertyAccessExpression)
    if (receiverProp.getExpression().getKind() !== SyntaxKind.ThisKeyword) continue

    const fieldName    = receiverProp.getName()
    const serviceClass = serviceFields.get(fieldName)
    if (!serviceClass) continue

    const symbol = `${serviceClass}::${calledMethod}`
    if (seen.has(symbol)) continue
    seen.add(symbol)

    results.push({ serviceClass, method: calledMethod, symbol })
  }

  return results
}
