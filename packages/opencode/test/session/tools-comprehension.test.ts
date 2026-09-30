import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ChangeContext } from "@opencode-ai/core/change-context"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LLMEvent } from "@opencode-ai/llm"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LLM } from "@/session/llm"
import { SessionTools } from "@/session/tools"
import { MessageID, SessionID } from "@/session/schema"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Question } from "@/question"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { model } from "../fixture/comprehension"
import { testEffect } from "../lib/effect"

const question = "What happens when count equals limit after this change?"
const answer = "It now includes equality, so count equal to limit returns true."
const filediff = ChangeContext.extract("limit.ts", "return count > limit\n", "return count >= limit\n")

const baseLayer = Layer.mergeAll(
  LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, CrossSpawnSpawner.node])),
  Layer.mock(Plugin.Service, {
    trigger: ((_name, _input, output) => Effect.succeed(output)) as Plugin.Interface["trigger"],
  }),
  Layer.mock(MCP.Service, {
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
  }),
  Layer.mock(Truncate.Service, {
    output: (content) => Effect.succeed({ content, truncated: false }),
  }),
  RuntimeFlags.layer(),
)

const it = testEffect(baseLayer)

function testAgent(learnMode: boolean): Agent.Info {
  return {
    name: "test-agent",
    mode: "primary",
    permission: [],
    options: { learnMode },
  }
}

function processor() {
  return {
    message: { id: MessageID.make("msg_tools_comprehension") },
    updateToolCall: () => Effect.void,
    completeToolCall: () => Effect.void,
  }
}

function llmEvaluations(results: ReadonlyArray<boolean>) {
  let calls = 0
  let evaluations = 0
  return Layer.mock(LLM.Service, {
    stream: () => {
      calls++
      if (calls % 2 === 1) return Stream.make(LLMEvent.textDelta({ id: `question-${calls}`, text: question }))
      const passed = results[Math.min(evaluations, results.length - 1)] ?? false
      evaluations++
      return Stream.make(
        LLMEvent.textDelta({
          id: `evaluation-${calls}`,
          text: JSON.stringify({
            passed,
            feedback: passed
              ? "The answer explains the behavior change."
              : "A sufficient answer should mention that equality is now included.",
          }),
        }),
      )
    },
  })
}

function failingLlm() {
  return Layer.mock(LLM.Service, {
    stream: () => Stream.fail(new Error("LLM should not be called")),
  })
}

function permissionLayer(requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">>) {
  return Layer.mock(Permission.Service, {
    ask: (request) =>
      Effect.sync(() => {
        requests.push(request)
      }),
    reply: () => Effect.void,
    list: () => Effect.succeed([]),
  })
}

function toolRegistryLayer(afterAsk: () => void) {
  const fakeEditTool: Tool.Def = {
    id: "fake_edit",
    description: "Fake edit tool for comprehension gating",
    parameters: Schema.Struct({}),
    execute: (_args, ctx) =>
      Effect.gen(function* () {
        yield* ctx.ask({
          permission: "edit",
          patterns: ["limit.ts"],
          always: ["*"],
          metadata: { filediff },
        })
        afterAsk()
        return {
          title: "fake edit",
          metadata: {},
          output: "edit continued",
        }
      }),
  }

  return Layer.mock(ToolRegistry.Service, {
    ids: () => Effect.succeed(["fake_edit"]),
    all: () => Effect.succeed([fakeEditTool]),
    named: () => Effect.die("unused"),
    tools: () => Effect.succeed([fakeEditTool]),
  })
}

function runFakeEdit(input: { learnMode: boolean; afterAsk: () => void }) {
  return Effect.gen(function* () {
    const tools = yield* SessionTools.resolve({
      agent: testAgent(input.learnMode),
      model,
      session: { id: SessionID.make("ses_tools_comprehension") } as any,
      processor: processor() as any,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as any,
    })

    return yield* Effect.promise(() =>
      tools.fake_edit.execute?.(
        {},
        {
          toolCallId: "call_fake_edit",
          abortSignal: new AbortController().signal,
        } as any,
      ),
    )
  }).pipe(Effect.provide(toolRegistryLayer(input.afterAsk)))
}

function waitForQuestion() {
  return Effect.gen(function* () {
    const questions = yield* Question.Service
    let request: Question.Request | undefined
    while (!request) {
      request = (yield* questions.list())[0]
      if (!request) yield* Effect.sleep("1 millis")
    }
    return request
  })
}

function answerQuestion(response = answer) {
  return Effect.gen(function* () {
    const questions = yield* Question.Service
    const request = yield* waitForQuestion()
    yield* questions.reply({ requestID: request.id, answers: [[response]] })
    return request
  })
}

describe("SessionTools comprehension gate", () => {
  it.instance("continues to downstream permission when LearnMode comprehension passes", () =>
    Effect.gen(function* () {
      const permissionRequests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      let continued = false

      const fiber = yield* runFakeEdit({
        learnMode: true,
        afterAsk: () => {
          continued = true
        },
      }).pipe(Effect.provide(permissionLayer(permissionRequests)), Effect.provide(llmEvaluations([true])), Effect.forkScoped)

      yield* answerQuestion()

      expect(yield* Fiber.join(fiber)).toMatchObject({ output: "edit continued" })
      expect(permissionRequests.map((request) => request.permission)).toEqual(["edit"])
      expect(continued).toBe(true)
    }),
  )

  it.instance("waits for passing comprehension before downstream permission", () =>
    Effect.gen(function* () {
      const permissionRequests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      let continued = false

      const fiber = yield* runFakeEdit({
        learnMode: true,
        afterAsk: () => {
          continued = true
        },
      }).pipe(
        Effect.provide(permissionLayer(permissionRequests)),
        Effect.provide(llmEvaluations([false, true])),
        Effect.forkScoped,
      )

      yield* answerQuestion("I don't know.")
      const retry = yield* waitForQuestion()
      expect(retry.questions[0]?.question).toContain("Previous answer did not pass")
      expect(permissionRequests).toEqual([])
      expect(continued).toBe(false)

      const questions = yield* Question.Service
      yield* questions.reply({ requestID: retry.id, answers: [[answer]] })

      expect(yield* Fiber.join(fiber)).toMatchObject({ output: "edit continued" })
      expect(permissionRequests.map((request) => request.permission)).toEqual(["edit"])
      expect(continued).toBe(true)
    }),
  )

  it.instance("skips comprehension when LearnMode is off", () =>
    Effect.gen(function* () {
      const permissionRequests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      let continued = false

      const result = yield* runFakeEdit({
        learnMode: false,
        afterAsk: () => {
          continued = true
        },
      }).pipe(Effect.provide(permissionLayer(permissionRequests)), Effect.provide(failingLlm()))

      expect(result).toMatchObject({ output: "edit continued" })
      expect(permissionRequests.map((request) => request.permission)).toEqual(["edit"])
      expect(continued).toBe(true)
    }),
  )
})
