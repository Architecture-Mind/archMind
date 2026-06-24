import { SyntaxKind } from "ts-morph"
import type { ClassDeclaration, MethodDeclaration } from "ts-morph"

export interface SideEffectDescriptor {
  type: "ir:queue_job" | "ir:event_dispatch" | "ir:mail" | "ir:notification"
  symbol: string
  queued?: boolean
}

type FieldKind = "queue" | "event_emitter" | "mailer" | "notifier"

/**
 * Map constructor-injected fields to their semantic role.
 *
 * Recognises:
 *   @InjectQueue(...)  or  Queue type          → "queue"
 *   EventEmitter2 type                         → "event_emitter"
 *   MailerService / Mailer type                → "mailer"
 *   NotificationService / Notifier / Fcm type  → "notifier"
 */
function getConstructorFieldKinds(cls: ClassDeclaration): Map<string, FieldKind> {
  const map = new Map<string, FieldKind>()

  for (const ctor of cls.getConstructors()) {
    for (const param of ctor.getParameters()) {
      const decoratorNames = param.getDecorators().map((d) => d.getName())
      const typeName = param.getTypeNode()?.getText() ?? ""
      const fieldName = param.getName()

      if (decoratorNames.includes("InjectQueue") || typeName.includes("Queue")) {
        map.set(fieldName, "queue")
      } else if (typeName.includes("EventEmitter")) {
        map.set(fieldName, "event_emitter")
      } else if (typeName.includes("MailerService") || typeName.includes("Mailer")) {
        map.set(fieldName, "mailer")
      } else if (/Notification.*Service|NotificationService|Notifier|FcmService|PushService|FirebaseService/i.test(typeName)) {
        map.set(fieldName, "notifier")
      }
    }
  }

  return map
}

/**
 * Scan a method body for side-effect call expressions:
 *   this.queue.add(jobName, payload)       → ir:queue_job
 *   this.eventEmitter.emit(eventName, ...) → ir:event_dispatch
 *   this.mailer.sendMail(options)          → ir:mail (queued: false)
 */
export function extractSideEffects(
  cls: ClassDeclaration,
  method: MethodDeclaration
): SideEffectDescriptor[] {
  const fieldKinds = getConstructorFieldKinds(cls)
  if (fieldKinds.size === 0) return []

  const results: SideEffectDescriptor[] = []

  for (const callExpr of method.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = callExpr.getExpression()
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue

    const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression)
    const calledMethod = propAccess.getName()
    const receiver = propAccess.getExpression()

    if (receiver.getKind() !== SyntaxKind.PropertyAccessExpression) continue

    const receiverProp = receiver.asKindOrThrow(SyntaxKind.PropertyAccessExpression)
    if (receiverProp.getExpression().getKind() !== SyntaxKind.ThisKeyword) continue

    const fieldName = receiverProp.getName()
    const kind = fieldKinds.get(fieldName)
    if (!kind) continue

    const args = callExpr.getArguments()

    if (kind === "queue" && (calledMethod === "add" || calledMethod === "addBulk")) {
      const jobName = args[0]?.getText().replace(/['"]/g, "") ?? fieldName
      results.push({ type: "ir:queue_job", symbol: jobName })
    } else if (kind === "event_emitter" && calledMethod === "emit") {
      const eventName = args[0]?.getText().replace(/['"]/g, "") ?? "unknown.event"
      results.push({ type: "ir:event_dispatch", symbol: eventName })
    } else if (kind === "mailer" && (calledMethod === "sendMail" || calledMethod === "send")) {
      results.push({ type: "ir:mail", symbol: "sendMail", queued: false })
    } else if (kind === "notifier" && /send|notify|push|dispatch/i.test(calledMethod)) {
      const notifName = args[0]?.getText().replace(/['"]/g, "") ?? calledMethod
      results.push({ type: "ir:notification", symbol: notifName })
    }
  }

  return results
}
