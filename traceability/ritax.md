# Traceability: Rita Xiao (ritax)

**Target feature:** OpenCode `/undo` feature, where `/undo` focuses on restoring files that were changed by AI. <br>
Main Source Files: <br>
- [`packages/tui/src/routes/session/index.tsx`](https://github.com/CMU-313/fall-26-opencode-jarvis/blob/ritax/properties/packages/tui/src/routes/session/index.tsx)
- [`packages/opencode/src/session/revert.ts`](https://github.com/CMU-313/fall-26-opencode-jarvis/blob/ritax/properties/packages/opencode/src/session/revert.ts)
- [`packages/opencode/src/snapshot/index.ts`](https://github.com/CMU-313/fall-26-opencode-jarvis/blob/ritax/properties/packages/opencode/src/snapshot/index.ts) <br>

Property Tests are located in:<br>
- [packages/opencode/test/session/revert.property.test.ts](https://github.com/CMU-313/fall-26-opencode-jarvis/blob/ritax/properties/packages/opencode/test/session/revert.property.test.ts) 


## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test | Mutants it kills |
|---|---|---|---|---|---|---|---|
| R1 | C-12, O-11: Users expect modified files to return to their original content after undo. | Running /undo should restore a modified file to its state before the undone interaction. | Given greetings.txt originally contains “Hello, Rita!” and OpenCode changes it to “Hello, world!”, running /undo should restore exactly “Hello, Rita!”. | No | Editing then undoing restores exact original contents (round-trip). | [R1 (Round-Trip)](../packages/opencode/test/session/revert.property.test.ts#L62) | H1 |
| R2 | C-7, S-3, O-8: “the undo feature should only undo what the AI changed” | Running /undo should revert the undone interaction’s AI changes while preserving manual edits in separate files that the interaction did not modify. | Given the user manually edits fileA and OpenCode edits fileB, running /undo should restore fileB to its previous state while fileA remains unchanged. | Yes | Undo preserves a separate manually edited file while restoring the AI-edited file (invariant). | [R2 (Invariant)](../packages/opencode/test/session/revert.property.test.ts#L78) | H1, H5 |
| R3 | C-15, O-16, O-17: “They should both return to the original state [after undo].” | After running /undo, all file changes/creations made during the same interaction should be reverted. | Given OpenCode modifies greetings.txt and creates notes.txt in one interaction, running /undo should restore greetings.txt and remove notes.txt. | No | Undo restores file contents and existence to the saved pre-interaction state (model/oracle). | [R3 (Oracle)](../packages/opencode/test/session/revert.property.test.ts#L99) | H1, H2, H3, M2 |
| R4 | S-6, O-5: “I think it would help if you could choose how far back to undo. You might not want to go through every single step one at a time.” | Users must be able to restore a selected specific earlier interaction without needing to repeatedly execute /undo. | Given three completed interactions (1, 2, 3), selecting the state after interaction 1 should restore the associated files to that state and remove the changes from interactions 2 and 3. | No | One direct revert restores the recorded workspace at the selected boundary (model/oracle). | [R4 (Oracle)](../packages/opencode/test/session/revert.property.test.ts#L135) | H1, H4, M1, M2 |
| R5 | S-5: “Maybe you could have timestamps with the undo history, so you know which points or stage you are going back to.” | For each available state in undo history, there should be a corresponding timestamp displayed. | Given interactions A, B, and C complete at different times, undo history should display each interaction with its individual recorded timestamp. | No | Not tested in P4 property testing. | — | — |
| R6 | S-7, C-13, O-19: “There could be some kind of summary telling you what changed and what you still need to do afterwards.” | After /undo, OpenCode must display a confirmation identifying each affected file, the change reverted, and the affected line numbers or ranges. | Given OpenCode modifies lines 3–6 of greetings.txt, running /undo should display a confirmation identifying the change reverted, the affected filename, and the affected lines. | Yes | The stored undo summary lists the changed files and identifies the final edit and its line (P5 model/oracle). | [R6 summary property](../packages/opencode/test/session/revert.property.test.ts#L158) | M3 |

Properties written or suggested by opencode or another AI tool: R1, R2, R3, and R4. 

## Requirement changes
| ID | Original requirement (P3) | Revised requirement | Why it changed |
|---|---|---|---|
| R2 | When running /undo command, it should keep the manual edits, and only the AI edits should be undone. | Running /undo should revert the undone interaction’s AI changes while preserving manual edits in separate files that the interaction did not modify. | The original wording could include overlapping manual and AI edits within the same file, but the acceptance criterion describes two separate files. The revision makes the scope explicit and checkable while preserving the protection requested in C-7 and O-8. It does not establish a policy for overlapping edits. |
| R6 | After /undo, OpenCode must display a summary of the changes reverted and affected files and lines so users can verify the result. | After /undo, OpenCode must display a confirmation identifying each affected file, the change reverted, and the affected line numbers or ranges. | “Affected lines” could mean line counts, line numbers, or actual changed text. The revision specifies line numbers or ranges, matching the original acceptance criterion and O-19’s request to identify which file and line changed. |

## Hand-written mutants

The kill list in the requirements table reflects the current suite, which includes the R2 and R3 improvements and adds a text-only turn to R2. All five patches were rerun individually with seed `42` and 20 cases per property.

| ID | Requirement targeted | Change | Predicted killer | First result | Revised properties |
|---|---|---|---|---|---|
| [H1](../mutants/ritax/H1.patch) | R1 | In the single-file path, `Snapshot.revert` uses `git restore --source <hash> --staged` to restore only the staged copy. | **R1 (round-trip).** The test reads `greetings.txt` from disk after undo, where the AI's edit would still be visible. | Killed by R1, R2, and R4. In R1, `greetings.txt` started empty and still contained the AI's edit after undo. | Killed by R1, R2, R3, and R4. |
| [H2](../mutants/ritax/H2.patch) | R3 | The batched checkout passes only the first existing file to Git. | **R3 (oracle).** The test changes two existing files and checks both after undo. One would still contain the AI's edit. | Killed by R3. `greetings.txt` still contained the AI's edit after undo. | Killed by R3. |
| [H3](../mutants/ritax/H3.patch) | R3 | `SessionRevert.revert` collects only the first patch from each assistant message. | **Likely survives.** R3 checks multiple file changes within one patch. The harness generates one patch per assistant message, so the property never exercises a second patch in the same message. | Survived all four properties. Each generated assistant message had one patch. | Killed by R3. The second step created an empty `follow-up.txt` that survived undo. |
| [H4](../mutants/ritax/H4.patch) | R4 | `Snapshot.revert` loops over `patches.toReversed()` and uses the first snapshot it sees for each file. | **R4 (oracle)** when undo spans two or more turns. If both turns edit `greetings.txt`, undo would bring back the version from between the turns. | Killed by R4. Undo returned `1: ` where the selected boundary required `0: `. | Killed by R4. |
| [H5](../mutants/ritax/H5.patch) | R2 | `SessionRevert.revert` restores the first patch's whole snapshot before applying the per-file undo. | **Likely survives.** R2 edits `fileA.txt` before the AI turn, so the snapshot already includes that manual edit. Restoring the snapshot would overwrite a manual edit made after the AI turn. | Survived all four properties. The snapshot already contained the manual edit. | Killed by R2. Undo wiped out a one-space manual edit made after the AI turn. |

## Stryker comparison

The [Stryker config](../packages/opencode/stryker.ritax.config.json) runs only `test/session/revert.property.test.ts` with fast-check seed `42` and eight generated cases per property. It mutates how undo selects the interaction, identifies and collects its file changes, restores existing files, and removes newly created files. I kept the same 129 mutation targets for the before-and-after comparison. The final run also executes the new R6 property, and I tested the red team's summary mutation separately.

| **Run** | **Mutants** | **Killed + timed out** | **Survived** | **Equivalent** | **Score (as Stryker reports it)** | **Score without equivalent mutants** |
|---|---:|---:|---:|---:|---:|---:|
| Original properties (baseline rerun) | 129 | 70 | 59 | 4 | 54.26% | 56.00% (70/125) |
| Revised R2 and R3 properties before red-team defense | 129 | 71 | 58 | 4 | 55.04% | 56.80% (71/125) |
| After red-team defense | 129 | 72 | 57 | 4 | 55.81% | 57.60% (72/125) |

All three runs in the table had zero timeouts and errors. Mutant #104 removes the working-directory argument from the batched `git ls-tree` call. It was killed in an earlier run of the original properties and survived all three runs shown here. The cause of the inconsistent result is still unknown.

The earlier R2 change generated manual edits made after the AI turn and caught H5. The earlier R3 change generated two patches in one assistant message and caught H3.

I added a text-only turn before the AI edit in R2 and undid both turns together. The harness records patch parts only when a step reports changed paths, matching the session processor. In an isolated run with mutant #38 applied, removing the empty-path filter made the text-only turn report the entire workspace as a changed path. Undo then wiped out a manual edit made after the AI turn. R2 expected one space in `fileA.txt` and found an empty file.

Compared with the latest original run, #38 was the only mutant to change status before the red-team defense. It went from survived to killed. After the red-team defense, #121 also went from survived to killed. It replaces the path separator argument `--` in batched Git checkout with an empty string. [Final HTML report](../mutants/ritax/mutation.html)

**Hand-written comparison.** Stryker generated none of H1–H5 exactly. It emptied or changed arguments in the checkout commands, while H1 changes how Git restores a file and H2 passes only one filename. Its patch-collection mutations flip the condition or remove the push. H3 keeps one patch per assistant message. H4 reverses patch order and H5 adds a whole-snapshot restore, changes that the generated mutations did not make.

**Unexpected survivors.** Mutant #98 empties the batched `git ls-tree` command's argument array. I expected that to break undo, but the command fails and the fallback restores files individually. Mutant #114 is a more plausible mistake. A developer might assume every affected path existed in the earlier snapshot and drop the checkout filter. The resulting checkout can fail for a newly created file and still produce the expected workspace through the fallback.

**What each approach found.** The hand-written mutants let me start with a user-visible failure and work backward. H3 and H5 showed that my generators needed to cover multiple steps in one interaction and manual edits made after the AI turn. Stryker exposed smaller implementation changes I had overlooked. In particular, #38 showed that a text-only turn could be mistaken for a workspace-wide file change, even though no file had been edited in that turn.

### Equivalent mutants

- **#9** replaces `if (!rev)` with `if (true)`. The preceding branch continues the loop whenever `rev` is set, so every execution that reaches this condition already has `rev` unset.
- **#39 and #110** each remove a `.trim()` before splitting Git output into lines. Both pipelines still trim every individual line and filter out empty strings. Removing the outer trim therefore yields the same list of paths.
- **#75** replaces `tree.text.trim()` with `tree.text` in the single-file fallback. A successful `git ls-tree` call here produces empty output or a tree entry with a mode, type, and hash. Both expressions have the same truthiness for those outputs, so the keep-or-delete decision stays the same.

The final score is **55.81% as reported by Stryker** and **57.60% (72/125)** after excluding these four equivalent mutants.

### Remaining survivors (53)

R1–R4 check the contents and existence of files after undo. A survivor can point to an input my generators missed or to a different execution path that leaves the same files in the cases I tested. I left these mutants in the adjusted score because I did not establish equivalence.

- **Undo request boundaries (2 mutants, #19, #23).** R4 picks a valid user message from a generated history. Removing the part-ID match in #19 leaves that user-message match intact. Removing the early return in #23 only matters when no matching boundary is found, which these histories never request.
- **Working directory and path separators (8 mutants, #32, #48, #55, #56, #61, #69, #104, #123).** The tests use root-level and nested filenames in temporary repositories. The paths in this run use POSIX separators, and some Git commands already have explicit repository and worktree paths. To distinguish the working-directory mutations, I would need a case where resolving paths from a different directory changes which file is restored. #104 also varied across runs with the same seed, as described above.
- **Git failure handling (7 mutants, #34, #36, #37, #106, #108, #125, #127).** The generated cases create working snapshot repositories and do not arrange for the original diff, batch lookup, or batch checkout to fail. Changes inside those error paths therefore have little opportunity to affect the post-undo assertions. To exercise them, I would need to trigger a specific failure and establish the expected file state when it occurs.
- **Single-file fallback (8 mutants, #63, #65–#68, #71, #73, #74).** If checkout succeeds, a mutant that continues to the tree lookup can still find the file and keep it. If checkout fails because the file was newly created, the original lookup finds no entry, and several broken lookups also lead to deletion. A case where checkout fails for a file that did exist in the snapshot would exercise the decision to preserve it.
- **Batch size and grouping (9 mutants, #81, #86–#91, #95, #97).** My generated batches are too small to exercise the 100-file limit. Splitting a batch can still restore all the files individually. Combining files from different snapshots could matter if the shared checkout uses the wrong file version, but the generated histories did not expose a difference.
- **Batch commands and fallback selection (15 mutants, #98–#102, #105, #107, #114, #116, #118–#120, #122, #124, #126).** When a mutated batch lookup or checkout fails, undo can fall back to restoring each file separately. For example, #114 sends newly created paths to checkout, but individual restore still removes them when they are absent from the snapshot. Since R1–R4 check the resulting files, they pass when the fallback restores the expected workspace.
- **Git output parsing (3 mutants, #42, #109, #113).** Removing the trim on individual paths has no visible effect with the filenames these tests generate. For #109, the extra empty entry in the batch lookup set does not match any generated file path, so it does not change which files are restored or deleted.
- **Ignored paths (1 mutant, #43).** The properties leave Git ignore rules alone. Removing the filter therefore has no effect on the generated changed-file lists. A history where an existing file becomes ignored during an interaction would exercise that filter.

## Red team

### Attack

I targeted the assignment statistics feature. The three patches are in [`mutants/ritax/redteam`](../mutants/ritax/redteam) at commit `1662d38`.

### Defense

My red-teamer was `xiangcuz`, who wrote the patches against commit `b3553f6eb6ad36adbc23bbd2ee3fff6ed141efcc`. I reproduced each patch in a separate temporary copy and ran the properties with fast-check seed `42` and 20 cases per property. All five properties passed on the unmodified code.

| Mutant | Requirement | Before the defense | Final result and evidence |
|---|---|---|---|
| [M1](https://github.com/CMU-313/fall-26-opencode-init-to-win-it/blob/a9e8a78/mutants/xiangcuz/redteam/M1.patch) | R4 | Survived. The original generator used root-level files, where basenames match workspace-relative paths. | **Killed by R4.** The generated history now edits `src/greetings.txt` and creates files under `notes/`. After undo, the mutant left `src/greetings.txt` missing when R4 expected its contents from the retained turn. |
| [M2](https://github.com/CMU-313/fall-26-opencode-init-to-win-it/blob/a9e8a78/mutants/xiangcuz/redteam/M2.patch) | R3 | **Killed by R3 and R4.** The earlier R3 improvement already creates a file in a separate second patch, which exercises single-file undo. | **Killed by R3 and R4.** R3 expected `follow-up.txt` to be absent after undo and found an empty file. |
| [M3](https://github.com/CMU-313/fall-26-opencode-init-to-win-it/blob/a9e8a78/mutants/xiangcuz/redteam/M3.patch) | R6 | Survived. The earlier properties only checked the restored workspace. | **Killed by R6.** The new property generates a line edit in the last of two undone interactions. It checks the files in the stored summary and the changed text and line number in the final file's patch. The mutant reported `earlier.txt` alone, omitting `final.txt`. |

R6 checks the summary data produced by undo. The terminal display itself is outside this property test.


## Agent Failure Case

**The property.** I asked OpenCode in Build mode with GPT-5.6 Luna to write an independent fast-check property for R3. OpenCode wrote [`revert.agent.property.test.ts`](https://github.com/CMU-313/fall-26-opencode-jarvis/blob/9dd5904af5f01a630d3eb5cce8f7f7dcc3782263/packages/opencode/test/session/revert.agent.property.test.ts).

**Prompt I sent**

```text
Create a fast-check property for R3 of my /undo feature. Add it to
packages/opencode/test/session/revert.agent.property.test.ts.

R3: After running /undo, all file changes and creations made during the
same interaction should be reverted.

Acceptance criterion: The AI modifies greetings.txt and creates notes.txt in one interaction. After /undo, greetings.txt has exactly its original
contents and notes.txt is gone.

The undo code is in packages/opencode/src/session/revert.ts and
packages/opencode/src/snapshot/index.ts. The /undo command is in
packages/tui/src/routes/session/index.tsx. See
packages/opencode/test/session/revert-compact.test.ts for how tests record
AI turns.

I want an independent property, so please do not read existing property tests, including packages/opencode/test/session/revert.property.test.ts. Do not read
anything in traceability/ or mutants/.

Each case creates a Git repo, so use a fixed fast-check seed and keep the
default number of cases small enough to run in a few minutes. Run this
from packages/opencode:

bun test test/session/revert.agent.property.test.ts

Report the seed, number of cases, and actual test result. Only change
the requested test file. Do not commit or push.
```

**OpenCode’s reply**

> Added `packages/opencode/test/session/revert.agent.property.test.ts`.
>
> - Seed: 20261113
> - Cases: 5
> - Result: 1 pass, 0 failures, 10 assertions
> - Runtime: 86.62s

**The part of OpenCode’s property that matters**

```ts
const contents = fc.string({ maxLength: 80 })
const interaction = fc
  .record({
    original: contents,
    modified: contents,
    notes: contents,
  })
  .filter((value) => value.original !== value.modified)

// In recordInteraction, both file changes happen before one patch is recorded.
const before = yield* snapshot.track()
if (!before) throw new Error("expected a snapshot before the interaction")

yield* Effect.promise(() => fs.writeFile(path.join(dir, "greetings.txt"), value.modified))
yield* Effect.promise(() => fs.writeFile(path.join(dir, "notes.txt"), value.notes))

// ... post-edit snapshot and step parts ...
const patch = yield* snapshot.patch(before)

// ... step parts are recorded ...
yield* session.updatePart({
  id: PartID.ascending(),
  messageID: assistantMessage.id,
  sessionID: info.id,
  type: "patch",
  hash: patch.hash,
  files: patch.files,
})

// In the property, undo the interaction and check the workspace.
const result = yield* recordInteraction(dir, value)
const revert = yield* SessionRevert.Service
yield* revert.revert(result)

expect(yield* Effect.promise(() => fs.readFile(greetings, "utf8"))).toBe(value.original)
expect(yield* Effect.promise(() => fs.stat(notes).catch(() => undefined))).toBeUndefined()
```

**The mutant it let survive.** [H3](../mutants/ritax/H3.patch) changes `SessionRevert.revert` to collect only the first patch in each assistant message. With only H3 applied, the original OpenCode property passed all five generated cases.

```diff
-            if (part.type === "patch") patches.push(part)
+            if (part.type === "patch" && part === msg.parts.find((item) => item.type === "patch")) {
+              patches.push(part)
+            }
```

**Why the property was too weak.** The generator varies the original and edited contents of `greetings.txt` and the contents of `notes.txt`. Every case records both file changes in a single patch on the assistant message. H3 keeps the first patch, which already contains both changes, so undo still restores `greetings.txt` and removes `notes.txt`. The missing case is an assistant message with a second patch whose changes undo must also revert.

**Strengthened version.** I asked OpenCode to split the generated file changes into two steps in the same assistant message. The first step edits `greetings.txt`, and the second creates `notes.txt`. Each step records its own snapshot and patch. The test checks both generated file contents before undo, then checks that one undo restores the exact original contents of `greetings.txt` and removes `notes.txt`. [Strengthened property](../packages/opencode/test/session/revert.agent.property.test.ts)

**Evidence.** Both versions use fast-check seed `20261113` and request five cases per run. The command was `bun test test/session/revert.agent.property.test.ts` from `packages/opencode`. OpenCode ran the baselines with Bun 1.3.14 and confirmed H3 was absent for the strengthened baseline. The H3 runs used Bun 1.4.2 in temporary copies based on commit `9dd5904`. A separate run of the strengthened property with H3 applied reproduced the same failure on the first generated case and shrank to the same counterexample.

| Property | Baseline run | Mutant applied |
| --- | --- | --- |
| Original OpenCode property | 1 pass, 0 failures (86.62s) | 1 pass, 0 failures, 10 assertions (55.29s) |
| Strengthened property | 1 pass, 0 failures, 20 assertions (75.97s) | 0 passes, 1 failure (83.03s) |

With H3 applied, the strengthened property restored `greetings.txt` but failed the assertion that `notes.txt` was absent. `fs.stat(notes)` returned a `Stats` object for an empty file, so the second patch’s creation remained on disk after undo.

```text
error: Property failed after 1 tests
{ seed: 20261113, path: "0:0:0:0:0:0", endOnFailure: true }
Counterexample: [{"original":"","modified":" ","notes":""}]
Shrunk 5 time(s)

176 |                     expect(yield* Effect.promise(() => fs.stat(notes).catch(() => undefined))).toBeUndefined()
error: expect(received).toBeUndefined()

Received: Stats {
  ...
  size: 0,
  ...
}
```
