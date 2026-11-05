// Property-based tests for /undo file restoration.
// Requirements R1–R4 are documented in traceability/ritax.md.
// Each generated case uses real session services and a fresh temporary Git workspace.
import { describe, expect } from "bun:test"
import fc from "fast-check"
import path from "node:path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session } from "../../src/session/session"
import { SessionRevert } from "../../src/session/revert"
import { MessageID, PartID } from "../../src/session/schema"
import { Snapshot } from "../../src/snapshot"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
const layer = LayerNode.compile(
  LayerNode.group([Session.node, SessionRevert.node, Snapshot.node, SessionProjector.node, CrossSpawnSpawner.node]),
)
const it = testEffect(layer)
// Override locally for stress runs; CI keeps 20 cases unless explicitly configured.
const runs = Number(process.env.PROPERTY_RUNS ?? 20)
const timeout = Number(process.env.PROPERTY_TIMEOUT ?? Math.max(120_000, runs * 6_000))
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("PROPERTY_RUNS must be a positive integer")
if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error("PROPERTY_TIMEOUT must be a positive integer")

// Generators
// Empty files, Unicode and newline differences check exact restoration (R1).
// R2 varies manual and AI edits separately; R3 combines two edits with 1–3 new files.
const contents = fc.oneof(
  fc.constantFrom("", "Hello, Rita!", "Hello, world!", "你好 👋", "\n", "a\nb", "a\nb\n"),
  fc.string({ maxLength: 80 }),
)
// Different before/after contents ensure there is a real change to undo.
const edit = fc.record({ before: contents, after: contents }).filter((value) => value.before !== value.after)
// R4 uses 2–4 turns and an earlier target to check which edits undo keeps or removes.
const history = fc.array(contents, { minLength: 2, maxLength: 4 }).chain((texts) =>
  fc.record({
    texts: fc.constant(texts),
    target: fc.integer({ min: 1, max: texts.length - 1 }),
  }),
)
//======================================================================
// Property Tests for /undo
//======================================================================

describe("session undo properties", () => {
  // R1: Running /undo should restore a modified file to its state before the undone interaction.
  // Kind: round-trip. Vary both original and replacement contents.
  it.live(
    "R1: undo restores exact original contents",
    property("R1", edit, (h, value) =>
      Effect.gen(function* () {
        yield* h.write({ "greetings.txt": value.before })
        const boundary = yield* h.turn({ "greetings.txt": value.after })
        expect(yield* h.read("greetings.txt")).toBe(value.after)
        yield* h.undo(boundary)
        expect(yield* h.read("greetings.txt")).toBe(value.before)
      }),
    ),
    timeout,
  )
  // R2: Running /undo should revert the undone interaction’s AI changes while preserving
  // manual edits in separate files that the interaction did not modify.
  // Kind: invariant.
  it.live(
    "R2: undo preserves separate manual edits",
    property("R2", fc.record({ manual: edit, ai: edit }), (h, value) =>
      Effect.gen(function* () {
        yield* h.write({ "fileA.txt": value.manual.before, "fileB.txt": value.ai.before })
        yield* h.write({ "fileA.txt": value.manual.after })
        const boundary = yield* h.turn({ "fileB.txt": value.ai.after })
        expect(yield* h.read("fileB.txt")).toBe(value.ai.after)
        yield* h.undo(boundary)
        expect(yield* h.read("fileA.txt")).toBe(value.manual.after)
        expect(yield* h.read("fileB.txt")).toBe(value.ai.before)
      }),
    ),
    timeout,
  )
  // R3: After running /undo, all file changes/creations made during the same interaction should be reverted.
  // Kind: model/oracle. Saved originals and absent new files form the expected state.
  it.live(
    "R3: undo reverts all edits and creations in one interaction",
    property(
      "R3",
      fc.record({
        first: edit,
        second: edit,
        created: fc.array(contents, { minLength: 1, maxLength: 3 }),
      }),
      (h, value) =>
        Effect.gen(function* () {
          const original = { "greetings.txt": value.first.before, "existing.txt": value.second.before }
          yield* h.write(original)
          const created = Object.fromEntries(value.created.map((text, index) => [`notes-${index}.txt`, text]))
          const changed = { "greetings.txt": value.first.after, "existing.txt": value.second.after, ...created }
          const boundary = yield* h.turn(changed)
          yield* Effect.forEach(Object.entries(changed), ([name, text]) =>
            h.read(name).pipe(Effect.map((actual) => expect(actual).toBe(text))),
          )
          yield* h.undo(boundary)
          yield* Effect.forEach(Object.entries(original), ([name, text]) =>
            h.read(name).pipe(Effect.map((actual) => expect(actual).toBe(text))),
          )
          yield* Effect.forEach(Object.keys(created), (name) =>
            h.read(name).pipe(Effect.map((actual) => expect(actual).toBeNull())),
          )
        }),
    ),
    timeout,
  )
  // R4: Users must be able to restore a selected specific earlier interaction
  // without needing to repeatedly execute /undo.
  // Kind: model/oracle. Generate 2–4 interactions and any nonfinal completed state.
  // Repeated edits exercise version ordering; per-turn creations exercise file existence.
  it.live(
    "R4: one revert restores a selected earlier workspace",
    property("R4", history, (h, value) =>
      Effect.gen(function* () {
        yield* h.write({ "greetings.txt": "initial" })
        const states = value.texts.map((text, index) => `${index}: ${text}`)
        const boundaries = yield* Effect.forEach(states, (text, index) =>
          h.turn({ "greetings.txt": text, [`turn-${index}.txt`]: text }),
        )
        expect(yield* h.read("greetings.txt")).toBe(states[states.length - 1]!)
        // To retain target interactions, revert from the first excluded user message.
        yield* h.undo(boundaries[value.target]!)
        expect(yield* h.read("greetings.txt")).toBe(states[value.target - 1]!)
        yield* Effect.forEach(states, (text, index) =>
          h
            .read(`turn-${index}.txt`)
            .pipe(Effect.map((actual) => expect(actual).toBe(index < value.target ? text : null))),
        )
      }),
    ),
    timeout,
  )
})
function property<A>(
  name: string,
  arbitrary: fc.Arbitrary<A>,
  run: (h: Effect.Success<ReturnType<typeof harness>>, value: A) => Effect.Effect<void, unknown>,
) {
  return Effect.gen(function* () {
    const context = yield* Effect.context<Layer.Success<typeof layer>>()
    yield* Effect.promise(() =>
      fc.assert(
        fc.asyncProperty(arbitrary, (value) =>
          Effect.runPromiseWith(context)(
            provideTmpdirInstance(
              (dir) =>
                Effect.gen(function* () {
                  const h = yield* harness(dir)
                  yield* run(h, value)
                }),
              { git: true },
            ).pipe(Effect.scoped),
          ),
        ),
        { numRuns: runs },
      ),
    )
    // The package uses --only-failures; keep successful properties visible in CI.
    console.log(`[property] ${name}: passed ${runs} generated cases`)
  })
}

