# Traceability: Michael Yeh (myeh2)

**Target feature:** Session undo/redo: `/undo`, `/redo`, and Revert on an earlier message. Undo rolls the chat back to a user message and restores the files the AI changed since then; redo brings them back. Main source files: [`packages/opencode/src/session/revert.ts`](../packages/opencode/src/session/revert.ts) (undo, redo, and discarding undone messages), [`packages/opencode/src/snapshot/index.ts`](../packages/opencode/src/snapshot/index.ts) (file snapshots), and [`packages/tui/src/routes/session/index.tsx`](../packages/tui/src/routes/session/index.tsx) (the `/undo` and `/redo` commands).

All properties are in [`packages/opencode/test/session/undo-redo.property.test.ts`](../packages/opencode/test/session/undo-redo.property.test.ts). In P5 I renamed it from `revert.property.test.ts` so it doesn't clash with a teammate's file.

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test | Mutants it kills |
|---|---|---|---|---|---|---|---|
| R1 | C-7, S-8, O-7: "I’d expect to see the exact same thing; nothing should be changed" | Undoing and then redoing should put your files and chat back exactly how they were before the undo. | The AI changes a.txt from "v1" to "v2" and creates b.txt. After /undo, a.txt says "v1" and b.txt is gone. After /redo, a.txt says "v2", b.txt is back, and the chat shows the same messages as before. | No | For any session and any turn to undo back to, undo, then /redo once per undone turn (like the TUI, each /redo brings back one turn). After each /redo the files match the state before the next undone turn, and at the end every file and the message list are exactly as before (round-trip). After undo, every file matches the state recorded right before the undone turn (model / oracle). | [R1 (round-trip): undo then redo restores every file and the same messages](../packages/opencode/test/session/undo-redo.property.test.ts#L278); [R1 (model): after undo, files match the state recorded before the undone turn](../packages/opencode/test/session/undo-redo.property.test.ts#L309) | Round-trip: H1, H2, H3, H4, H6, Stryker 77, 142, 208, 210, 216, 218. Model: H2, H3, H4, Stryker 142, 208, 210, 216, 218 |
| R2 | C-3, C-4, S-5, O-3: "it also shouldnt rewrite git history" | Undo should only change the files the AI changed. Your other files and your git history should stay the same. | You have an uncommitted change in c.txt, then the AI edits only a.txt. After /undo, a.txt is back to how it was before the AI's edit, c.txt still has your change, and git log looks the same as before. | No | For any committed starting files, any uncommitted edits and any session, every file the undone turns did not change keeps its content after undo, and `git log` is unchanged (invariant). | [R2 (invariant): undo leaves untouched files and git history alone](../packages/opencode/test/session/undo-redo.property.test.ts#L333) | H3 |
| R3 | C-5, O-6, S-6: "if i undo, it should undo the refactor not the manual fix I did" | If you edit a file by hand after the AI's last change to it, undo leaves that file exactly as you left it, and still restores every other file the AI changed. | The AI changes a.txt and b.txt, then you edit a.txt by hand. After /undo, a.txt still has your edit and b.txt is back to how it was before the AI's turn. | Yes | For any session, after you hand-edit one file the undone turns changed, undo keeps that file exactly as you left it and restores every other changed file (invariant). | [R3 (invariant): undo keeps a file you edited by hand after the AI](../packages/opencode/test/session/undo-redo.property.test.ts#L369) | H3, Stryker 142, 208, 210, 216, 218 |
| R4 | C-8, S-10, O-9: "once u do something new the redo should not be available" | If you send a new message after undoing, the undone messages are gone and you can't redo them. | After /undo, you send "hello". The undone messages are deleted, /redo is disabled, and running /redo doesn't change anything. | No | For any session and undo point, sending a new message deletes exactly the undone turns, clears the redo state (what disables /redo), and a later redo changes no files or messages. A second message, with nothing undone, deletes nothing more (invariant). | [R4 (invariant): a new message after undo deletes the undone turns and redo does nothing](../packages/opencode/test/session/undo-redo.property.test.ts#L404) | H5, Stryker 91 |
| R5 | C-10, O-10, O-11, S-12: "i’d be confused about which is the “real” undo if they were different" | Undoing twice should end up in the same place as reverting to the message two turns back. | Three turns change a.txt to "v1", "v2", then "v3". Running /undo twice and choosing Revert on the second message both leave a.txt as "v1", with only the first turn showing. | No | The same session replayed twice: undoing N times one at a time, and choosing Revert N turns back (on the user message or the AI's reply to it), end with the same files and the same revert point, and redo takes both back to the start, for N = 1 to 4 (metamorphic). | [R5 (metamorphic): undoing N times one by one equals one Revert N turns back](../packages/opencode/test/session/undo-redo.property.test.ts#L446) | H1, H6, Stryker 22, 23, 25, 67, 69 |

Properties written or suggested by opencode or another AI tool: R1, R2, R3, R4, R5. All six properties and their generators were drafted with Claude (an AI assistant), as were the code fixes and the P5 changes below. I reviewed each one against its requirement and acceptance criteria. The extra R1 property in the [Agent failure case](#agent-failure-case) was written by opencode, then strengthened.

"Mutants it kills" lists my hand-written mutants (H1–H6) and the Stryker mutants that survived an earlier Stryker run and that I targeted afterwards. I ran each of these against all six properties without stopping at the first failure (15 cases, seed 42, as in CI). Stryker runs with `--bail`, so it doesn't record which property killed each of its other mutants.

## Requirement changes

| ID | Original requirement (P3) | Revised requirement | Why it changed |
|---|---|---|---|
| R3 | If you edited a file by hand after the AI changed it, undo should keep your edit. (Acceptance criteria: the AI changes line 1 of a.txt, you change line 5 by hand; after /undo, line 1 is back to the original and line 5 still has your change.) | If you edit a file by hand after the AI's last change to it, undo leaves that file exactly as you left it, and still restores every other file the AI changed. | Feasibility. Removing the AI's change but keeping yours inside the same file means merging the two edits line by line. That only works when they are on different lines. When they overlap, or when you edited a file the AI created, there is no correct result without a merge-conflict screen, which opencode doesn't have. What interviewees needed was not to lose their own manual work (C-5, O-6), and S-6 expected the tool to notice the conflict. The revised requirement keeps the whole hand-edited file instead of overwriting it. |

R1, R2, R4 and R5 are kept as written. Each can be built on opencode's file snapshots, none conflicts with another (with R3 revised, redo still restores your hand edit, because the snapshot redo uses is taken at the moment you undo), and each has acceptance criteria a test can check.

## Failures and fixes (Step 3)

| Property | Shrunk counterexample | Outcome | Fix |
|---|---|---|---|
| R3 (invariant) | No files at the start. The AI creates `a.txt` (empty), you edit it by hand, then /undo. Undo deleted `a.txt`, including your edit. | Code bug: undo restored every file the AI touched, with no check for hand edits. | `revert.ts` now compares each file with the snapshot taken right after the AI's last change to it (stored on the step-finish part). If the file differs, it was edited by hand, and undo leaves it alone. Added `Snapshot.changed(from, to)` to compare two snapshots. |
| R1 (round-trip) | `a.txt` exists (empty), the AI deletes it, then /undo and /redo. After redo, `a.txt` was back instead of deleted. | Code bug: `Snapshot.restore` ran `git read-tree` + `checkout-index`, which writes the snapshot's files but never deletes files missing from it, so redo could not re-delete a file the AI had deleted. | `restore` now runs `git read-tree --reset -u`, which also removes those files, before `checkout-index`. |
| R3, then R1 (model) | Found by R3 after the first fix: in the last turn the AI deletes `notes.md` ("v1") and creates `src/app.ts` with the same content. Undoing back to an earlier turn left `notes.md` deleted. The same session also fails the R1 model property, and it fails on the original code too. | Code bug: `Snapshot.patch` listed changed files with `git diff --name-only`, which detects renames by default. A delete plus an add with similar content shows only the new name, so the deleted file never made it into the patch and undo could not restore it. This happens whenever the AI moves or renames a file. | `patch` now passes `--no-renames`, and so does the new `changed`. |
| All six, on CI | No counterexample: the PR's `test` check timed out. `opencode`'s existing tests already take about 9.5 of the 10-minute "Run unit tests" limit on `main`, and the properties add a few more minutes. | Not a code or test bug: the CI step's time limit was too small for the suite. | Raised the "Run unit tests" timeout in `.github/workflows/test.yml` from 10 to 15 minutes (the job's own limit is 30). |

No property failed because the test itself was wrong. After the three fixes, all six properties pass, including a local stress run with 100 cases each, and the existing undo and snapshot tests (`revert-compact.test.ts`, `snapshot.test.ts`, and the session server tests) still pass.

## Hand-written mutants

Each mutant is a small, plausible edit to the undo/redo code, saved with `git diff` in [`mutants/myeh2/`](../mutants/myeh2/) (apply one with `git apply mutants/myeh2/H1.patch`). I wrote down the predicted killer for all six before running any of them. "First result" is the run against my P4 properties (seed 42, 15 cases each). "Final" is the run against the properties as they are now, after the P5 changes here and in the Stryker section, with the same seed and number of cases.

| ID | Requirement targeted | Change | Predicted killer | First result | Final |
|---|---|---|---|---|---|
| [H1](../mutants/myeh2/H1.patch) | R1 | `Snapshot.restore` runs plain `git read-tree <snapshot>` instead of `read-tree --reset -u` (the pre-P4 code), so redo writes the snapshot's files but never deletes ones the AI had deleted. | R1 (round-trip): any undone turn that deletes a file that already existed. | Killed by R1 (round-trip). Counterexample: `b.txt` exists (empty), the AI deletes it, then undo and redo leave `b.txt` behind. | Killed by R1 (round-trip), R5 |
| [H2](../mutants/myeh2/H2.patch) | R1 | `Snapshot.patch` drops `--no-renames`, so git's rename detection is back on. | R1 (model), but only if seed 42 generates a turn that deletes a file and writes its exact content to another file. I expected it might survive. | **Survived** all six properties: random writes never produced that pair. | Killed by R1 (both), after I added a "move" operation to the generator. Counterexample: `src/app.ts` exists (empty), the AI moves it to `a.txt`, and undo never brings `src/app.ts` back. |
| [H3](../mutants/myeh2/H3.patch) | R2 | `revert` collects patch parts from every turn, not just the undone ones (the `if (rev)` guard moved below the push). | R2 (invariant): files changed only in earlier, kept turns get rolled back too. R1 (model) as well. | Killed by R2, R1 (model), R3. | Killed by R1 (both), R2, R3 |
| [H4](../mutants/myeh2/H4.patch) | R3 | `editedByHand` builds its map from `steps.toReversed()`, so it compares each file with the AI's *first* change to it instead of its last. | R1 (model): a file the AI changed in two undone turns now looks hand-edited and is skipped. R3 might not notice. | Killed by R1 (model), R3. Counterexample: two turns write `a.txt` ("" then "v1"); undoing both left `a.txt` as "v1". | Killed by R1 (both) |
| [H5](../mutants/myeh2/H5.patch) | R4 | `cleanup` removes messages starting at `index + 1`, so the undone user message survives sending a new message (off by one). | R4 (invariant): the kept messages must be exactly the turns before the undo. | Killed by R4. | Killed by R4 |
| [H6](../mutants/myeh2/H6.patch) | R5 | `revert` always takes a fresh snapshot instead of reusing the one from the first undo (`rev.snapshot = yield* snap.track()`). | None: after undoing twice, redo would return to the state after the first undo, but R5 never redoes and R1 only redoes after a single undo. I expected it to survive. | **Prediction wrong**: killed by R5. The R3 hand-edit check also reads `rev.snapshot`, so on the second undo a file the AI created in the last turn (already removed by the first undo) looks "edited by hand" and is skipped. | Killed by R5, R1 (round-trip). R5 now also redoes after the undos and checks that the original files come back, so it covers redo directly. |

All six are killed by the final properties.

## Stryker comparison

Config: [`packages/opencode/stryker.myeh2.config.json`](../packages/opencode/stryker.myeh2.config.json). It uses the command runner on my property file only (`PROPERTY_RUNS=5 PROPERTY_SEED=42 bun test --bail`) and only mutates the undo/redo code: `revert`, `unrevert`, `cleanup` and the hand-edit check in `revert.ts`, and `patch`, `changed`, `restore` and `revert` in `snapshot/index.ts`, skipping log-only lines. The fast-check seed is fixed at **42**. Stryker runs 5 cases per property instead of CI's 15, which keeps one run under two hours on 2 CPUs. Full report of the final run: [`mutants/myeh2/mutation.html`](../mutants/myeh2/mutation.html).

| Run | Mutants | Killed + timed out | Survived | Equivalent | Score (as Stryker reports it) | Score without equivalent mutants |
|---|---|---|---|---|---|---|
| First (properties after the hand-written mutants) | 291 | 151 | 140 | 57 | 51.89% | 64.1% (150/234) |
| Second (after the first four fixes below) | 291 | 154 | 137 | 57 | 52.92% | 65.8% (154/234) |
| Final (after all fixes) | 291 | 158 | 133 | 57 | 54.30% | 67.5% (158/234) |

In the first run, equivalent mutant 285 timed out and Stryker counted it as killed, so the last column leaves it out (150, not 151).

**What the first run found, and what I changed.** All of these are changes to properties or generators, not new example tests:

- **77**, the second undo no longer restores the pre-undo snapshot first. It survived because my "redo" was a single `unrevert`. The TUI's `/redo` actually brings back one turn at a time by reverting to the next user message, so a real redo goes through this exact line. R1 (round-trip) now redoes like the TUI, one turn at a time, and checks the files after each step.
- **91**, `cleanup` stops returning early when nothing is undone. `SessionPrompt.prompt` runs `cleanup` before every message, so this crashes every normal message, but R4 only ever sent one message right after an undo. R4 now sends a second message and checks nothing else is deleted.
- **22, 23, 25, 67, 69** break the code that maps the AI's reply to its user message, so Revert on a reply leaves the user message behind. In R5, the direct Revert now picks either the user message or the AI's reply, and both have to land in the same place.
- **142** drops `.filter(Boolean)` in `Snapshot.patch`. For a turn that changes no files, `"".split("\n")` gives `[""]`, so the patch lists the whole project folder, and undoing past that turn checks out every file from its snapshot. The generator never made a turn with no file changes, even though that is the most common kind (the AI only answers). Turns can now change 0–3 files.

**What the second run found.** All 8 above were killed, but 4 mutants the first run had killed now survived: **208, 210, 216, 218**. They all break the step in `Snapshot.revert` that deletes a file the AI created, on the path it takes when that file is the only new one in its turn. Allowing empty turns changed which 5 cases seed 42 produces, and none of the new ones had an undone turn whose only new file was one it created. That turn is common in real use, but with 3 of 4 starting files present, few generated turns create a file at all. I counted over 2,000 generated sessions: 12% reach that step, so 5 cases miss it about half the time. Starting files are now missing half the time, which raises it to 22%, and R1 (round-trip) kills all four. Mutant 285 went the other way (timed out, then survived). It's equivalent (see below).

**Which hand-written mutants did Stryker never generate, and why?** None of them exactly. Stryker swaps operators, empties strings, arrays and blocks, and forces conditions to `true`/`false`. It doesn't delete one argument from a list, reorder statements, or add a method call.
- H1 (drop `--reset -u`) and H2 (drop `--no-renames`): Stryker only replaced each flag with `""` (mutants 129–135, 177–179). That makes git reject the whole command, a loud failure that any property catches. Silently losing one flag is the subtle version.
- H3 (move the `if (rev)` guard below the push): the closest is 36 (`if (true)`), which also breaks finding the revert point.
- H4 (add `.toReversed()`): no mutator adds a call.
- H5 (`index + (partID ? 1 : 0)` → `index + 1`): Stryker didn't mutate the inner `partID ? 1 : 0` at all. It made `index - (...)` (107), which only matters when reverting from a part.
- H6 (always take a fresh snapshot): Stryker made `??` into `&&` (74) and removed the `?.` (75), both killed, but never "drop the left side".

**Which Stryker survivors would I never have thought of, and would a developer write them?** 77: I didn't know `/redo` goes through `revert`, and dropping that restore is a very plausible "cleanup", since it's redundant whenever you only move backward. 91 is plausible too: the shell path checks `session.revert` before calling `cleanup`, so it's easy to assume every caller does. 142 is a classic JS slip (`"".split("\n")` is `[""]`), and I wouldn't have guessed it turns into "check out the whole project". Most other survivors are not bugs anyone would write on purpose. They come from Stryker blindly emptying arguments or flipping error checks. One useful surprise: Stryker showed the `checkout-index` call in `restore` has been dead code since my P4 fix (11 equivalent mutants), and that the `.trim()` on file names is itself a latent bug for names that start or end with a space.

**What each approach finds that the other doesn't.** Hand-written mutants come from knowing the feature, so they are subtle and aimed at one requirement: a single missing git flag (H1, H2), or the right code running over the wrong turns (H3, H4, H6). Stryker can't make most of them. Stryker covers every branch, including ones I didn't know mattered (the stepwise redo path, `cleanup` on every message, empty patches), and it maps out what my properties can't reach by design: git failures, reverting from a part, Windows paths. The cost is noise: 57 of the 291 mutants are equivalent, mostly in `Snapshot.revert`'s batching and error handling. Re-running Stryker after each change also showed a limit of my setup: with 5 cases per property, whether a mutant dies can depend on which cases the seed happens to produce (208–218 above).

### Equivalent mutants (57)

- **The `checkout-index` after `read-tree --reset -u` in `restore` (11 mutants:** 182–192). Since my P4 fix, `read-tree --reset -u` already rewrites every file that is missing from disk or differs from the snapshot. I checked this with git directly: a deleted file and a same-size edit both come back. So `checkout-index -a -f` has nothing left to write. Skipping it, breaking its arguments, or flipping the success check only changes what gets logged.
- **Batching in `Snapshot.revert` (27 mutants:** 223, 228, 229, 231, 233, 239, 244–246, 248, 251, 258, 260–265, 268, 277, 279, 281–285, 287). `revert` restores files in batches, up to 100 per git command, and falls back to one file at a time when a batch command fails. These mutants either never batch, drop the 100 limit, send one file through the batch path, or break the batch command so it falls back. For example, checking out a file the snapshot doesn't have makes git reject the whole batch, `checkout <tree> --` with no paths is refused, and 285 passes `undefined` for every path, which git also rejects. Every file ends up the same; only the number of git processes changes (that's why 285 timed out once). (`a === b` never holds inside a batch, because files are de-duplicated first.)
- **Output parsing (5 mutants:** 143, 167, 168, 272, 273). Dropping the first `.trim()` only adds an empty last line, which `.filter(Boolean)` removes, and each line is trimmed again anyway. Dropping `.filter(Boolean)` in `changed` or in the batch `ls-tree` parse only adds the project folder or `""` to a set that is only checked against file paths.
- **Git failures with nothing on stdout (4 mutants:** 138, 164, 219, 221). A failed `git diff` or `ls-tree` prints nothing to stdout, so skipping the explicit failure branch still parses to no files. Only the warning log is lost. 219 and 221 rely on the same fact: empty output is already falsy.
- **The working directory of git commands that take no relative paths (3 mutants:** 180, 207, 286). They pass `--git-dir` and `--work-tree` and use absolute paths or no paths, so where git runs doesn't matter. I checked `checkout` with an absolute path from an unrelated folder.
- **Conditions that can't change the result (7 mutants)** in `revert.ts` and `Snapshot.revert`. 46: `if (!rev)` is always true there, because the block above `continue`s when `rev` is set. 17: every snapshot in `last` has an entry in `differs`, so `?.` never short-circuits. 4: without the filter, `undefined` is compared too, git fails, and the result is dropped by `value &&` anyway. 26: the placeholder string has no `.type`, so `.some(...)` ignores it. 98: `msgs[-1]` is already `undefined`. 193: a bogus first entry in the list of files to restore; its git commands fail and it's skipped. 209: a successful checkout now also runs `ls-tree`, which always finds the file (that's why the checkout worked) and keeps it.

### Survivors I didn't kill (76)

None of these are equivalent. Each needs a situation my generators never create:

- **Reverting from a part (30 mutants:** 57, 60–64, 66, 68, 70, 97, 99, 100, 107, 110–126). The server's revert also takes a `partID`, to undo from the middle of an AI reply. Neither the TUI nor the desktop app sends one, my requirements only cover `/undo`, `/redo` and Revert on a message, and my replay records one step per reply, so this path never runs. 29 and 31 (resetting the snapshot at each `step-start`) also need several steps in one reply.
- **A git command fails (16 mutants:** 140, 141, 166, 181, 211–214, 217, 220, 269–271, 288–290). These are error branches. Reaching them needs a broken snapshot repo, and my properties only use a working one.
- **A path that is a file in one snapshot and a folder in another (10 mutants:** 222, 224–227, 230, 232, 252–254). This is the `clash` check that keeps those out of the same batch.
- **opencode opened in a subfolder of the repo (4 mutants:** 136, 162, 215, 267). `git diff -- .` and `ls-tree` paths depend on the working directory only then.
- **Windows paths (4 mutants:** 153, 174, 201, 202). The `replaceAll("\\", "/")` calls do nothing on Linux, where CI runs.
- **File names that start or end with a space (3 mutants:** 146, 171, 276). Here the original `.trim()` is the bug.
- **A revert point that isn't in the session (3 mutants:** 73, 102, 105).
- **A hand edit between two AI turns (2 mutants:** 249, 250). These batch files from different turns together, which only goes wrong if you edited a file between those turns. None of my requirements says what undo should do with that edit, so this is a gap in the requirements, not just the properties.
- **Snapshots turned off in the config** (87) and **a file that becomes gitignored** (148).

## Agent failure case

**The property.** I asked opencode (build mode, GPT-5.6 Luna) to write its own property for R1, without reading my property file. It wrote [`undo-redo.agent.property.test.ts`](../packages/opencode/test/session/undo-redo.agent.property.test.ts). The commit that adds this file has opencode's version exactly as it wrote it, and the commit after it strengthens it. I made a `/share` link, but opencode no longer hosts shared sessions (the link now says "This link and its content are no longer available"), so the prompt and reply are pasted below, with screenshots.

Prompt I sent:

```
Write a fast-check property-based test for this requirement, in
packages/opencode/test/session/undo-redo.agent.property.test.ts.

R1: Undoing and then redoing should put your files and chat back exactly
how they were before the undo. Acceptance criteria: the AI changes a.txt
from "v1" to "v2" and creates b.txt. After /undo, a.txt says "v1" and b.txt
is gone. After /redo, a.txt says "v2", b.txt is back, and the chat shows the
same messages as before.

The undo/redo code is in packages/opencode/src/session/revert.ts and
packages/opencode/src/snapshot/index.ts, and /undo and /redo are in
packages/tui/src/routes/session/index.tsx. See
test/session/revert-compact.test.ts for how tests record AI turns.

I want an independent property, so do not read
test/session/revert.property.test.ts or test/session/undo-redo.property.test.ts,
and do not read anything in traceability/ or mutants/.

Each case creates a git repo, so keep the default number of cases small
enough to run in a few minutes. Run it from packages/opencode with
bun test test/session/undo-redo.agent.property.test.ts until it passes.
Don't change any other file and don't commit.
```

opencode's final reply:

> Added `packages/opencode/test/session/undo-redo.agent.property.test.ts`.
>
> - Uses fast-check with 3 git-backed cases.
> - Verifies undo restores files and redo restores files plus identical chat.
> - Only the requested file changed.
> - Test passes: 1 pass, 0 fail.
>
> Build · GPT-5.6 Luna · 8m 23s

Screenshots: [prompt](../mutants/myeh2/opencode-prompt.png), [reply](../mutants/myeh2/opencode-reply.png).

The parts of opencode's property that matter (`numRuns: 3`):

```ts
fc.record({
  prompt: fc.constantFrom("change the files", "make the requested edit", "update the project"),
  response: fc.constantFrom("Done", "I changed the files", "The requested edit is complete"),
}),
// ...
yield* Effect.promise(() => fs.writeFile(path.join(dir, "a.txt"), "v1"))
// ... user message, AI reply, step-start snapshot ...
yield* Effect.promise(() => fs.writeFile(path.join(dir, "a.txt"), "v2"))
yield* Effect.promise(() => fs.writeFile(path.join(dir, "b.txt"), "created by the agent"))
// ... step-finish snapshot and patch ...
yield* revert.revert({ sessionID: info.id, messageID: user.id })
expect(yield* read(path.join(dir, "a.txt"))).toBe("v1")
expect(yield* Effect.promise(() => Bun.file(path.join(dir, "b.txt")).exists())).toBe(false)

yield* revert.unrevert({ sessionID: info.id })
expect(yield* read(path.join(dir, "a.txt"))).toBe("v2")
expect(yield* read(path.join(dir, "b.txt"))).toBe("created by the agent")
expect(yield* session.messages({ sessionID: info.id })).toEqual(beforeUndo)
```

**The mutant it let survive: H1.** opencode's property passes against every mutant I ran it on: H1–H6 and Stryker 77, 142, 208, 210, 216 and 218. H1 matters most, because it puts back the real bug my R1 property found in P4. `Snapshot.restore` runs plain `git read-tree` instead of `read-tree --reset -u`, so redo writes back the files the AI changed but never deletes a file the AI deleted:

```diff
-              const result = yield* git([...core, ...args(["read-tree", "--reset", "-u", snapshot])], {
+              const result = yield* git([...core, ...args(["read-tree", snapshot])], {
```

**Why the property was too weak.** Its generator randomizes the wrong thing. The only random inputs are the prompt and reply text, which undo never looks at. The files and what the AI does to them are fixed: `a.txt` goes from "v1" to "v2" and `b.txt` is created, which is the acceptance-criteria example copied into the test. So all 3 runs check the same file changes, and the property is really one example test. That example never deletes a file, so H1 can't show up. It also has one AI turn and one undo, so the mutants that need two undone turns (H3, H4) or a redo that goes through `revert` (H6, 77) can't show up either. This is the "generator that misses the bug" kind of weakness: the inputs are too narrow. opencode also only ran `bun test`. The untyped `Effect.context()` makes `bun typecheck` fail.

**Strengthened version** ([same file](../packages/opencode/test/session/undo-redo.agent.property.test.ts)). It keeps opencode's chat-text generator and the way it records an AI turn, and changes three things:

- The generator now makes the starting files (any of `a.txt`, `b.txt` and `src/c.ts` can be missing or have content) and 1–3 AI turns. Each turn writes or deletes any of those files, or changes nothing. The property undoes back to a random turn and checks that every file matches what it was right before that turn.
- Redo works like the TUI's `/redo`. While there is a later user message, it reverts to it, which brings back one turn, and checks the files match that point. It only calls `unrevert` once none is left. At the end, every file and the message list must be exactly as before the undo.
- It runs 10 cases with a fixed seed (42), and the context is typed, so typecheck passes.

**Evidence.** I ran the same mutants against both versions. opencode's version has no seed, but its only random inputs are the chat text, so its result is the same for any seed. Both versions pass on the real code.

| Mutant | opencode's property | Strengthened (seed 42, 10 cases) |
|---|---|---|
| H1 | Survived | Killed. Counterexample: `a.txt` is "v1", the first AI turn deletes it, and the second changes nothing. After undoing both turns, the first `/redo` should bring back the deletion, but `a.txt` is back as "v1". |
| H3 | Survived | Killed |
| H4 | Survived | Killed |
| H6 | Survived | Killed |
| Stryker 77 | Survived | Killed |
| Stryker 142, 208, 210, 216, 218 | Survived | Killed |
| H2 | Survived | Survived. It needs a turn that moves a file (deletes it and writes the same content to another file), and none of the 10 cases does. My R1 (model) property kills it with a "move" operation. |
| H5 | Survived | Survived. It breaks sending a new message after an undo, which is R4, not R1. |

The strengthened version kills 10 of the 12 mutants. opencode's version killed none.
