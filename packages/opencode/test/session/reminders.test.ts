import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import type { Agent } from "../../src/agent/agent"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { SessionReminders } from "../../src/session/reminders"
import { Session } from "../../src/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const remindersLayer = LayerNode.compile(LayerNode.group([Session.node, FSUtil.node, RuntimeFlags.node]))

const it = testEffect(remindersLayer)

const sessionID = SessionID.make("ses_reminders")

const agent = (name: string) => ({ name }) as unknown as Agent.Info

const session = { id: sessionID } as unknown as Session.Info

function userMessage(text: string): SessionV1.WithParts {
  const id = MessageID.make("msg_user")
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 0 },
      path: { cwd: "/", root: "/" },
    } as unknown as SessionV1.User,
    parts: [
      {
        id: PartID.make("prt_1"),
        sessionID,
        messageID: id,
        type: "text",
        text,
      },
    ] as SessionV1.Part[],
  }
}

// Returns the text of every synthetic part appended by the reminder pass.
function synthetic(messages: SessionV1.WithParts[]): string[] {
  return messages
    .flatMap((msg) => msg.parts)
    .filter((part) => part.type === "text" && part.synthetic)
    .map((part) => (part.type === "text" ? part.text : ""))
}

afterEach(async () => {
  await disposeAllInstances()
})

it.instance("learn agent gets the read-only reminder", () =>
  Effect.gen(function* () {
    const messages = yield* SessionReminders.apply({
      messages: [userMessage("how does the agent registry work?")],
      agent: agent("learn"),
      session,
    })
    const texts = synthetic(messages)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("Learn Mode")
    expect(texts[0]).toContain("READ-ONLY")
  }),
)

// The regression that motivated this: denying the edit tools strips them from the
// toolset, but bash survives, so the reminder has to forbid shell-based edits too.
it.instance("learn reminder forbids editing files through bash", () =>
  Effect.gen(function* () {
    const messages = yield* SessionReminders.apply({
      messages: [userMessage("add Michael to the contributors in the README")],
      agent: agent("learn"),
      session,
    })
    const text = synthetic(messages)[0] ?? ""
    expect(text).toContain("sed")
    expect(text).toContain("bash command")
    expect(text).toMatch(/only.*read\/inspect/i)
  }),
)

it.instance("build agent gets no read-only reminder", () =>
  Effect.gen(function* () {
    const messages = yield* SessionReminders.apply({
      messages: [userMessage("add Michael to the contributors in the README")],
      agent: agent("build"),
      session,
    })
    expect(synthetic(messages)).toHaveLength(0)
  }),
)

it.instance("plan agent still gets the plan reminder", () =>
  Effect.gen(function* () {
    const messages = yield* SessionReminders.apply({
      messages: [userMessage("how does the agent registry work?")],
      agent: agent("plan"),
      session,
    })
    const texts = synthetic(messages)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("Plan Mode")
  }),
)
