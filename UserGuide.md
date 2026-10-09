# Cancel queued follow-up prompts (Alice)

While an agent is working, switch delivery mode to **queue** and send a follow-up. It appears above the composer until processed. Click **Cancel** to remove that item, or press `<leader>d` to cancel the newest queued item (`<leader>` defaults to `ctrl+x`). **Steer** follow-ups still send immediately and before queued items. When the session becomes idle, the next queued follow-up is sent.

**Manual check:** Run `bun dev`. Send a prompt that takes time to process, switch to queue mode, and send one or more follow-ups. Cancel any item with the mouse and cancel the newest with `<leader>d`. Send a steer follow-up to confirm it sends immediately. When the current response finishes, confirm the oldest remaining queued prompt is processed.

**Automated checks:** From `packages/tui`, run `bun test test/prompt/followup-queue.test.ts`. Tests live in [`packages/tui/test/prompt/followup-queue.test.ts`](packages/tui/test/prompt/followup-queue.test.ts) and cover queue/steer selection, idle-only FIFO dispatch, concurrent-dispatch prevention, and cancellation. They cover the queue decisions used by the TUI without starting an OpenCode process. These tests sufficiently cover the queue and cancellation decision helpers used by the TUI; the manual check verifies their integration with composer input, keyboard/mouse controls, and session status transitions.


# Steer/queue toggle for follow-up prompts (Alex)

While an agent is working, a **[steer | queue]** badge appears in the composer. Click it or press `ctrl+x w` to switch the delivery mode for your next follow-up. The bold and colorful word is the active mode. **Steer** sends the follow-up immediately. **Queue** holds it on the client (nothing is sent to the server yet) and shows it above the composer as QUEUED until the current turn finishes. The badge is hidden when the session is idle, since the choice only matters mid-turn.

**Manual check:** Run `bun dev`. Send a prompt that takes a while to process. Confirm the `[steer | queue]` badge appears while the agent is working. Press `ctrl+x w` and confirm the bold word flips, then press it again to flip back. In queue mode, send a follow-up and confirm it shows as QUEUED above the composer. Switch to steer mode and send another follow-up and confirm it sends immediately without being queued. When the response finishes, confirm the queued prompt is sent automatically and the badge disappears once the session is idle.

**Automated checks:** From `packages/tui`, run `bun test`. To run only the files for this feature:

```
bun test test/context/delivery.test.tsx test/cli/tui/followup-delivery.test.ts
```

Tests live in:
- [`packages/tui/test/context/delivery.test.tsx`](packages/tui/test/context/delivery.test.tsx): the delivery mode flag can be read and toggled.
- [`packages/tui/test/cli/tui/followup-delivery.test.ts`](packages/tui/test/cli/tui/followup-delivery.test.ts): end-to-end tests that run the real TUI against a fake server. They check that the keybind flips the badge (and which word is bold), that the badge is hidden when idle, that queue mode holds a mid-turn prompt until the turn ends, that steer mode sends immediately, that QUEUED rows are shown, and that queued prompts survive a permission prompt. Edge cases are: multiple queued prompts sent in order, a send that finishes after the session went idle, and a failed send.

These tests are sufficient because they cover each acceptance criterion from our initial plan, and the end-to-end tests record every prompt the TUI sends and control when each turn ends, which lets them verify that a queued prompt is only sent after the current turn finishes. The manual check confirms the same behavior in a real session. 


# Learn mode (Michael)

Press **Tab** in the composer to cycle Build → **Learn** → Plan. Learn is shown in green. In Learn mode the agent reads and explains code as usual, but before any file edit is written it asks you a comprehension question about that change. A passing answer applies the edit. A failing answer shows feedback and a smaller follow-up question until you pass. Dismissing the question rejects the edit. The question generation and grading behind this were built by Derek and Rita.

**Manual check:** From `packages/opencode`, run `bun dev <path>` on a small throwaway project. Press Tab until **Learn** is shown in green. Ask for a small edit and confirm a "Comprehension" question appears while the file is unchanged. Answer `I don't know` and confirm you see feedback and a narrower question. Answer correctly and confirm the edit is written. Ask for another edit, dismiss the question, and confirm the file is unchanged. Switch to Build, repeat the edit, and confirm no question appears.

**Automated checks:** From `packages/opencode`, run:

```
bun test test/agent/agent.test.ts test/session/reminders.test.ts test/session/tools-comprehension.test.ts test/comprehension-question.test.ts test/comprehension-evaluation.test.ts test/comprehension-handoff.test.ts test/tool/apply_patch.test.ts
```

