// Property-based tests for session undo/redo (/undo, /redo, Revert).
// Requirements R1–R5 are listed in traceability/myeh2.md.
//
// Every generated case builds a real git project in a temp folder and replays a
// session the way src/session/processor.ts records it: for each AI turn we take a
// snapshot, apply the turn's file changes, take another snapshot, and store the
// step-start / step-finish / patch parts. No LLM is involved, so each case is
// deterministic and fast-check can shrink a failure to a minimal session.
//
// "Undo" is SessionRevert.revert on a turn's user message (what /undo and the
// Revert option call), "redo" is SessionRevert.unrevert, and "send a new message"
// is SessionRevert.cleanup, which SessionPrompt.prompt runs before admitting the
// message.
import { afterEach, describe, expect } from "bun:test"
import { $ } from "bun"
import fc from "fast-check"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { SessionRevert } from "../../src/session/revert"
import { Snapshot } from "../../src/snapshot"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionRevert.node, Snapshot.node, SessionProjector.node, CrossSpawnSpawner.node]),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

// Each case runs ~20-40 git commands, so CI uses a modest run count. Set
// PROPERTY_RUNS (e.g. 200) to stress-test locally.
const RUNS = Number(process.env.PROPERTY_RUNS ?? 15)
const TIMEOUT = 240_000

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// A small pool of paths, so different turns often touch the same file (the
// case where undo has to pick the right version), plus a nested path, so a file
// the AI deleted has to come back inside its folder.
const FILES = ["a.txt", "b.txt", "notes.md", "src/app.ts"] as const
type File = (typeof FILES)[number]
// null means the file does not exist.
type State = Record<File, string | null>
type Op = { file: File; content: string | null }

// Empty files, multi-line text and short random strings. Interviewees cared
// about exact contents coming back (C-7, O-8), so small differences matter.
// Reusing a few fixed values across files also produces "delete one file,
// create another with the same content", which git treats as a rename (the
// case that exposed the rename bug in Snapshot.patch).
const content = fc.oneof(fc.constantFrom("", "v1", "v2", "line 1\nline 2\n"), fc.string({ maxLength: 12 }))
const maybe = fc.option(content, { nil: null, freq: 4 })

// The project before the session starts: each file is missing or has content.
const initial: fc.Arbitrary<State> = fc.record({
  "a.txt": maybe,
  "b.txt": maybe,
  "notes.md": maybe,
  "src/app.ts": maybe,
})

// One AI turn writes, creates or deletes 1-3 files (null content = delete).
const turn = fc.array(fc.record({ file: fc.constantFrom(...FILES), content: maybe }), { minLength: 1, maxLength: 3 })

// 1-4 turns, and which turn to undo back to (0 = the first turn). Jumping back
// several turns at once is what choosing Revert on an earlier message does.
const session = fc
  .record({ initial, turns: fc.array(turn, { minLength: 1, maxLength: 4 }) })
  .chain((s) =>
    fc.record({ initial: fc.constant(s.initial), turns: fc.constant(s.turns), undo: fc.nat(s.turns.length - 1) }),
  )

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// Runs fast-check inside the Effect test runtime: each generated input runs as
// its own Effect with the test's services. The package's test script uses
// --only-failures, which hides passing test names, so each property prints a
// line when it passes to show in the CI log that it ran.
const property = <T, E, R>(name: string, arb: fc.Arbitrary<T>, run: (input: T) => Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    const runCase = Effect.runPromiseWith(context)
    yield* Effect.promise(() =>
      fc.assert(
        fc.asyncProperty(arb, (input) => runCase(run(input))),
        { numRuns: RUNS },
      ),
    )
    console.log(`[property] ${name}: passed ${RUNS} generated cases`)
  })

// A fresh git project per case, deleted when the case ends.
const withProject = <A, E, R>(body: (dir: string) => Effect.Effect<A, E, R>) =>
  provideTmpdirInstance(body, { git: true }).pipe(Effect.scoped)

const put = (dir: string, file: string, value: string | null) =>
  Effect.promise(async () => {
    const target = path.join(dir, file)
    if (value === null) return fs.rm(target, { force: true })
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, value)
  })

const read = (dir: string) =>
  Effect.promise(async () => {
    const entries = await Promise.all(
      FILES.map(async (file) => [file, await fs.readFile(path.join(dir, file), "utf-8").catch(() => null)] as const),
    )
    return Object.fromEntries(entries) as State
  })

const git = (dir: string, args: string[]) => Effect.promise(() => $`git ${args}`.cwd(dir).quiet().text())

const messageIDs = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return (yield* sessions.messages({ sessionID })).map((m) => m.info.id)
  })

