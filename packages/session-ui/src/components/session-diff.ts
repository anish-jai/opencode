import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs"
import { parsePatch } from "diff"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"

type LegacyDiff = {
  file: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

type SnapshotDiff = SnapshotFileDiff & { file: string }
type ReviewDiff = SnapshotDiff | FileDiffInfo | VcsFileDiff | LegacyDiff
export type DiffSource = Pick<LegacyDiff, "file" | "patch" | "before" | "after">

export type ViewDiff = {
  file: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
  fileDiff: FileDiffMetadata
}

const diffCacheLimit = 16
const patchFileDiffCache = new Map<string, FileDiffMetadata>()

export function resolveFileDiff(diff: DiffSource) {
  if (typeof diff.patch === "string") return fileDiffFromPatch(diff.file, diff.patch)
  return fileDiffFromContent(
    diff.file,
    typeof diff.before === "string" ? diff.before : "",
    typeof diff.after === "string" ? diff.after : "",
  )
}

export function normalize(diff: ReviewDiff): ViewDiff {
  return {
    file: diff.file,
    additions: diff.additions,
    deletions: diff.deletions,
    status: diff.status,
    fileDiff: resolveFileDiff(diff),
  }
}

export function text(diff: ViewDiff, side: "deletions" | "additions") {
  if (side === "deletions") return diff.fileDiff.deletionLines.join("")
  return diff.fileDiff.additionLines.join("")
}

function fileDiffFromPatch(file: string, patch: string) {
  const key = `${file}\0${patch}`
  const hit = patchFileDiffCache.get(key)
  if (hit) {
    patchFileDiffCache.delete(key)
    patchFileDiffCache.set(key, hit)
    return hit
  }

  const contents = completePatchContents(patch)
  const input = contents ? undefined : patchInput(file, patch)
  const value = contents
    ? fileDiffFromContent(file, contents.before, contents.after)
    : ((input ? parsePatchFiles(input)[0]?.files[0] : undefined) ?? emptyFileDiff(file))
  patchFileDiffCache.set(key, value)
  while (patchFileDiffCache.size > diffCacheLimit) patchFileDiffCache.delete(patchFileDiffCache.keys().next().value!)
  return value
}

const patchSides: Record<string, ("before" | "after")[]> = {
  "-": ["before"],
  "+": ["after"],
  " ": ["before", "after"],
  "\\": [],
}

function parseFirstPatch(patch: string) {
  try {
    return parsePatch(patch)[0]
  } catch {
    return undefined
  }
}

function completePatchContents(patch: string) {
  const parsed = parseFirstPatch(patch)
  if (!parsed || (!parsed.index && !parsed.oldFileName && !parsed.newFileName)) return
  // Snapshot and VCS producers request full context. Tool patches use jsdiff's shorter default context.
  if (!patch.startsWith("diff --git ") && !/^--- [^\n]*\t\r?\n\+\+\+ [^\n]*\t(?:\r?\n|$)/m.test(patch)) return
  // Full patches collapse into one leading hunk. Separated hunks omit ranges and must stay partial.
  const hunk = parsed.hunks.length === 1 ? parsed.hunks[0] : undefined
  if (!hunk || hunk.oldStart > 1 || hunk.newStart > 1) return
  if (hunk.lines.some((line) => !patchSides[line[0]])) return

  // A "\ No newline at end of file" marker strips the newline from the line right before it.
  const lines = hunk.lines.map((line, index) => ({
    sides: patchSides[line[0]],
    text: line.slice(1) + (hunk.lines[index + 1]?.startsWith("\\") ? "" : "\n"),
  }))
  const text = (side: "before" | "after") =>
    lines
      .filter((line) => line.sides.includes(side))
      .map((line) => line.text)
      .join("")
  return { before: text("before"), after: text("after") }
}

function patchInput(file: string, patch: string) {
  const parsed = parseFirstPatch(patch)
  if (!parsed) return
  if (parsed.index || parsed.oldFileName || parsed.newFileName) return patch
  if (!parsed.hunks.length) return
  return `Index: ${file}\n===================================================================\n--- ${file}\t\n+++ ${file}\t\n${patch}`
}

function fileDiffFromContent(file: string, before: string, after: string) {
  if (!before && !after) return emptyFileDiff(file)
  return parseDiffFromFile({ name: file, contents: before }, { name: file, contents: after })
}

function emptyFileDiff(file: string) {
  return parseDiffFromFile({ name: file, contents: "" }, { name: file, contents: "" })
}
