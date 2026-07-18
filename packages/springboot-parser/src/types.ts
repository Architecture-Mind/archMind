// ---------------------------------------------------------------------------
// Intermediate representation for a parsed Spring Boot controller method.
// ir-emitter.ts converts these to IntermediateExecutionGraph.
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS"

export interface AuthAnnotation {
  // "unknown" = an auth-shaped annotation we can't classify (custom framework
  // annotation, e.g. SpringBlade's @PreAuth or Shiro's @RequiresRoles) — emitted
  // as ir:unknown_middleware instead of a guessed auth_gate/authz_check so the
  // LLM sees "there IS a security signal here, but I can't tell you its shape"
  // rather than silently reading it as no-auth.
  kind:       "preAuthorize" | "secured" | "rolesAllowed" | "unknown"
  expression: string    // raw annotation value, e.g. "hasRole('ADMIN')"
  isAuthOnly: boolean   // true when the expression only checks isAuthenticated()
}

export interface ServiceCall {
  fieldName:  string    // injected field name, e.g. "orderService"
  fieldType:  string    // class name, e.g. "OrderService"
  method:     string    // called method, e.g. "createOrder"
}

export interface DataAccessCall {
  fieldName:  string    // e.g. "orderRepository"
  fieldType:  string    // e.g. "OrderRepository"
  method:     string    // e.g. "findById" | "save"
  isWrite:    boolean   // save/delete/update/deleteById
}

export interface EventPublication {
  className: string     // event class name, e.g. "OrderCreatedEvent"
  insideTxn: boolean    // true when inside an @Transactional method
}

export type EntrypointKind = "http" | "queue" | "cron"

// Metadata for a method entered via a message listener
// (@KafkaListener / @RabbitListener / @JmsListener).
export interface MessagingEntrypointMetadata {
  annotation:  string          // "KafkaListener" | "RabbitListener" | "JmsListener"
  destination: string          // topic / queue / destination name
  groupId?:    string          // Kafka consumer group, when present
}

// Metadata for a method entered via @Scheduled.
export interface ScheduledEntrypointMetadata {
  cron?:        string
  fixedRate?:   string
  fixedDelay?:  string
}

export interface SpringControllerMethod {
  filePath:            string
  className:           string
  methodName:          string
  kind:                EntrypointKind
  httpMethod?:         HttpMethod   // set when kind === "http"
  path?:               string       // full path (class prefix + method path); set when kind === "http"
  messaging?:          MessagingEntrypointMetadata  // set when kind === "queue"
  schedule?:           ScheduledEntrypointMetadata  // set when kind === "cron"
  authAnnotations:     AuthAnnotation[]
  hasValidation:       boolean    // @Valid on any parameter
  validatedParamTypes: string[]   // e.g. ["CreateOrderRequest"]
  isTransactional:     boolean    // @Transactional on method or class
  readOnly:            boolean    // @Transactional(readOnly=true)
  serviceCalls:        ServiceCall[]
  dataAccessCalls:     DataAccessCall[]
  eventPublications:   EventPublication[]
  asyncCalls:          string[]   // @Async method targets
  mailCalls:           string[]   // JavaMailSender.send targets
  messagingCalls:      string[]   // RabbitTemplate/KafkaTemplate targets (outgoing calls, not the listener itself)
  methodLine:          number     // 1-indexed, for editor integration
}
