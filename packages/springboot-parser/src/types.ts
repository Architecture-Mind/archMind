// ---------------------------------------------------------------------------
// Intermediate representation for a parsed Spring Boot controller method.
// ir-emitter.ts converts these to IntermediateExecutionGraph.
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS"

export interface AuthAnnotation {
  kind:       "preAuthorize" | "secured" | "rolesAllowed"
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

export interface SpringControllerMethod {
  filePath:            string
  className:           string
  methodName:          string
  httpMethod:          HttpMethod
  path:                string     // full path (class prefix + method path)
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
  messagingCalls:      string[]   // RabbitTemplate/KafkaTemplate targets
  methodLine:          number     // 1-indexed, for editor integration
}
