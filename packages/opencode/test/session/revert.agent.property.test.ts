import { describe, expect } from "bun:test"
import fc from "fast-check"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"

import { Session } from "@/session/session"
import { SessionRevert } from "@/session/revert"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const layer = LayerNode.compile(
  LayerNode.group([Session.node, SessionRevert.node, Snapshot.node, SessionProjector.node, CrossSpawnSpawner.node]),
)
const it = testEffect(layer)

const seed = 20261113
const numRuns = 5

const contents = fc.string({ maxLength: 80 })
const interaction = fc
  .record({
    original: contents,
    modified: contents,
    notes: contents,
  })
  .filter((value) => value.original !== value.modified)

const user = Effect.fn("test.user")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID,
    agent: "default",
    model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
    time: { created: Date.now() },
  })
})

const recordInteraction = Effect.fn("test.recordInteraction")(function* (
  dir: string,
  value: { original: string; modified: string; notes: string },
) {
  const session = yield* Session.Service
  const snapshot = yield* Snapshot.Service
  const info = yield* session.create({})
  const userMessage = yield* user(info.id)

  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.id,
    sessionID: info.id,
    type: "text",
    text: "Update greetings and create notes.",
  })

  const assistantMessage = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant" as const,
    sessionID: info.id,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelV2.ID.make("gpt-4"),
    providerID: ProviderV2.ID.make("openai"),
    parentID: userMessage.id,
    time: { created: Date.now() },
    finish: "end_turn",
  })

  const beforeGreetings = yield* snapshot.track()
  if (!beforeGreetings) throw new Error("expected a snapshot before the greetings step")

  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistantMessage.id,
    sessionID: info.id,
    type: "step-start",
    snapshot: beforeGreetings,
  })
  yield* Effect.promise(() => fs.writeFile(path.join(dir, "greetings.txt"), value.modified))

  const afterGreetings = yield* snapshot.track()
  if (!afterGreetings) throw new Error("expected a snapshot after the greetings step")
  const greetingsPatch = yield* snapshot.patch(beforeGreetings)

  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistantMessage.id,
    sessionID: info.id,
    type: "step-finish",
    reason: "stop",
    snapshot: afterGreetings,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistantMessage.id,
    sessionID: info.id,
    type: "patch",
    hash: greetingsPatch.hash,
    files: greetingsPatch.files,
  })

  const beforeNotes = yield* snapshot.track()
  if (!beforeNotes) throw new Error("expected a snapshot before the notes step")
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistantMessage.id,
    sessionID: info.id,
    type: "step-start",
    snapshot: beforeNotes,
  })
  yield* Effect.promise(() => fs.writeFile(path.join(dir, "notes.txt"), value.notes))
  const afterNotes = yield* snapshot.track()
  if (!afterNotes) throw new Error("expected a snapshot after the notes step")
  const notesPatch = yield* snapshot.patch(beforeNotes)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistantMessage.id,
    sessionID: info.id,
    type: "step-finish",
    reason: "stop",
    snapshot: afterNotes,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistantMessage.id,
    sessionID: info.id,
    type: "patch",
    hash: notesPatch.hash,
    files: notesPatch.files,
  })

  return { sessionID: info.id, messageID: userMessage.id }
})

describe("/undo agent properties", () => {
  it.live(
    "R3: reverts all changes and creations from one interaction",
    Effect.gen(function* () {
      const context = yield* Effect.context<Layer.Success<typeof layer>>()

      yield* Effect.promise(() =>
        fc.assert(
          fc.asyncProperty(interaction, (value) =>
            Effect.runPromiseWith(context)(
              provideTmpdirInstance(
                (dir) =>
                  Effect.gen(function* () {
                    const greetings = path.join(dir, "greetings.txt")
                    const notes = path.join(dir, "notes.txt")
                    yield* Effect.promise(() => fs.writeFile(greetings, value.original))

                    const result = yield* recordInteraction(dir, value)
                    expect(yield* Effect.promise(() => fs.readFile(greetings, "utf8"))).toBe(value.modified)
                    expect(yield* Effect.promise(() => fs.readFile(notes, "utf8"))).toBe(value.notes)
                    const revert = yield* SessionRevert.Service
                    yield* revert.revert(result)

                    expect(yield* Effect.promise(() => fs.readFile(greetings, "utf8"))).toBe(value.original)
                    expect(yield* Effect.promise(() => fs.stat(notes).catch(() => undefined))).toBeUndefined()
                  }),
                { git: true },
              ).pipe(Effect.scoped),
            ),
          ),
          { seed, numRuns },
        ),
      )
    }),
    { timeout: 120_000 },
  )
})
