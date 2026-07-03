export interface GuardDescriptor {
  className: string
  args: string[]
  irType: "ir:auth_gate" | "ir:authz_check" | "unknown_guard"
}

import type { SideEffectDescriptor } from "./extractors/side-effect.extractor.js"
import type { ServiceCallDescriptor } from "./extractors/service-call.extractor.js"
import type { TransactionBlock } from "./extractors/transaction.extractor.js"
import type { ResponseResourceDescriptor } from "./extractors/response.extractor.js"

export type { SideEffectDescriptor, ServiceCallDescriptor, TransactionBlock, ResponseResourceDescriptor }

export type EntrypointKind = "http" | "cron"

// Metadata for a method entered via @Cron (@nestjs/schedule).
export interface CronMetadata {
  expression: string   // raw first-arg text, e.g. "45 * * * * *" or "CronExpression.EVERY_MINUTE"
}

export interface NestJSSemanticRoute {
  kind: EntrypointKind
  method: string    // "GET" | "POST" | ... for kind "http"; "CRON" for kind "cron"
  path: string       // URL path for kind "http"; cron expression for kind "cron"
  symbol: string
  controllerClass: string
  file: string
  line: number
  guards: GuardDescriptor[]
  isPublic: boolean
  validationPipe: boolean
  dto: string | null
  sideEffects: SideEffectDescriptor[]
  serviceCalls: ServiceCallDescriptor[]
  transactions: TransactionBlock[]
  responseResource: ResponseResourceDescriptor | null
  cron?: CronMetadata   // set when kind === "cron"
}
