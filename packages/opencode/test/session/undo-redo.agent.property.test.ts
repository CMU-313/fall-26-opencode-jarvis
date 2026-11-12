import { describe, expect } from "bun:test"
import fc from "fast-check"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
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

const RUNS = Number(process.env.PROPERTY_RUNS ?? 10)
const SEED = Number(process.env.PROPERTY_SEED ?? 42)

const tokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

// A few fixed paths, one nested, so later turns often touch files earlier turns changed.
const FILES = ["a.txt", "b.txt", "src/c.ts"]
const content = fc.constantFrom("", "v1", "v2", "created by the agent")
// One AI turn: each file it touches gets new content, or null when the AI deletes it.
// A turn can also touch no files, like a reply that only answers a question.
const turn = fc.dictionary(fc.constantFrom(...FILES), fc.option(content, { nil: null }))
const scenario = fc
  .record({
    prompt: fc.constantFrom("change the files", "make the requested edit", "update the project"),
    response: fc.constantFrom("Done", "I changed the files", "The requested edit is complete"),
    // The files that exist before the session starts.
    initial: fc.dictionary(fc.constantFrom(...FILES), content),
    turns: fc.array(turn, { minLength: 1, maxLength: 3 }),
  })
  .chain((input) => fc.nat({ max: input.turns.length - 1 }).map((undo) => ({ ...input, undo })))

// Each path's content, or null when the file is missing.
const files = (dir: string) =>
  Effect.promise(async () =>
    Object.fromEntries(
      await Promise.all(
        FILES.map(async (file) => [file, await fs.readFile(path.join(dir, file), "utf8").catch(() => null)] as const),
      ),
    ),
  )

const apply = (dir: string, changes: Record<string, string | null>) =>
  Effect.promise(() =>
    Promise.all(
      Object.entries(changes).map(([file, text]) =>
        text === null ? fs.rm(path.join(dir, file), { force: true }) : Bun.write(path.join(dir, file), text),
      ),
    ),
  )

describe("undo and redo agent workflow", () => {
  it.live(
    "R1: redo restores the files and chat from before undo",
    () =>
      Effect.gen(function* () {
        // The services each generated case needs. Without the type, this doesn't typecheck.
        const context = yield* Effect.context<
          Session.Service | SessionRevert.Service | Snapshot.Service | ChildProcessSpawner.ChildProcessSpawner
        >()

        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(scenario, (input) =>
              Effect.runPromise(
                provideTmpdirInstance(
                  (dir) =>
                    Effect.gen(function* () {
                      const session = yield* Session.Service
                      const revert = yield* SessionRevert.Service
                      const snapshot = yield* Snapshot.Service
                      const info = yield* session.create({})

                      yield* apply(dir, input.initial)

                      // Record each AI turn the way the session processor does: the user message,
                      // the AI's reply, a step-start snapshot, the file changes, a step-finish
                      // snapshot and the patch.
                      const turns = yield* Effect.forEach(input.turns, (changes) =>
                        Effect.gen(function* () {
                          const before = yield* files(dir)
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

                          const start = yield* snapshot.track()
                          if (!start) throw new Error("expected a snapshot before the agent turn")
                          yield* session.updatePart({
                            id: PartID.ascending(),
                            messageID: assistant.id,
                            sessionID: info.id,
                            type: "step-start",
                            snapshot: start,
                          })

                          yield* apply(dir, changes)

                          const finish = yield* snapshot.track()
                          if (!finish) throw new Error("expected a snapshot after the agent turn")
                          const patch = yield* snapshot.patch(start)
                          yield* session.updatePart({
                            id: PartID.ascending(),
                            messageID: assistant.id,
                            sessionID: info.id,
                            type: "step-finish",
                            reason: "stop",
                            snapshot: finish,
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
                          return { user: user.id, before }
                        }),
                      )

                      const latest = yield* files(dir)
                      const beforeUndo = yield* session.messages({ sessionID: info.id })

                      yield* revert.revert({ sessionID: info.id, messageID: turns[input.undo]!.user })
                      expect(yield* files(dir)).toEqual(turns[input.undo]!.before)

                      // Redo the way the TUI's /redo does: while a later user message exists,
                      // revert to it, which brings back one turn. Only unrevert once none is left.
                      yield* Effect.forEach(
                        turns.slice(input.undo + 1),
                        (next) =>
                          Effect.gen(function* () {
                            yield* revert.revert({ sessionID: info.id, messageID: next.user })
                            expect(yield* files(dir)).toEqual(next.before)
                          }),
                        { discard: true },
                      )
                      yield* revert.unrevert({ sessionID: info.id })
                      expect(yield* files(dir)).toEqual(latest)
                      expect(yield* session.messages({ sessionID: info.id })).toEqual(beforeUndo)
                    }),
                  { git: true },
                ).pipe(Effect.scoped, Effect.provide(context)),
              ),
            ),
            { numRuns: RUNS, seed: SEED },
          ),
        )
      }),
    240_000,
  )
})
