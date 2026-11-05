import { expect, test } from "bun:test"
import fc from "fast-check"
import { withQueueView } from "../fixture/followup-queue-view"
import { createRoot, createSignal } from "solid-js"
import { createFollowupQueue, shouldQueueFollowup } from "../../src/prompt/followup-queue"

// Duplicate/empty text is intentional: identity must not depend on prompt text.
// Empty and multiple attachments exercise preservation of the complete payload.
const prompt = fc.record({
  // Reserve marker/control strings so generated text cannot impersonate test selectors.
  text: fc
    .oneof(fc.constant(""), fc.constant("same prompt"), fc.string({ maxLength: 80 }))
    .filter((text) => !/q\d+z|Cancel|Undo recent cancel|View more/.test(text)),
  attachments: fc.array(fc.record({ name: fc.string({ maxLength: 20 }), content: fc.string({ maxLength: 80 }) }), {
    maxLength: 3,
  }),
})

// Bias toward the compact-view boundary (3/4) and empty/single-item queues.
const prompts = fc.oneof(
  { withCrossShrink: true },
  fc.array(prompt, { maxLength: 12 }),
  ...[0, 1, 2, 3, 4, 5].map((length) => fc.array(prompt, { minLength: length, maxLength: length })),
)
const cancellation = fc.array(prompt, { minLength: 1, maxLength: 12 }).chain((items) =>
  fc.record({
    items: fc.constant(items),
    index: fc.oneof(fc.constant(0), fc.constant(items.length - 1), fc.integer({ min: 0, max: items.length - 1 })),
  }),
)

// Add short unique display markers so duplicate text, wrapping, and truncation cannot
// make us mistake one prompt for another. Test the real Prompt, not a replica of its JSX.
const visibleCancellation = cancellation.map(({ items, index }) => ({ items: labeled(items), index }))

// R1: Canceling a follow-up makes it disappear while all other queued prompts remain.
// Kind: invariant
test("R1: cancel removes only the selected visible queue entry", async () => {
  await fc.assert(
    fc.asyncProperty(visibleCancellation, async ({ items, index }) => {
      await withQueue(async (h) => {
        items.forEach(h.add)
        await withQueueView(h.queue, async (view) => {
          await view.frame()
          // Expand if implemented so any generated cancellation index is reachable.
          if ((await view.frame()).includes("View more")) await view.click("View more")
          await view.click("Cancel", `q${index}z`)
          const frame = await view.frame()
          expect(frame).not.toContain(`q${index}z`)
          expect(h.queue.items.map((item) => item.text)).toEqual(
            items.filter((_, i) => i !== index).map((item) => item.text),
          )
          // An expanded list may collapse after cancellation; expose the remaining entries again.
          if (frame.includes("View more")) await view.click("View more")
          expect(markers(await view.frame())).toEqual(items.flatMap((_, i) => (i === index ? [] : [`q${i}z`])))
          expect(h.sent).toEqual([])
        })
      })
    }),
    { numRuns: 30 },
  )
}, 30000)

// R2: At four or more follow-ups, show the first and last with expandable intermediate prompts.
// Kind: metamorphic. Start with three, then append prompts to the same rendered queue.
// Generate 4..12 payloads so every run crosses 3 -> 4 and can exercise further appends
test("R2: appending follow-ups collapses at four and preserves endpoints", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(prompt, { minLength: 4, maxLength: 12 }).map(labeled), async (items) => {
      await withQueue(async (h) => {
        items.slice(0, 3).forEach(h.add)
        await withQueueView(h.queue, async (view) => {
          const initial = await view.frame()
          expect(markers(initial)).toEqual(["q0z", "q1z", "q2z"])
          expect(initial).not.toContain("View more")

          for (const [index, item] of items.slice(3).entries()) {
            const before = markers(await view.frame())
            h.add(item)
            const after = await view.frame()
            // Appending preserves the previously visible first prompt, replaces the
            // last endpoint with the new prompt, and hides all intermediate prompts.
            expect(markers(after)).toEqual([before[0], `q${index + 3}z`])
            expect(after).toContain("View more")
            expect(h.sent).toEqual([])
          }

          await view.click("View more")
          expect(markers(await view.frame())).toEqual(items.map((_, i) => `q${i}z`))
          expect(h.sent).toEqual([])
        })
      })
    }),
    { numRuns: 30 },
  )
}, 30000)