function harness(dir: string) {
  return Effect.gen(function* () {
    const session = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const revert = yield* SessionRevert.Service
    const info = yield* session.create({})
    const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const write = (files: Record<string, string>) =>
      Effect.forEach(Object.entries(files), ([name, text]) =>
        Effect.promise(() => Bun.write(path.join(dir, name), text)),
      ).pipe(Effect.as(undefined))
    const read = (name: string) =>
      Effect.promise(async () => {
        const file = Bun.file(path.join(dir, name))
        return (await file.exists()) ? file.text() : null
      })
    const turn = (files: Record<string, string>) =>
      Effect.gen(function* () {
        const user = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: info.id,
          agent: "default",
          model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
          time: { created: Date.now() },
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID: info.id,
          messageID: user.id,
          type: "text",
          text: "Apply the interaction’s file changes",
        })
        const assistant = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: info.id,
          parentID: user.id,
          mode: "default",
          agent: "default",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens,
          modelID: ModelV2.ID.make("gpt-4"),
          providerID: ProviderV2.ID.make("openai"),
          time: { created: Date.now() },
          finish: "end_turn",
        })
        const before = yield* snapshot.track()
        if (!before) throw new Error("Expected initial snapshot")
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID: info.id,
          messageID: assistant.id,
          type: "step-start",
          snapshot: before,
        })
        yield* write(files)
        const after = yield* snapshot.track()
        if (!after) throw new Error("Expected post-edit snapshot")
        const patch = yield* snapshot.patch(before)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID: info.id,
          messageID: assistant.id,
          type: "step-finish",
          snapshot: after,
          reason: "stop",
          cost: 0,
          tokens,
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID: info.id,
          messageID: assistant.id,
          type: "patch",
          hash: patch.hash,
          files: patch.files,
        })
        return user.id
      })
    return {
      write,
      read,
      turn,
      undo: (messageID: MessageID) => revert.revert({ sessionID: info.id, messageID }).pipe(Effect.as(undefined)),
    }
  })
}
