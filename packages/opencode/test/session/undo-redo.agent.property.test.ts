import { describe, expect } from "bun:test"
import fc from "fast-check"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"

import { Session } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRevert } from "../../src/session/revert"
import { MessageID, PartID } from "../../src/session/schema"
import { Snapshot } from "../../src/snapshot"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionRevert.node, Snapshot.node, SessionProjector.node, CrossSpawnSpawner.node]),
  ),
)

const tokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))

describe("undo and redo agent workflow", () => {
  it.live(
    "R1: redo restores the files and chat from before undo",
    () =>
      Effect.gen(function* () {
      const context = yield* Effect.context()

      yield* Effect.promise(() =>
        fc.assert(
          fc.asyncProperty(
            fc.record({
              prompt: fc.constantFrom("change the files", "make the requested edit", "update the project"),
              response: fc.constantFrom("Done", "I changed the files", "The requested edit is complete"),
            }),
            (input) =>
              Effect.runPromise(
                provideTmpdirInstance(
                  (dir) =>
                    Effect.gen(function* () {
                      const session = yield* Session.Service
                      const revert = yield* SessionRevert.Service
                      const snapshot = yield* Snapshot.Service
                      const info = yield* session.create({})

                      yield* Effect.promise(() => fs.writeFile(path.join(dir, "a.txt"), "v1"))

                      const user = yield* session.updateMessage({
                        id: MessageID.ascending(),
                        role: "user",
                        sessionID: info.id,
                        agent: "default",
                        model: {
                          providerID: ProviderV2.ID.make("openai"),
                          modelID: ModelV2.ID.make("gpt-4"),
                        },
                        time: { created: Date.now() },
                      })
                      yield* session.updatePart({
                        id: PartID.ascending(),
                        messageID: user.id,
                        sessionID: info.id,
                        type: "text",
                        text: input.prompt,
                      })

                      const assistant = yield* session.updateMessage({
                        id: MessageID.ascending(),
                        role: "assistant",
                        sessionID: info.id,
                        mode: "default",
                        agent: "default",
                        path: { cwd: dir, root: dir },
                        cost: 0,
                        tokens,
                        modelID: ModelV2.ID.make("gpt-4"),
                        providerID: ProviderV2.ID.make("openai"),
                        parentID: user.id,
                        time: { created: Date.now() },
                        finish: "end_turn",
                      })
                      yield* session.updatePart({
                        id: PartID.ascending(),
                        messageID: assistant.id,
                        sessionID: info.id,
                        type: "text",
                        text: input.response,
                      })

                      const before = yield* snapshot.track()
                      if (!before) throw new Error("expected a snapshot before the agent turn")
                      yield* session.updatePart({
                        id: PartID.ascending(),
                        messageID: assistant.id,
                        sessionID: info.id,
                        type: "step-start",
                        snapshot: before,
                      })

                      yield* Effect.promise(() => fs.writeFile(path.join(dir, "a.txt"), "v2"))
                      yield* Effect.promise(() => fs.writeFile(path.join(dir, "b.txt"), "created by the agent"))

                      const after = yield* snapshot.track()
                      if (!after) throw new Error("expected a snapshot after the agent turn")
                      const patch = yield* snapshot.patch(before)
                      yield* session.updatePart({
                        id: PartID.ascending(),
                        messageID: assistant.id,
                        sessionID: info.id,
                        type: "step-finish",
                        reason: "stop",
                        snapshot: after,
                        cost: 0,
                        tokens,
                      })
                      yield* session.updatePart({
                        id: PartID.ascending(),
                        messageID: assistant.id,
                        sessionID: info.id,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })

                      const beforeUndo = yield* session.messages({ sessionID: info.id })
                      yield* revert.revert({ sessionID: info.id, messageID: user.id })
                      expect(yield* read(path.join(dir, "a.txt"))).toBe("v1")
                      expect(yield* Effect.promise(() => Bun.file(path.join(dir, "b.txt")).exists())).toBe(false)

                      yield* revert.unrevert({ sessionID: info.id })
                      expect(yield* read(path.join(dir, "a.txt"))).toBe("v2")
                      expect(yield* read(path.join(dir, "b.txt"))).toBe("created by the agent")
                      expect(yield* session.messages({ sessionID: info.id })).toEqual(beforeUndo)
                    }),
                  { git: true },
                ).pipe(Effect.provide(context)),
              ),
          ),
          { numRuns: 3 },
        ),
      )
      }),
    30_000,
  )
})