const model = { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") }
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

// Writes the starting files, then records each AI turn exactly like the
// processor does. Returns the project state before each turn (index i = right
// before turn i) and after the last turn: the model the properties compare to.
const replay = Effect.fn("test.replay")(function* (dir: string, input: { initial: State; turns: Op[][] }) {
  const sessions = yield* Session.Service
  const snapshot = yield* Snapshot.Service
  yield* Effect.forEach(FILES, (file) => put(dir, file, input.initial[file]))
  const info = yield* sessions.create({})
  const users: MessageID[] = []
  const before: State[] = []
  for (const [index, ops] of input.turns.entries()) {
    before.push(yield* read(dir))
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "user" as const,
      sessionID: info.id,
      agent: "default",
      model,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: user.id,
      sessionID: info.id,
      type: "text" as const,
      text: `turn ${index}`,
    })
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      role: "assistant" as const,
      sessionID: info.id,
      mode: "default",
      agent: "default",
      path: { cwd: dir, root: dir },
      cost: 0,
      tokens,
      modelID: model.modelID,
      providerID: model.providerID,
      parentID: user.id,
      time: { created: Date.now() },
      finish: "end_turn",
    })
    const start = yield* snapshot.track()
    if (!start) return yield* Effect.die(new Error("snapshots are off"))
    yield* Effect.forEach(ops, (op) => put(dir, op.file, op.content))
    const end = yield* snapshot.track()
    const patch = yield* snapshot.patch(start)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: info.id,
      type: "step-start" as const,
      snapshot: start,
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.id,
      sessionID: info.id,
      type: "step-finish" as const,
      reason: "stop",
      snapshot: end,
      cost: 0,
      tokens,
    })
    // The processor only stores a patch part when the turn changed something.
    if (patch.files.length)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: info.id,
        type: "patch" as const,
        hash: patch.hash,
        files: patch.files,
      })
    users.push(user.id)
  }
  return { sessionID: info.id, users, before, after: yield* read(dir) }
})

// Files whose content differs between two states.
const changed = (a: State, b: State) => FILES.filter((file) => a[file] !== b[file])

