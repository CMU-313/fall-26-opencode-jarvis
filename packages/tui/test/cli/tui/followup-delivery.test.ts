import { afterAll, expect, mock, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"

const sessionID = "ses_followup"
const TOGGLE = /\[\s*steer\s*\|\s*queue\s*\]/

// src/app is imported once per file, so the mocked renderer factory hands out each test's renderer.
let renderer: TestRendererSetup["renderer"] | undefined
const core = await import("@opentui/core")
mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => renderer }))
afterAll(() => mock.restore())

test("steer mode (default) sends a follow-up to the server immediately while a turn is running", async () => {
  await withApp(async (app) => {
    app.status("busy")
    await app.frame((frame) => TOGGLE.test(frame))
    expect(app.mode()).toBe("steer")

    await app.submit("steer this")
    await app.until(() => app.prompts.length === 1)
    expect(app.prompts).toEqual(["steer this"])
    expect(app.ui.captureCharFrame()).not.toContain("QUEUED")
  })
})

test("queue mode holds a mid-turn follow-up as pending and sends it only after the turn finishes", async () => {
  await withApp(async (app) => {
    app.status("busy")
    await app.frame((frame) => TOGGLE.test(frame))

    expect(app.mode()).toBe("steer")
    await app.toggle()
    await app.until(() => app.mode() === "queue")

    await app.submit("run the tests next")
    await app.frame((frame) => frame.includes("QUEUED") && frame.includes("run the tests next"))
    await Bun.sleep(50)
    expect(app.prompts).toEqual([])

    app.status("idle")
    await app.until(() => app.prompts.length === 1)
    expect(app.prompts).toEqual(["run the tests next"])
    await app.frame((frame) => !frame.includes("QUEUED"))
  })
})

test("multiple queued follow-ups are sent in order, one per finished turn", async () => {
  await withApp(async (app) => {
    app.status("busy")
    await app.frame((frame) => TOGGLE.test(frame))
    await app.toggle()
    await app.submit("first")
    await app.submit("second")
    await app.frame((frame) => frame.includes("first") && frame.includes("second"))

    app.status("idle")
    await app.until(() => app.prompts.length === 1)
    app.status("busy")
    await app.frame((frame) => TOGGLE.test(frame))
    app.finishTurn()
    await Bun.sleep(50)
    expect(app.prompts).toEqual(["first"])

    app.status("idle")
    await app.until(() => app.prompts.length === 2)
    expect(app.prompts).toEqual(["first", "second"])
  })
})

test("the cancel keybind drops the latest queued follow-up so it is never sent", async () => {
  await withApp(async (app) => {
    app.status("busy")
    await app.frame((frame) => TOGGLE.test(frame))
    await app.toggle()
    await app.submit("keep me")
    await app.submit("drop me")
    await app.frame((frame) => frame.includes("drop me"))

    await app.leader("d")
    await app.frame((frame) => !frame.includes("drop me") && frame.includes("keep me"))

    app.status("idle")
    await app.until(() => app.prompts.length === 1)
    app.finishTurn()
    await Bun.sleep(50)
    expect(app.prompts).toEqual(["keep me"])
  })
})

test("clicking Cancel on a pending follow-up removes it", async () => {
  await withApp(async (app) => {
    app.status("busy")
    await app.frame((frame) => TOGGLE.test(frame))
    await app.toggle()
    await app.submit("click to cancel")
    const frame = await app.frame((frame) => frame.includes("click to cancel"))

    const row = frame.split("\n").findIndex((line) => line.includes("click to cancel"))
    await app.ui.mockMouse.click(frame.split("\n")[row].indexOf("Cancel") + 1, row)
    await app.frame((frame) => !frame.includes("click to cancel"))

    app.status("idle")
    await Bun.sleep(50)
    expect(app.prompts).toEqual([])
  })
})

test("a queued follow-up survives a permission prompt that hides the input mid-turn", async () => {
  await withApp(async (app) => {
    app.status("busy")
    await app.frame((frame) => TOGGLE.test(frame))
    await app.toggle()
    await app.submit("after permission")
    await app.frame((frame) => frame.includes("after permission"))

    app.emit({
      id: "evt_permission_asked",
      type: "permission.asked",
      properties: {
        id: "per_1",
        sessionID,
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
      },
    })
    await app.frame((frame) => !frame.includes("after permission"))
    app.emit({
      id: "evt_permission_replied",
      type: "permission.replied",
      properties: { sessionID, requestID: "per_1", reply: "once" },
    })

    app.status("idle")
    await app.until(() => app.prompts.length === 1)
    expect(app.prompts).toEqual(["after permission"])
  })
})

