import type { OtelSpan, TraceSession } from "@kidkender/archmind-protocol"
import { readFileSync } from "fs"
import { normalizeAttributes, extractEntrypoint, computeDurationMs } from "./normalize-spans.js"

interface OtlpAttribute {
  key: string
  value: {
    stringValue?: string
    intValue?: number
    boolValue?: boolean
    doubleValue?: number
  }
}

interface OtlpRawSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes?: OtlpAttribute[]
  status?: { code: number; message?: string }
}

interface OtlpJson {
  resourceSpans?: Array<{
    resource?: { attributes?: OtlpAttribute[] }
    scopeSpans?: Array<{
      scope?: { name?: string; version?: string }
      spans?: OtlpRawSpan[]
    }>
  }>
}

function flattenAttributes(attrs: OtlpAttribute[] = []): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {}
  for (const a of attrs) {
    const v = a.value
    if (v.stringValue !== undefined)  result[a.key] = v.stringValue
    else if (v.intValue !== undefined)    result[a.key] = v.intValue
    else if (v.boolValue !== undefined)   result[a.key] = v.boolValue
    else if (v.doubleValue !== undefined) result[a.key] = v.doubleValue
  }
  return result
}

function parseRawSpan(raw: OtlpRawSpan): OtelSpan {
  return {
    traceId:          raw.traceId,
    spanId:           raw.spanId,
    parentSpanId:     raw.parentSpanId || undefined,
    name:             raw.name,
    kind:             raw.kind,
    startTimeUnixNano: raw.startTimeUnixNano,
    endTimeUnixNano:  raw.endTimeUnixNano,
    attributes:       flattenAttributes(raw.attributes),
    status:           raw.status,
  }
}

export function parseOtlpJson(json: OtlpJson): TraceSession {
  const spans: OtelSpan[] = []
  let serviceVersion: string | undefined

  for (const rs of json.resourceSpans ?? []) {
    const resourceAttrs = flattenAttributes(rs.resource?.attributes)
    if (!serviceVersion && resourceAttrs["service.version"]) {
      serviceVersion = String(resourceAttrs["service.version"])
    }
    for (const ss of rs.scopeSpans ?? []) {
      for (const raw of ss.spans ?? []) {
        spans.push(parseRawSpan(raw))
      }
    }
  }

  const normalized = normalizeAttributes(spans)
  const entrypoint = extractEntrypoint(normalized)
  const totalDuration = computeDurationMs(normalized)

  return {
    sessionId:      spans[0]?.traceId ?? crypto.randomUUID(),
    entrypoint,
    durationMs:     totalDuration,
    spans:          normalized,
    recordedAt:     new Date().toISOString(),
    framework:      "laravel",
    serviceVersion,
  }
}

export function ingestOtlpFile(filePath: string): TraceSession {
  const raw = JSON.parse(readFileSync(filePath, "utf-8")) as OtlpJson
  return parseOtlpJson(raw)
}
