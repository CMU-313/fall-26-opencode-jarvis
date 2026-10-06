# Cancel queued follow-up prompts (Alice)

While an agent is working, switch delivery mode to **queue** and send a follow-up. It appears above the composer until processed. Click **Cancel** to remove that item, or press `<leader>d` to cancel the newest queued item (`<leader>` defaults to `ctrl+x`). **Steer** follow-ups still send immediately and before queued items. When the session becomes idle, the next queued follow-up is sent.

**Manual check:** Run `bun dev`. Send a prompt that takes time to process, switch to queue mode, and send one or more follow-ups. Cancel any item with the mouse and cancel the newest with `<leader>d`. Send a steer follow-up to confirm it sends immediately. When the current response finishes, confirm the oldest remaining queued prompt is processed.

**Automated checks:** From `packages/tui`, run `bun test test/prompt/followup-queue.test.ts`. Tests live in [`packages/tui/test/prompt/followup-queue.test.ts`](packages/tui/test/prompt/followup-queue.test.ts) and cover queue/steer selection, idle-only FIFO dispatch, concurrent-dispatch prevention, and cancellation. They cover the queue decisions used by the TUI without starting an OpenCode process. These tests sufficiently cover the queue and cancellation decision helpers used by the TUI; the manual check verifies their integration with composer input, keyboard/mouse controls, and session status transitions.


# Steer/queue toggle for follow-up prompts (Alex)

While an agent is working, a **[steer | queue]** badge appears in the composer. Click it or press `ctrl+x w` to switch the delivery mode for your next follow-up. The bold and colorful word is the active mode. **Steer** sends the follow-up immediately. **Queue** holds it on the client (nothing is sent to the server yet) and shows it above the composer as QUEUED until the current turn finishes. The badge is hidden when the session is idle, since the choice only matters mid-turn.

**Manual check:** Run `bun dev`. Send a prompt that takes a while to process. Confirm the `[steer | queue]` badge appears while the agent is working. Press `ctrl+x w` and confirm the bold word flips, then press it again to flip back. In queue mode, send a follow-up and confirm it shows as QUEUED above the composer. Switch to steer mode and send another follow-up and confirm it sends immediately without being queued. When the response finishes, confirm the queued prompt is sent automatically and the badge disappears once the session is idle.

**Automated checks:** From `packages/tui`, run `bun test`. To run only the files for this feature:

```
bun test test/context/delivery.test.tsx test/prompt/followup-delivery.test.ts
```

Tests live in:
- [`packages/tui/test/context/delivery.test.tsx`](packages/tui/test/context/delivery.test.tsx): the delivery mode flag can be read and toggled.
- [`packages/tui/test/prompt/followup-delivery.test.ts`](packages/tui/test/prompt/followup-delivery.test.ts): end-to-end tests that run the real TUI against a fake server. They check that the keybind flips the badge (and which word is bold), that the badge is hidden when idle, that queue mode holds a mid-turn prompt until the turn ends, that steer mode sends immediately, that QUEUED rows are shown, and that queued prompts survive a permission prompt. Edge cases are: multiple queued prompts sent in order, a send that finishes after the session went idle, and a failed send.

These tests are sufficient because they cover each acceptance criterion from our initial plan, and the end-to-end tests record every prompt the TUI sends and control when each turn ends, which lets them verify that a queued prompt is only sent after the current turn finishes. The manual check confirms the same behavior in a real session. 
