import { describe, expect, test } from "bun:test"
import { applyPatch, parsePatch } from "diff"
import { ChangeContext } from "@opencode-ai/core/change-context"

describe("ChangeContext", () => {
  test("extracts a replacement with at most three surrounding lines on each side", () => {
    const original = "outside before\nbefore 3\nbefore 2\nbefore 1\nold\nafter 1\nafter 2\nafter 3\noutside after\n"
    const proposed = original.replace("old\n", "new\n")
    const result = ChangeContext.extract("src/example.ts", original, proposed)

    expect(result).toMatchObject({ file: "src/example.ts", status: "modified", additions: 1, deletions: 1 })
    expect(parsePatch(result.patch!)[0].hunks).toEqual([
      expect.objectContaining({
        oldStart: 2,
        oldLines: 7,
        newStart: 2,
        newLines: 7,
        lines: [" before 3", " before 2", " before 1", "-old", "+new", " after 1", " after 2", " after 3"],
      }),
    ])
    expect(result.patch).not.toContain("outside")
    expect(applyPatch(original, result.patch!)).toBe(proposed)
  })

  test("identifies a new file and includes its proposed content", () => {
    const result = ChangeContext.extract("new.ts", undefined, "export const answer = 42\n")

    expect(result).toMatchObject({ file: "new.ts", status: "added", additions: 1, deletions: 0 })
    expect(applyPatch("", result.patch!)).toBe("export const answer = 42\n")
    expect(ChangeContext.extract("empty.ts", undefined, "")).toMatchObject({
      status: "added",
      additions: 0,
      deletions: 0,
    })
    expect(ChangeContext.extract("empty.ts", "", "content\n").status).toBe("modified")
  })

  test.each([
    ["addition", "first\nlast\n", "first\ninserted\nlast\n", 1, 0],
    ["deletion", "first\nremoved\nlast\n", "first\nlast\n", 0, 1],
    ["emptying a file", "removed\n", "", 0, 1],
    ["no final newline", "old", "new", 1, 1],
    ["CRLF", "first\r\nold\r\nlast\r\n", "first\r\nnew\r\nlast\r\n", 1, 1],
  ])("preserves %s in the extracted patch", (_name, original, proposed, additions, deletions) => {
    const result = ChangeContext.extract("example.ts", original, proposed)

    expect(result).toMatchObject({ additions, deletions, status: "modified" })
    expect(applyPatch(original, result.patch!)).toBe(proposed)
  })

  test("keeps separated changed regions without including the entire file", () => {
    const original = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`).join("")
    const proposed = original.replace("line 5\n", "first change\n").replace("line 25\n", "second change\n")
    const result = ChangeContext.extract("example.ts", original, proposed)

    expect(parsePatch(result.patch!)[0].hunks).toHaveLength(2)
    expect(result).toMatchObject({ additions: 2, deletions: 2 })
    expect(result.patch).not.toContain("line 15\n")
    expect(applyPatch(original, result.patch!)).toBe(proposed)
  })

  test("returns no changed regions for unchanged content", () => {
    const result = ChangeContext.extract("example.ts", "unchanged\n", "unchanged\n")

    expect(result).toMatchObject({ additions: 0, deletions: 0 })
    expect(parsePatch(result.patch!)[0].hunks).toEqual([])
  })
})
