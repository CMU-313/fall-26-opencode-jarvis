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
  test("selects the oldest uncanceled entry and its position", () => {
    const canceled = { id: "canceled", canceled: true }
    const first = { id: "first", canceled: false }
    const second = { id: "second", canceled: false }
    const selection = nextQueuedFollowup("idle", false, [canceled, first, second])
    expect(selection?.index).toBe(1)
    expect(selection?.next).toBe(first)
  })

  test("blocks dispatch while active, sending, or waiting after failure", () => {
    const followup = { id: "queued", canceled: false }
    expect(nextQueuedFollowup("busy", false, [followup])).toBeUndefined()
    expect(nextQueuedFollowup("retry", false, [followup])).toBeUndefined()
    expect(nextQueuedFollowup("idle", true, [followup])).toBeUndefined()
    expect(nextQueuedFollowup("idle", false, [followup], true)).toBeUndefined()
  })

  test("allows cleanup when no uncanceled entries remain", () => {
    expect(nextQueuedFollowup("idle", false, [])).toEqual({ index: -1, next: undefined })
    expect(nextQueuedFollowup("idle", false, [{ canceled: true }])).toEqual({ index: -1, next: undefined })
  })
})

describe("cancelQueuedFollowup", () => {
  test("marks the selected entry while preserving its position and payload for undo", () => {
    const first = { id: "first", text: "same", send: () => Promise.resolve() }
    const second = { id: "second", text: "same", send: () => Promise.resolve() }
    const items = [first, second]
    const cancellation = cancelQueuedFollowup(items, second.id)
    expect(cancellation?.index).toBe(1)
    expect(cancellation?.item).toEqual({ ...second, canceled: true })
    expect(cancellation?.item.send).toBe(second.send)
    expect(items).toEqual([first, second])
    expect("canceled" in second).toBe(false)
    expect(cancelQueuedFollowup(items, first.id)?.index).toBe(0)
  })

  test("ignores missing and already canceled entries", () => {
    expect(cancelQueuedFollowup([], "missing")).toBeUndefined()
    expect(cancelQueuedFollowup([{ id: "first" }], "missing")).toBeUndefined()
    expect(cancelQueuedFollowup([{ id: "first", canceled: true }], "first")).toBeUndefined()
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

  test("undo stays available behind an in-flight send until dispatch reaches the canceled entry", async () => {
    await withQueue(async (h) => {
      h.add("first")
      h.add("canceled")
      h.add("last")
      const id = h.queue.items[1].id
      h.queue.cancel(id)
      h.setStatus("idle")
      await flush()
      expect(h.sent).toEqual(["first"])
      expect(h.queue.canUndo).toBe(true)

      // Keep undo available until the previous send finishes, even if the session reports idle first.
      h.setStatus("busy")
      h.setStatus("idle")
      await flush()
      expect(h.queue.canUndo).toBe(true)
      h.finish()
      await flush()
      expect(h.sent).toEqual(["first", "last"])
      expect(h.queue.canUndo).toBe(false)
      h.queue.undo()
      expect(h.texts()).toEqual([])
    })
  })

  test("undo restores the original callback after earlier prompts have left the queue", async () => {
    await withQueue(async (h) => {
      h.add("first")
      h.add("restore me")
      h.add("last")
      const original = h.queue.items[1]
      h.queue.cancel(original.id)
      h.setStatus("idle")
      await flush()
      h.queue.undo()
      expect(h.texts()).toEqual(["restore me", "last"])
      expect(h.queue.items[0].id).toBe(original.id)
      expect(h.queue.items[0].send).toBe(original.send)
      expect(h.queue.canUndo).toBe(false)
      h.finish()
      await flush()
      expect(h.sent).toEqual(["first", "restore me"])
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
