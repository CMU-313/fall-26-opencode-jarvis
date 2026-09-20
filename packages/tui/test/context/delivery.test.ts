import { expect, test } from "bun:test"
import { nextDeliveryMode } from "../../src/context/delivery"

test("toggles from steer to queue", () => {
  expect(nextDeliveryMode("steer")).toBe("queue")
})

test("toggles from queue to steer", () => {
  expect(nextDeliveryMode("queue")).toBe("steer")
})
