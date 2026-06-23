// Field-level validation contract — framework-agnostic.
// Used by nestjs-parser and laravel-parser to describe DTO/FormRequest fields.

export type FieldType = "string" | "number" | "boolean" | "object" | "array" | "unknown"

export type RuleKind =
  | "required" | "optional"
  | "email" | "url" | "uuid"
  | "min" | "max"
  | "minLength" | "maxLength"
  | "integer" | "positive" | "negative"
  | "boolean" | "array"
  | "arrayMinSize" | "arrayMaxSize"
  | "enum" | "regex" | "isIn"
  | "date" | "phone" | "ethereumAddress"
  | "alphanumeric" | "numberString"

export interface ValidationRule {
  kind: RuleKind
  value?: number | string | string[]
}

export interface FieldSchema {
  name:  string
  type:  FieldType
  rules: ValidationRule[]
}

export interface DTOSchema {
  className: string
  /** Relative path to the source file inside the scanned project */
  file:      string
  fields:    FieldSchema[]
}
