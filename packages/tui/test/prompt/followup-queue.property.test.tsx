/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import fc from "fast-check"
import { createRoot, createSignal } from "solid-js"
import { DeliveryProvider, useDelivery, type DeliveryMode } from "../../src/context/delivery"
import { createFollowupQueue, shouldQueueFollowup } from "../../src/prompt/followup-queue"

fc.configureGlobal({ seed: 42 })

const prompt = fc.string({ minLength: 1, maxLength: 40 }).filter((text) => text.trim().length > 0)
// A small shared vocabulary makes identical text common while each submission has a separate identity.
const prompts = (minLength: number) =>
  fc.array(fc.constantFrom("run tests", "check output", "review changes"), { minLength, maxLength: 8 })

// R1: A queued follow-up must not be sent to the agent until the current task finishes.
// Kind: invariant. Vary the prompt and the active status, including retrying turns.
test("R1: a queued follow-up waits for the active task to finish", async () => {
  await fc.assert(
    fc.asyncProperty(prompt, fc.constantFrom("busy", "retry"), async (text, activeStatus) => {
      await withQueue(async (h) => {
        h.setStatus(activeStatus)
        h.submit(text, "queue")
        await Bun.sleep(0)
        expect(h.status()).toBe(activeStatus)
        expect(h.items.map((item) => item.text)).toEqual([text])
        expect(h.sent).toEqual([])

        h.setStatus("idle")
        await Bun.sleep(0)
        expect(h.sent).toEqual([{ submission: 0, text }])
        expect(h.items).toHaveLength(0)
        await h.finishTurn()
        expect(h.sent).toEqual([{ submission: 0, text }])
      })
    }),
  )
})

test("R1: idle or Steer submissions send immediately", async () => {
  const immediate = fc.constantFrom(
    ["idle", "queue"] as const,
    ["idle", "steer"] as const,
    ["busy", "steer"] as const,
    ["retry", "steer"] as const,
  )
  await fc.assert(
    fc.asyncProperty(prompt, immediate, async (text, [status, mode]) => {
      await withQueue(async (h) => {
        h.setStatus(status)
        h.submit(text, mode)
        expect(h.sent).toEqual([{ submission: 0, text }])
        expect(h.items).toHaveLength(0)
        await h.finishTurn()
      })
    }),
  )
})

// R3: Switching between Steer and Queue without submitting a new prompt must preserve the current task and all pending queued prompts.
// Kind: round-trip. Generate at least two pending prompts, including repeated text, and compare ordered IDs and text.
test("R3: Queue → Steer → Queue preserves the active task and pending queue", async () => {
  await fc.assert(
    fc.asyncProperty(prompts(2), async (texts) => {
      let h!: ReturnType<typeof createHarness>
      let delivery!: ReturnType<typeof useDelivery>
      function Probe() {
        h = createHarness()
        delivery = useDelivery()
        return <box />
      }

      const app = await testRender(() => (
        <DeliveryProvider>
          <Probe />
        </DeliveryProvider>
      ))
      try {
        delivery.set("queue")
        texts.forEach((text) => h.submit(text, delivery.mode))
        expect(h.items.map((item) => item.text)).toEqual(texts)
        const pending = h.items.map((item) => ({ id: item.id, text: item.text }))

        for (const mode of ["steer", "queue"] as const) {
          delivery.toggle()
          await Bun.sleep(0)
          expect(delivery.mode).toBe(mode)
          expect(h.status()).toBe("busy")
          expect(h.sent).toEqual([])
          expect(h.items.map((item) => ({ id: item.id, text: item.text }))).toEqual(pending)
        }
      } finally {
        app.renderer.destroy()
      }
    }),
  )
})

// R4: Newly queued prompts must be appended after existing prompts without changing their relative order.
// Kind: model/oracle. Generate multiple existing prompts and append a separate submission that can repeat earlier text.
test("R4: a new follow-up appends and dispatches in submission order", async () => {
  await fc.assert(
    fc.asyncProperty(prompts(3), async (texts) => {
      await withQueue(async (h) => {
        const existing = texts.slice(0, -1)
        existing.forEach((text) => h.submit(text, "queue"))
        expect(h.items.map((item) => item.text)).toEqual(existing)
        const existingIDs = h.items.map((item) => item.id)

        h.submit(texts[texts.length - 1], "queue")
        expect(h.items.map((item) => item.text)).toEqual(texts)
        expect(h.items.slice(0, -1).map((item) => item.id)).toEqual(existingIDs)
        await expectDispatch(
          h,
          texts.map((text, submission) => ({ text, submission })),
        )
      })
    }),
  )
})

