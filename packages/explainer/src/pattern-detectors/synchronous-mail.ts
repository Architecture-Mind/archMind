import type { IntermediateExecutionGraph } from "@kidkender/archmind-protocol"
import { IR_NODE_TYPES } from "@kidkender/archmind-protocol"
import { query } from "@kidkender/archmind-graph-query"
import type { Finding } from "../findings/types.js"
import { FINDING_TYPES } from "../findings/types.js"
import { stableHash } from "../findings/stable-hash.js"

interface MailDetail {
  className?: string
  queued?:    boolean
}

function parseDetail(raw: unknown): MailDetail | null {
  if (!raw) return null
  if (typeof raw === "object") return raw as MailDetail
  try { return JSON.parse(raw as string) as MailDetail } catch { return null }
}

/**
 * Detects ir:mail nodes where queued=false — synchronous Mail::to()->send()
 * inside an HTTP request handler. This blocks the response until the SMTP
 * call completes, adding latency proportional to mail server round-trip.
 *
 * Queued mail (Mail::to()->queue()) is intentionally excluded.
 */
export function detectSynchronousMail(
  graph: IntermediateExecutionGraph
): Finding[] {
  const q = query(graph)
  const ctrlNode = q.nodes().ofType(IR_NODE_TYPES.BUSINESS_HANDLER).first()
  if (!ctrlNode) return []

  const syncMailNodes = q.messaging().mails().toArray().filter((n) => {
    const detail = parseDetail(n.detail)
    return detail !== null && detail.queued === false
  })

  if (syncMailNodes.length === 0) return []

  return syncMailNodes.map((mailNode) => {
    const detail  = parseDetail(mailNode.detail)
    const clsName = detail?.className ?? mailNode.symbol.split("::")[0] ?? mailNode.symbol

    return {
      id:         `${FINDING_TYPES.SYNCHRONOUS_MAIL}-${stableHash([mailNode.id])}`,
      type:       FINDING_TYPES.SYNCHRONOUS_MAIL,
      severity:   "MEDIUM",
      confidence: "HIGH",
      provenance: {
        detector:            FINDING_TYPES.SYNCHRONOUS_MAIL,
        ontology_primitives: ["Mail", "SynchronousIO"],
        supporting_nodes:    [ctrlNode.id, mailNode.id],
        supporting_edges:    graph.edges
          .filter((e) => e.from === ctrlNode.id && e.to === mailNode.id)
          .map((e) => `${e.from}:${e.relation}:${e.to}`),
      },
      summary: `${clsName} is sent synchronously inside ${ctrlNode.symbol} — SMTP blocks the HTTP response`,
      reasoning: [
        {
          type:        "synchronous_mail_detected",
          mailable:    clsName,
          note:        "Mail::to()->send() dispatches synchronously on the request thread",
        },
        {
          type:        "latency_risk",
          description: "SMTP round-trip (100ms–3s) adds tail latency to every request that sends mail",
        },
        {
          type:        "reliability_risk",
          description: "If the mail server is unavailable, the HTTP response fails even if the business operation succeeded",
        },
      ],
      evidence: [
        {
          nodeId:      mailNode.id,
          description: `${clsName} sent synchronously (queued=false)`,
          detail:      "Detected via Mail::to()->send() — not Mail::to()->queue()",
        },
        {
          nodeId:      ctrlNode.id,
          description: `${ctrlNode.symbol} blocks until mail is delivered`,
        },
      ],
      recommendations: [
        `Replace Mail::to($recipient)->send(new ${clsName}()) with Mail::to($recipient)->queue(new ${clsName}())`,
        `Or use Mail::later(Carbon::now()->addSeconds(5), new ${clsName}()) to delay and deccouple`,
        `Ensure ${clsName} implements ShouldQueue if queue-based delivery is preferred`,
        `Add a fallback notification if mail queuing is unavailable in the deployment environment`,
      ],
    }
  })
}
