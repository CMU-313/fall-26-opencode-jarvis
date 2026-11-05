# Traceability: Derek Li (derekli)

**Target feature:** Queue/Steer Follow-Up Prompt Management in OpenCode

- [`packages/tui/src/prompt/followup-queue.ts`](../packages/tui/src/prompt/followup-queue.ts)
- [`packages/tui/src/context/delivery.tsx`](../packages/tui/src/context/delivery.tsx)
- [`packages/tui/src/component/prompt/index.tsx`](../packages/tui/src/component/prompt/index.tsx)
- [`packages/tui/src/routes/session/index.tsx`](../packages/tui/src/routes/session/index.tsx)

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test |
|---|---|---|---|---|---|---|
| R1 | C-2, S-2, O-2: Queued prompts should wait until the current task finishes. | A queued follow-up must not be sent to the agent until the current task finishes. | Given an active session processing prompt A, when the user queues prompt B, B remains pending and is not sent to the agent. Once A finishes and the session becomes idle, B is sent. | No | Invariant | [R1: a queued follow-up waits for the active task to finish](../packages/tui/test/prompt/followup-queue.property.test.tsx#L16) |
| R2 | S-2, S-5: Queued prompts should not influence the current task or provide information prematurely. | The agent must not receive the content of a queued prompt before that prompt is dispatched. | Given an active prompt A and a queued prompt B containing a unique instruction, the agent's input for A must not contain B's instruction. B's instruction becomes available only when B is dispatched. | No | — | — |
| R3 | C-3, S-3, O-3: Switching modes should only change the selected mode, not the current task or existing queue. | Switching between Steer and Queue without submitting a new prompt must preserve the current task and all pending queued prompts. | Given active prompt A and queued prompts B and C, switching Queue → Steer → Queue leaves A running and B and C pending in the original order. | No | Round-trip | [R3: Queue → Steer → Queue preserves the active task and pending queue](../packages/tui/test/prompt/followup-queue.property.test.tsx#L40) |
| R4 | C-4, S-4, O-4: Adding another queued prompt should not affect existing queued prompts. | Newly queued prompts must be appended after existing prompts without changing their relative order. | Given queued prompts A and B, when C is added, the queue becomes [A, B, C]. After the current task finishes, the prompts are dispatched in order A, B, C. | No | Model/oracle | [R4: a new follow-up appends and dispatches in submission order](../packages/tui/test/prompt/followup-queue.property.test.tsx#L79) |
| R5 | C-4, S-4, O-4: Canceling a queued prompt should preserve the remaining prompts and their order. | Canceling a pending prompt must remove only the selected prompt without changing the relative order of the remaining prompts. | Given queued prompts A, B, and C, when B is canceled, the queue becomes [A, C]. B is never dispatched, and A and C remain eligible for dispatch in that order. | No | Model/oracle | [R5: cancellation removes only the selected submission](../packages/tui/test/prompt/followup-queue.property.test.tsx#L102) |
| R6 | C-2, C-5, O-2, O-3: Users expect queued prompts to remain visible until processed or canceled. | The interface must display pending queued prompts while they are waiting to be dispatched. | Given an active session, when A and B are queued, both appear in the pending queue in submission order. When A is dispatched, it is removed from the pending queue while B remains visible. | No | — | — |
| R7 | C-5, S-5, O-5: Users expect to verify processing order and view the responses to their requests. | The conversation history must preserve the order of dispatched prompts and associate each completed prompt with its response. | Given independent queued prompts A, B, and C that complete successfully in sequence, the conversation history displays A, B, and C in processing order, with their respective responses visible under the corresponding requests. | No | — | — |

Properties written or suggested by opencode or another AI tool: R1, R3, R4, R5 (suggested in the prompt and written with Codex).

## Requirement changes

| ID | Original requirement (P3) | Revised requirement | Why it changed |
|---|---|---|---|

All seven requirements were kept. They describe compatible, observable outcomes at the dispatch boundary, in the pending queue, in the agent input, or in the conversation history.

## Property test results

The first invocation stopped before running the properties because fast-check does not export a named `fc` binding. After switching to its default import, the first run that exercised the properties passed all four. No counterexample or production fix was needed.