test("R4: a failed send keeps its place until the next turn finishes", async () => {
  await fc.assert(
    fc.asyncProperty(prompts(2), fc.constantFrom("idle", "busy", "retry"), async (texts, failureStatus) => {
      await withQueue(async (h) => {
        texts.forEach((text) => h.submit(text, "queue"))
        const pendingIDs = h.items.map((item) => item.id)
        const first = { submission: 0, text: texts[0] }
        h.setStatus("idle")
        await Bun.sleep(0)
        expect(h.sent).toEqual([first])

        h.setStatus(failureStatus)
        const error = new Error("send failed")
        await h.failTurn(error)
        h.setStatus("idle")
        await Bun.sleep(0)
        expect(h.errors).toEqual([error])
        expect(h.sent).toEqual([first])
        expect(h.items.map((item) => item.id)).toEqual(pendingIDs)

        h.setStatus("busy")
        await Bun.sleep(0)
        expect(h.sent).toEqual([first])
        h.setStatus("idle")
        await Bun.sleep(0)
        expect(h.sent).toEqual([first, first])
        expect(h.items.map((item) => item.id)).toEqual(pendingIDs.slice(1))
      })
    }),
  )
})

// R5: Canceling a pending prompt must remove only the selected prompt without changing the relative order of the remaining prompts.
// Kind: model/oracle. Choose any valid position, including the sole prompt, and generate repeated text to exercise cancellation by ID.
test("R5: cancellation removes only the selected submission", async () => {
  const cancellation = prompts(1).chain((texts) =>
    fc.record({ texts: fc.constant(texts), index: fc.integer({ min: 0, max: texts.length - 1 }) }),
  )
  await fc.assert(
    fc.asyncProperty(cancellation, async ({ texts, index }) => {
      await withQueue(async (h) => {
        texts.forEach((text) => h.submit(text, "queue"))
        expect(h.items.map((item) => item.text)).toEqual(texts)
        const pending = h.items.map((item) => ({ id: item.id, text: item.text }))
        expect(new Set(pending.map((item) => item.id)).size).toBe(texts.length)
        const remaining = pending.toSpliced(index, 1)

        h.cancel(pending[index].id)
        expect(h.items.map((item) => ({ id: item.id, text: item.text }))).toEqual(remaining)
        await expectDispatch(h, texts.map((text, submission) => ({ text, submission })).toSpliced(index, 1))
      })
    }),
  )
})

test("R5: Cancel Latest removes only the newest submission", async () => {
  await fc.assert(
    fc.asyncProperty(prompts(1), async (texts) => {
      await withQueue(async (h) => {
        texts.forEach((text) => h.submit(text, "queue"))
        const pendingIDs = h.items.map((item) => item.id)
        h.cancelLatest()
        expect(h.items.map((item) => item.id)).toEqual(pendingIDs.slice(0, -1))
        await expectDispatch(
          h,
          texts.slice(0, -1).map((text, submission) => ({ text, submission })),
        )
      })
    }),
  )
})

async function withQueue(run: (h: ReturnType<typeof createHarness>) => Promise<void>) {
  await createRoot(async (dispose) => {
    try {
      await run(createHarness())
    } finally {
      dispose()
    }
  })
}

function createHarness() {
  const [status, setStatus] = createSignal("busy")
  const errors: unknown[] = []
  const queue = createFollowupQueue({
    status,
    onError: (error) => errors.push(error),
  })
  const sent: { text: string; submission: number }[] = []
  const turns: { resolve: () => void; reject: (error: Error) => void }[] = []
  let nextSubmission = 0
  return {
    get items() {
      return queue.items
    },
    cancel: queue.cancel,
    cancelLatest: queue.cancelLatest,
    status,
    setStatus,
    sent,
    errors,
    submit(text: string, mode: DeliveryMode) {
      const submission = nextSubmission++
      const send = () => {
        sent.push({ text, submission })
        return new Promise<void>((resolve, reject) => turns.push({ resolve, reject }))
      }
      // Use the composer's production decision and observe its send callback boundary.
      if (shouldQueueFollowup(status(), mode)) {
        queue.add(text, send)
        return
      }
      void send()
    },
    async finishTurn() {
      turns.shift()?.resolve()
      await Bun.sleep(0)
    },
    async failTurn(error: Error) {
      turns.shift()?.reject(error)
      await Bun.sleep(0)
    },
  }
}

async function expectDispatch(h: ReturnType<typeof createHarness>, expected: typeof h.sent) {
  await Bun.sleep(0)
  expect(h.sent).toEqual([])
  for (const [index] of expected.entries()) {
    h.setStatus("idle")
    await Bun.sleep(0)
    expect(h.sent).toEqual(expected.slice(0, index + 1))
    h.setStatus("busy")
    await h.finishTurn()
    expect(h.sent).toEqual(expected.slice(0, index + 1))
  }
  h.setStatus("idle")
  await Bun.sleep(0)
  expect(h.sent).toEqual(expected)
  expect(h.items).toHaveLength(0)
}