// Files the AI changed in turns `from` onward (the turns an undo removes).
const changedSince = (from: number, before: State[], after: State) =>
  new Set(before.slice(from).flatMap((state, i) => changed(state, before[from + i + 1] ?? after)))

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("session undo/redo properties", () => {
  // R1: Undoing and then redoing should put your files and chat back exactly how
  // they were before the undo.
  // Kind: round-trip
  it.live(
    "R1 (round-trip): undo then redo restores every file and the same messages",
    () =>
      property("R1 (round-trip): undo then redo restores every file and the same messages", session, (input) =>
        withProject((dir) =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const revert = yield* SessionRevert.Service
            const run = yield* replay(dir, input)
            const messages = yield* messageIDs(run.sessionID)

            yield* revert.revert({ sessionID: run.sessionID, messageID: run.users[input.undo] })
            yield* revert.unrevert({ sessionID: run.sessionID })

            expect(yield* read(dir)).toEqual(run.after)
            expect(yield* messageIDs(run.sessionID)).toEqual(messages)
            expect((yield* sessions.get(run.sessionID)).revert).toBeUndefined()
          }),
        ),
      ),
    TIMEOUT,
  )

  // R1: Undoing and then redoing should put your files and chat back exactly how
  // they were before the undo. (Acceptance criteria, first half: after /undo every
  // file is back to how it was before the undone turn, and files the AI created
  // are gone.)
  // Kind: model / oracle. The model is the project state the test recorded right
  // before each turn; undoing to turn i must reproduce it exactly.
  it.live(
    "R1 (model): after undo, files match the state recorded before the undone turn",
    () =>
      property("R1 (model): after undo, files match the state recorded before the undone turn", session, (input) =>
        withProject((dir) =>
          Effect.gen(function* () {
            const revert = yield* SessionRevert.Service
            const run = yield* replay(dir, input)

            yield* revert.revert({ sessionID: run.sessionID, messageID: run.users[input.undo] })

            expect(yield* read(dir)).toEqual(run.before[input.undo])
          }),
        ),
      ),
    TIMEOUT,
  )

  // R2: Undo should only change the files the AI changed. Your other files and
  // your git history should stay the same.
  // Kind: invariant
  // Generator: the starting files are committed to the project's git (so there is
  // real history), then some get uncommitted edits before the AI starts, like
  // C-3's "uncommitted work".
  it.live(
    "R2 (invariant): undo leaves untouched files and git history alone",
    () =>
      property(
        "R2 (invariant): undo leaves untouched files and git history alone",
        session.chain((s) => fc.record({ ...mapConst(s), uncommitted: fc.subarray([...FILES]), text: content })),
        (input) =>
          withProject((dir) =>
            Effect.gen(function* () {
              const revert = yield* SessionRevert.Service
              yield* Effect.forEach(FILES, (file) => put(dir, file, input.initial[file]))
              yield* git(dir, ["add", "-A"])
              yield* git(dir, ["commit", "--allow-empty", "-q", "-m", "user work"])
              const start = { ...input.initial }
              for (const file of input.uncommitted) start[file] = `${input.text} (uncommitted)`
              const history = yield* git(dir, ["log", "--format=%H"])
              const run = yield* replay(dir, { initial: start, turns: input.turns })
              const touched = changedSince(input.undo, run.before, run.after)

              yield* revert.revert({ sessionID: run.sessionID, messageID: run.users[input.undo] })

              const now = yield* read(dir)
              for (const file of FILES.filter((f) => !touched.has(f))) expect(now[file]).toBe(run.after[file])
              expect(yield* git(dir, ["log", "--format=%H"])).toBe(history)
            }),
          ),
      ),
    TIMEOUT,
  )

  // R3: If you edit a file by hand after the AI's last change to it, undo leaves
  // that file exactly as you left it, and still restores the other files the AI
  // changed. (Revised in P4, see traceability/myeh2.md.)
  // Kind: invariant
  // Generator: after all turns, the user edits one file the undone turns changed
  // (C-5's "manual fix"). If the AI deleted it, the user recreates it.
  it.live(
    "R3 (invariant): undo keeps a file you edited by hand after the AI",
    () =>
      property(
        "R3 (invariant): undo keeps a file you edited by hand after the AI",
        session.chain((s) => fc.record({ ...mapConst(s), pick: fc.nat() })),
        (input) =>
          withProject((dir) =>
            Effect.gen(function* () {
              const revert = yield* SessionRevert.Service
              const run = yield* replay(dir, input)
              const touched = [...changedSince(input.undo, run.before, run.after)]
              if (!touched.length) return
              const edited = touched[input.pick % touched.length]
              const mine = `${run.after[edited] ?? ""}// fixed by hand\n`
              yield* put(dir, edited, mine)

              yield* revert.revert({ sessionID: run.sessionID, messageID: run.users[input.undo] })

              const now = yield* read(dir)
              expect(now[edited]).toBe(mine)
              for (const file of touched.filter((f) => f !== edited))
                expect(now[file]).toBe(run.before[input.undo][file])
            }),
          ),
      ),
    TIMEOUT,
  )

  // R4: If you send a new message after undoing, the undone messages are gone and
  // you can't redo them.
  // Kind: invariant
  it.live(
    "R4 (invariant): a new message after undo deletes the undone turns and redo does nothing",
    () =>
      property(
        "R4 (invariant): a new message after undo deletes the undone turns and redo does nothing",
        session,
        (input) =>
          withProject((dir) =>
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const revert = yield* SessionRevert.Service
              const run = yield* replay(dir, input)
              const messages = yield* messageIDs(run.sessionID)

              yield* revert.revert({ sessionID: run.sessionID, messageID: run.users[input.undo] })
              yield* revert.cleanup(yield* sessions.get(run.sessionID))

              // Each turn is one user and one assistant message.
              const kept = messages.slice(0, input.undo * 2)
              expect(yield* messageIDs(run.sessionID)).toEqual(kept)
              expect((yield* sessions.get(run.sessionID)).revert).toBeUndefined()
              const files = yield* read(dir)

              yield* revert.unrevert({ sessionID: run.sessionID })

              expect(yield* read(dir)).toEqual(files)
              expect(yield* messageIDs(run.sessionID)).toEqual(kept)
            }),
          ),
      ),
    TIMEOUT,
  )

  // R5: Undoing twice should end up in the same place as reverting to the message
  // two turns back.
  // Kind: metamorphic. Same session replayed in two projects: one undoes `times`
  // turns one at a time (what repeated /undo does), the other jumps straight to
  // that turn with Revert. Generalizes "twice" to 1-4 times.
  it.live(
    "R5 (metamorphic): undoing N times one by one equals one Revert N turns back",
    () =>
      property(
        "R5 (metamorphic): undoing N times one by one equals one Revert N turns back",
        session.chain((s) => fc.record({ ...mapConst(s), times: fc.integer({ min: 1, max: s.turns.length }) })),
        (input) =>
          Effect.gen(function* () {
            const stepwise = yield* withProject((dir) =>
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const revert = yield* SessionRevert.Service
                const run = yield* replay(dir, input)
                for (const index of run.users
                  .map((_, i) => i)
                  .reverse()
                  .slice(0, input.times))
                  yield* revert.revert({ sessionID: run.sessionID, messageID: run.users[index] })
                const point = (yield* sessions.get(run.sessionID)).revert?.messageID
                return { files: yield* read(dir), point: run.users.findIndex((id) => id === point) }
              }),
            )
            const direct = yield* withProject((dir) =>
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const revert = yield* SessionRevert.Service
                const run = yield* replay(dir, input)
                yield* revert.revert({ sessionID: run.sessionID, messageID: run.users[run.users.length - input.times] })
                const point = (yield* sessions.get(run.sessionID)).revert?.messageID
                return { files: yield* read(dir), point: run.users.findIndex((id) => id === point) }
              }),
            )
            expect(stepwise).toEqual(direct)
          }),
      ),
    TIMEOUT,
  )
})

// Keeps an already generated session fixed while chaining extra inputs onto it.
function mapConst(s: { initial: State; turns: Op[][]; undo: number }) {
  return { initial: fc.constant(s.initial), turns: fc.constant(s.turns), undo: fc.constant(s.undo) }
}
