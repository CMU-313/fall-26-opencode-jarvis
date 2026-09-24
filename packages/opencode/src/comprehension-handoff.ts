import { ChangeContext } from "@opencode-ai/core/change-context"
import { Effect } from "effect"
import { ComprehensionQuestion } from "./comprehension-question"
import { Provider } from "./provider/provider"
import { Question } from "./question"
import { SessionID } from "./session/schema"

/** Identity and context only; the caller retains ownership of executing the pending edit. */
export interface PendingChange {
  readonly sessionID: SessionID
  readonly tool: Question.Tool
  readonly context: ReturnType<typeof ChangeContext.extract>
}

/** An unevaluated response for #13. Returning this does not authorize the pending edit. */
export interface Submission {
  readonly pending: PendingChange
  readonly question: string
  readonly answers: ReadonlyArray<Question.Answer>
}

export const present = Effect.fn("ComprehensionHandoff.present")(function* (input: {
  pending: PendingChange
  model: Provider.Model
}) {
  const question = yield* ComprehensionQuestion.generate({
    context: input.pending.context,
    sessionID: input.pending.sessionID,
    model: input.model,
  })
  const questions = yield* Question.Service
  const answers = yield* questions.ask({
    sessionID: input.pending.sessionID,
    tool: input.pending.tool,
    questions: [{ question, header: "Comprehension", options: [], custom: true, multiple: false }],
  })
  return { pending: input.pending, question, answers } satisfies Submission
})

export * as ComprehensionHandoff from "./comprehension-handoff"
