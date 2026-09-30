import { describe, expect, test } from "bun:test"
import { cancelQueuedFollowup, nextQueuedFollowup, shouldQueueFollowup } from "../../src/prompt/followup-queue"

describe("shouldQueueFollowup", () => {
  test("queues queue-mode follow-ups while a session is active", () => {
    expect(shouldQueueFollowup("busy", "queue")).toBe(true)
    expect(shouldQueueFollowup("retry", "queue")).toBe(true)
  })

  test("sends queue-mode prompts immediately for an idle session", () => {
    expect(shouldQueueFollowup("idle", "queue")).toBe(false)
  })

  test("never locally queues steer prompts", () => {
    expect(shouldQueueFollowup("busy", "steer")).toBe(false)
    expect(shouldQueueFollowup("idle", "steer")).toBe(false)
  })
})

describe("nextQueuedFollowup", () => {
  test("dispatches the oldest queued follow-up when the session becomes idle", () => {
    const first = { id: "first" }
    const second = { id: "second" }

    expect(nextQueuedFollowup("idle", false, [first, second])).toBe(first)
  })

  test("does not dispatch while the session is active or another queue dispatch is in flight", () => {
    const followup = { id: "queued" }

    expect(nextQueuedFollowup("busy", false, [followup])).toBeUndefined()
    expect(nextQueuedFollowup("idle", true, [followup])).toBeUndefined()
  })
})

describe("cancelQueuedFollowup", () => {
  test("removes the only queued follow-up so nothing can dispatch", () => {
    const followup = { id: "queued" }
    const remaining = cancelQueuedFollowup([followup], followup.id)

    expect(remaining).toEqual([])
    expect(nextQueuedFollowup("idle", false, remaining)).toBeUndefined()
  })

  test("removes only the selected follow-up", () => {
    const first = { id: "first" }
    const second = { id: "second" }

    expect(cancelQueuedFollowup([first, second], first.id)).toEqual([second])
    expect(cancelQueuedFollowup([first, second], second.id)).toEqual([first])
  })
})
