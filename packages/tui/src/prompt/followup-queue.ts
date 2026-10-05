import { createEffect, createSignal, on, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { DeliveryMode } from "../context/delivery"

export type QueuedFollowup = {
  id: string
  text: string
  send: () => Promise<void>
}

export type FollowupQueue = ReturnType<typeof createFollowupQueue>

export function shouldQueueFollowup(status: string, delivery: DeliveryMode) {
  return status !== "idle" && delivery === "queue"
}

export function nextQueuedFollowup<T>(status: string, sending: boolean, followups: ReadonlyArray<T>) {
  if (status !== "idle") return
  if (sending) return
  return followups[0]
}

export function cancelQueuedFollowup<T extends { id: string }>(followups: ReadonlyArray<T>, id: string) {
  return followups.filter((followup) => followup.id !== id)
}

export function createFollowupQueue(input: { status: Accessor<string>; onError: (error: unknown) => void }) {
  const [items, setItems] = createStore<QueuedFollowup[]>([])
  const [sending, setSending] = createSignal(false)
  // A failed send stays at the front but waits for the next turn, so an idle session doesn't retry in a loop.
  const [failed, setFailed] = createSignal(false)

  createEffect(
    on(input.status, (status) => {
      if (status !== "idle") setFailed(false)
    }),
  )

  // Also re-runs when `sending` clears: the prompt request resolves only after its turn ends,
  // which can be after the session already reported idle.
  createEffect(() => {
    const next = nextQueuedFollowup(input.status(), sending() || failed(), items)
    if (!next) return
    setSending(true)
    setItems((list) => list.slice(1))
    void next
      .send()
      .catch((error) => {
        setItems((list) => [next, ...list])
        setFailed(true)
        input.onError(error)
      })
      .finally(() => setSending(false))
  })

  return {
    items,
    add(text: string, send: () => Promise<void>) {
      setItems((list) => [...list, { id: crypto.randomUUID(), text, send }])
    },
    cancel(id: string) {
      setItems((list) => cancelQueuedFollowup(list, id))
    },
    cancelLatest() {
      setItems((list) => list.slice(0, -1))
    },
  }
}
