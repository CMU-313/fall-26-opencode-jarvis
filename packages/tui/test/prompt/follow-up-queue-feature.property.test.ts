import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { createRoot, createSignal } from "solid-js"
import { createFollowupQueue, shouldQueueFollowup } from "../../src/prompt/followup-queue"

fc.configureGlobal({ seed: 42 })

// Generator choices
// - typedText: random unicode strings wrapped in leading/trailing whitespace (spaces, tabs, newlines),
//   because the interviewees worried about text being trimmed or rewritten (R2).
// - statuses: only "idle", "busy" and "retry", since those are the states the queue actually distinguishes.
// - operation sequences (R1, R3, R6, R7): random interleavings of add / status change / turn finish (and cancel
//   or fail for R6/R7), so the "send on idle, one at a time" logic is exercised in orders a hand-written example
//   never hits. R7 weights status changes and failures up, because its bugs need a failure followed by a
//   specific run of status changes.
// - uniqueArray for texts (R4): unique texts let us tell prompts apart by content in the sent log.
// - R3 laws: statuses include arbitrary strings, since the queue treats every non-"idle" status the same way.
// - R7 scenario property: random sequences rarely produce "fail while busy, then straight to idle", so one
//   property builds that order directly and quantifies over the text and the non-idle statuses.
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
            else if (h.finish() !== undefined) completed++
            await flush()
            // Everything sent so far is a prefix of the added order, and at most one send is in flight.
            expect(h.sent).toEqual(added.slice(0, h.sent.length))
            expect(h.sent.length - completed).toBeLessThanOrEqual(1)
          }
          // Drain: once the session is idle and turns keep finishing, every prompt is sent exactly once, in order.
          for (let i = 0; i < added.length + 2; i++) {
            h.setStatus("idle")
            await flush()
            if (h.finish() !== undefined) completed++
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

  // R3: In queue mode, a queued prompt is not sent until the session goes idle.
  // Kind: invariant
  test("R3: a prompt is only ever sent while the session is idle", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 30 }), async (ops) => {
        await withQueue(async (h) => {
          let status = "busy"
          for (const o of ops) {
            const before = h.sent.length
            if (o.kind === "add") h.add(o.text)
            else if (o.kind === "status") {
              status = o.value
              h.setStatus(o.value)
            } else h.finish()
            await flush()
            // Any send that happened during this step must have happened while idle.
            if (h.sent.length > before) expect(status).toBe("idle")
          }
        })
      }),
      { numRuns: 100 },
    )
  })

  // R3: The queue-or-steer decision. Three laws that together pin the function down without restating it.
  // Kind: algebraic laws, each over generated statuses
  test("R3: a prompt is queued only when the session is busy and the mode is queue", () => {
    const nonIdle = fc.oneof(
      fc.constantFrom("busy", "retry"),
      fc.string().filter((s) => s !== "idle"),
    )
    // Steer mode never queues, whatever the status.
    fc.assert(
      fc.property(fc.oneof(anyStatus, fc.string()), (s) => shouldQueueFollowup(s, "steer") === false),
      { numRuns: 100 },
    )
    // An idle session never queues, whatever the mode.
    fc.assert(
      fc.property(fc.constantFrom("queue", "steer"), (d) => shouldQueueFollowup("idle", d) === false),
      { numRuns: 100 },
    )
    // Queue mode on any non-idle session always queues.
    fc.assert(
      fc.property(nonIdle, (s) => shouldQueueFollowup(s, "queue") === true),
      { numRuns: 100 },
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

  // R7: While the session is open, a queued prompt whose send fails stays visible with an error, and is
  //     removed only when a retry succeeds or the user cancels it.
  // Kind: model / invariant
  // The queue has no explicit Retry action: a failed prompt goes back to the front and is retried on the
  // next turn (status leaves idle, then returns). So "retry" here means a status change to non-idle, and
  // while that retry is in flight the prompt counts as still present.
  // Strengthened in P5: opencode's version only checked that nothing bad happens (safety). It never checked
  // that the retry actually happens, so mutants that never reset the failed flag survived. The liveness
  // assertion at the end of each step closes that gap.
  test("R7: a failed queued prompt stays until a retry succeeds or it is canceled", async () => {
    const op7 = fc.oneof(
      { weight: 3, arbitrary: fc.constant({ kind: "add" as const }) },
      { weight: 4, arbitrary: fc.record({ kind: fc.constant("status" as const), value: anyStatus }) },
      { weight: 1, arbitrary: fc.constant({ kind: "finish" as const }) },
      { weight: 3, arbitrary: fc.constant({ kind: "fail" as const }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant("cancel" as const), index: fc.nat() }) },
    )
    await fc.assert(
      fc.asyncProperty(fc.array(op7, { maxLength: 50 }), async (ops) => {
        await withQueue(async (h) => {
          let count = 0
          let status = "busy"
          // Model of "a failure is waiting for a new turn": set by any failure, cleared when status leaves idle.
          let blocked = false
          const expectedErrors: string[] = []
          // Failed and not yet resolved by a successful retry or a cancel.
          const failed = new Set<string>()
          // Failed and no new turn has started since, so the queue must not resend them yet.
          const awaitingTurn = new Set<string>()
          for (const o of ops) {
            const sentBefore = h.sent.length
            if (o.kind === "add") h.add(`prompt-${count++}`)
            else if (o.kind === "status") {
              if (o.value !== status && o.value !== "idle") {
                awaitingTurn.clear()
                blocked = false
              }
              status = o.value
              h.setStatus(o.value)
            } else if (o.kind === "finish") {
              const text = h.finish()
              if (text !== undefined) failed.delete(text)
            } else if (o.kind === "fail") {
              const text = h.fail()
              if (text !== undefined) {
                blocked = true
                failed.add(text)
                awaitingTurn.add(text)
                expectedErrors.push(`send failed: ${text}`)
              }
            } else {
              const item = h.queue.items[o.index % Math.max(h.queue.items.length, 1)]
              if (item) {
                h.queue.cancel(item.id)
                failed.delete(item.text)
                awaitingTurn.delete(item.text)
              }
            }
            await flush()
            // Every unresolved failure is still visible in the queue, or is the retry currently in flight.
            for (const text of failed) expect([...h.texts(), ...h.inFlight()]).toContain(text)
            // Each failure surfaces exactly one error, carrying the underlying message.
            expect(h.errors).toEqual(expectedErrors)
            // No automatic retry loop: a failed prompt is not resent until a new turn starts.
            for (const text of h.sent.slice(sentBefore)) expect(awaitingTurn.has(text)).toBe(false)
            // The prompt is never shown twice.
            expect(new Set(h.texts()).size).toBe(h.texts().length)
            // Liveness: once a new turn has started, an idle session with nothing in flight has sent everything.
            if (status === "idle" && !blocked && h.inFlight().length === 0) expect(h.texts()).toEqual([])
          }
        })
      }),
      { numRuns: 300 },
    )
  })

  // R7: Returning to idle is not a new turn. A failed prompt is retried only after the status has left idle
  //     and come back, and then it is sent again exactly once.
  // Kind: scenario property (random sequences rarely produce "fail while busy, then straight to idle")
  test("R7: a failed prompt is retried on the next turn, not on returning to idle", async () => {
    await fc.assert(
      fc.asyncProperty(
        typedText,
        fc.constantFrom("busy", "retry"),
        fc.constantFrom("busy", "retry"),
        async (text, whileFailing, nextTurn) => {
          await withQueue(async (h) => {
            h.add(text)
            h.setStatus("idle")
            await flush()
            expect(h.sent).toEqual([text])
            // The turn is running when the send fails.
            h.setStatus(whileFailing)
            await flush()
            expect(h.fail()).toBe(text)
            await flush()
            expect(h.errors).toHaveLength(1)
            // Back to idle without a new turn: no retry, and the prompt is still queued.
            h.setStatus("idle")
            await flush()
            expect(h.sent).toEqual([text])
            expect(h.texts()).toEqual([text])
            // A new turn starts and ends: now the retry goes out, once.
            h.setStatus(nextTurn)
            await flush()
            h.setStatus("idle")
            await flush()
            expect(h.sent).toEqual([text, text])
            expect(h.texts()).toEqual([])
          })
        },
      ),
      { numRuns: 50 },
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
  const pending: { text: string; resolve: () => void; reject: (error: Error) => void }[] = []
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
        return new Promise<void>((resolve, reject) => pending.push({ text, resolve, reject }))
      })
    },
    inFlight: () => pending.map((p) => p.text),
    // Ends the oldest in-flight turn successfully. Returns its text, if there was one.
    finish() {
      const next = pending.shift()
      next?.resolve()
      return next?.text
    },
    // Fails the oldest in-flight send. Returns its text, if there was one.
    fail() {
      const next = pending.shift()
      next?.reject(new Error(`send failed: ${next.text}`))
      return next?.text
    },
  }
}

function flush() {
  return Bun.sleep(0)
}