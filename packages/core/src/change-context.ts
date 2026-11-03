export * as ChangeContext from "./change-context"

import { FileDiff } from "@opencode-ai/schema/file-diff"
import { formatPatch, structuredPatch } from "diff"

/** Undefined original content represents a new file; an empty string represents an existing empty file. */
export function extract(file: string, original: string | undefined, proposed: string): FileDiff.Info {
  // Bound unchanged context per region without dropping any proposed changes.
  const patch = structuredPatch(file, file, original ?? "", proposed, undefined, undefined, { context: 3 })
  const counts = patch.hunks
    .flatMap((hunk) => hunk.lines)
    .reduce(
      (result, line) => ({
        additions: result.additions + Number(line.startsWith("+")),
        deletions: result.deletions + Number(line.startsWith("-")),
      }),
      { additions: 0, deletions: 0 },
    )
  return {
    file,
    patch: formatPatch(patch),
    status: original === undefined ? "added" : "modified",
    ...counts,
  }
}

/** Joins per-file contexts so a multi-file change is quizzed as a single unit. */
export function combine(contexts: ReadonlyArray<FileDiff.Info>): FileDiff.Info {
  if (contexts.length === 1) return contexts[0]
  return {
    file: contexts.flatMap((context) => context.file ?? []).join(", "),
    patch: contexts.flatMap((context) => context.patch ?? []).join(""),
    status: "modified",
    additions: contexts.reduce((sum, context) => sum + context.additions, 0),
    deletions: contexts.reduce((sum, context) => sum + context.deletions, 0),
  }
}
