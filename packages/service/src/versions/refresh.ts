/**
 * Refresh orchestration (PRD §8.1): fetch + compare, no agent time.
 *
 * Runs when the review is opened or the user clicks refresh:
 * 1. `resolveHead` (fetch, best effort) → new head SHA.
 * 2. Same head → `{ moved: false }`, snapshot untouched.
 * 3. New head → new merge-base + local diff → parse/classify/hash →
 *    hunk-by-hunk comparison + `git range-diff` (display only) → one
 *    `ReviewStore.mutate` applying the PRD §8 table (hunk state, annotations,
 *    cards, findings, pins, threads log, review-level `versionStatus`).
 * 4. Persist the `versions` row + per-version files (migration 003) so
 *    older versions stay viewable, and bump `reviews.current_version`.
 *
 * Uncommitted local edits as an extra version (PRD §8 last line) is a
 * documented seam: not implemented here. A future `dirty-worktree` version
 * can reuse `compareHunks` + the same mutate recipe with
 * `git diff HEAD` as the new diff.
 */
import type {
  Hunk,
  PinnedCode,
  ReviewFile,
  ReviewSnapshot,
  TimedStep,
  Version,
  VersionComparison,
  VersionStatus,
} from "@unvibe/shared";
import { assertReadySnapshot, displayedReviewDecision, summarizeComparison } from "@unvibe/shared";
import type { CommandRunner } from "../exec/index.js";
import {
  baseRefCandidates,
  buildReviewCommits,
  classifyFile,
  fileKeyForPath,
  hashHunkLines,
  parseUnifiedDiff,
  readCommitDiffs,
  readCommitMessages,
  resolveHead,
  resolvePrMergeBase,
} from "../ingest/index.js";
import { uninterestingReason } from "../ingest/index.js";
import type { DatabaseSync } from "../store/index.js";
import { transaction } from "../store/index.js";
import type { ReviewStore } from "../state/store.js";
import { parseId } from "@unvibe/shared";
import { remapAnchor } from "./anchors.js";
import { compareHunks, compareVersions } from "./compare.js";
import { cardCitations, remapCardCitations } from "./citations.js";
import { loadVersionFiles, saveVersionFiles } from "./files.js";
import { getRangeDiff } from "./rangeDiff.js";

export interface RefreshRow {
  repoId: string;
  branch: string;
  prNumber: number | null;
}

export interface RefreshDeps {
  runner: CommandRunner;
  db: DatabaseSync;
  reviews: ReviewStore;
}

export type RefreshResult =
  | { moved: false }
  | {
      moved: true;
      version: Version;
      comparison: VersionComparison;
      versionStatus: VersionStatus;
    };

