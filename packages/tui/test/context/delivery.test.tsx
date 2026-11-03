/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { DeliveryProvider, nextDeliveryMode, useDelivery } from "../../src/context/delivery"

test("toggles from steer to queue", () => {
  expect(nextDeliveryMode("steer")).toBe("queue")
})

test("toggles from queue to steer", () => {
  expect(nextDeliveryMode("queue")).toBe("steer")
})

test("provider defaults to steer and can be toggled or set", async () => {
  let delivery!: ReturnType<typeof useDelivery>
  function Probe() {
    delivery = useDelivery()
    return <box />
  }
  const app = await testRender(() => (
    <DeliveryProvider>
      <Probe />
    </DeliveryProvider>
  ))

  try {
    expect(delivery.mode).toBe("steer")
    delivery.toggle()
    expect(delivery.mode).toBe("queue")
    delivery.toggle()
    expect(delivery.mode).toBe("steer")
    delivery.set("queue")
    expect(delivery.mode).toBe("queue")
  } finally {
    app.renderer.destroy()
  }
})
