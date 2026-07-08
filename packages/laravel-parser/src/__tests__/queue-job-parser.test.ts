import { join } from "path"
import { parseQueuedJob, parseQueuedJobs } from "../queue-job-parser.js"

const FIXTURES = join(process.cwd(), "src/__tests__/fixtures")
const JOBS_DIR = join(FIXTURES, "jobs")

describe("parseQueuedJob", () => {
  test("detects a ShouldQueue job with an explicit $queue property", () => {
    const graph = parseQueuedJob(join(JOBS_DIR, "ProcessReport.php"))
    expect(graph?.source?.type).toBe("queue")
    expect(graph?.source?.trigger).toBe("reports")
    expect(graph?.source?.metadata.class).toBe("ProcessReport")
    expect(graph?.source?.metadata.queue).toBe("reports")
  })

  test("defaults to the 'default' queue when no $queue property is declared", () => {
    const graph = parseQueuedJob(join(JOBS_DIR, "SendWelcomeEmail.php"))
    expect(graph?.source?.trigger).toBe("default")
    expect(graph?.source?.metadata.queue).toBe("default")
  })

  test("returns null for a class that does not implement ShouldQueue", () => {
    const graph = parseQueuedJob(join(JOBS_DIR, "PlainValueObject.php"))
    expect(graph).toBeNull()
  })

  test("entrypoint id is stable and framework-agnostic", () => {
    const graph = parseQueuedJob(join(JOBS_DIR, "ProcessReport.php"))
    expect(graph?.source?.id).toBe("queue:ProcessReport")
    expect(graph?.entrypoint).toBe(graph?.source?.id)
  })
})

describe("parseQueuedJobs", () => {
  test("finds every ShouldQueue class under the project root, including listeners", () => {
    const graphs = parseQueuedJobs(JOBS_DIR)
    const classes = graphs.map((g) => g.source?.metadata.class).sort()
    expect(classes).toEqual(["ProcessReport", "SendWelcomeEmail"])
  })
})