async function runGit(
  runner: CommandRunner,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const res = await runner.run("git", { args, cwd });
    return { ok: res.code === 0, stdout: res.stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

async function linguistGenerated(
  runner: CommandRunner,
  repoPath: string,
  paths: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (paths.length === 0) return out;
  try {
    const res = await runner.run("git", {
      args: ["check-attr", "linguist-generated", "--stdin"],
      cwd: repoPath,
      stdin: paths.join("\n"),
    });
    if (res.code !== 0) return out;
    for (const line of res.stdout.split("\n")) {
      const m = line.match(/^(.*): linguist-generated: (.*)$/);
      if (m && m[2].trim() === "set") out.add(m[1]);
    }
  } catch {
    // Best effort only.
  }
  return out;
}

/** Rebuild `ReviewFile[]` from diff text (mirrors `ingestReview`). */
async function buildFiles(
  runner: CommandRunner,
  repoPath: string,
  headSha: string,
  diffText: string,
): Promise<ReviewFile[]> {
  const parsed = parseUnifiedDiff(diffText);
  const gen = await linguistGenerated(
    runner,
    repoPath,
    parsed.map((f) => f.path),
  );
  return parsed.map((f) => {
    const category = classifyFile(f.path, { linguistGenerated: gen });
    const fileKey = fileKeyForPath(f.path);
    const hunks: Hunk[] = f.hunks.map((h) => {
      const contentHash = hashHunkLines(h.lines);
      const reason = uninterestingReason(h, { category, generatedFlag: gen.has(f.path) });
      return {
        contentHash,
        header: h.header,
        ...(h.context !== undefined ? { context: h.context } : {}),
        newStart: h.newStart,
        newEnd: h.newEnd,
        oldStart: h.oldStart,
        oldEnd: h.oldEnd,
        added: h.added,
        removed: h.removed,
        lines: h.lines.map((l) => ({ ...l })),
        ...(h.noNewline ? { noNewline: true as const } : {}),
        ...(reason !== undefined ? { hiddenReason: reason } : {}),
      };
    });
    return {
      fileKey,
      path: f.path,
      category,
      hunks,
      ...(f.oldPath !== undefined ? { oldPath: f.oldPath } : {}),
      ...(f.isNew ? { isNew: true as const } : {}),
      ...(f.isDeleted ? { isDeleted: true as const } : {}),
      ...(f.isRename ? { isRename: true as const } : {}),
      ...(f.isBinary ? { isBinary: true as const } : {}),
    };
  });
}

async function resolveNewBase(
  runner: CommandRunner,
  repoPath: string,
  oldBaseRef: string,
  newHead: string,
): Promise<{ baseRef: string; mergeBaseSha: string }> {
  // #93: the stored base may be a bare branch name whose clone only has
  // `origin/<base>` (stacked PR) — try the shared origin-first candidates.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const c of [...baseRefCandidates(oldBaseRef), "origin/main", "origin/master", "main", "master"]) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    candidates.push(c);
  }
  for (const base of candidates) {
    const mb = await runGit(runner, ["merge-base", base, newHead], repoPath);
    const sha = mb.ok ? mb.stdout.trim().split("\n")[0] : "";
    if (!sha) continue;
    // Degenerate self-base (remote-less fixture where baseRef == branch):
    // merge-base(branch, head) == head yields an empty diff. Skip so the
    // root-commit fallback below produces the real root..head diff.
    if (sha === newHead) continue;
    return { baseRef: base, mergeBaseSha: sha };
  }
  const root = await runGit(runner, ["rev-list", "--max-parents=0", newHead], repoPath);
  const rootSha = root.ok && root.stdout.trim() ? root.stdout.trim().split("\n")[0] : newHead;
  return { baseRef: oldBaseRef, mergeBaseSha: rootSha };
}

/** Full new-version file contents at `headSha`, keyed by NEW fileKey. */
async function loadNewContents(
  runner: CommandRunner,
  repoPath: string,
  headSha: string,
  newFiles: ReviewFile[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const f of newFiles) {
    if (f.isDeleted || f.isBinary) continue;
    const res = await runGit(runner, ["show", `${headSha}:${f.path}`], repoPath);
    if (!res.ok) continue;
    out.set(f.fileKey, res.stdout.split("\n"));
  }
  // Rename fallback: old fileKey → same lines under the old key when the
  // caller looks the file up by its previous identity.
  return out;
}

function findBlock(lines: string[], block: string[]): { start: number; end: number } | null {
  if (block.length === 0 || lines.length === 0) return null;
  const eq = (a: string, b: string): boolean => a === b || a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
  outer: for (let start = 1; start + block.length - 1 <= lines.length; start++) {
    for (let i = 0; i < block.length; i++) {
      if (!eq(lines[start - 1 + i] ?? "", block[i] ?? "")) continue outer;
    }
    return { start, end: start + block.length - 1 };
  }
  return null;
}

/**
 * File lines at a revision for pins whose file is not in the new diff.
 * Same `git show <rev>:<path>` source as `readCodeSlice`
 * (`src/mcp/read.ts`), returning all lines instead of a slice. Null on
 * missing file, binary blob (NUL), read error, path escape, or very large
 * file — callers flag the pin rather than throwing or silently keeping it.
 */
async function loadFileLinesAtHead(
  runner: CommandRunner,
  repoPath: string,
  rev: string,
  relPath: string,
): Promise<string[] | null> {
  if (!relPath || relPath.includes("\0") || relPath.startsWith("/") || relPath.split(/[\\/]/).includes("..")) {
    return null;
  }
  const res = await runGit(runner, ["show", `${rev}:${relPath}`], repoPath);
  if (!res.ok) return null;
  if (res.stdout.includes("\0")) return null;
  // Very large files: avoid loading + scanning huge blobs to remap a small
  // pin. Flag for re-pinning instead (same as missing). 1 MiB is generous
  // for source files.
  if (res.stdout.length > 1_000_000) return null;
  return res.stdout.split("\n");
}

/**
 * Shared pin remap by content: find `pin.text` in `lines`, record the new
 * location + clear the flag, or flag for re-pinning when not found. Keeps
 * `pin.text` consistent with the remapped range (exact file content, so a
 * whitespace-insensitive match does not leave stale text). Pure + sync so
 * both the in-diff path and the untouched-file fallback share it. Never
 * throws.
 */
function remapPinByContent(pin: PinnedCode, lines: string[], headSha: string): boolean {
  const hit = findBlock(lines, pin.text.split("\n"));
  if (!hit) {
    pin.needsRepining = true;
    return false;
  }
  pin.remappedSha = headSha;
  pin.remappedStart = hit.start;
  pin.remappedEnd = hit.end;
  pin.needsRepining = false;
  const actual = lines.slice(hit.start - 1, hit.end).join("\n");
  if (actual !== pin.text) pin.text = actual;
  return true;
}

/**
 * Fetch, compare, and apply a new version. Throws on git failures the
 * caller maps to 502; returns `{ moved: false }` when the head is steady.
 */
export async function refreshReview(
  deps: RefreshDeps,
  repoPath: string,
  reviewId: string,
  row: RefreshRow,
  snapshot: ReviewSnapshot,
): Promise<RefreshResult> {
  // #92: routes refuse loading/failed first; assert here for the type narrowing.
  assertReadySnapshot(snapshot);
  // Issue #194: non-agent refresh steps, timed for the Debug page.
  const steps: TimedStep[] = [];
  const fetchStep: TimedStep = { label: "Fetch", startedAt: Date.now() };
  steps.push(fetchStep);
  const head = await resolveHead(deps.runner, repoPath, {
    ...(row.prNumber !== null ? { pr: row.prNumber } : { branch: row.branch }),
  });
  fetchStep.finishedAt = Date.now();
  // #224: keep the stored PR state fresh from the same `gh pr view` call,
  // even when the head is steady (a merge/approval moves no commits).
  // #230: the stored decision is the displayed one (re-request hides
  // changes_requested; review_required never shows).
  const displayedDecision = displayedReviewDecision({
    reviewDecision: head.reviewDecision,
    reviewRequests: head.reviewRequests,
    latestReviews: head.latestReviews,
  });
  const prChanged =
    row.prNumber !== null &&
    head.prState !== undefined &&
    snapshot.description !== undefined &&
    (snapshot.description.state !== head.prState ||
      snapshot.description.isDraft !== (head.isDraft ?? false) ||
      snapshot.description.reviewDecision !== displayedDecision);
  if (!head.headSha || head.headSha === snapshot.version.headSha) {
    if (prChanged) {
      await deps.reviews.mutate(reviewId, (draft) => {
        if (!draft.description) return;
        draft.description.state = head.prState;
        draft.description.isDraft = head.isDraft ?? false;
        if (displayedDecision !== undefined) draft.description.reviewDecision = displayedDecision;
        else delete draft.description.reviewDecision;
      });
    }
    return { moved: false };
  }
  const buildStep: TimedStep = { label: "Building the new version", startedAt: Date.now() };
  steps.push(buildStep);

  const oldVersion = snapshot.version;
  const oldFiles = snapshot.files;
  const base = await resolveNewBase(deps.runner, repoPath, oldVersion.baseRef, head.headSha);
  // PR reviews track the PR's base branch; branch reviews keep the ingested base.
  const newBaseRef = row.prNumber !== null && head.baseRef ? head.baseRef : base.baseRef;
  let newBaseSha = base.mergeBaseSha;
  if (row.prNumber !== null && head.baseRef && head.baseRef !== base.baseRef) {
    // #93: same origin-first merge-base as ingest, through the shared helper.
    try {
      const resolved = await resolvePrMergeBase(deps.runner, repoPath, head.baseRef, head.headSha);
      newBaseSha = resolved.mergeBaseSha;
    } catch {
      // Keep the resolveNewBase fallback: refresh still produces a diff
      // against the best base found above rather than failing the refresh.
    }
  }

  const diff = await runGit(
    deps.runner,
    ["diff", "-U3", "-M", "--no-color", "--no-ext-diff", newBaseSha, head.headSha, "--"],
    repoPath,
  );
  if (!diff.ok) throw new Error(`git diff failed for ${head.headSha}`);
  const newFiles = await buildFiles(deps.runner, repoPath, head.headSha, diff.stdout);
  // Issue #193: refresh the commit evidence for the new range.
  const newCommitMessages = await readCommitMessages(deps.runner, repoPath, newBaseSha, head.headSha);
  const newCommits = buildReviewCommits(
    newCommitMessages,
    await readCommitDiffs(deps.runner, repoPath, newCommitMessages),
    newFiles,
  );

  const cmp = compareHunks(oldFiles, newFiles);
  const rangeStep: TimedStep = { label: "Range diff", startedAt: Date.now() };
  steps.push(rangeStep);
  const rangeDiff = await getRangeDiff(
    deps.runner,
    repoPath,
    oldVersion.mergeBaseSha,
    oldVersion.headSha,
    newBaseSha,
    head.headSha,
  );
  rangeStep.finishedAt = Date.now();
  const comparison = compareVersions({
    oldFiles,
    newFiles,
    oldVersion: oldVersion.n,
    newVersion: oldVersion.n + 1,
    oldHeadSha: oldVersion.headSha,
    newHeadSha: head.headSha,
    rangeDiff,
  });
  void cmp;

  const now = Date.now();
  const idMapping: Record<string, string> = {};
  for (const u of comparison.unchanged) idMapping[u.oldId] = u.newId;
  for (const c of comparison.changed) idMapping[c.oldId] = c.newId;
  const version: Version = {
    n: oldVersion.n + 1,
    headSha: head.headSha,
    mergeBaseSha: newBaseSha,
    baseRef: newBaseRef,
    fetchedAt: now,
    idMapping,
  };
  const summary = summarizeComparison(comparison);
  // A rebase without conflicts comes out as "no change": the version is
  // still recorded (with its ID mapping) but nothing is stale, so the UI
  // shows no Update banner and the update pass reports nothing to do.
  const hasChanges = summary.changedHunks + summary.newHunks + summary.removedHunks > 0;
  // #179: the new diff is empty — say so in the banner instead of
  // silently showing no files, and never offer an agent update for it.
  const isEmpty = newFiles.every((f) => f.hunks.length === 0 && !f.isBinary);
  const versionStatus: VersionStatus = {
    stale: hasChanges,
    fromVersion: oldVersion.n,
    toVersion: version.n,
    unchangedHunks: summary.unchangedHunks,
    changedHunks: summary.changedHunks,
    newHunks: summary.newHunks,
    removedHunks: summary.removedHunks,
    renamedFiles: summary.renames,
    changedOldIds: summary.changedOldIds,
    changedNewIds: summary.changedNewIds,
    rangeDiff,
    fetchedAt: now,
    ...(isEmpty ? { empty: true } : {}),
  };

  const newContents = await loadNewContents(deps.runner, repoPath, head.headSha, newFiles);
  // Old-key fallback for anchors whose file has no surviving hunks.
  for (const f of newFiles) {
    const lines = newContents.get(f.fileKey);
    if (!lines) continue;
    if (f.oldPath) {
      const oldKey = fileKeyForPath(f.oldPath);
      if (!newContents.has(oldKey)) newContents.set(oldKey, lines);
    }
  }

  // Pins in files the new diff does not touch have no entry in
  // `newContents`. Load those files at the new head now (async, before the
  // sync mutate below) so the pinned-code loop can decide by content.
  // Missing / binary / very large / unreadable → null → flagged, never thrown.
  const untouchedContents = new Map<string, string[] | null>();
  {
    const livePins = deps.reviews.getSnapshot(reviewId)?.pinnedCode ?? snapshot.pinnedCode ?? [];
    for (const pin of livePins) {
      if (!pin.text) continue;
      let newPath = pin.path;
      for (const r of comparison.renames) {
        if (r.oldPath === pin.path) {
          newPath = r.newPath;
          break;
        }
      }
      const nf = newFiles.find((f) => f.path === newPath);
      if (nf && newContents.get(nf.fileKey)) continue;
      if (nf) continue; // In-diff but unreadable (deleted/binary): flagged, no fallback read.
      if (untouchedContents.has(newPath)) continue;
      untouchedContents.set(newPath, await loadFileLinesAtHead(deps.runner, repoPath, head.headSha, newPath));
    }
  }

  // #112: `code:` citations to files outside the new diff need the same
  // content decision as pins. Preload old/new file lines (async, before
  // the sync mutate) for every distinct outside-diff cited path.
  const codeFiles = new Map<string, { oldLines: string[] | null; newLines: string[] | null; newPath: string }>();
  {
    const live = deps.reviews.getSnapshot(reviewId) ?? snapshot;
    const citedPaths = new Map<string, string>();
    for (const page of live.pages) {
      for (const card of page.cards) {
        for (const cit of cardCitations(card)) {
          const parsed = parseId(cit.target);
          if (parsed?.kind !== "code" || citedPaths.has(parsed.path)) continue;
          let newPath = parsed.path;
          for (const r of comparison.renames) {
            if (r.oldPath === parsed.path) {
              newPath = r.newPath;
              break;
            }
          }
          citedPaths.set(parsed.path, newPath);
        }
      }
    }
    for (const [oldPath, newPath] of citedPaths) {
      // #81: every cited file is re-anchored by content at the new head,
      // in the diff or outside it. In-diff new lines come from the full
      // contents already loaded; old lines always read at the old head.
      const inDiff = newFiles.find((f) => f.path === newPath);
      const oldLines = await loadFileLinesAtHead(deps.runner, repoPath, oldVersion.headSha, oldPath);
      const newLines = inDiff
        ? (newContents.get(inDiff.fileKey) ?? null)
        : await loadFileLinesAtHead(deps.runner, repoPath, head.headSha, newPath);
      codeFiles.set(oldPath, { oldLines, newLines, newPath });
    }
  }

  // #81: `code:` anchors (file-tab Explain/Ask/Comment) remap by content
  // like diff anchors. Preload each anchored file at the new head.
  const codeAnchorContents = new Map<string, string[] | null>();
  {
    const live = deps.reviews.getSnapshot(reviewId) ?? snapshot;
    for (const ann of live.annotations) {
      if (ann.anchor.host.kind !== "code") continue;
      const oldPath = ann.anchor.host.path;
      let newPath = oldPath;
      for (const r of comparison.renames) {
        if (r.oldPath === oldPath) {
          newPath = r.newPath;
          break;
        }
      }
      if (codeAnchorContents.has(oldPath)) continue;
      const inDiff = newFiles.find((f) => f.path === newPath);
      const lines = inDiff
        ? (newContents.get(inDiff.fileKey) ?? null)
        : await loadFileLinesAtHead(deps.runner, repoPath, head.headSha, newPath);
      codeAnchorContents.set(oldPath, lines);
    }
  }

  buildStep.finishedAt = Date.now();

  // One mutate so the UI gets one patch (PRD §8.4).
  await deps.reviews.mutate(reviewId, (draft) => {
    // #224: same PR-state refresh as the steady-head path above.
    if (row.prNumber !== null && head.prState !== undefined && draft.description) {
      draft.description.state = head.prState;
      draft.description.isDraft = head.isDraft ?? false;
      if (displayedDecision !== undefined) draft.description.reviewDecision = displayedDecision;
      else delete draft.description.reviewDecision;
    }
    draft.files = newFiles as ReviewSnapshot["files"];
    draft.commits = newCommits;
    draft.version = { ...version };
    draft.review.versions = [...draft.review.versions, { ...version }];
    draft.review.currentVersion = version.n;
    // Custom guides are not revised by the update pass: they show
    // "generated for an earlier version" with Regenerate instead.
    for (const g of draft.guides ?? []) if (g.version < version.n) g.stale = true;
    draft.versionStatus = { ...versionStatus };

    // Hunk state (PRD §8 table).
    const oldHashToNew = new Map<string, string>();
    for (const c of comparison.changed) {
      const oh = c.oldHunk.contentHash;
      if (!oldHashToNew.has(oh)) oldHashToNew.set(oh, c.newHunk.contentHash);
    }
    for (const s of draft.hunkStates) {
      const nh = oldHashToNew.get(s.contentHash);
      if (nh === undefined) continue;
      s.stale = true;
      s.needsSummary = true;
      s.supersededBy = nh;
    }
    for (const c of comparison.changed) {
      const prev = draft.hunkStates.find((s) => s.contentHash === c.oldHunk.contentHash);
      if (!prev) continue;
      if (draft.hunkStates.some((s) => s.contentHash === c.newHunk.contentHash)) continue;
      draft.hunkStates.push({
        contentHash: c.newHunk.contentHash,
        folded: prev.folded,
        reviewed: false,
        ...(prev.summary !== undefined ? { summary: prev.summary } : {}),
        stale: true,
        needsSummary: true,
      });
    }
    // Reviewed flags on changed hunks live on the carried entries above;
    // entries keyed by the old hash keep history for old-version views.

    // Issue #194: remap sub-steps, timed inside the one mutate.
    const remapSteps: TimedStep[] = [];
    const anchorsStep: TimedStep = { label: "Remapping anchors", startedAt: Date.now() };
    remapSteps.push(anchorsStep);
    // Annotations on code: moved or outdated.
    for (const ann of draft.annotations) {
      if (ann.anchor.host.kind !== "diff-line" && ann.anchor.host.kind !== "code") continue;
      const out = remapAnchor(ann.anchor, {
        comparison: cmp,
        newContents,
        newVersion: version.n,
        codeContents: codeAnchorContents,
        newHeadSha: head.headSha,
      });
      if (out.remap.status === "moved" && out.newAnchor) {
        ann.anchor = out.newAnchor;
        if (ann.anchor.host.kind === "code") {
          for (const r of comparison.renames) {
            if (r.oldPath === ann.anchor.host.path) ann.anchor.host.path = r.newPath;
          }
        }
        ann.outdated = false;
        delete ann.outdatedReason;
        delete ann.originalSnippet;
        delete ann.successor;
      } else {
        ann.outdated = true;
        ann.outdatedReason = out.remap.status === "outdated" ? out.remap.reason : "quote not found";
        if (ann.originalSnippet === undefined) ann.originalSnippet = ann.anchor.quotedText;
        if (out.successor) ann.successor = out.successor;
      }
    }

    anchorsStep.finishedAt = Date.now();
    const citationsStep: TimedStep = { label: "Remapping citations", startedAt: Date.now() };
    remapSteps.push(citationsStep);
    // Cards + findings: remap citations, flag stale / recheck.
    const ctx = { comparison: cmp, oldFiles, newHeadSha: head.headSha, codeFiles };
    for (const page of draft.pages) {
      for (const card of page.cards) {
        const changedCount = remapCardCitations(card, ctx);
        if (changedCount > 0) {
          card.stale = true;
          card.staleChangedHunks = (card.staleChangedHunks ?? 0) + changedCount;
          const ids = new Set(card.staleHunks ?? []);
          for (const id of summary.changedNewIds) ids.add(id);
          card.staleHunks = [...ids];
        }
      }
      if (page.kind === "finding") {
        const changedInPage = page.cards.some((c) => c.stale === true);
        if (changedInPage) {
          page.needsRecheck = true;
          page.recheckStatus = "pending";
        }
      }
    }

    citationsStep.finishedAt = Date.now();
    const pinsStep: TimedStep = { label: "Remapping pins", startedAt: Date.now() };
    remapSteps.push(pinsStep);
    // Pinned code: found again by content, else flagged for re-pinning.
    // Empty-text pins (persisted before text was stored, or never
    // resolvable) have nothing to match: flag them instead of running
    // the content search on a blank block, which would remap to a
    // spurious blank line. Pins whose file is not in the new diff are
    // decided by content at the new head (preloaded above): unchanged
    // content keeps the pin, moved text remaps via the same helper, and
    // missing/gone/unreadable flags for re-pinning.
    if (draft.pinnedCode) {
      for (const pin of draft.pinnedCode) {
        if (!pin.text) {
          pin.needsRepining = true;
          continue;
        }
        let newPath = pin.path;
        for (const r of comparison.renames) {
          if (r.oldPath === pin.path) {
            newPath = r.newPath;
            break;
          }
        }
        const nf = newFiles.find((f) => f.path === newPath);
        const lines = nf ? newContents.get(nf.fileKey) : undefined;
        if (lines) {
          remapPinByContent(pin, lines, head.headSha);
          continue;
        }
        if (nf) {
          // In-diff but no readable content (deleted/binary): flag.
          pin.needsRepining = true;
          continue;
        }
        if (!untouchedContents.has(newPath)) {
          // Concurrent pin added after the preload: no content to decide
          // by — flag rather than silently keeping it.
          pin.needsRepining = true;
          continue;
        }
        const untouched = untouchedContents.get(newPath);
        if (!untouched) {
          pin.needsRepining = true;
          continue;
        }
        remapPinByContent(pin, untouched, head.headSha);
      }
    }

    pinsStep.finishedAt = Date.now();
    draft.refreshTimings = { at: Date.now(), steps: [...steps, ...remapSteps] };

    // Threads in progress: the change list notes moved anchors / changed
    // code via one log line (change lists include global entries).
    const moved = draft.annotations.filter((a) => !a.outdated).length;
    const outdated = draft.annotations.filter((a) => a.outdated).length;
    const seq = draft.logTail.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
    draft.logTail.push({
      seq,
      kind: "version",
      payload: {
        from: oldVersion.n,
        to: version.n,
        unchanged: summary.unchangedHunks,
        changed: summary.changedHunks,
        added: summary.newHunks,
        removed: summary.removedHunks,
        movedAnchors: moved,
        outdatedAnchors: outdated,
      },
      scope: { scope: "global" },
    });
  });

  // Durable rows (versions + per-version files + current_version bump).
  transaction(deps.db, () => {
    deps.db
      .prepare(
        "INSERT INTO versions (review_id, n, head_sha, merge_base_sha, base_ref, fetched_at, id_mapping) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(reviewId, version.n, version.headSha, version.mergeBaseSha, version.baseRef, version.fetchedAt, JSON.stringify(version.idMapping));
    deps.db.prepare("UPDATE reviews SET current_version = ? WHERE id = ?").run(version.n, reviewId);
    // Backfill the previous version's files so ?version=n-1 stays viewable.
    if (!loadVersionFiles(deps.db, reviewId, oldVersion.n)) {
      saveVersionFiles(deps.db, reviewId, oldVersion.n, oldFiles);
    }
    saveVersionFiles(deps.db, reviewId, version.n, newFiles);
  });

  return { moved: true, version, comparison, versionStatus };
}
