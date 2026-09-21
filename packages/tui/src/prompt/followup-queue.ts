import type { DeliveryMode } from "../context/delivery"

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
