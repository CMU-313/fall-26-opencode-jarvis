import { expect, test } from "bun:test"
import fc from "fast-check"
import { withQueueView } from "../fixture/followup-queue-view"
import { createRoot, createSignal } from "solid-js"
import { createFollowupQueue, shouldQueueFollowup } from "../../src/prompt/followup-queue"

fc.configureGlobal({ seed: 42 })

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
    { numRuns: 5 },
  )
}, 30000)

// R2: Generated queues cross the collapse boundary in both directions, including
// mounting with an existing queue and shrinking an expanded queue before regrowing it.
// Kind: metamorphic
test("R2: appending follow-ups collapses at four and preserves endpoints", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(prompt, { minLength: 5, maxLength: 12 }).map(labeled), async (items) => {
      await withQueue(async (h) => {
        items.forEach(h.add)
        await withQueueView(h.queue, async (view) => {
          expectCollapsed(await view.frame(), "q0z", `q${items.length - 1}z`)
          await view.click("View more")
          expect(markers(await view.frame())).toEqual(items.map((_, i) => `q${i}z`))

          for (const index of items.map((_, i) => i).slice(3).reverse()) {
            await view.click("Cancel", `q${index}z`)
            const frame = await view.frame()
            expect(markers(frame)).toEqual(items.slice(0, index).map((_, i) => `q${i}z`))
            expect(frame).not.toContain("View more")
            if (index >= 4) expect(frame).toContain("View less")
            if (index === 3) expect(frame).not.toContain("View less")
          }

          for (const [index, item] of items.slice(3).entries()) {
            h.add(item)
            expectCollapsed(await view.frame(), "q0z", `q${index + 3}z`)
            expect(h.sent).toEqual([])
          }

          await view.click("View more")
          const expanded = await view.frame()
          expect(markers(expanded)).toEqual(items.map((_, i) => `q${i}z`))
          expect(expanded).not.toContain("View more")
          await view.click("View less")
          expectCollapsed(await view.frame(), "q0z", `q${items.length - 1}z`)
          expect(h.sent).toEqual([])
        })
      })
    }),
    { numRuns: 3 },
  )
}, 30000)

// R3: Undo the latest cancellation before dispatch reaches it, preserving prompt, attachments, and order.
// Kind: round-trip
test("R3: cancel then undo restores the exact queue and payloads", async () => {
  await fc.assert(
    fc.asyncProperty(cancellation, async ({ items, index }) => {
      await withQueue(async (h) => {
        items.forEach(h.add)
        const before = h.queue.items.map((item) => ({ ...item }))
        expect(h.queue.canUndo).toBe(false)
        h.queue.cancel(before[index].id)
        expect(h.queue.canUndo).toBe(true)
        expect(h.queue.items.map((item) => item.id)).toEqual(before.filter((_, i) => i !== index).map((item) => item.id))
        h.queue.undo()
        expect(h.queue.canUndo).toBe(false)
        expect(h.queue.items.map((item) => item.id)).toEqual(before.map((item) => item.id))
        expect(h.queue.items.map((item) => item.text)).toEqual(items.map((item) => item.text))
        h.queue.items.forEach((item, i) => expect(item.send).toBe(before[i].send))
        h.queue.undo()
        expect(h.queue.items.map((item) => item.id)).toEqual(before.map((item) => item.id))
        for (const _ of items) {
          h.setStatus("idle")
          await Bun.sleep(0)
          h.setStatus("busy")
          h.finish()
          await Bun.sleep(0)
        }
        expect(h.sent).toEqual(items)
      })
    }),
  )
}, 30000)

