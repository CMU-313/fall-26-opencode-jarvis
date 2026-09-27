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

  it.instance("evaluates the answer while leaving the pending edit unapplied", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const file = `${instance.directory}/limit.txt`
      const original = "return count > limit\n"
      yield* Effect.promise(() => Bun.write(file, original))
      const pending: ComprehensionHandoff.PendingChange = {
        sessionID: SessionID.make("ses_comprehension_eval"),
        tool: { messageID: MessageID.make("msg_change_eval"), callID: "call_edit_eval" },
        context: ChangeContext.extract(file, original, "return count >= limit\n"),
      }
      const questions = yield* Question.Service
      const events = yield* EventV2Bridge.Service
      const published = yield* Deferred.make<Question.Request>()
      const evaluating = yield* Deferred.make<void>()
      const releaseEvaluation = yield* Deferred.make<void>()
      const off = yield* events.listen((event) => {
        if (event.type === Question.Event.Asked.type)
          return Deferred.succeed(published, Schema.decodeUnknownSync(Question.Request)(event.data)).pipe(Effect.asVoid)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)

      let calls = 0
      const evaluation = {
        passed: true,
        feedback: "The response explains that equality is now included.",
      }
      const fiber = yield* ComprehensionHandoff.presentAndEvaluate({ pending, model }).pipe(
        Effect.provide(
          Layer.mock(LLM.Service, {
            stream: (request) => {
              calls++
              if (calls === 1) return Stream.make(LLMEvent.textDelta({ id: "question", text }))

              expect(request.messages).toEqual([
                {
                  role: "user",
                  content: JSON.stringify({
                    file: pending.context.file,
                    patch: pending.context.patch,
                    question: text,
                    response: "Equality now returns true.",
                  }),
                },
              ])

              return Stream.unwrap(
                Effect.gen(function* () {
                  yield* Deferred.succeed(evaluating, undefined)
                  yield* Deferred.await(releaseEvaluation)
                  return Stream.make(LLMEvent.textDelta({ id: "evaluation", text: JSON.stringify(evaluation) }))
                }),
              )
            },
          }),
        ),
        Effect.forkScoped,
      )

      const request = yield* Deferred.await(published)
      yield* questions.reply({ requestID: request.id, answers: [["Equality now returns true."]] })

      yield* Deferred.await(evaluating)
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(original)

      yield* Deferred.succeed(releaseEvaluation, undefined)
      expect(yield* Fiber.join(fiber)).toEqual({
        pending,
        question: text,
        answers: [["Equality now returns true."]],
        evaluation,
      })
      expect(calls).toBe(2)
      expect(yield* questions.list()).toEqual([])
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(original)
    }),
  )

  it.instance("gate shows feedback and asks another question after comprehension fails", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const file = `${instance.directory}/limit.txt`
      const original = "return count > limit\n"
      yield* Effect.promise(() => Bun.write(file, original))
      const pending: ComprehensionHandoff.PendingChange = {
        sessionID: SessionID.make("ses_comprehension_gate_fail"),
        tool: { messageID: MessageID.make("msg_change_gate_fail"), callID: "call_edit_gate_fail" },
        context: ChangeContext.extract(file, original, "return count >= limit\n"),
      }
      const questions = yield* Question.Service
      const events = yield* EventV2Bridge.Service
      const firstPublished = yield* Deferred.make<Question.Request>()
      const secondPublished = yield* Deferred.make<Question.Request>()
      let published = 0
      const off = yield* events.listen((event) => {
        if (event.type === Question.Event.Asked.type) {
          const request = Schema.decodeUnknownSync(Question.Request)(event.data)
          published++
          return Deferred.succeed(published === 1 ? firstPublished : secondPublished, request).pipe(Effect.asVoid)
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)

      let calls = 0
      const failed = { passed: false, feedback: "This should mention that equality is now included." }
      const passed = { passed: true, feedback: "The response explains the behavior change." }
      const fiber = yield* ComprehensionHandoff.gate({ pending, model }).pipe(
        Effect.provide(
          Layer.mock(LLM.Service, {
            stream: () => {
              calls++
              if (calls === 1) return Stream.make(LLMEvent.textDelta({ id: "question-1", text }))
              if (calls === 2) return Stream.make(LLMEvent.textDelta({ id: "evaluation-1", text: JSON.stringify(failed) }))
              if (calls === 3) return Stream.make(LLMEvent.textDelta({ id: "question-2", text }))
              return Stream.make(LLMEvent.textDelta({ id: "evaluation-2", text: JSON.stringify(passed) }))
            },
          }),
        ),
        Effect.forkScoped,
      )

      const first = yield* Deferred.await(firstPublished)
      expect(first.questions).toEqual([
        { question: text, header: "Comprehension", options: [], custom: true, multiple: false },
      ])
      yield* questions.reply({ requestID: first.id, answers: [["I don't know."]] })

      const second = yield* Deferred.await(secondPublished)
      expect(second.questions).toEqual([
        {
          question: `Previous answer did not pass: ${failed.feedback}\n\n${text}`,
          header: "Comprehension",
          options: [],
          custom: true,
          multiple: false,
        },
      ])
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(original)
      yield* questions.reply({ requestID: second.id, answers: [["Equality now returns true."]] })

      expect(yield* Fiber.join(fiber)).toEqual({
        pending,
        question: text,
        answers: [["Equality now returns true."]],
        evaluation: passed,
      })
      expect(calls).toBe(4)
      expect(yield* questions.list()).toEqual([])
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(original)
    }),
  )

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
