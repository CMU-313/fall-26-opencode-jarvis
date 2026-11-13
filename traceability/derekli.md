# Traceability: Derek Li (derekli)

**Target feature:** Queue/Steer Follow-Up Prompt Management in OpenCode

- [`packages/tui/src/prompt/followup-queue.ts`](../packages/tui/src/prompt/followup-queue.ts)
- [`packages/tui/src/context/delivery.tsx`](../packages/tui/src/context/delivery.tsx)
- [`packages/tui/src/component/prompt/index.tsx`](../packages/tui/src/component/prompt/index.tsx)
- [`packages/tui/src/routes/session/index.tsx`](../packages/tui/src/routes/session/index.tsx)

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test | Mutants it kills |
|---|---|---|---|---|---|---|---|
| R1 | C-2, S-2, O-2: Queued prompts should wait until the current task finishes. | A queued follow-up must not be sent to the agent until the current task finishes. | Given an active session processing prompt A, when the user queues prompt B, B remains pending and is not sent to the agent. Once A finishes and the session becomes idle, B is sent. | No | Invariant | [Queued follow-up waits for the active task](../packages/tui/test/prompt/followup-queue.property.test.tsx#L18) · [Idle or Steer submissions send immediately](../packages/tui/test/prompt/followup-queue.property.test.tsx#L40) | H1 |
| R2 | S-2, S-5: Queued prompts should not influence the current task or provide information prematurely. | The agent must not receive the content of a queued prompt before that prompt is dispatched. | Given an active prompt A and a queued prompt B containing a unique instruction, the agent's input for A must not contain B's instruction. B's instruction becomes available only when B is dispatched. | No | — | — | — |
| R3 | C-3, S-3, O-3: Switching modes should only change the selected mode, not the current task or existing queue. | Switching between Steer and Queue without submitting a new prompt must preserve the current task and all pending queued prompts. | Given active prompt A and queued prompts B and C, switching Queue → Steer → Queue leaves A running and B and C pending in the original order. | No | Round-trip | [Queue → Steer → Queue preserves the active task and pending queue](../packages/tui/test/prompt/followup-queue.property.test.tsx#L62) | H2, H3 |
| R4 | C-4, S-4, O-4: Adding another queued prompt should not affect existing queued prompts. | Newly queued prompts must be appended after existing prompts without changing their relative order. | Given queued prompts A and B, when C is added, the queue becomes [A, B, C]. After the current task finishes, the prompts are dispatched in order A, B, C. | No | Model/oracle | [New follow-up appends and dispatches in submission order](../packages/tui/test/prompt/followup-queue.property.test.tsx#L101) · [Failed send keeps its place until the next turn finishes](../packages/tui/test/prompt/followup-queue.property.test.tsx#L122) | H3 |
| R5 | C-4, S-4, O-4: Canceling a queued prompt should preserve the remaining prompts and their order. | Canceling a pending prompt must remove only the selected prompt without changing the relative order of the remaining prompts. | Given queued prompts A, B, and C, when B is canceled, the queue becomes [A, C]. B is never dispatched, and A and C remain eligible for dispatch in that order. | No | Model/oracle | [Cancellation removes only the selected submission](../packages/tui/test/prompt/followup-queue.property.test.tsx#L156) · [Cancel Latest removes only the newest submission](../packages/tui/test/prompt/followup-queue.property.test.tsx#L177) | H3, H4, H5 |
| R6 | C-2, C-5, O-2, O-3: Users expect queued prompts to remain visible until processed or canceled. | The interface must display pending queued prompts while they are waiting to be dispatched. | Given an active session, when A and B are queued, both appear in the pending queue in submission order. When A is dispatched, it is removed from the pending queue while B remains visible. | No | — | — | — |
| R7 | C-5, S-5, O-5: Users expect to verify processing order and view the responses to their requests. | The conversation history must preserve the order of dispatched prompts and associate each completed prompt with its response. | Given independent queued prompts A, B, and C that complete successfully in sequence, the conversation history displays A, B, and C in processing order, with their respective responses visible under the corresponding requests. | No | — | — | — |

Properties written or suggested by opencode or another AI tool: R1, R3, R4, R5 (suggested in the prompt and written with Codex).

## Requirement changes

| ID | Original requirement (P3) | Revised requirement | Why it changed |
|---|---|---|---|

All seven requirements were kept. They describe compatible, observable outcomes at the dispatch boundary, in the pending queue, in the agent input, or in the conversation history.

## Property test results

The first invocation stopped before running the properties because fast-check does not export a named `fc` binding. After switching to its default import, the first run that exercised the properties passed all four. No counterexample or production fix was needed.

## Hand-written mutants

Predictions are based on the four Queue/Steer properties from Project 4 and were recorded before running any mutant.

| ID | Requirement targeted | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| [H1](../mutants/derekli/H1.patch) | R1 | In `shouldQueueFollowup`, check for `busy` instead of checking whether the session is non-idle. A queued submission can bypass the queue while the session is retrying. | R1. The property generates `retry` as an active status and expects the prompt to stay pending with no send. | Killed by R1. The shrunk case was prompt `"!"` during `retry`; the pending queue was empty. |
| [H2](../mutants/derekli/H2.patch) | R3 | In `nextDeliveryMode`, swap the mode in the comparison while leaving both branches in place. Toggling retains the current mode. | R3. The first toggle starts in Queue and the property expects Steer with the same pending items. | Killed by R3. The first toggle left the mode in Queue. |
| [H3](../mutants/derekli/H3.patch) | R4 | In `add`, put the new item before the existing list. A later submission takes priority over earlier submissions. | R4. It checks the order and identity of pending submissions after an append, then checks the send order. | Killed by R3, R4, and R5. R4 generated three identical texts and still detected that the original submission IDs shifted. |
| [H4](../mutants/derekli/H4.patch) | R5 | In `cancelQueuedFollowup`, find the selected index and call `toSpliced` without a delete count. Canceling a prompt removes the rest of the queue after it as well. | R5. The generator selects positions before the tail, and the oracle expects the remaining IDs and sends to match removal of exactly one item. | Killed by R5. Canceling the first of three submissions removed the two that should have remained. |
| [H5](../mutants/derekli/H5.patch) | R5 | In `cancelLatest`, slice from index 1. The command to cancel the latest queued follow-up removes the oldest when multiple items are pending. | Predicted survivor. The P4 R5 property calls cancellation by ID and never calls `cancelLatest`. | Survived the original four properties. The new R5 Cancel Latest property killed it. The shrunk case submitted `"run tests"` twice and detected that the older submission ID was removed (seed 42, path `0:1`). |

## Stryker comparison

The [TUI config](../packages/tui/stryker.derekli.config.json) runs only the Queue/Steer property file with fast-check seed `42`. It mutates the queue implementation and the mode toggle. Both runs used Stryker 10.1.1 with the same 66 generated mutants.

| Run | Killed | Survived | Raw score | Score excluding equivalent mutants |
|---|---:|---:|---:|---:|
| Baseline with four P4 properties | 46 | 20 | 69.70% | — |
| [Final HTML report](../mutants/derekli/mutation.html) with seven properties | 66 | 0 | 100.00% | 100.00% |

No mutant timed out or produced an instrumentation or runtime error. The final run had no surviving mutants to classify as equivalent.

- **Hand-written mutations Stryker missed.** H1 singles out `busy` and misses `retry`. Stryker flipped the equality and substituted constants, but never introduced the `busy` status check. H3 reorders a spread and its new item. H4 rewrites the cancellation around an index and omits the splice count. H5 changes the slice bounds to remove the head. Stryker mutated the array and call expressions without generating those changes. Stryker did reproduce H2's behavior for both valid modes by flipping the toggle's equality operator.
- **Unexpected Stryker survivors.** Replacing the entire admission condition with `true` survived because the original suite submitted prompts only when Queue mode should hold them. That change is unlikely to ship, but flipping `&&` to `||` could plausibly make idle Queue submissions or active Steer submissions wait. Stryker also removed the failure handler and changed the status check that resets the failure flag. The original queue properties exercised successful sends. They missed the case where a send fails during an active status and the subsequent idle transition can trigger a premature retry.
- **What each approach found.** The hand-written patches modeled changes in user-visible behavior such as FIFO insertion and canceling the wrong queue entry. Stryker systematically probed both sides of predicates and removed effects such as reporting a failed send. H5 and Stryker's `cancelLatest` mutations independently identified the same missing command coverage.

The final properties generate immediate-send cases across idle and Steer states (five Stryker survivors), failed sends across idle and active states while checking retry timing, error reporting and queue order (eleven), and cancellation of the newest submission across queues of varying length with repeated text (four). The Cancel Latest property also killed H5.

## Agent failure case

I asked opencode 1.18.30 for one property for R5 in a new session (`ses_e2d19dac3ffeKw3crySvWSe9hh`). The prompt described both cancellation entry points and let opencode choose which one to exercise.

**Prompt**

```text
Write one TypeScript fast-check property for this OpenCode TUI requirement (R5): Canceling a pending prompt must remove only the selected prompt without changing the relative order of the remaining prompts. A canceled prompt must never dispatch.

Assume the property test has Bun's test and expect, fast-check as fc, and an async withQueue helper that starts a busy session. Its harness has submit(text, "queue"), items (ordered entries with unique id and text), cancel(id) for selecting an entry, cancelLatest() for the command that selects the newest entry, and expectDispatch(h, expected) to check the remaining sends after the session goes idle. Each send is represented as { text, submission }, where submission is the zero-based index assigned on submit. Existing prompts(1) generates arrays of one to eight strings with duplicates possible.

Choose one cancellation operation to cover. Return one runnable test block using these helpers, and explain briefly what it checks. Please answer in chat only.
```

**opencode response**

```ts
import { test } from "bun:test";
import fc from "fast-check";

test("R5: cancel(id) removes only the selected pending prompt", async () => {
  await fc.assert(
    fc.asyncProperty(prompts(1), fc.nat(), async (texts, pick) => {
      await withQueue(async (h) => {
        const submitted = texts.map((text, submission) => {
          h.submit(text, "queue");
          return { text, submission };
        });

        const selectedIndex = pick % h.items.length;
        const selected = h.items[selectedIndex];
        h.cancel(selected.id);

        const expected = submitted.filter((_, index) => index !== selectedIndex);
        await expectDispatch(h, expected);
      });
    }),
  );
});
```

This selects a random queued entry by its unique `id`, so duplicate prompt text is handled correctly. It then asserts the exact remaining dispatch sequence, which verifies that only that submission was removed, the rest kept their relative order, and the canceled prompt never dispatched.

**Surviving mutant and gap.** [H5](../mutants/derekli/H5.patch) changes `cancelLatest()` so it removes the oldest pending submission. The suggested property compares the exact remaining dispatch sequence after canceling by ID. That oracle catches errors in `cancel(id)`, but the property never exercises the Cancel Latest command, so it passes with H5 applied.

**Strengthened property.** [R5: Cancel Latest removes only the newest submission](../packages/tui/test/prompt/followup-queue.property.test.tsx#L177) exercises the second entry point. It generates queues with possible duplicate text, records the pending IDs, calls `cancelLatest()`, and checks that the remaining IDs and eventual dispatches match the original queue without its last entry.

| Property run in isolation with seed `42` | Clean source | H5 applied |
|---|---|---|
| opencode's `cancel(id)` property | Passed | Passed |
| Strengthened Cancel Latest property | Passed | Failed |

I ran the opencode test body with the existing harness and seed, using the file's existing imports. The strengthened property shrank the H5 failure to two submissions with the same text, `["run tests", "run tests"]` (fast-check path `0:1`). After cancellation, H5 left the newer ID pending where the test expected the older ID.