// R3: Only the latest cancellation is undoable; dispatch expires undo without reviving older cancels.
// Kind: invariant
test("R3: latest cancellation expires at dispatch and never falls back", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(prompt, { minLength: 2, maxLength: 12 }).chain((items) =>
        fc.record({
          items: fc.constant(items),
          indices: fc.shuffledSubarray(items.map((_, index) => index), { minLength: 2, maxLength: 2 }),
        }),
      ),
      fc.boolean(),
      async ({ items, indices }, restore) => {
        await withQueue(async (h) => {
          items.forEach(h.add)
          const before = h.queue.items.map((item) => ({ ...item }))
          h.queue.cancel(before[indices[0]].id)
          h.queue.cancel(before[indices[1]].id)
          expect(h.queue.canUndo).toBe(true)
          if (restore) {
            h.queue.undo()
            expect(h.queue.canUndo).toBe(false)
          }
          const expected = items.filter((_, index) => index !== indices[0] && (restore || index !== indices[1]))
          const ids = before.filter((_, index) => index !== indices[0] && (restore || index !== indices[1])).map((item) => item.id)
          expect(h.queue.items.map((item) => item.id)).toEqual(ids)
          if (restore) {
            h.queue.undo()
            expect(h.queue.items.map((item) => item.id)).toEqual(ids)
          }
          for (const index of Array.from({ length: expected.length + 1 }, (_, index) => index)) {
            h.setStatus("idle")
            await Bun.sleep(0)
            expect(h.sent).toEqual(expected.slice(0, index + 1))
            expect(h.queue.items.map((item) => item.text)).toEqual(expected.slice(index + 1).map((item) => item.text))
            // Dispatch has skipped the latest cancellation once all preceding active entries have sent.
            const preceding = before.slice(0, indices[1]).filter((_, i) => i !== indices[0]).length
            if (!restore && index < preceding) expect(h.queue.canUndo).toBe(true)
            if (restore || index >= preceding) {
              expect(h.queue.canUndo).toBe(false)
              const remaining = h.queue.items.map((item) => item.id)
              h.queue.undo()
              expect(h.queue.items.map((item) => item.id)).toEqual(remaining)
            }
            h.setStatus("busy")
            h.finish()
            await Bun.sleep(0)
          }
          expect(h.queue.canUndo).toBe(false)
          expect(h.queue.items).toEqual([])
          expect(h.sent).toEqual(expected)
        })
      },
    ),
  )
}, 30000)

// R3: Cancellation remains reversible while earlier generated prompts are in flight.
// Kind: round-trip across dispatch boundaries
test("R3: undo behind an in-flight prompt preserves remaining payloads and order", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(prompt, { minLength: 2, maxLength: 12 }).chain((items) =>
        fc.record({ items: fc.constant(items), index: fc.integer({ min: 1, max: items.length - 1 }) }),
      ),
      async ({ items, index }) => {
        await withQueue(async (h) => {
          items.forEach(h.add)
          const before = h.queue.items.map((item) => ({ ...item }))
          h.queue.cancel(before[index].id)
          for (const [position] of items.slice(0, index).entries()) {
            h.setStatus("idle")
            await Bun.sleep(0)
            expect(h.sent).toEqual(items.slice(0, position + 1))
            expect(h.queue.canUndo).toBe(true)
            h.setStatus("busy")
            if (position < index - 1) {
              h.finish()
              await Bun.sleep(0)
            }
          }
          h.queue.undo()
          expect(h.queue.canUndo).toBe(false)
          expect(h.queue.items.map((item) => item.id)).toEqual(before.slice(index).map((item) => item.id))
          h.queue.items.forEach((item, i) => expect(item.send).toBe(before[index + i].send))
          h.finish()
          await Bun.sleep(0)
          for (const _ of items.slice(index)) {
            h.setStatus("idle")
            await Bun.sleep(0)
            h.setStatus("busy")
            h.finish()
            await Bun.sleep(0)
          }
          expect(h.sent).toEqual(items)
          expect(h.queue.items).toEqual([])
        })
      },
    ),
  )
}, 30000)

// R4: Emptying a queue through cancellation must not block later generated inputs.
// Kind: metamorphic
test("R4: a fully canceled queue can accept and dispatch a new batch", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(prompt, { minLength: 1, maxLength: 12 }),
      fc.array(prompt, { minLength: 1, maxLength: 12 }),
      async (canceled, fresh) => {
        await withQueue(async (h) => {
          canceled.forEach(h.add)
          h.queue.items.map((item) => item.id).forEach((id) => h.queue.cancel(id))
          h.setStatus("idle")
          await Bun.sleep(0)
          expect(h.sent).toEqual([])
          expect(h.queue.items).toEqual([])
          expect(h.queue.canUndo).toBe(false)
          h.setStatus("busy")
          fresh.forEach(h.add)
          for (const [index] of fresh.entries()) {
            h.setStatus("idle")
            await Bun.sleep(0)
            expect(h.sent).toEqual(fresh.slice(0, index + 1))
            h.setStatus("busy")
            h.finish()
            await Bun.sleep(0)
          }
          expect(h.queue.items).toEqual([])
          expect(h.sent).toEqual(fresh)
        })
      },
    ),
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

function expectCollapsed(frame: string, first: string, last: string) {
  expect(markers(frame)).toEqual([first, last])
  expect(frame.match(/View more/g) ?? []).toHaveLength(1)
  expect(frame.indexOf("View more")).toBeGreaterThan(frame.indexOf(first))
  expect(frame.indexOf("View more")).toBeLessThan(frame.indexOf(last))
  expect(frame).not.toContain("View less")
}
