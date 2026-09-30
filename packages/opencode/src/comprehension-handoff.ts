import { ChangeContext } from "@opencode-ai/core/change-context"
import { Effect } from "effect"
import { ComprehensionEvaluation } from "./comprehension-evaluation"
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

export interface EvaluatedSubmission extends Submission {
  readonly evaluation: ComprehensionEvaluation.Result
}

export const present = Effect.fn("ComprehensionHandoff.present")(function* (input: {
  pending: PendingChange
  feedback?: string
  model: Provider.Model
}) {
  const question = yield* ComprehensionQuestion.generate({
    context: input.pending.context,
    sessionID: input.pending.sessionID,
    model: input.model,
  })
  const questions = yield* Question.Service
  const prompt = input.feedback ? `Previous answer did not pass: ${input.feedback}\n\n${question}` : question
  const answers = yield* questions.ask({
    sessionID: input.pending.sessionID,
    tool: input.pending.tool,
    questions: [{ question: prompt, header: "Comprehension", options: [], custom: true, multiple: false }],
  })
  return { pending: input.pending, question, answers } satisfies Submission
})

export const presentAndEvaluate = Effect.fn("ComprehensionHandoff.presentAndEvaluate")(function* (input: {
  pending: PendingChange
  model: Provider.Model
  feedback?: string
}) {
  const submission = yield* present(input)
  const response = submission.answers[0]?.join("\n") ?? ""
  const evaluation = yield* ComprehensionEvaluation.evaluate({
    context: submission.pending.context,
    sessionID: submission.pending.sessionID,
    model: input.model,
    question: submission.question,
    response,
  })
  return { ...submission, evaluation } satisfies EvaluatedSubmission
})

export const gate = Effect.fn("ComprehensionHandoff.gate")(function* (input: {
  pending: PendingChange
  model: Provider.Model
}) {
  let feedback: string | undefined

  while (true) {
    const submission = yield* presentAndEvaluate({ ...input, feedback })

    if (submission.evaluation.passed) {
      return submission
    }

    feedback = submission.evaluation.feedback
  }
})

export * as ComprehensionHandoff from "./comprehension-handoff"
