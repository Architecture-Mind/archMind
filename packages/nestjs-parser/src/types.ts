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

export interface NestJSSemanticRoute {
  method: string
  path: string
  symbol: string
  controllerClass: string
  file: string
  guards: GuardDescriptor[]
  isPublic: boolean
  validationPipe: boolean
  dto: string | null
  sideEffects: SideEffectDescriptor[]
  serviceCalls: ServiceCallDescriptor[]
  transactions: TransactionBlock[]
  responseResource: ResponseResourceDescriptor | null
}
