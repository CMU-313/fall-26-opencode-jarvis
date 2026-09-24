import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ChangeContext } from "@opencode-ai/core/change-context"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LLMEvent } from "@opencode-ai/llm"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import { ComprehensionHandoff } from "@/comprehension-handoff"
import { ComprehensionQuestion } from "@/comprehension-question"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LLM } from "@/session/llm"
import { SessionID, MessageID } from "@/session/schema"
import { Question } from "@/question"
import { disposeAllInstances, TestInstance } from "./fixture/fixture"
import { model } from "./fixture/comprehension"
import { testEffect } from "./lib/effect"

const text = "What happens when count equals limit after this change?"
const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, CrossSpawnSpawner.node])),
    Layer.mock(LLM.Service, { stream: () => Stream.make(LLMEvent.textDelta({ id: "question", text })) }),
  ),
)

afterEach(disposeAllInstances)

describe("ComprehensionHandoff", () => {
  const actions = ["reply", "reject", "interrupt"]
  actions.forEach((action) => {
    it.instance(`publishes the question and handles ${action} without editing`, () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const file = `${instance.directory}/limit.txt`
        const original = "return count > limit\n"
        yield* Effect.promise(() => Bun.write(file, original))
        const pending: ComprehensionHandoff.PendingChange = {
          sessionID: SessionID.make("ses_comprehension"),
          tool: { messageID: MessageID.make("msg_change"), callID: "call_edit" },
          context: ChangeContext.extract(file, original, "return count >= limit\n"),
        }
        const questions = yield* Question.Service
        const events = yield* EventV2Bridge.Service
        const published = yield* Deferred.make<Question.Request>()
        const off = yield* events.listen((event) => {
          if (event.type === Question.Event.Asked.type)
            return Deferred.succeed(published, Schema.decodeUnknownSync(Question.Request)(event.data)).pipe(
              Effect.asVoid,
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => off)
        const fiber = yield* ComprehensionHandoff.present({ pending, model }).pipe(Effect.forkScoped)
        const request = yield* Deferred.await(published)
        expect(request.sessionID).toBe(pending.sessionID)
        expect(request.tool).toEqual(pending.tool)
        expect(request.questions).toEqual([
          { question: text, header: "Comprehension", options: [], custom: true, multiple: false },
        ])
        expect(yield* questions.list()).toEqual([request])
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(original)
        if (action === "reply") {
          const answers = [["Equality now returns true."]]
          yield* questions.reply({ requestID: request.id, answers })
          expect(yield* Fiber.join(fiber)).toEqual({ pending, question: text, answers })
        }
        if (action === "reject") {
          yield* questions.reject(request.id)
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Question.RejectedError)
        }
        if (action === "interrupt") {
          yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        }
        expect(yield* questions.list()).toEqual([])
        expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(original)
      }),
    )
  })

  it.instance("does not publish a question when generation fails", () =>
    Effect.gen(function* () {
      const questions = yield* Question.Service
      const exit = yield* ComprehensionHandoff.present({
        pending: {
          sessionID: SessionID.make("ses_failure"),
          tool: { messageID: MessageID.make("msg_failure"), callID: "call_failure" },
          context: ChangeContext.extract("example.txt", "old", "new"),
        },
        model,
      }).pipe(Effect.provide(Layer.mock(LLM.Service, { stream: () => Stream.fail(new Error("offline")) })), Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(ComprehensionQuestion.GenerationFailed)
      expect(yield* questions.list()).toEqual([])
    }),
  )
})
