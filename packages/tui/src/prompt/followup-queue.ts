import { batch, createEffect, createMemo, createSignal, on, type Accessor } from "solid-js"
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
  const [items, setItems] = createStore<(QueuedFollowup & { canceled?: boolean })[]>([])
  const visible = createMemo(() => items.filter((item) => !item.canceled))
  const [latest, setLatest] = createSignal<string>()
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
    if (input.status() !== "idle" || sending() || failed()) return
    // Only discard canceled entries when dispatch reaches them. Entries behind an
    // active prompt retain their original position and send callback for undo.
    const index = items.findIndex((item) => !item.canceled)
    const next = items[index]
    batch(() => {
      if (next) setSending(true)
      if (items.slice(0, index < 0 ? items.length : index + 1).some((item) => item.id === latest())) {
        setLatest(undefined)
      }
      if (items.length) setItems((list) => (index < 0 ? [] : list.slice(index + 1)))
    })
    if (!next) return
    void next
      .send()
      .catch((error) => {
        batch(() => {
          setFailed(true)
          setItems((list) => [next, ...list])
        })
        input.onError(error)
      })
      .finally(() => setSending(false))
  })

  return {
    get items() {
      return visible()
    },
    get canUndo() {
      return items.some((item) => item.id === latest() && item.canceled)
    },
    undo() {
      const index = items.findIndex((item) => item.id === latest() && item.canceled)
      if (index < 0) return
      batch(() => {
        setItems(index, "canceled", false)
        setLatest(undefined)
      })
    },
    add(text: string, send: () => Promise<void>) {
      setItems((list) => [...list, { id: crypto.randomUUID(), text, send }])
    },
    cancel,
    cancelLatest() {
      const item = visible().at(-1)
      if (item) cancel(item.id)
    },
  }

  function cancel(id: string) {
    const index = items.findIndex((item) => item.id === id && !item.canceled)
    if (index < 0) return
    batch(() => {
      setItems(index, "canceled", true)
      setLatest(id)
    })
  }
}