// R3: Undo the latest cancellation before dispatch reaches it, preserving prompt, attachments, and order.
// Kind: round-trip
test("R3: cancel then undo restores the exact queue and payloads", async () => {
  await fc.assert(
    fc.asyncProperty(visibleCancellation, async ({ items, index }) => {
      await withQueue(async (h) => {
        items.forEach(h.add)
        await withQueueView(h.queue, async (view) => {
          const before = h.queue.items.map((item) => item.id)
          expect(await view.frame()).not.toContain("Undo recent cancel")
          if ((await view.frame()).includes("View more")) await view.click("View more")
          await view.click("Cancel", `q${index}z`)
          expect(await view.frame()).toContain("Undo recent cancel")
          await view.click("Undo recent cancel")
          expect(await view.frame()).not.toContain("Undo recent cancel")
          expect(h.queue.items.map((item) => item.id)).toEqual(before)
          expect(h.queue.items.map((item) => item.text)).toEqual(items.map((item) => item.text))
          if ((await view.frame()).includes("View more")) await view.click("View more")
          expect(markers(await view.frame())).toEqual(items.map((_, i) => `q${i}z`))
          for (const _ of items) {
            h.setStatus("idle")
            await Bun.sleep(0)
            h.setStatus("busy")
            h.finish()
            await Bun.sleep(0)
          }
          expect(h.sent).toEqual(items)
        })
      })
    }),
    { numRuns: 30 },
  )
}, 30000)

// R3: Only the latest cancellation is undoable; dispatch expires undo without reviving older cancels.
// Kind: invariant
test("R3: latest cancellation expires at dispatch and never falls back", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(prompt, { minLength: 2, maxLength: 3 }).map(labeled),
      fc.boolean(),
      async (items, restore) => {
        await withQueue(async (h) => {
          items.forEach(h.add)
          await withQueueView(h.queue, async (view) => {
            await view.frame()
            await view.click("Cancel", "q0z")
            await view.click("Cancel", "q1z")
            expect(await view.frame()).toContain("Undo recent cancel")
            if (restore) {
              await view.click("Undo recent cancel")
              expect(markers(await view.frame())).toEqual(items.slice(1).map((_, i) => `q${i + 1}z`))
              expect(await view.frame()).not.toContain("Undo recent cancel")
            }
            h.setStatus("idle")
            await Bun.sleep(0)
            expect(await view.frame()).not.toContain("Undo recent cancel")
            expect(h.sent).toEqual(items.slice(restore ? 1 : 2, restore ? 2 : 3))
            h.setStatus("busy")
            h.finish()
            await Bun.sleep(0)
            expect(await view.frame()).not.toContain("Undo recent cancel")
          })
        })
      },
    ),
    { numRuns: 30 },
  )
}, 30000)

// R4: Follow-ups wait during processing, then leave the queue and send oldest first when idle.
// Kind: model / oracle
test("R4: real queue agrees with FIFO across turn completion orderings", async () => {
  await fc.assert(
    fc.asyncProperty(
      prompts,
      fc.constantFrom("busy", "retry"),
      fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
      async (items, active, idleFirst) => {
        await withQueue(async (h) => {
          h.setStatus(active)
          expect(shouldQueueFollowup(active, "queue")).toBe(true)
          expect(shouldQueueFollowup("idle", "queue")).toBe(false)
          items.forEach(h.add)
          await Bun.sleep(0)
          expect(h.sent).toEqual([])
          expect(h.queue.items.map((item) => item.text)).toEqual(items.map((item) => item.text))
          h.setStatus("idle")
          await Bun.sleep(0)
          for (const [index] of items.entries()) {
            expect(h.sent).toEqual(items.slice(0, index + 1))
            expect(h.queue.items.map((item) => item.text)).toEqual(items.slice(index + 1).map((item) => item.text))
            h.setStatus(active)
            await Bun.sleep(0)
            if (idleFirst[index]) {
              h.setStatus("idle")
              await Bun.sleep(0)
              expect(h.sent).toEqual(items.slice(0, index + 1))
              h.finish()
            } else {
              h.finish()
              await Bun.sleep(0)
              expect(h.sent).toEqual(items.slice(0, index + 1))
              h.setStatus("idle")
            }
            await Bun.sleep(0)
          }
          expect(h.sent).toEqual(items)
          expect(h.queue.items).toEqual([])
        })
      },
    ),
  )
})

type Payload = typeof prompt extends fc.Arbitrary<infer T> ? T : never

async function withQueue(run: (h: ReturnType<typeof harness>) => Promise<void>) {
  await createRoot(async (dispose) => {
    try {
      await run(harness())
    } finally {
      dispose()
    }
  })
}

function harness() {
  const [status, setStatus] = createSignal("busy")
  const sent: Payload[] = []
  const pending: (() => void)[] = []
  const queue = createFollowupQueue({
    status,
    onError: (error) => {
      throw error
    },
  })
  return {
    queue,
    setStatus,
    sent,
    add(item: Payload) {
      queue.add(item.text, () => {
        sent.push(structuredClone(item))
        return new Promise<void>((resolve) => pending.push(resolve))
      })
    },
    finish() {
      pending.shift()?.()
    },
  }
}

// Markers identify rows without constraining generated prompt contents to be unique.
function labeled(items: Payload[]) {
  return items.map((item, index) => ({ ...item, text: `q${index}z ${item.text}` }))
}

function markers(frame: string) {
  return Array.from(frame.matchAll(/\bq\d+z\b/g), (match) => match[0])
}
