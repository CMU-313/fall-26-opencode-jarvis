import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"

export type DeliveryMode = "steer" | "queue"

export function nextDeliveryMode(mode: DeliveryMode): DeliveryMode {
  return mode === "steer" ? "queue" : "steer"
}

export const { use: useDelivery, provider: DeliveryProvider } = createSimpleContext({
  name: "Delivery",
  init: () => {
    const [store, setStore] = createStore<{ mode: DeliveryMode }>({
      mode: "steer",
    })
    return {
      get mode() {
        return store.mode
      },
      set(mode: DeliveryMode) {
        setStore("mode", mode)
      },
      toggle() {
        setStore("mode", nextDeliveryMode)
      },
    }
  },
})
