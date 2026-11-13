/** @jsxImportSource @opentui/solid */
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
import { Prompt } from "../../src/component/prompt"
import type { FollowupQueue } from "../../src/prompt/followup-queue"
import { createPluginRuntime } from "../../src/plugin/runtime"
import { registerOpencodeKeymap } from "../../src/keymap"
import { TestTuiContexts } from "./tui-environment"
import { createTuiResolvedConfig } from "./tui-runtime"
import { createFetch, directory, eventSource, json } from "./tui-sdk"
import { tmpdir } from "./fixture"
import { ExitProvider } from "../../src/context/exit"
import { ClipboardProvider } from "../../src/context/clipboard"
import { OpencodeKeymapProvider } from "../../src/keymap"
import { ArgsProvider } from "../../src/context/args"
import { KVProvider } from "../../src/context/kv"
import { ToastProvider } from "../../src/ui/toast"
import { RouteProvider } from "../../src/context/route"
import { TuiConfigProvider } from "../../src/config"
import { PluginRuntimeProvider } from "../../src/plugin/runtime"
import { SDKProvider } from "../../src/context/sdk"
import { PermissionProvider } from "../../src/context/permission"
import { DeliveryProvider } from "../../src/context/delivery"
import { ProjectProvider } from "../../src/context/project"
import { SyncProvider } from "../../src/context/sync"
import { DataProvider } from "../../src/context/data"
import { ThemeProvider } from "../../src/context/theme"
import { LocalProvider } from "../../src/context/local"
import { PromptStashProvider } from "../../src/component/prompt/stash"
import { DialogProvider } from "../../src/ui/dialog"
import { FrecencyProvider } from "../../src/component/prompt/frecency"
import { PromptHistoryProvider } from "../../src/component/prompt/history"
import { PromptRefProvider } from "../../src/context/prompt"
import { EditorContextProvider } from "../../src/context/editor"
import { LocationProvider } from "../../src/context/location"

// Real Prompt + real providers, rendered in memory. Only SDK responses are supplied
// by the existing transport fixture. No module mocks, subprocesses, or HTTP listener.
export async function withQueueView(
  queue: FollowupQueue,
  run: (view: Awaited<ReturnType<typeof mount>>) => Promise<void>,
) {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const view = await mount(queue, tmp.path)
  try {
    await run(view)
  } finally {
    view.ui.renderer.destroy()
  }
}

async function mount(queue: FollowupQueue, root: string) {
  const sessionID = "ses_queue_properties"
  const transport = createFetch((url) => {
    if (url.pathname === "/session/status") return json({ [sessionID]: { type: "busy" } })
    if (url.pathname === "/agent") return json([{ name: "build", mode: "primary", permission: [], options: {} }])
    if (url.pathname.startsWith(`/session/${sessionID}/`)) return json([])
  })
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ plugin_enabled: {} })
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    const runtime = createPluginRuntime()
    return (
      <TestTuiContexts directory={directory} paths={{ home: root, state: root, worktree: root }}>
        <ExitProvider
          exit={() => {
            throw new Error("Unexpected exit")
          }}
        >
          <ClipboardProvider value={{}}>
            <OpencodeKeymapProvider keymap={keymap}>
              <ArgsProvider>
                <KVProvider>
                  <ToastProvider>
                    <RouteProvider initialRoute={{ type: "session", sessionID }}>
                      <TuiConfigProvider config={config}>
                        <PluginRuntimeProvider value={runtime}>
                          <SDKProvider
                            url="http://test"
                            directory={directory}
                            fetch={transport.fetch}
                            events={eventSource()}
                          >
                            <PermissionProvider>
                              <DeliveryProvider>
                                <ProjectProvider>
                                  <SyncProvider>
                                    <DataProvider>
                                      <ThemeProvider mode="dark">
                                        <LocalProvider>
                                          <PromptStashProvider>
                                            <DialogProvider>
                                              <FrecencyProvider>
                                                <PromptHistoryProvider>
                                                  <PromptRefProvider>
                                                    <EditorContextProvider>
                                                      <LocationProvider>
                                                        <Prompt sessionID={sessionID} followups={queue} />
                                                      </LocationProvider>
                                                    </EditorContextProvider>
                                                  </PromptRefProvider>
                                                </PromptHistoryProvider>
                                              </FrecencyProvider>
                                            </DialogProvider>
                                          </PromptStashProvider>
                                        </LocalProvider>
                                      </ThemeProvider>
                                    </DataProvider>
                                  </SyncProvider>
                                </ProjectProvider>
                              </DeliveryProvider>
                            </PermissionProvider>
                          </SDKProvider>
                        </PluginRuntimeProvider>
                      </TuiConfigProvider>
                    </RouteProvider>
                  </ToastProvider>
                </KVProvider>
              </ArgsProvider>
            </OpencodeKeymapProvider>
          </ClipboardProvider>
        </ExitProvider>
      </TestTuiContexts>
    )
  }
  const ui = await testRender(() => <Harness />, { width: 120, height: 50, useThread: false })
  try {
    const start = Date.now()
    while (!ui.renderer.currentFocusedEditor) {
      await ui.renderOnce()
      if (Date.now() - start > 3000) throw new Error(`Prompt failed to mount: ${ui.captureCharFrame()}`)
      await Bun.sleep(10)
    }
  } catch (error) {
    ui.renderer.destroy()
    throw error
  }
  return {
    ui,
    async frame() {
      await Bun.sleep(0)
      await ui.renderOnce()
      return ui.captureCharFrame()
    },
    async click(label: string, rowText?: string) {
      await ui.renderOnce()
      const lines = ui.captureCharFrame().split("\n")
      const row = lines.findIndex((line) => line.includes(label) && (!rowText || line.includes(rowText)))
      if (row < 0) throw new Error(`Missing rendered control: ${label}\n${ui.captureCharFrame()}`)
      await ui.mockMouse.click(lines[row].indexOf(label) + 1, row)
      await Bun.sleep(0)
      await ui.renderOnce()
    },
  }
}