Tests live in:
- [`packages/opencode/test/agent/agent.test.ts`](packages/opencode/test/agent/agent.test.ts): Learn is a visible primary agent with `learnMode` on, edits allowed, and a pinned green color, and it can be disabled or set as the default agent.
- [`packages/opencode/test/session/reminders.test.ts`](packages/opencode/test/session/reminders.test.ts): Learn's reminder forbids editing files through bash or subagents, and Build and Plan don't get it.
- [`packages/opencode/test/`](packages/opencode/test/) `comprehension-question`, `comprehension-handoff`, `comprehension-evaluation`, and `session/tools-comprehension` tests: my additions check that a retry question is built from earlier failed attempts, a grade wrapped in a code block is still read, and an edit is rejected with feedback when the check can't run.
- [`packages/opencode/test/tool/apply_patch.test.ts`](packages/opencode/test/tool/apply_patch.test.ts) and [`packages/core/test/change-context.test.ts`](packages/core/test/change-context.test.ts) (run from `packages/core`): a multi-file `apply_patch` edit gets one combined question.

These tests are sufficient because they cover each part I changed, from how Learn is defined to how an edit reaches the check, using a fake model so they don't depend on a real provider. The manual check confirms that a real model's follow-up questions get easier and that the edit is only written after a passing answer.


# Comprehension question context, generation, and handoff (Derek)

In **Learn** mode, a proposed file change produces one short comprehension question about its behavior or reasoning before the change is written. The question uses the proposed diff and nearby unchanged lines, so it focuses on the actual change. A multi-file patch produces one combined question. Select **Type your own answer**, press Enter, type your explanation, and press Enter to submit it. Your answer goes to the team's evaluator; a passing answer allows the pending change, while a failed answer shows feedback and a new, more concrete question. Press Escape at the question prompt to reject the pending change. Question generation and handoff are Derek's work; grading and the Learn-mode edit gate are integrated team features.

**Manual check:** With dependencies installed and a model provider configured, create a throwaway project containing `example.ts` with `export const atLimit = (count: number, limit: number) => count > limit`. From `packages/opencode`, run `bun dev <absolute-path-to-project>` and press Tab until **Learn** is selected. Ask: "Change atLimit to return true when count equals limit, using the edit tool."

1. Confirm a **Comprehension** question appears before `example.ts` changes. It should ask about the comparison's behavior or reasoning, without supplying the answer; exact wording depends on the model.
2. Select **Type your own answer** and submit `I don't know`. Confirm feedback and another question appear, and the file still uses `>`.
3. Answer the displayed question in your own words. For a question about equality, explain that `>=` returns true when count equals limit, whereas `>` returned false. Once your answer passes, confirm the file changes to `>=`.
4. Request another small edit, then press Escape at the question prompt. Confirm that edit is not written. Repeat in Build mode and confirm no comprehension question appears.
5. In Learn mode, ask for one `apply_patch` change touching two files. Confirm one question covers the combined change rather than separate prompts for each file.

**Automated checks:** Run each command from the indicated package directory, not the repository root:

```sh
# From packages/core
bun test test/change-context.test.ts

# From packages/opencode
bun test test/comprehension-question.test.ts test/comprehension-handoff.test.ts test/tool/edit.test.ts test/tool/write.test.ts

# From packages/tui
bun test test/cli/tui/comprehension-question.test.tsx
```

Tests live in:

- [`packages/core/test/change-context.test.ts`](packages/core/test/change-context.test.ts): extracts real diffs for existing and new files, preserves separated changed regions with bounded surrounding context, handles unchanged content, and combines multi-file contexts without losing changes.
- [`packages/opencode/test/comprehension-question.test.ts`](packages/opencode/test/comprehension-question.test.ts): passes change context as data to the model, joins streamed text, keeps embedded code instructions in the data message, bounds failed-attempt history, accepts question marks inside code spans, and rejects invalid context, malformed questions, and provider failures. It also checks cancellation of generation.
- [`packages/opencode/test/comprehension-handoff.test.ts`](packages/opencode/test/comprehension-handoff.test.ts): connects the generated question to the pending session and tool call, waits for a user reply, preserves free-text answers, handles dismissal and generation failure, waits for evaluation, and carries feedback into a retry question.
- [`packages/opencode/test/tool/edit.test.ts`](packages/opencode/test/tool/edit.test.ts) and [`packages/opencode/test/tool/write.test.ts`](packages/opencode/test/tool/write.test.ts): verify that the actual edit and write tools provide change context to their execution boundary, including file creation and replacement.
- [`packages/tui/test/cli/tui/comprehension-question.test.tsx`](packages/tui/test/cli/tui/comprehension-question.test.tsx): renders the real question UI against a local test server, enters a free-text answer, and verifies the answer submitted through the question API.

These tests cover the feature's boundaries: accurate change context, constrained question output, pending-change identity, asynchronous reply and failure handling, and submission through the user interface. They exercise the implementation with controlled model responses, so results do not depend on provider availability or wording. This is sufficient for the deterministic context, generation validation, and handoff behavior; the manual checks complement it by checking question relevance and the full Learn-mode workflow with a real model.
