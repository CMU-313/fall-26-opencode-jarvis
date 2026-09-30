import { SDKProvider } from "../../../src/context/sdk"
/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean | Promise<boolean>, timeout = 2000) {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountPrompt(input: { root: string; url: string }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider },
    { QuestionPrompt },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/routes/session/question"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({
      keybinds: {},
      leader_timeout: 1000,
    })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts
        directory={input.root}
        paths={{
          home: input.root,
          state,
          worktree: input.root,
        }}
      >
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <SDKProvider url={input.url} events={{ subscribe: async () => () => {} }}>
                      <QuestionPrompt
                        request={{
                          id: "que_comprehension",
                          sessionID: "ses_comprehension",
                          tool: { messageID: "msg_change", callID: "call_edit" },
                          questions: [
                            {
                              question: "What happens when count equals limit after this change?",
                              header: "Comprehension",
                              options: [],
                              custom: true,
                              multiple: false,
                            },
                          ],
                        }}
                      />
                    </SDKProvider>
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true, width: 100, height: 24 })
  return {
    app,
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

test("displays a comprehension question and submits free text through the question API", async () => {
  await using tmp = await tmpdir()
  const replies: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/question/que_comprehension/reply")
      replies.push(await request.json())
      return Response.json(true)
    },
  })
  const prompt = await mountPrompt({ root: tmp.path, url: server.url.toString() })
  try {
    await wait(async () => {
      await prompt.app.renderOnce()
      return prompt.app.captureCharFrame().includes("What happens when count equals limit")
    })
    const frame = prompt.app.captureCharFrame()
    expect(frame).toContain("What happens when count equals limit after this change?")
    expect(frame).toContain("Type your own answer")
    prompt.app.mockInput.pressEnter()
    await prompt.app.renderOnce()
    await prompt.app.mockInput.typeText("Equality now returns true.")
    prompt.app.mockInput.pressEnter()
    await wait(() => replies.length === 1)
    expect(replies).toEqual([{ answers: [["Equality now returns true."]] }])
  } finally {
    await prompt.cleanup()
    server.stop(true)
  }
})
