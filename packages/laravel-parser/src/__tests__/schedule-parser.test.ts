import { join } from "path"
import { parseSchedule } from "../schedule-parser.js"

const FIXTURES = join(process.cwd(), "src/__tests__/fixtures")
const KERNEL_FIXTURE = join(FIXTURES, "Kernel.php")

describe("parseSchedule", () => {
  test("parses one graph per scheduled command", () => {
    const graphs = parseSchedule(KERNEL_FIXTURE)
    expect(graphs).toHaveLength(4)
  })

  test("normalizes ->daily() to a 5-field cron expression", () => {
    const graphs = parseSchedule(KERNEL_FIXTURE)
    const g = graphs.find((x) => x.source?.metadata.command === "report:generate")
    expect(g?.source?.type).toBe("cron")
    expect(g?.source?.trigger).toBe("0 0 * * *")
    expect(g?.source?.metadata.expression).toBe("0 0 * * *")
  })

  test("normalizes ->everyFiveMinutes() to a 5-field cron expression", () => {
    const graphs = parseSchedule(KERNEL_FIXTURE)
    const g = graphs.find((x) => x.source?.metadata.command === "emails:send")
    expect(g?.source?.trigger).toBe("*/5 * * * *")
  })

  test("passes through an explicit ->cron() expression unchanged", () => {
    const graphs = parseSchedule(KERNEL_FIXTURE)
    const g = graphs.find((x) => x.source?.metadata.command === "backup:run")
    expect(g?.source?.trigger).toBe("0 3 * * *")
  })

  test("detects job-based schedules with ->hourly()", () => {
    const graphs = parseSchedule(KERNEL_FIXTURE)
    const g = graphs.find((x) => x.source?.metadata.command === "SendHeartbeat")
    expect(g?.source?.type).toBe("cron")
    expect(g?.source?.trigger).toBe("0 * * * *")
  })

  test("entrypoint id is stable and framework-agnostic", () => {
    const graphs = parseSchedule(KERNEL_FIXTURE)
    const g = graphs.find((x) => x.source?.metadata.command === "report:generate")
    expect(g?.source?.id).toBe("schedule:report:generate")
    expect(g?.entrypoint).toBe(g?.source?.id)
  })

  test("returns an empty array when the file has no schedule() method", () => {
    const graphs = parseSchedule(join(FIXTURES, "TaskController.php"))
    expect(graphs).toEqual([])
  })
})
