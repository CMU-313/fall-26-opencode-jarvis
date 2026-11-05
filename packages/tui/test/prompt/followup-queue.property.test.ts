import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { createRoot, createSignal } from "solid-js"
import { createFollowupQueue } from "../../src/prompt/followup-queue"

// Generator choices
// - typedText: random unicode strings wrapped in leading/trailing whitespace (spaces, tabs, newlines),
//   because the interviewees worried about text being trimmed or rewritten (R2).
// - statuses: only "idle", "busy" and "retry", since those are the states the queue actually distinguishes.
// - operation sequences (R1, R6): random interleavings of add / status change / turn finish (and cancel for R6),
//   so the "send on idle, one at a time" logic is exercised in orders a hand-written example never hits.
// - uniqueArray for texts (R4): unique texts let us tell prompts apart by content in the sent log.
const padding = fc.constantFrom("", " ", "  ", "\t", "\n", "\r\n")
const typedText = fc.tuple(padding, fc.string({ unit: "binary" }), padding).map(([a, b, c]) => a + b + c)
const uniqueTexts = (minLength: number, maxLength: number) => fc.uniqueArray(typedText, { minLength, maxLength })
const anyStatus = fc.constantFrom("idle", "busy", "retry")

const op = fc.oneof(
  fc.record({ kind: fc.constant("add" as const), text: typedText }),
  fc.record({ kind: fc.constant("status" as const), value: anyStatus }),
  fc.constant({ kind: "finish" as const }),
)

describe("followup queue properties", () => {
  // R1: Several queued prompts are sent in the order they were queued (FIFO), one at a time, without crashing.
  // Kind: model / oracle
  test("R1: queued prompts are sent FIFO, one at a time", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 30 }), async (ops) => {
        await withQueue(async (h) => {
          const added: string[] = []
          let completed = 0
          for (const o of ops) {
            if (o.kind === "add") {
              added.push(o.text)
              h.add(o.text)
            } else if (o.kind === "status") h.setStatus(o.value)
            else if (h.finish()) completed++
            await flush()
            // Everything sent so far is a prefix of the added order, and at most one send is in flight.
            expect(h.sent).toEqual(added.slice(0, h.sent.length))
            expect(h.sent.length - completed).toBeLessThanOrEqual(1)
          }
          // Drain: once the session is idle and turns keep finishing, every prompt is sent exactly once, in order.
          for (let i = 0; i < added.length + 2; i++) {
            h.setStatus("idle")
            await flush()
            if (h.finish()) completed++
            await flush()
          }
          expect(h.sent).toEqual(added)
          expect(h.errors).toEqual([])
        })
      }),
      { numRuns: 100 },
    )
  })

  // R2: A queued prompt is sent with exactly the text the user typed.
  // Kind: round-trip
  test("R2: queued text is sent exactly as typed", async () => {
    await fc.assert(
      fc.asyncProperty(typedText, async (text) => {
        await withQueue(async (h) => {
          h.add(text)
          expect(h.queue.items[0].text).toBe(text)
          h.setStatus("idle")
          await flush()
          expect(h.sent).toEqual([text])
        })
      }),
      // The acceptance-criteria example, including its trailing space, is always tried.
      { numRuns: 100, examples: [["Find and fix the bug in ‘index.ts’ "]] },
    )
  })

  // R4: Cancelling a queued prompt removes it completely, and the input box is left alone.
  // Kind: metamorphic
  test("R4: cancelling a queued prompt is the same as never queuing it", async () => {
    await fc.assert(
      fc.asyncProperty(uniqueTexts(1, 10), fc.nat(), async (texts, n) => {
        const cancelIndex = n % texts.length
        const withCancel = await runToCompletion(texts, cancelIndex)
        const withoutPrompt = await runToCompletion(texts.filter((_, i) => i !== cancelIndex))
        expect(withCancel).toEqual(withoutPrompt)
        expect(withCancel).not.toContain(texts[cancelIndex])
      }),
      { numRuns: 100 },
    )
  })

  // R6: When a queued prompt is sent, it appears once in the history as its own entry right after
  //     the last agent response, and it leaves the queued list.
  // Kind: invariant
  test("R6: a queued prompt is sent once and leaves the queued list", async () => {
    const op6 = fc.oneof(
      fc.constant({ kind: "add" as const }),
      fc.record({ kind: fc.constant("status" as const), value: anyStatus }),
      fc.constant({ kind: "finish" as const }),
      fc.constant({ kind: "cancelLatest" as const }),
    )
    await fc.assert(
      fc.asyncProperty(fc.array(op6, { maxLength: 30 }), async (ops) => {
        await withQueue(async (h) => {
          const added: string[] = []
          const canceled: string[] = []
          const check = () => {
            const queued = h.texts()
            // Never queued and sent at once, never sent twice.
            for (const text of h.sent) expect(queued).not.toContain(text)
            expect(new Set(h.sent).size).toBe(h.sent.length)
            // Nothing is lost or invented: queued + sent + canceled is exactly what was added.
            expect([...queued, ...h.sent, ...canceled].sort()).toEqual([...added].sort())
          }
          for (const o of ops) {
            if (o.kind === "add") {
              const text = `prompt-${added.length}`
              added.push(text)
              h.add(text)
            } else if (o.kind === "status") h.setStatus(o.value)
            else if (o.kind === "finish") h.finish()
            else {
              const last = h.texts().at(-1)
              h.queue.cancelLatest()
              if (last !== undefined) canceled.push(last)
            }
            await flush()
            check()
          }
        })
      }),
      { numRuns: 100 },
    )
  })
})

// Queues every text while busy, cancels one (optionally), then lets the session go idle and finishes turns
// until nothing is left. Returns the order in which prompts were sent.
async function runToCompletion(texts: string[], cancelIndex?: number) {
  return withQueue(async (h) => {
    for (const text of texts) h.add(text)
    if (cancelIndex !== undefined) h.queue.cancel(h.queue.items[cancelIndex].id)
    for (let i = 0; i < texts.length + 2; i++) {
      h.setStatus("idle")
      await flush()
      h.finish()
      await flush()
    }
    return [...h.sent]
  })
}

async function withQueue<T>(fn: (harness: ReturnType<typeof createHarness>) => Promise<T>): Promise<T> {
  return createRoot(async (dispose) => {
    try {
      return await fn(createHarness())
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
    add(text: string) {
      queue.add(text, () => {
        sent.push(text)
        return new Promise<void>((resolve) => pending.push(resolve))
      })
    },
    // Ends the oldest in-flight turn. Returns whether there was one.
    finish() {
      const resolve = pending.shift()
      resolve?.()
      return resolve !== undefined
    },
  }
}

function flush() {
  return Bun.sleep(0)
}