test("the steer/queue toggle is only shown while a turn is running and the keybind flips it both ways", async () => {
  await withApp(async (app) => {
    app.status("idle")
    await app.ui.renderOnce()
    expect(app.ui.captureCharFrame()).not.toMatch(TOGGLE)

    app.status("busy")
    await app.frame((frame) => TOGGLE.test(frame))
    expect(app.mode()).toBe("steer")
    await app.toggle()
    await app.until(() => app.mode() === "queue")
    await app.toggle()
    await app.until(() => app.mode() === "steer")

    app.status("idle")
    await app.frame((frame) => !TOGGLE.test(frame))
  })
})

async function withApp(fn: (app: Awaited<ReturnType<typeof startApp>>) => Promise<void>) {
  const app = await startApp()
  try {
    await fn(app)
  } finally {
    await app.stop()
  }
}

async function startApp() {
  const ui = await createTestRenderer({ width: 100, height: 30, useThread: false, kittyKeyboard: true })
  renderer = ui.renderer
  const events = createEventSource()
  const prompts: string[] = []
  const turns: (() => void)[] = []
  const base = createFetch((url) => {
    if (url.pathname === "/session") return json([session()])
    if (url.pathname === `/session/${sessionID}`) return json(session())
    if (url.pathname.startsWith(`/session/${sessionID}/`)) return json([])
    if (url.pathname === "/permission" || url.pathname === "/question") return json([])
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: { test: "test-model" } })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
  }, events)
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== `/session/${sessionID}/message`) return base.fetch(input, init)
    const body = await request.json()
    prompts.push(body.parts.find((part: { type: string }) => part.type === "text").text)
    // The real endpoint streams the reply and responds only once the turn ends.
    await new Promise<void>((resolve) => turns.push(resolve))
    return json({ info: { id: `msg_${prompts.length}`, sessionID, role: "assistant" }, parts: [] })
  }) as typeof globalThis.fetch

  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const { run } = await import("../../../src/app")
  const task = Effect.runPromise(
    run({
      url: "http://test",
      directory,
      config: createTuiResolvedConfig({ plugin_enabled: {} }),
      fetch,
      events: events.source,
      args: { sessionID },
      pluginHost: {
        // The real plugin host enables slots; the session prompt renders through one.
        async start(host) {
          host.runtime.setupSlots(host.api)
          started()
        },
        async dispose() {},
      },
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
  )
  await ready
  await frame((value) => value.includes("Test Model"))

  async function until(predicate: () => boolean, timeout = 5000) {
    const start = Date.now()
    while (true) {
      await ui.renderOnce()
      if (predicate()) return
      if (Date.now() - start > timeout) throw new Error(`timed out; last frame:\n${ui.captureCharFrame()}`)
      await Bun.sleep(10)
    }
  }

  async function frame(predicate: (frame: string) => boolean) {
    await until(() => predicate(ui.captureCharFrame()))
    return ui.captureCharFrame()
  }

  function editor() {
    const focused = ui.renderer.currentFocusedEditor
    return focused instanceof TextareaRenderable ? focused : undefined
  }

  function emit(payload: GlobalEvent["payload"]) {
    events.emit({ directory, project: "proj_test", payload } as GlobalEvent)
  }

  return {
    ui,
    prompts,
    emit,
    until,
    frame,
    status(type: "busy" | "idle") {
      emit({ id: `evt_status_${type}_${Date.now()}`, type: "session.status", properties: { sessionID, status: { type } } })
    },
    finishTurn() {
      turns.shift()?.()
    },
    mode() {
      const line = ui.captureSpans().lines.find((line) => line.spans.some((span) => span.text.includes("steer")))
      const bold = line?.spans.find((span) => /steer|queue/.test(span.text) && span.attributes & TextAttributes.BOLD)
      return bold?.text.includes("queue") ? "queue" : "steer"
    },
    async submit(text: string) {
      await ui.mockInput.typeText(text)
      ui.mockInput.pressEnter()
      await until(() => editor()?.plainText === "")
    },
    async leader(key: string) {
      ui.mockInput.pressKey("x", { ctrl: true })
      ui.mockInput.pressKey(key)
      await ui.renderOnce()
    },
    async toggle() {
      await this.leader("w")
    },
    async stop() {
      turns.splice(0).forEach((resolve) => resolve())
      process.emit("SIGHUP")
      await task
      if (!ui.renderer.isDestroyed) ui.renderer.destroy()
    },
  }
}

const provider = {
  id: "test",
  name: "Test",
  source: "api",
  env: [],
  options: {},
  models: {
    "test-model": {
      id: "test-model",
      providerID: "test",
      name: "Test Model",
      api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai-compatible" },
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 100_000, output: 10_000 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
  },
}

function session() {
  return {
    id: sessionID,
    title: "Followup session",
    slug: sessionID,
    projectID: "proj_test",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  }
}
