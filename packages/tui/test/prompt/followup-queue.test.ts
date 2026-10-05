import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  cancelQueuedFollowup,
  createFollowupQueue,
  nextQueuedFollowup,
  shouldQueueFollowup,
} from "../../src/prompt/followup-queue"

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

describe("createFollowupQueue", () => {
  test("holds follow-ups while the turn runs and sends them in order, one turn at a time", async () => {
    await withQueue(async (h) => {
      h.add("first")
      h.add("second")
      await flush()
      expect(h.sent).toEqual([])
      expect(h.texts()).toEqual(["first", "second"])

      h.setStatus("idle")
      await flush()
      expect(h.sent).toEqual(["first"])
      expect(h.texts()).toEqual(["second"])

      h.setStatus("busy")
      h.finish()
      await flush()
      expect(h.sent).toEqual(["first"])

      h.setStatus("idle")
      await flush()
      expect(h.sent).toEqual(["first", "second"])
      expect(h.texts()).toEqual([])
    })
  })

  test("sends the next follow-up when the request resolves after the session already went idle", async () => {
    await withQueue(async (h) => {
      h.add("first")
      h.add("second")
      h.setStatus("idle")
      await flush()
      expect(h.sent).toEqual(["first"])

      h.setStatus("busy")
      h.setStatus("idle")
      await flush()
      expect(h.sent).toEqual(["first"])

      h.finish()
      await flush()
      expect(h.sent).toEqual(["first", "second"])
    })
  })

  test("cancel removes a specific follow-up and cancelLatest removes the newest", async () => {
    await withQueue(async (h) => {
      h.add("first")
      h.add("second")
      h.add("third")

      h.queue.cancel(h.queue.items[1].id)
      expect(h.texts()).toEqual(["first", "third"])

      h.queue.cancelLatest()
      expect(h.texts()).toEqual(["first"])

      h.queue.cancelLatest()
      h.setStatus("idle")
      await flush()
      expect(h.sent).toEqual([])
    })
  })

  test("a failed send is reported and kept at the front until the next turn ends", async () => {
    await withQueue(async (h) => {
      h.add("first", () => Promise.reject(new Error("offline")))
      h.add("second")
      h.setStatus("idle")
      await flush()

      expect(h.errors).toEqual(["offline"])
      expect(h.texts()).toEqual(["first", "second"])
      expect(h.sent).toEqual([])

      h.setStatus("busy")
      h.setStatus("idle")
      await flush()
      expect(h.errors).toEqual(["offline", "offline"])
    })
  })
})

async function withQueue(fn: (harness: ReturnType<typeof createHarness>) => Promise<void>) {
  await createRoot(async (dispose) => {
    try {
      await fn(createHarness())
    } finally {
      dispose()
    }
  })
}

function createHarness() {
  const [status, setStatus] = createSignal("busy")
  const sent: string[] = []
  const errors: string[] = []
  const pending: (() => void)[] = []
  const queue = createFollowupQueue({
    status,
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
  })
  return {
    queue,
    sent,
    errors,
    setStatus,
    texts: () => queue.items.map((item) => item.text),
    // Sends stay pending like the real prompt request, which resolves only when its turn ends.
    add(text: string, send?: () => Promise<void>) {
      queue.add(
        text,
        send ??
          (() => {
            sent.push(text)
            return new Promise<void>((resolve) => pending.push(resolve))
          }),
      )
    },
    finish() {
      pending.shift()?.()
    },
  }
}

function flush() {
  return Bun.sleep(0)
}
