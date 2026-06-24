export interface GuardDescriptor {
  className: string
  args: string[]
  irType: "ir:auth_gate" | "ir:authz_check" | "unknown_guard"
}

import type { SideEffectDescriptor } from "./extractors/side-effect.extractor.js"
import type { ServiceCallDescriptor } from "./extractors/service-call.extractor.js"

export type { SideEffectDescriptor, ServiceCallDescriptor }

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
}
