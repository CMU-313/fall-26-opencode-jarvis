# Traceability: Alex de Leeuw (adeleeuw)

**Target feature:** Queued prompts (queue mode vs. steer mode) in OpenCode; main source files:

- [Toggle UI and queued-prompt display](https://github.com/CMU-313/fall-26-opencode-jarvis/blob/79c421867310b2f4bdde0198133f11967b8b87db/packages/tui/src/component/prompt/index.tsx)
- [Storing a queued message and sending when idle](https://github.com/CMU-313/fall-26-opencode-jarvis/blob/79c421867310b2f4bdde0198133f11967b8b87db/packages/tui/src/prompt/followup-queue.ts)
- [Steer/queue mode state](https://github.com/CMU-313/fall-26-opencode-jarvis/blob/79c421867310b2f4bdde0198133f11967b8b87db/packages/tui/src/context/delivery.tsx)
- [Local prompt delivery](https://github.com/CMU-313/fall-26-opencode-jarvis/blob/79c421867310b2f4bdde0198133f11967b8b87db/packages/tui/src/context/local.tsx)
- [Keybinds (ctrl+x w, ctrl+x d)](https://github.com/CMU-313/fall-26-opencode-jarvis/blob/79c421867310b2f4bdde0198133f11967b8b87db/packages/tui/src/config/keybind.ts)
- [CI test task for the TUI package](https://github.com/CMU-313/fall-26-opencode-jarvis/blob/79c421867310b2f4bdde0198133f11967b8b87db/turbo.json)
- [End to end tests](https://github.com/CMU-313/fall-26-opencode-jarvis/blob/79c421867310b2f4bdde0198133f11967b8b87db/packages/tui/test/cli/tui/followup-delivery.test.ts)
- [Delivery context tests](https://github.com/CMU-313/fall-26-opencode-jarvis/blob/79c421867310b2f4bdde0198133f11967b8b87db/packages/tui/test/context/delivery.test.tsx)
- [Queue tests](https://github.com/CMU-313/fall-26-opencode-jarvis/blob/79c421867310b2f4bdde0198133f11967b8b87db/packages/tui/test/prompt/followup-queue.test.ts)

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test | Mutant it kills |
|---|---|---|---|---|---|---|---|
| R1 | C-3: “in the wrong order or quantity”<br>S-2: “handle sending several queued messages and not crash”<br>O-2: “in the order I queued it” | Several queued prompts are sent in the order they were queued (FIFO), one at a time, without crashing. | During a running turn, queue prompts labeled A, B, C in that order. On the first idle, only A is sent. B is sent only after the turn started by A goes idle, and C only after B’s turn. Verify there are no errors or crashes. | No | Prompts are always sent in the order they were queued, one at a time (model / oracle) | [packages/tui/test/prompt/followup-queue.property.test.ts](../packages/tui/test/prompt/followup-queue.property.test.ts) | H1, H6 |
| R2 | C-2: “never be changed in any way before it actually gets sent”<br>O-2: “the text should be exactly what I typed. Nothing should rewrite or trim it” | A queued prompt is sent with exactly the text the user typed. | Queue the text "Find and fix the bug in ‘index.ts’ ". Verify that the prompt sent after idle is identical to this string, character for character. | No | Queued text is sent exactly as it was typed, including spaces (round-trip) | [packages/tui/test/prompt/followup-queue.property.test.ts](../packages/tui/test/prompt/followup-queue.property.test.ts) | H2 |
| R3 | S-2: “I do not want the model to know that there are any queued messages”<br>S-4: “The model should not know about any queued prompts”<br>O-3: “Sent while the agent is still working is basically the same as not queuing at all”<br>O-6: “in queue mode it only sees it after the current task finishes” | In queue mode, a queued prompt is not sent, and the running turn does not see it, until the session goes idle. | During a running turn in queue mode, submit prompt A. Verify the running turn never receives A and nothing is sent until the session goes idle, then verify A is sent. In steer mode, the same prompt is sent immediately. | No | A prompt is only ever sent while the session is idle (invariant). A prompt is queued only when the session is busy and the mode is queue (three algebraic laws). Both added in P5. | [packages/tui/test/prompt/followup-queue.property.test.ts](../packages/tui/test/prompt/followup-queue.property.test.ts) | H4 |
| R4 | C-5: “canceled entirely”<br>S-4: “if i queue it and then cancel it, there should be no change”<br>O-4: “Nothing should be sent to the agent” | Cancelling a queued prompt removes it completely, and the input box is left alone. | During a running turn, queue prompt A, then type “testing” in the input box and cancel A. Verify the queue is empty, the input box still says “testing”, and A is never sent when the session goes idle. | No | Cancelling a prompt gives the same result as never queuing it (metamorphic) | [packages/tui/test/prompt/followup-queue.property.test.ts](../packages/tui/test/prompt/followup-queue.property.test.ts) | H1 (also killed by R1) |
| R5 | C-4: “some sort of verification that the queued message was canceled”<br>O-4: “some small confirmation that it was canceled, like a toast” | Cancelling a queued prompt shows a confirmation that it was canceled, and the confirmation is removed once the user submits another prompt. | Queue prompt A and cancel it. Verify a “canceled” confirmation appears and the input box still works. Submit a new prompt and verify the confirmation is gone. | Yes | None (the confirmation is TUI display code, not part of the queue module) | None | None |
| R6 | C-9: “the most recently sent prompt from my end”<br>S-6: “two checkpoints at which we can go back to”<br>O-8: “the agent sitting idle with a prompt still showing as queued” | When a queued prompt is sent, it appears once in the history as its own entry right after the last agent response, and it leaves the queued list. | Start with a history of one prompt and its response, then queue prompt A. After idle, verify A appears once in the history right after that response, and that A is no longer in the queued list. | No | Every prompt is always either queued, sent once, or canceled (invariant) | [packages/tui/test/prompt/followup-queue.property.test.ts](../packages/tui/test/prompt/followup-queue.property.test.ts) | H3 |
| R7 | C-3: “most frustrating if the prompt disappeared”<br>S-8: “the agent lost some of the instructions that I gave it”<br>O-9: “a clear error state on the queued item, not just silence, and also some way to retry” | While the TUI session is open, if sending a queued prompt fails, it stays visible with an error and a Retry option, and is removed only when the user retries successfully or cancels it. | Make the send fail for queued prompt A. Verify A stays in the list marked as failed, not QUEUED, with a Retry option. Click Retry with sending working and verify A is sent once and removed from the list. | Yes | A failed queued prompt stays until a retry succeeds or it is canceled, each failure reports one error, no automatic retry loop, and an idle session with no pending failure has nothing left queued (model / invariant). A failed prompt is retried on the next turn, not on returning to idle (scenario property). | [packages/tui/test/prompt/followup-queue.property.test.ts](../packages/tui/test/prompt/followup-queue.property.test.ts) | H5, H6 (also killed by R1) |

Properties written or suggested by opencode or another AI tool: revised R5 and R7 properties, code for R1, R2, R4, R6 


## Requirement changes

| ID | Original requirement (P3) | Revised requirement | Why it changed |
|---|---|---|---|
| R5 | Cancelling a queued prompt shows a brief confirmation that goes away when the user sends another prompt. | Cancelling a queued prompt shows a confirmation that it was canceled, and the confirmation is removed as soon as the user submits another prompt. | Original requirement is not testable, since the confirmation being “brief” is subjective and is not something that we can test. We can, however, verify that the confirmation disappears after another prompt is sent. |
| R7 | If sending a queued prompt fails, it stays visible with an error and a Retry option, and is never dropped without saying anything. | While the TUI session is open, if sending a queued prompt fails, it stays visible with an error and a Retry option, and is removed only when the user retries successfully or cancels it. | Original requirement is not feasible, since “never” would also cover the TUI being closed or crashing with prompts still queued, which the feature can’t guard against. |

## Hand-written mutants


| ID | Requirement targeted | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| H1 | R1 | followup-queue.ts: `add` prepends the new prompt (`[{ id, text, send }, ...list]`) instead of appending it, so the newest queued prompt is sent first | "Prompts are always sent in the order they were queued, one at a time" (R1). R4 and R6 don't check order, so only R1 should catch it. | Killed by R1 and R4. R4 was unexpected: with the order reversed, it cancels a different prompt than it expects. |
| H2 | R2 | followup-queue.ts: `add` stores `text.trim()` instead of `text`, so leading and trailing whitespace is lost | "Queued text is sent exactly as it was typed, including spaces" (R2), through the `queue.items[0].text` assertion. The `h.sent` assertion can't catch it because the harness pushes the original text. | Killed by R2. |
| H3 | R4 | followup-queue.ts: `cancelLatest` changed from `slice(0, -1)` to `slice(1)`, so it cancels the oldest prompt instead of the newest | "Every prompt is always either queued, sent once, or canceled" (R6). R4 only uses `cancel(id)`, so it never runs this code. | Killed by R6. |
| H4 | R3 | followup-queue.ts: `nextQueuedFollowup` check changed from `status !== "idle"` to `status === "busy"`, so a queued prompt is also sent while the status is "retry" | None expected. No property checks that nothing is sent unless the session is idle (R3 has no property). | Survived at first. Killed by the new R3 property (only sent while idle). |
| H5 | R7 | followup-queue.ts: removed `setItems((list) => [next, ...list])` from the `.catch`, so a prompt whose send fails is silently dropped | None expected. The harness never makes `send` reject, so the failure path is never exercised (R7 has no property). | Survived at first. Killed by R7 once a failing send was added to the harness. |
| H6 | R1 | followup-queue.ts: `sending() \|\| failed()` changed to `failed()`, removing the guard that stops a second prompt being sent while one is in flight | R1 ("at most one send in flight"). Prediction made after the fact: this change was in my first H4.patch by mistake, so I kept it as an extra mutant. | Killed by R1 and R7. |

## Stryker comparison

Seed: 42. Config: `packages/tui/stryker.adeleeuw.config.json`, mutating `src/prompt/followup-queue.ts` (61 mutants). Final report: `mutants/adeleeuw/mutation.html`.

| Run | Test file state | Killed / 61 | Survived | Score |
|---|---|---|---|---|
| 1 | P4 properties (R1, R2, R4, R6) | 40 | 21 | 65.57% |
| 2 | + opencode's R7 property | 45 | 16 | 73.77% |
| 3 | + R3 properties, + R7 liveness assertion | 58 | 3 | 95.08% |
| 4 (final) | + R7 scenario property | 61 | 0 | 100.00% |

**1. Which hand-written mutants did Stryker never generate? Why not?** All six, as written. Stryker changes one token or node at a time from a fixed table. It empties arrays but never reorders them (H1), removes method calls but never adds `.trim()` (H2), and never drops one operand of `||` (H6). For H3 it generated only neighbors (removing `slice`, and `-1` to `+1`), not the two-argument rewrite. H4 needs two edits on the same line (the operator and the string), and Stryker produced only single-edit variants there (`=== "idle"`, `if (false)`, `""`). For H5 it emptied the whole `.catch` block and replaced the `setItems` callback or its array, but never deleted that one statement.

**2. Which Stryker survivors would I never have thought of? Are any plausible real bugs?** The ten survivors in `shouldQueueFollowup`: I hadn't noticed that no property called it. Two are realistic: `||` instead of `&&` and `delivery !== "queue"` would make steer-mode prompts get queued. The five survivors on the `failed` reset (lines 34-35) are also realistic. Dropping that reset in a refactor leaves a failed prompt stuck until the TUI restarts, and resetting on idle instead of on leaving idle makes it retry the moment the session goes idle.

**3. What does each approach find that the other doesn't?** Hand-written mutants find multi-token bugs shaped like the requirements, and they test my predictions (two were wrong: R4 also killed H1, and my first H4 patch did not match its description). Stryker finds code and behavior I never thought to test, such as the untested function and the failure-then-retry cycle, but it cannot produce bugs like H1 to H6.

I killed survivors only by strengthening properties: three laws and an "only sent while idle" property for R3, and a liveness assertion plus a scenario property for R7. The scenario property is the closest to an example test, but it quantifies over the prompt text and the non-idle statuses.

### Equivalent mutants

- None. Every survivor was killed by strengthening a property.

**Final mutation score**: 100.00, **Mutation score without equivalents**: 100.00

## Agent failure case

> **Prompt:** In packages/tui/test/prompt/followup-queue.property.test.ts, write a fast-check property for requirement R7: "While the TUI session is open, if sending a queued prompt fails, it stays visible with an error and a Retry option, and is removed only when the user retries successfully or cancels it." Use createFollowupQueue and the existing harness style.
>
> **Response:** I added an R7 property to followup-queue.property.test.ts. All 5 tests in the file pass and `bun typecheck` is clean.
>
> **What it does:** It runs random sequences of add, status change, successful send, failed send, and cancel (any queued item). After each step it checks:
> - **Stays visible:** a prompt whose send failed, and that hasn't since been sent successfully or cancelled, is still in `queue.items`, or is the retry currently being sent.
> - **Error shown:** each failed send calls `onError` exactly once, with that send's error message.
> - **No silent retry:** a failed prompt isn't sent again until the session starts a new turn (status changes to something other than `idle`). Without this, it would retry endlessly while idle.
> - **No duplicates:** the same prompt is never listed twice.
>
> **Harness changes:** The fake sends now record their text and can be made to fail. `finish()` returns the finished prompt's text instead of `true`/`false`, and I added `fail()` and `inFlight()`. Because a prompt's text can be `""`, I changed R1's two `if (h.finish())` checks to compare against `undefined`.
>
> **Checking it can fail:** I temporarily broke `followup-queue.ts` in two ways: once so a failed prompt isn't put back in the queue, and once so the queue resends it immediately in a loop. R7 failed both times. I then restored the file, and it has no changes.
>
> **Not covered:** `createFollowupQueue` has no error state on each queued item and no Retry action. A failed prompt is only retried on the next turn. So the test treats the next turn as the retry, and treats the shared `onError` call as the error. The "error shown with the item, plus a Retry option" part of R7 can't be tested at this level until the queue exposes something like `item.error` and `retry(id)`.

The property let five Stryker mutants of the `failed` reset survive (run 2, 73.77): 28 and 30 (lines 34-35, `failed` never reset) and 29, 31 and 32 (line 35, `failed` reset on returning to idle instead of on leaving idle). The property was too weak because it only checks that bad things don't happen (the prompt isn't lost, the error is reported once, no early resend, no duplicates) and never that the retry actually happens, so a queue where a failed prompt is stuck forever passes every assertion. Opencode's own check only broke the code in two ways, both safety violations, so it could not reveal this. The generator also rarely produces "fail while busy, then straight to idle", which is the only order that separates mutants 29, 31 and 32 from the original code.

Strengthened version:

```ts
// In the R7 random-sequence test: a `blocked` flag models "a failure is waiting for a new turn".
// It is set by any failure and cleared when the status leaves idle. Added after each step:
// Liveness: once a new turn has started, an idle session with nothing in flight has sent everything.
if (status === "idle" && !blocked && h.inFlight().length === 0) expect(h.texts()).toEqual([])

// New scenario property: returning to idle is not a new turn.
test("R7: a failed prompt is retried on the next turn, not on returning to idle", async () => {
  await fc.assert(
    fc.asyncProperty(
      typedText,
      fc.constantFrom("busy", "retry"),
      fc.constantFrom("busy", "retry"),
      async (text, whileFailing, nextTurn) => {
        await withQueue(async (h) => {
          h.add(text)
          h.setStatus("idle")
          await flush()
          expect(h.sent).toEqual([text])
          h.setStatus(whileFailing) // the turn is running when the send fails
          await flush()
          expect(h.fail()).toBe(text)
          await flush()
          expect(h.errors).toHaveLength(1)
          h.setStatus("idle") // back to idle without a new turn: no retry
          await flush()
          expect(h.sent).toEqual([text])
          expect(h.texts()).toEqual([text])
          h.setStatus(nextTurn) // a new turn starts and ends: now the retry goes out, once
          await flush()
          h.setStatus("idle")
          await flush()
          expect(h.sent).toEqual([text, text])
          expect(h.texts()).toEqual([])
        })
      },
    ),
    { numRuns: 50 },
  )
})
```

The R7 generator also weights status changes and failures higher (weights 4 and 3) and runs 300 times instead of 200. With opencode's version, mutants 28 to 32 survive (run 2: 73.77, 16 survivors). With the strengthened version they are killed: the liveness assertion killed 28 and 30 (run 3: 95.08, survivors 29, 31, 32), and the scenario property killed the last three (run 4: 100.00, 0 survivors).

### Evidence

**Before (opencode's R7 only).** Survivors on the `failed` reset in Stryker run 2:

```text
28 Survived BlockStatement 34:34 "{}"
29 Survived ConditionalExpression 35:11 "true"
30 Survived ConditionalExpression 35:11 "false"
32 Survived StringLiteral 35:22 "\"\""
31 Survived EqualityOperator 35:11 "status === \"idle\""
```

**After (strengthened properties).** I re-created each of the five mutants by editing line 35 of `followup-queue.ts` (for 28, deleting the line so the callback body is empty), ran the final test file against each, and reverted. The counterexamples are fast-check's shrunk inputs (seed 42).

| Mutant | Change on line 35 | Failing test | Shrunk counterexample |
|---|---|---|---|
| 28 | line deleted (callback body empty) | R7 random-sequence test and R7 scenario property | `add, idle, fail, busy, idle`; and `("", "busy", "busy")` |
| 29 | `status !== "idle"` to `true` | R7 scenario property | `("", "busy", "busy")` |
| 30 | `status !== "idle"` to `false` | R7 random-sequence test and R7 scenario property | `add, idle, fail, busy, idle`; and `("", "busy", "busy")` |
| 31 | `status !== "idle"` to `status === "idle"` | R7 scenario property | `("", "busy", "busy")` |
| 32 | `"idle"` to `""` | R7 scenario property | `("", "busy", "busy")` |

Mutants 28 and 30 are killed by the random-sequence test: its counterexample ends with the prompt still queued while the session is idle, which is what the liveness assertion forbids. Mutants 29, 31 and 32 survive the random-sequence test and are killed only by the scenario property, which matches Stryker run 3 (survivors 29, 31, 32). After all five runs, `git status` showed `followup-queue.ts` unchanged.